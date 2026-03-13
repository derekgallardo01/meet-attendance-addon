const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const app = express();
app.use(express.json());

app.use(cors({
  origin: [
    'https://derekgallardo01.github.io',
    'https://meet.google.com',
  ],
}));

// ── Secret Manager ────────────────────────────────────────────────────────────
let serviceAccountKey = null;
async function loadServiceAccountKey() {
  if (serviceAccountKey) return serviceAccountKey;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: 'projects/415551639811/secrets/meet-sa-key/versions/latest',
  });
  serviceAccountKey = JSON.parse(version.payload.data.toString());
  console.log('[Auth] Service account key loaded from Secret Manager');
  return serviceAccountKey;
}

// ── Auth — returns a raw access token via JWT + domain-wide delegation ────────
async function getAccessToken() {
  const key = await loadServiceAccountKey();
  const subject = process.env.IMPERSONATE_EMAIL || 'advertising@theyachtgroup.com';
  console.log('[Auth] Impersonating:', subject);

  const jwt = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/meetings.space.readonly'],
    subject,
  });

  const tokens = await jwt.authorize();
  console.log('[Auth] Access token obtained, type:', tokens.token_type);
  return tokens.access_token;
}

// ── Meet REST API helper — direct HTTP calls ──────────────────────────────────
async function meetGet(path, token) {
  const url = `https://meet.googleapis.com/v2/${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Meet API ${resp.status}: ${body}`);
  }
  return resp.json();
}

// ── GET /api/attendance ───────────────────────────────────────────────────────
app.get('/api/attendance', async (req, res) => {
  const { conferenceId } = req.query;
  if (!conferenceId) return res.status(400).json({ error: 'conferenceId is required' });

  try {
    const token = await getAccessToken();

    let records = [];

    // Try meeting_code filter
    try {
      const data = await meetGet(`conferenceRecords?filter=space.meeting_code%3D%22${conferenceId}%22`, token);
      records = data.conferenceRecords || [];
      console.log(`[meeting_code] found ${records.length} records`);
    } catch (e) {
      console.warn('[meeting_code] failed:', e.message);
    }

    // Fallback: space.name filter
    if (records.length === 0) {
      try {
        const spaceName = conferenceId.startsWith('spaces/') ? conferenceId : `spaces/${conferenceId}`;
        const encoded = encodeURIComponent(`space.name="${spaceName}"`);
        const data = await meetGet(`conferenceRecords?filter=${encoded}`, token);
        records = data.conferenceRecords || [];
        console.log(`[space.name] found ${records.length} records`);
      } catch (e) {
        console.warn('[space.name] failed:', e.message);
      }
    }

    if (records.length === 0) {
      return res.json({
        participants: [],
        message: 'No conference record yet — meeting may still be live. Try refreshing in 30s.',
      });
    }

    const conferenceRecord = records[records.length - 1];
    const conferenceName = conferenceRecord.name; // e.g. conferenceRecords/abc123
    console.log('Using conferenceRecord:', conferenceName);

    // List participants
    const pData = await meetGet(`${conferenceName}/participants`, token);
    const rawParticipants = pData.participants || [];
    console.log(`Found ${rawParticipants.length} participants`);

    const participants = await Promise.all(
      rawParticipants.map(async (p) => {
        const sData = await meetGet(`${p.name}/participantSessions`, token);
        const sessions = sData.participantSessions || [];

        const joinTimes  = sessions.map(s => s.startTime).filter(Boolean).map(t => new Date(t));
        const leaveTimes = sessions.map(s => s.endTime).filter(Boolean).map(t => new Date(t));

        return {
          displayName: p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
          email:     p.user?.email || p.signedinUser?.email || '',
          joinTime:  joinTimes.length  > 0 ? new Date(Math.min(...joinTimes)).toISOString()  : null,
          leaveTime: leaveTimes.length > 0 ? new Date(Math.max(...leaveTimes)).toISOString() : null,
          present:   sessions.some(s => !s.endTime),
          sessions:  sessions.length,
        };
      })
    );

    res.json({ participants });

  } catch (err) {
    console.error('Error fetching attendance:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/save-to-sheets ──────────────────────────────────────────────────
app.post('/api/save-to-sheets', async (req, res) => {
  const { meetingTitle, exportedAt, participants } = req.body;
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) return res.status(500).json({ error: 'SHEET_ID env var not set' });

  try {
    const key = await loadServiceAccountKey();
    const subject = process.env.IMPERSONATE_EMAIL || 'advertising@theyachtgroup.com';
    const sheetsAuth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      subject,
    });

    await sheetsAuth.authorize();
    const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
    const d = new Date(exportedAt);
    const tabName = `${meetingTitle || 'Meeting'} ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`.slice(0, 100);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });

    const header = ['Name', 'Email', 'Join Time', 'Leave Time', 'Duration (min)', 'Sessions', 'Status'];
    // Use timezone offset sent from client, fallback to UTC
    const tzOffset = req.body.tzOffset || 0; // minutes behind UTC
    const toLocal = (iso) => {
      if (!iso) return '';
      const d = new Date(new Date(iso).getTime() - tzOffset * 60000);
      return d.toISOString().replace('T', ' ').substring(0, 16);
    };
    const rows = participants.map(p => {
      const dur = p.joinTime
        ? Math.round((new Date(p.leaveTime || exportedAt) - new Date(p.joinTime)) / 60000)
        : '';
      return [
        p.displayName,
        p.email || '',
        toLocal(p.joinTime),
        toLocal(p.leaveTime),
        dur, p.sessions,
        p.present ? 'Present' : 'Left',
      ];
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] },
    });

    res.json({ success: true, sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}` });

  } catch (err) {
    console.error('Error saving to Sheets:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'meet-attendance-backend' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));