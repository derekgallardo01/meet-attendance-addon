const { Firestore, FieldValue } = require('@google-cloud/firestore');
const crypto = require('crypto');
const CONFIG = require('../config');
const log = require('../lib/logger');

// ── Token encryption (AES-256-GCM using SESSION_SECRET as key) ──
const ALGO = 'aes-256-gcm';
function deriveKey() {
  return crypto.createHash('sha256').update(CONFIG.sessionSecret).digest();
}

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');
  return `${iv.toString('base64')}:${tag}:${encrypted}`;
}

function decryptToken(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext; // not encrypted (legacy)
  try {
    const [ivB64, tagB64, data] = ciphertext.split(':');
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    log.warn('token decryption failed — may be legacy plaintext', { error: err.message });
    return ciphertext; // return as-is if decryption fails (legacy unencrypted token)
  }
}

let db = null;

function getDb() {
  if (!db) {
    const opts = {};
    if (CONFIG.gcpProjectId) opts.projectId = CONFIG.gcpProjectId;
    db = new Firestore(opts);
  }
  return db;
}

// Extract last segment from Meet API resource name
// e.g. "conferenceRecords/abc/participants/xyz" → "xyz"
function lastSegment(resourceName) {
  const parts = resourceName.split('/');
  return parts[parts.length - 1];
}

/**
 * Persist meeting + participants after attendance fetch.
 * Fire-and-forget — never throws.
 */
async function persistAttendance(conferenceId, recordName, participants) {
  try {
    const firestore = getDb();
    const now = FieldValue.serverTimestamp();
    const meetingRef = firestore.collection('meetings').doc(conferenceId);

    const joinTimes = participants.map(p => p.joinTime).filter(Boolean).map(t => new Date(t));
    const leaveTimes = participants.map(p => p.leaveTime).filter(Boolean).map(t => new Date(t));

    await meetingRef.set({
      conferenceId,
      recordName,
      participantCount: participants.length,
      startTime: joinTimes.length > 0 ? new Date(Math.min(...joinTimes)) : null,
      endTime: leaveTimes.length > 0 ? new Date(Math.max(...leaveTimes)) : null,
      lastFetchedAt: now,
      updatedAt: now,
      createdAt: now,
    }, { merge: true });

    const batch = firestore.batch();
    for (const p of participants) {
      const docId = lastSegment(p.participantId);
      const pRef = meetingRef.collection('participants').doc(docId);
      batch.set(pRef, {
        participantId: p.participantId,
        displayName: p.displayName,
        email: p.email,
        joinTime: p.joinTime ? new Date(p.joinTime) : null,
        leaveTime: p.leaveTime ? new Date(p.leaveTime) : null,
        present: p.present,
        sessions: p.sessions,
        lastSeenAt: now,
        updatedAt: now,
        createdAt: now,
      }, { merge: true });
    }
    await batch.commit();

    log.info('firestore: persisted attendance', { conferenceId, participants: participants.length });
  } catch (err) {
    log.error('firestore: persistAttendance failed', { conferenceId, error: err.message });
  }
}

/**
 * Update meeting title + calendar attendees from calendar data.
 * Fire-and-forget — never throws.
 */
async function persistCalendarData(meetingCode, eventTitle, attendees) {
  try {
    const firestore = getDb();
    const now = FieldValue.serverTimestamp();
    const meetingRef = firestore.collection('meetings').doc(meetingCode);

    await meetingRef.set({
      conferenceId: meetingCode,
      title: eventTitle,
      calendarAttendees: attendees,
      updatedAt: now,
      createdAt: now,
    }, { merge: true });

    log.info('firestore: persisted calendar data', { meetingCode, eventTitle });
  } catch (err) {
    log.error('firestore: persistCalendarData failed', { meetingCode, error: err.message });
  }
}

/**
 * Record a sheets export for audit trail.
 * Fire-and-forget — never throws.
 */
async function persistExport({ meetingTitle, tabName, exportedAt, participantCount, sheetUrl }) {
  try {
    const firestore = getDb();
    const now = FieldValue.serverTimestamp();

    await firestore.collection('exports').add({
      meetingTitle,
      tabName,
      exportedAt,
      participantCount,
      sheetUrl,
      createdAt: now,
    });

    log.info('firestore: persisted export record', { tabName, participantCount });
  } catch (err) {
    log.error('firestore: persistExport failed', { tabName, error: err.message });
  }
}

// ── User management (OAuth Phase 3) ──

async function getUser(email) {
  try {
    const doc = await getDb().collection('users').doc(email.toLowerCase()).get();
    if (!doc.exists) return null;
    const data = doc.data();
    // Decrypt refresh token on read
    if (data.refreshToken) data.refreshToken = decryptToken(data.refreshToken);
    return data;
  } catch (err) {
    log.error('firestore: getUser failed', { email, error: err.message });
    return null;
  }
}

async function upsertUser({ email, domain, displayName, refreshToken, sheetId }) {
  try {
    const firestore = getDb();
    const now = FieldValue.serverTimestamp();
    const data = {
      email: email.toLowerCase(),
      domain,
      displayName,
      lastLoginAt: now,
      updatedAt: now,
      createdAt: now,
    };
    if (refreshToken !== undefined) data.refreshToken = encryptToken(refreshToken);
    if (sheetId !== undefined) data.sheetId = sheetId;

    await firestore.collection('users').doc(email.toLowerCase()).set(data, { merge: true });
    log.info('firestore: upserted user', { email });
  } catch (err) {
    log.error('firestore: upsertUser failed', { email, error: err.message });
  }
}

async function getUserSheetId(email) {
  const user = await getUser(email);
  return user?.sheetId || null;
}

async function setUserSheetId(email, sheetId) {
  try {
    await getDb().collection('users').doc(email.toLowerCase()).set(
      { sheetId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    log.info('firestore: set user sheetId', { email, sheetId });
  } catch (err) {
    log.error('firestore: setUserSheetId failed', { email, error: err.message });
  }
}

async function updateUserTokens(email, { accessToken, tokenExpiresAt }) {
  try {
    await getDb().collection('users').doc(email.toLowerCase()).set(
      { accessToken, tokenExpiresAt, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    log.error('firestore: updateUserTokens failed', { email, error: err.message });
  }
}

module.exports = {
  persistAttendance, persistCalendarData, persistExport,
  getUser, upsertUser, getUserSheetId, setUserSheetId, updateUserTokens,
};
