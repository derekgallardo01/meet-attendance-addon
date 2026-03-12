const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Allow requests from GitHub Pages and Meet iframe
app.use(cors({
  origin: [
    'https://derekgallardo01.github.io',
    'https://meet.google.com',
  ],
}));

// ── Auth ─────────────────────────────────────────────────────────────────────
// Uses Application Default Credentials on Cloud Run (no key file needed).
// Locally: set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON.
async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  return auth.getClient();
}

// ── GET /api/attendance ───────────────────────────────────────────────────────
// Returns participants + sessions for a given conferenceId.
// Meet stores conferenceRecords keyed by conference ID.
app.get('/api/attendance', async (req, res) => {
  const { conferenceId } = req.query;

  if (!conferenceId) {
    return res.status(400).json({ error: 'conferenceId is required' });
  }

  try {
    const authClient = await getAuthClient();
    const meet = google.meet({ version: 'v2', auth: authClient });

    // 1. Find the conferenceRecord matching this conferenceId
    const recordsResp = await meet.conferenceRecords.list({
      filter: `space.meeting_code="${conferenceId}"`,
    });

    const records = recordsResp.data.conferenceRecords || [];
    if (records.length === 0) {
      // Meeting hasn't ended or conference record not available yet
      return res.json({ participants: [], message: 'No conference record found yet' });
    }

    // Use the most recent record
    const conferenceRecord = records[records.length - 1];
    const conferenceName = conferenceRecord.name; // e.g. conferenceRecords/abc123

    // 2. List participants
    const participantsResp = await meet.conferenceRecords.participants.list({
      parent: conferenceName,
    });

    const rawParticipants = participantsResp.data.participants || [];

    // 3. For each participant, get their sessions
    const participants = await Promise.all(
      rawParticipants.map(async (p) => {
        const sessionsResp = await meet.conferenceRecords.participants.participantSessions.list({
          parent: p.name,
        });

        const sessions = sessionsResp.data.participantSessions || [];

        // Determine earliest join and latest leave across all sessions
        const joinTimes = sessions
          .map(s => s.startTime)
          .filter(Boolean)
          .map(t => new Date(t));

        const leaveTimes = sessions
          .map(s => s.endTime)
          .filter(Boolean)
          .map(t => new Date(t));

        const joinTime = joinTimes.length > 0
          ? new Date(Math.min(...joinTimes)).toISOString()
          : null;

        const leaveTime = leaveTimes.length > 0
          ? new Date(Math.max(...leaveTimes)).toISOString()
          : null;

        // Still present if any session has no endTime
        const present = sessions.some(s => !s.endTime);

        return {
          displayName: p.user?.displayName || p.signedinUser?.displayName || 'Unknown',
          joinTime,
          leaveTime,
          present,
          sessions: sessions.length,
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
// Saves attendance data to a Google Sheet.
// Creates a new sheet tab named after the meeting + timestamp.
app.post('/api/save-to-sheets', async (req, res) => {
  const { meetingTitle, conferenceId, exportedAt, participants } = req.body;

  // SHEET_ID env var — set this to your Google Sheet ID
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) {
    return res.status(500).json({ error: 'SHEET_ID environment variable not set' });
  }

  try {
    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Create a new tab named after the meeting
    const tabName = `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toLocaleDateString()}`.slice(0, 100);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: tabName },
          },
        }],
      },
    });

    // Build rows: header + one row per participant
    const header = ['Name', 'Join Time', 'Leave Time', 'Duration (min)', 'Sessions', 'Status'];
    const rows = participants.map(p => {
      const dur = p.joinTime
        ? Math.round((new Date(p.leaveTime || exportedAt) - new Date(p.joinTime)) / 60000)
        : '';
      return [
        p.displayName,
        p.joinTime  ? new Date(p.joinTime).toLocaleString()  : '',
        p.leaveTime ? new Date(p.leaveTime).toLocaleString() : '',
        dur,
        p.sessions,
        p.present ? 'Present' : 'Left',
      ];
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header, ...rows] },
    });

    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    res.json({ success: true, sheetUrl });

  } catch (err) {
    console.error('Error saving to Sheets:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'meet-attendance-backend' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));