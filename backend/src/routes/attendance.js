const { Router } = require('express');
const { google } = require('googleapis');
const { getMeetToken, makeJWT, loadServiceAccountKey } = require('../services/googleAuth');
const { meetGet, meetGetAll } = require('../services/meetApi');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistAttendance } = require('../services/firestore');

const router = Router();

// Extract Google user ID from participant path (e.g., "conferenceRecords/.../participants/117409479685467143851")
function extractUserId(participantPath) {
  const parts = (participantPath || '').split('/');
  const id = parts[parts.length - 1];
  // Google user IDs are numeric strings; skip non-numeric (anonymous/phone participants)
  return /^\d+$/.test(id) ? id : null;
}

// Look up emails from Google Workspace Directory for participants missing emails
async function enrichEmails(participants) {
  const needsLookup = participants.filter(p => !p.email && extractUserId(p.participantId));
  log.info('enrichEmails called', { total: participants.length, needsLookup: needsLookup.length });
  if (needsLookup.length === 0) return;
  if (!CONFIG.adminEmail) {
    log.info('ADMIN_EMAIL not set, skipping directory enrichment');
    return;
  }

  try {
    // Use admin email for Directory API (requires Workspace admin privileges)
    const key = await loadServiceAccountKey();
    const dirAuth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: CONFIG.adminEmail,
    });
    await dirAuth.authorize();
    const directory = google.admin({ version: 'directory_v1', auth: dirAuth });

    await Promise.all(needsLookup.map(async (p) => {
      const userId = extractUserId(p.participantId);
      log.info('directory lookup', { userId, displayName: p.displayName });
      try {
        // Try direct user ID lookup first
        const resp = await directory.users.get({ userKey: userId });
        log.info('directory lookup result', { userId, email: resp.data.primaryEmail });
        if (resp.data.primaryEmail) {
          p.email = resp.data.primaryEmail;
        }
      } catch (e) {
        log.info('directory id lookup miss, trying name search', { userId, error: e.message });
        // Fallback: search by display name
        try {
          const searchResp = await directory.users.list({
            customer: 'my_customer',
            query: `name:'${p.displayName}'`,
            maxResults: 1,
          });
          const user = searchResp.data.users?.[0];
          if (user?.primaryEmail) {
            p.email = user.primaryEmail;
            log.info('directory name search hit', { displayName: p.displayName, email: user.primaryEmail });
          } else {
            log.info('directory name search miss', { displayName: p.displayName });
          }
        } catch (e2) {
          log.warn('directory name search failed', { displayName: p.displayName, error: e2.message });
        }
      }
    }));

    log.info('directory email enrichment', { looked: needsLookup.length, found: needsLookup.filter(p => p.email).length });
  } catch (err) {
    log.warn('directory API unavailable, skipping email enrichment', { error: err.message });
  }
}

router.get('/attendance', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { conferenceId } = req.query;
  if (!conferenceId) return res.status(400).json({ error: 'conferenceId is required' });

  try {
    const token = await getMeetToken();
    let records = [];

    try {
      const data = await meetGet(`conferenceRecords?filter=space.meeting_code%3D%22${conferenceId}%22`, token);
      records = data.conferenceRecords || [];
      log.info('records by meeting_code', { count: records.length });
    } catch (e) {
      log.warn('meeting_code filter failed', { error: e.message });
    }

    if (records.length === 0) {
      try {
        const spaceName = conferenceId.startsWith('spaces/') ? conferenceId : `spaces/${conferenceId}`;
        const encoded = encodeURIComponent(`space.name="${spaceName}"`);
        const data = await meetGet(`conferenceRecords?filter=${encoded}`, token);
        records = data.conferenceRecords || [];
        log.info('records by space.name', { count: records.length });
      } catch (e) {
        log.warn('space.name filter failed', { error: e.message });
      }
    }

    if (records.length === 0) {
      return res.json({ participants: [], message: 'No conference record yet — meeting may still be live.' });
    }

    const conferenceRecord = records[records.length - 1];
    log.info('using conference record', { name: conferenceRecord.name });

    const rawParticipants = await meetGetAll(`${conferenceRecord.name}/participants`, token, 'participants');
    log.info('participants found', { count: rawParticipants.length });

    const participants = await Promise.all(
      rawParticipants.map(async (p) => {
        const sessions = await meetGetAll(`${p.name}/participantSessions`, token, 'participantSessions');
        const joinTimes  = sessions.map(s => s.startTime).filter(Boolean).map(t => new Date(t));
        const leaveTimes = sessions.map(s => s.endTime).filter(Boolean).map(t => new Date(t));
        return {
          participantId: p.name,
          displayName:   p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
          email:         p.user?.email || p.signedinUser?.email || '',
          joinTime:      joinTimes.length  > 0 ? new Date(Math.min(...joinTimes)).toISOString()  : null,
          leaveTime:     leaveTimes.length > 0 ? new Date(Math.max(...leaveTimes)).toISOString() : null,
          present:       sessions.some(s => !s.endTime),
          sessions:      sessions.length,
        };
      })
    );

    // Enrich missing emails via Workspace Directory API
    await enrichEmails(participants);

    res.json({ participants });

    // Fire-and-forget: persist to Firestore for analytics
    persistAttendance(conferenceId, conferenceRecord.name, participants);

  } catch (err) {
    log.error('attendance fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
