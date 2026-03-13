const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { meet: meetLib } = require('@googleapis/meet');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// Load service account key from Secret Manager at startup
let serviceAccountKey = null;
async function loadServiceAccountKey() {
  if (serviceAccountKey) return serviceAccountKey;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: 'projects/415551639811/secrets/meet-sa-key/versions/latest',
  });
  serviceAccountKey = JSON.parse(version.payload.data.toString());
  console.log('Service account key loaded from Secret Manager');
  return serviceAccountKey;
}

const app = express();
app.use(express.json());

app.use(cors({
  origin: [
    'https://derekgallardo01.github.io',
    'https://meet.google.com',
  ],
}));

async function getAuthClient() {
  const key = await loadServiceAccountKey();
  console.log('[Auth] Using service account:', key.client_email);
  console.log('[Auth] Impersonating:', process.env.IMPERSONATE_EMAIL || 'advertising@theyachtgroup.com');
  // JWT with subject enables domain-wide delegation to impersonate admin user
  const client = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    subject: process.env.IMPERSONATE_EMAIL || 'advertising@theyachtgroup.com',
  });
  try {
    const tokens = await client.authorize();
    console.log('[Auth] JWT authorized successfully, token type:', tokens.token_type);
  } catch (authErr) {
    console.error('[Auth] JWT authorize FAILED:', authErr.message);
    throw authErr;
  }
  return client;
}

// ── GET /api/attendance ───────────────────────────────────────────────────────
app.get('/api/attendance', async (req, res) => {
  const { conferenceId } = req.query;
  if (!conferenceId) return res.status(400).json({ error: 'conferenceId is required' });

  try {
    const authClient = await getAuthClient();
    const meetClient = meetLib({ version: 'v2', auth: authClient });

    let records = [];

    // Try meeting_code filter first (SDK meetingCode e.g. "cop-mmie-vug")
    try {
      const r = await meetClient.conferenceRecords.list({
        filter: `space.meeting_code="${conferenceId}"`,
      });
      records = r.data.conferenceRecords || [];
      console.log(`[meeting_code] found ${records.length} records`);
    } catch (e) {
      console.warn('[meeting_code] failed:', e.message);
    }

    // Fallback: space.name filter (SDK meetingId e.g. "spaces/Wv6f_rMi17IB")
    if (records.length === 0) {
      try {
        const spaceName = conferenceId.startsWith('spaces/') ? conferenceId : `spaces/${conferenceId}`;
        const r = await meetClient.conferenceRecords.list({
          filter: `space.name="${spaceName}"`,
        });
        records = r.data.conferenceRecords || [];
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
    const conferenceName = conferenceRecord.name;
    console.log('Using conferenceRecord:', conferenceName);

    const participantsResp = await meetClient.conferenceRecords.participants.list({
      parent: conferenceName,
    });
    const rawParticipants = participantsResp.data.participants || [];
    console.log(`Found ${rawParticipants.length} participants`);

    const participants = await Promise.all(
      rawParticipants.map(async (p) => {
        const sessionsResp = await meetClient.conferenceRecords.participants.participantSessions.list({
          parent: p.name,
        });
        const sessions = sessionsResp.data.participantSessions || [];

        const joinTimes  = sessions.map(s => s.startTime).filter(Boolean).map(t => new Date(t));
        const leaveTimes = sessions.map(s => s.endTime).filter(Boolean).map(t => new Date(t));

        return {
          displayName: p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
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
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const tabName = `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toLocaleDateString()}`.slice(0, 100);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });

    const header = ['Name', 'Join Time', 'Leave Time', 'Duration (min)', 'Sessions', 'Status'];
    const rows = participants.map(p => {
      const dur = p.joinTime
        ? Math.round((new Date(p.leaveTime || exportedAt) - new Date(p.joinTime)) / 60000)
        : '';
      return [
        p.displayName,
        p.joinTime  ? new Date(p.joinTime).toLocaleString()  : '',
        p.leaveTime ? new Date(p.leaveTime).toLocaleString() : '',
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