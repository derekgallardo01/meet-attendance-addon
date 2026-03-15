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
    return ciphertext;
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

// ── Tenant helper: all collections scoped under tenants/{domain} ──
function tenantRef(domain) {
  return getDb().collection('tenants').doc(domain);
}

// Extract last segment from Meet API resource name
function lastSegment(resourceName) {
  const parts = resourceName.split('/');
  return parts[parts.length - 1];
}

// ── Tenant config ──

async function getTenantConfig(domain) {
  try {
    const doc = await tenantRef(domain).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    log.error('firestore: getTenantConfig failed', { domain, error: err.message });
    return null;
  }
}

async function upsertTenantConfig(domain, config) {
  try {
    await tenantRef(domain).set({
      domain,
      ...config,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    log.info('firestore: upserted tenant config', { domain });
  } catch (err) {
    log.error('firestore: upsertTenantConfig failed', { domain, error: err.message });
  }
}

// ── Meeting persistence (tenant-scoped) ──

async function persistAttendance(domain, conferenceId, recordName, participants) {
  try {
    const now = FieldValue.serverTimestamp();
    const meetingRef = tenantRef(domain).collection('meetings').doc(conferenceId);

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

    const batch = getDb().batch();
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

    log.info('firestore: persisted attendance', { domain, conferenceId, participants: participants.length });
  } catch (err) {
    log.error('firestore: persistAttendance failed', { domain, conferenceId, error: err.message });
  }
}

async function persistCalendarData(domain, meetingCode, eventTitle, attendees) {
  try {
    const now = FieldValue.serverTimestamp();
    const meetingRef = tenantRef(domain).collection('meetings').doc(meetingCode);

    await meetingRef.set({
      conferenceId: meetingCode,
      title: eventTitle,
      calendarAttendees: attendees,
      updatedAt: now,
      createdAt: now,
    }, { merge: true });

    log.info('firestore: persisted calendar data', { domain, meetingCode, eventTitle });
  } catch (err) {
    log.error('firestore: persistCalendarData failed', { domain, meetingCode, error: err.message });
  }
}

async function persistExport(domain, { meetingTitle, tabName, exportedAt, participantCount, sheetUrl }) {
  try {
    const now = FieldValue.serverTimestamp();

    await tenantRef(domain).collection('exports').add({
      meetingTitle,
      tabName,
      exportedAt,
      participantCount,
      sheetUrl,
      createdAt: now,
    });

    log.info('firestore: persisted export record', { domain, tabName, participantCount });
  } catch (err) {
    log.error('firestore: persistExport failed', { domain, tabName, error: err.message });
  }
}

// ── User management (tenant-scoped) ──

async function getUser(domain, email) {
  try {
    const doc = await tenantRef(domain).collection('users').doc(email.toLowerCase()).get();
    if (!doc.exists) {
      // Fallback: check legacy root-level users collection (migration support)
      const legacyDoc = await getDb().collection('users').doc(email.toLowerCase()).get();
      if (legacyDoc.exists) {
        log.info('firestore: found legacy user, migrating', { email, domain });
        const data = legacyDoc.data();
        // Migrate to tenant-scoped
        await tenantRef(domain).collection('users').doc(email.toLowerCase()).set(data);
        if (data.refreshToken) data.refreshToken = decryptToken(data.refreshToken);
        return data;
      }
      return null;
    }
    const data = doc.data();
    if (data.refreshToken) data.refreshToken = decryptToken(data.refreshToken);
    return data;
  } catch (err) {
    log.error('firestore: getUser failed', { domain, email, error: err.message });
    return null;
  }
}

async function upsertUser(domain, { email, displayName, refreshToken, sheetId }) {
  try {
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

    await tenantRef(domain).collection('users').doc(email.toLowerCase()).set(data, { merge: true });
    log.info('firestore: upserted user', { domain, email });
  } catch (err) {
    log.error('firestore: upsertUser failed', { domain, email, error: err.message });
  }
}

async function getUserSheetId(domain, email) {
  const user = await getUser(domain, email);
  return user?.sheetId || null;
}

async function setUserSheetId(domain, email, sheetId) {
  try {
    await tenantRef(domain).collection('users').doc(email.toLowerCase()).set(
      { sheetId, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    log.info('firestore: set user sheetId', { domain, email, sheetId });
  } catch (err) {
    log.error('firestore: setUserSheetId failed', { domain, email, error: err.message });
  }
}

async function updateUserTokens(domain, email, { accessToken, tokenExpiresAt }) {
  try {
    await tenantRef(domain).collection('users').doc(email.toLowerCase()).set(
      { accessToken, tokenExpiresAt, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    log.error('firestore: updateUserTokens failed', { domain, email, error: err.message });
  }
}

// ── Delete user data (Marketplace compliance) ──

async function deleteUser(domain, email) {
  try {
    await tenantRef(domain).collection('users').doc(email.toLowerCase()).delete();
    log.info('firestore: deleted user', { domain, email });
  } catch (err) {
    log.error('firestore: deleteUser failed', { domain, email, error: err.message });
  }
}

module.exports = {
  getTenantConfig, upsertTenantConfig,
  persistAttendance, persistCalendarData, persistExport,
  getUser, upsertUser, getUserSheetId, setUserSheetId, updateUserTokens,
  deleteUser,
};
