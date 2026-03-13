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
  const { meetingTitle, tabName: clientTabName, exportedAt, participants } = req.body;
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
    // Use pre-formatted tab name from client (already in local timezone)
    const tabName = (clientTabName || `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toISOString()}`).slice(0, 100);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });

    const header = ['Name', 'Email', 'Join Time (UTC)', 'Leave Time (UTC)', 'Duration (min)', 'Sessions', 'Status'];
    const fmtUTC = (iso) => iso ? iso.replace('T', ' ').substring(0, 16) + ' UTC' : '';
    const rows = participants.map(p => {
      const dur = p.joinTimeISO
        ? Math.round((new Date(p.leaveTimeISO || exportedAt) - new Date(p.joinTimeISO)) / 60000)
        : '';
      return [
        p.displayName,
        p.email || '',
        fmtUTC(p.joinTimeISO),
        fmtUTC(p.leaveTimeISO),
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


// ── GET /api/calendar-attendees ───────────────────────────────────────────────
// Searches Google Calendar for an event matching the meeting code
// Returns attendee list with name + email
app.get('/api/calendar-attendees', async (req, res) => {
  const { meetingCode } = req.query;
  if (!meetingCode) return res.status(400).json({ error: 'meetingCode is required' });

  try {
    const key = await loadServiceAccountKey();
    const subject = process.env.IMPERSONATE_EMAIL || 'advertising@theyachtgroup.com';

    const calAuth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      subject,
    });
    await calAuth.authorize();
    const calendar = google.calendar({ version: 'v3', auth: calAuth });

    // Search events from 30 days ago to 7 days from now
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 7  * 24 * 60 * 60 * 1000).toISOString();

    const eventsResp = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults: 100,
      q: meetingCode, // search for the meeting code in event text
    });

    const events = eventsResp.data.items || [];
    console.log(`[Calendar] found ${events.length} events matching "${meetingCode}"`);

    // Find event whose Meet link contains the meeting code
    const matchedEvent = events.find(e => {
      const meetLink = e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '';
      const hangoutLink = e.hangoutLink || '';
      return meetLink.includes(meetingCode) || hangoutLink.includes(meetingCode);
    });

    if (!matchedEvent) {
      console.log('[Calendar] No matching event found — instant meeting');
      return res.json({ attendees: [], isScheduled: false });
    }

    console.log('[Calendar] Matched event:', matchedEvent.summary);

    const attendees = (matchedEvent.attendees || [])
      .filter(a => !a.resource) // exclude rooms/resources
      .map(a => ({
        email:       a.email,
        displayName: a.displayName || a.email.split('@')[0],
        status:      a.responseStatus, // accepted, declined, tentative, needsAction
      }));

    res.json({
      isScheduled: true,
      eventTitle:  matchedEvent.summary || 'Scheduled Meeting',
      attendees,
    });

  } catch (err) {
    console.error('[Calendar] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'meet-attendance-backend' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));