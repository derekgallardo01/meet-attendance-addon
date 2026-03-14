const { Firestore, FieldValue } = require('@google-cloud/firestore');
const CONFIG = require('../config');
const log = require('../lib/logger');

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

module.exports = { persistAttendance, persistCalendarData, persistExport };
