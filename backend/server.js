const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const app = express();
app.use(express.json());

// ── Config — all from env vars, no hardcoding ─────────────────────────────────
const required = (name) => {
  const val = process.env[name];
  if (!val) { console.error(`FATAL: ${name} env var not set`); process.exit(1); }
  return val;
};
const CONFIG = {
  impersonateEmail: required('IMPERSONATE_EMAIL'),
  sheetId:          required('SHEET_ID'),
  secretName:       required('SECRET_NAME'),
  allowedOrigins:  (process.env.ALLOWED_ORIGINS || 'https://derekgallardo01.github.io,https://meet.google.com').split(','),
  port:             process.env.PORT || 8080,
};

app.use(cors({ origin: CONFIG.allowedOrigins }));

// ── Structured logger ─────────────────────────────────────────────────────────
const log = {
  info:  (msg, data = {}) => console.log(JSON.stringify({ severity: 'INFO',    msg, ...data, ts: new Date().toISOString() })),
  warn:  (msg, data = {}) => console.warn(JSON.stringify({ severity: 'WARNING', msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data = {}) => console.error(JSON.stringify({ severity: 'ERROR',  msg, ...data, ts: new Date().toISOString() })),
};

// ── Secret Manager ────────────────────────────────────────────────────────────
let serviceAccountKey = null;
async function loadServiceAccountKey() {
  if (serviceAccountKey) return serviceAccountKey;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: `${CONFIG.secretName}/versions/latest` });
  serviceAccountKey = JSON.parse(version.payload.data.toString());
  log.info('service account key loaded');
  return serviceAccountKey;
}

// ── Auth helper — returns an authorized JWT client ────────────────────────────
async function makeJWT(scopes) {
  const key = await loadServiceAccountKey();
  const jwt = new google.auth.JWT({
    email:   key.client_email,
    key:     key.private_key,
    scopes,
    subject: CONFIG.impersonateEmail,
  });
  await jwt.authorize();
  return jwt;
}

async function getMeetToken() {
  const jwt = await makeJWT(['https://www.googleapis.com/auth/meetings.space.readonly']);
  const tokens = await jwt.authorize();
  return tokens.access_token;
}

// ── Meet REST API helper with retry ──────────────────────────────────────────
async function meetGet(path, token, retries = 2) {
  const url = `https://meet.googleapis.com/v2/${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) return resp.json();
    const body = await resp.text();
    if (resp.status >= 500 && attempt < retries) {
      log.warn('meet api transient error, retrying', { status: resp.status, attempt });
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`Meet API ${resp.status}: ${body}`);
  }
}

// ── GET /api/attendance ───────────────────────────────────────────────────────
app.get('/api/attendance', async (req, res) => {
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

    const pData = await meetGet(`${conferenceRecord.name}/participants`, token);
    const rawParticipants = pData.participants || [];
    log.info('participants found', { count: rawParticipants.length });

    const participants = await Promise.all(
      rawParticipants.map(async (p) => {
        const sData = await meetGet(`${p.name}/participantSessions`, token);
        const sessions = sData.participantSessions || [];
        const joinTimes  = sessions.map(s => s.startTime).filter(Boolean).map(t => new Date(t));
        const leaveTimes = sessions.map(s => s.endTime).filter(Boolean).map(t => new Date(t));
        return {
          displayName: p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
          email:       p.user?.email || p.signedinUser?.email || '',
          joinTime:    joinTimes.length  > 0 ? new Date(Math.min(...joinTimes)).toISOString()  : null,
          leaveTime:   leaveTimes.length > 0 ? new Date(Math.max(...leaveTimes)).toISOString() : null,
          present:     sessions.some(s => !s.endTime),
          sessions:    sessions.length,
        };
      })
    );

    res.json({ participants });

  } catch (err) {
    log.error('attendance fetch failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/save-to-sheets ──────────────────────────────────────────────────
app.post('/api/save-to-sheets', async (req, res) => {
  const { meetingTitle, tabName: clientTabName, exportedAt, participants } = req.body;
  if (!participants?.length) return res.status(400).json({ error: 'participants array is required' });

  try {
    const sheetsAuth = await makeJWT(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
    const tabName = (clientTabName || `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toISOString()}`).slice(0, 100);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: CONFIG.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });

    const header = ['Name', 'Email', 'Join Time (UTC)', 'Leave Time (UTC)', 'Duration (min)', 'Sessions', 'Status'];
    const fmtUTC = iso => iso ? iso.replace('T', ' ').substring(0, 16) + ' UTC' : '';
    const rows = participants.map(p => {
      const dur = p.joinTimeISO
        ? Math.round((new Date(p.leaveTimeISO || exportedAt) - new Date(p.joinTimeISO)) / 60000)
        : '';
      return [p.displayName, p.email || '', fmtUTC(p.joinTimeISO), fmtUTC(p.leaveTimeISO), dur, p.sessions, p.present ? 'Present' : 'Left'];
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] },
    });

    log.info('exported to sheets', { tabName, rows: rows.length });
    res.json({ success: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}` });

  } catch (err) {
    log.error('sheets export failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/calendar-attendees ───────────────────────────────────────────────
app.get('/api/calendar-attendees', async (req, res) => {
  const { meetingCode } = req.query;
  if (!meetingCode) return res.status(400).json({ error: 'meetingCode is required' });

  try {
    const calAuth = await makeJWT(['https://www.googleapis.com/auth/calendar.readonly']);
    const calendar = google.calendar({ version: 'v3', auth: calAuth });

    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() +  7 * 24 * 60 * 60 * 1000).toISOString();

    const eventsResp = await calendar.events.list({
      calendarId:   'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults:   250,
    });

    const events = eventsResp.data.items || [];
    log.info('calendar events scanned', { count: events.length, meetingCode });

    const matchedEvent = events.find(e => {
      const meetLink    = e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '';
      const hangoutLink = e.hangoutLink || '';
      return meetLink.includes(meetingCode) || hangoutLink.includes(meetingCode);
    });

    if (!matchedEvent) {
      log.info('no calendar event matched — instant meeting', { meetingCode });
      return res.json({ attendees: [], isScheduled: false });
    }

    log.info('calendar event matched', { title: matchedEvent.summary });

    const attendees = (matchedEvent.attendees || [])
      .filter(a => !a.resource)
      .map(a => ({
        email:       a.email,
        displayName: a.displayName || a.email.split('@')[0],
        status:      a.responseStatus,
      }));

    res.json({ isScheduled: true, eventTitle: matchedEvent.summary || 'Scheduled Meeting', attendees });

  } catch (err) {
    log.error('calendar lookup failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'meet-attendance-backend', ts: new Date().toISOString() }));

app.listen(CONFIG.port, () => log.info('server started', { port: CONFIG.port }));