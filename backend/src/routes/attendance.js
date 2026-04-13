const { Router } = require('express');
const { google } = require('googleapis');
const { getMeetToken, makeJWT, loadServiceAccountKey } = require('../services/googleAuth');
const { meetGet, meetGetAll } = require('../services/meetApi');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistAttendance, getTenantConfig } = require('../services/firestore');

const router = Router();

// Extract Google user ID from participant path (e.g., "conferenceRecords/.../participants/117409479685467143851")
function extractUserId(participantPath) {
  const parts = (participantPath || '').split('/');
  const id = parts[parts.length - 1];
  // Google user IDs are numeric strings; skip non-numeric (anonymous/phone participants)
  return /^\d+$/.test(id) ? id : null;
}

// Look up emails from Google Workspace Directory for participants missing emails
async function enrichEmails(participants, adminEmail) {
  const needsLookup = participants.filter(p => !p.email && extractUserId(p.participantId));
  log.info('enrichEmails called', { total: participants.length, needsLookup: needsLookup.length });
  if (needsLookup.length === 0) return;
  const resolvedAdmin = adminEmail || CONFIG.adminEmail;
  if (!resolvedAdmin) {
    log.info('no admin email configured, skipping directory enrichment');
    return;
  }

  try {
    // Use admin email for Directory API (requires Workspace admin privileges)
    const key = await loadServiceAccountKey();
    const dirAuth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
      subject: resolvedAdmin,
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
        // User not in this Workspace directory (external/personal account) — skip name search
        // to avoid false matches (e.g., "Derek" matching the wrong Workspace user)
        log.info('directory id lookup miss — external user', { userId, displayName: p.displayName, error: e.message });
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

  // Domain authorization: skip if ALLOWED_DOMAINS=* (public SaaS mode)
  const userDomain = req.user?.domain;
  if (userDomain && CONFIG.allowedDomains[0] !== '*' && !CONFIG.allowedDomains.includes(userDomain)) {
    log.warn('domain not authorized', { domain: userDomain, conferenceId });
    return res.status(403).json({ error: 'Your organization is not authorized to use this service.' });
  }

  try {
    // Try service account first (sees all participants including external guests).
    // Fall back to user OAuth token if delegation isn't configured for this org.
    const userDomainForTenant = req.user?.domain || 'default';
    const tenantConfig = await getTenantConfig(userDomainForTenant);
    const impersonateEmail = tenantConfig?.impersonateEmail || CONFIG.impersonateEmail;

    let token;
    let usingServiceAccount = false;
    // Only use service account if the impersonation email's domain matches the user's domain.
    // A service account impersonating user@domainA cannot see meetings from domainB.
    const impersonateDomain = impersonateEmail ? impersonateEmail.split('@')[1] : null;
    const shouldTryServiceAccount = impersonateEmail && (!userDomain || userDomain === impersonateDomain);
    if (shouldTryServiceAccount) {
      try {
        token = await getMeetToken(impersonateEmail);
        usingServiceAccount = true;
        log.info('using service account for Meet API', { impersonateEmail });
      } catch (saErr) {
        log.warn('service account failed, falling back to user OAuth', { error: saErr.message });
      }
    } else if (impersonateEmail && userDomain) {
      log.info('skipping service account — domain mismatch', { userDomain, impersonateDomain });
    }
    if (!token && req.user?.accessToken) {
      token = req.user.accessToken;
      log.info('using user OAuth for Meet API', { email: req.user.email });
    }
    if (!token) {
      return res.status(401).json({ error: 'No authentication available for Meet API. Admin setup may be required.' });
    }
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

    // Fetch participant sessions in batches of 10 to avoid rate limits
    const BATCH_SIZE = 10;
    const participants = [];
    for (let i = 0; i < rawParticipants.length; i += BATCH_SIZE) {
      const batch = rawParticipants.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (p) => {
          try {
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
          } catch (err) {
            log.warn('failed to fetch sessions for participant', { name: p.name, error: err.message });
            return {
              participantId: p.name,
              displayName:   p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
              email:         p.user?.email || p.signedinUser?.email || '',
              joinTime: null, leaveTime: null, present: true, sessions: 1,
            };
          }
        })
      );
      participants.push(...batchResults);
    }

    // Enrich missing emails via Workspace Directory API
    await enrichEmails(participants, tenantConfig?.adminEmail);

    res.json({ participants, delegationConfigured: usingServiceAccount });

    // Fire-and-forget: persist to Firestore for analytics
    const domain = req.user?.domain || 'default';
    persistAttendance(domain, conferenceId, conferenceRecord.name, participants);

  } catch (err) {
    log.error('attendance fetch failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch attendance data.' });
  }
});

module.exports = router;
