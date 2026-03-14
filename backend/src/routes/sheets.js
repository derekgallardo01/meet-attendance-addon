const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT, makeUserClient } = require('../services/googleAuth');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistExport, getUserSheetId, setUserSheetId } = require('../services/firestore');

const router = Router();

// Prevent formula injection — cells starting with =, +, -, @, tab, CR can execute formulas
function sanitizeCell(val) {
  if (typeof val !== 'string') return val;
  if (/^[=+\-@\t\r]/.test(val)) return "'" + val;
  return val;
}

// Google Sheets tab names cannot contain these characters
function sanitizeTabName(name) {
  return name
    .replace(/[\[\]*?/\\]/g, '-')  // Replace forbidden chars with dash
    .replace(/^'|'$/g, '')         // Cannot start or end with apostrophe
    .slice(0, 100)                 // Google Sheets limit
    || 'Meeting';                  // Fallback if empty after sanitization
}

function fmtRsvp(status) {
  switch (status) {
    case 'accepted':    return 'Accepted';
    case 'declined':    return 'Declined';
    case 'tentative':   return 'Tentative';
    case 'needsAction': return 'No Response';
    default:            return '';
  }
}

router.post('/save-to-sheets', async (req, res) => {
  const { meetingTitle, tabName: clientTabName, exportedAt, participants, calendarAttendees = [], meetingStartTime, conferenceId } = req.body;
  if (!participants?.length) return res.status(400).json({ error: 'participants array is required' });

  try {
    // Use user's OAuth token if available, otherwise fall back to service account
    const sheetsAuth = req.user
      ? makeUserClient(req.user.accessToken)
      : await makeJWT(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

    // Resolve spreadsheet ID: per-user sheet (OAuth) or shared sheet (legacy)
    let spreadsheetId;
    if (req.user) {
      spreadsheetId = await getUserSheetId(req.user.email);
      if (!spreadsheetId) {
        // First export: create a new spreadsheet in the user's Drive
        const createResp = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: 'Meet Attendance Tracker' },
            sheets: [{ properties: { title: 'Info' } }],
          },
        });
        spreadsheetId = createResp.data.spreadsheetId;
        await setUserSheetId(req.user.email, spreadsheetId);
        log.info('created user spreadsheet', { email: req.user.email, spreadsheetId });
      }
    } else {
      spreadsheetId = CONFIG.sheetId;
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Sign in required to export (no shared sheet configured)' });
      }
    }

    let tabName = sanitizeTabName(clientTabName || `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toISOString()}`);

    // Handle duplicate tab names by appending a counter
    let sheetId = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const tryName = attempt === 0 ? tabName : `${tabName} (${attempt + 1})`;
        const addResp = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tryName } } }] },
        });
        tabName = tryName;
        sheetId = addResp.data.replies[0].addSheet.properties.sheetId;
        break;
      } catch (e) {
        if (e.message?.includes('already exists') && attempt < 4) continue;
        throw e;
      }
    }

    // Meeting duration for attendance % calculation
    const joinTimes = participants.map(p => p.joinTimeISO).filter(Boolean).map(t => new Date(t));
    const meetStart = meetingStartTime ? new Date(meetingStartTime) : (joinTimes.length ? new Date(Math.min(...joinTimes)) : null);
    const meetEnd = new Date(exportedAt);
    const meetDurationMin = meetStart ? Math.round((meetEnd - meetStart) / 60000) : 0;

    // RSVP lookup from calendar attendees
    const rsvpMap = {};
    for (const a of calendarAttendees) {
      rsvpMap[a.email.toLowerCase()] = a.status;
    }

    // Format helpers — display in US Eastern time
    const fmtET = (iso) => {
      if (!iso) return '';
      return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
    };
    const fmtDate = iso => iso ? fmtET(iso) : '';
    const totalInvited = calendarAttendees.length || participants.length;
    const totalAttended = participants.length;
    const attendanceRate = totalInvited > 0 ? Math.round((totalAttended / totalInvited) * 100) + '%' : 'N/A';

    const summary = [
      ['Meeting', meetingTitle || 'Google Meet'],
      ['Meeting ID', conferenceId || 'N/A'],
      ['Date', fmtDate(meetingStartTime || exportedAt)],
      ['Duration (min)', meetStart ? (meetDurationMin || '< 1') : 'N/A'],
      ['Total Invited', totalInvited],
      ['Total Attended', totalAttended],
      ['Attendance Rate', attendanceRate],
      [],
    ];

    // Build participant rows
    const header = ['Name', 'Email', 'RSVP Status', 'Join Time (ET)', 'Leave Time (ET)', 'Duration (min)', 'Attendance %', 'Sessions', 'Status'];

    const attendedEmails = new Set();
    const attendedNames = new Set();
    const rows = participants.map(p => {
      const email = (p.email || '').toLowerCase();
      if (email) attendedEmails.add(email);
      const name = (p.displayName || '').toLowerCase().trim();
      if (name) attendedNames.add(name);
      const durRaw = p.joinTimeISO
        ? Math.round((new Date(p.leaveTimeISO || exportedAt) - new Date(p.joinTimeISO)) / 60000)
        : '';
      const dur = (durRaw === 0 && p.present) ? '< 1' : durRaw;
      const pct = (durRaw !== '' && meetDurationMin > 0)
        ? Math.min(100, Math.round((durRaw / meetDurationMin) * 100)) + '%'
        : (p.present ? '100%' : '');
      return [sanitizeCell(p.displayName), sanitizeCell(p.email || ''), fmtRsvp(rsvpMap[email]), fmtET(p.joinTimeISO), fmtET(p.leaveTimeISO), dur, pct, p.sessions, p.present ? 'Present' : 'Left'];
    });

    // Fix 2: Also capture emails from rows (includes manual overrides from frontend)
    rows.forEach(row => {
      const email = (row[1] || '').toLowerCase();
      if (email) attendedEmails.add(email);
    });

    // No-shows: calendar invitees who never joined (check email AND name)
    const noShows = calendarAttendees
      .filter(a => {
        if (attendedEmails.has(a.email.toLowerCase())) return false;
        const aName = (a.displayName || '').toLowerCase().trim();
        if (attendedNames.has(aName)) return false;
        // First-name match as fallback (handles different email, same person)
        const aFirst = aName.split(' ')[0];
        if (aFirst) {
          for (const name of attendedNames) {
            if (name.split(' ')[0] === aFirst) return false;
          }
        }
        return true;
      })
      .map(a => [sanitizeCell(a.displayName), sanitizeCell(a.email), fmtRsvp(a.status), '', '', '', '0%', 0, 'Absent']);

    const allRows = [...rows, ...noShows];

    const allValues = [...summary, header, ...allRows];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: allValues },
    });

    // Format the sheet: bold summary labels & header row, auto-resize columns
    const headerRowIndex = summary.length; // 0-based row index of the header
    const formatRequests = [
      // Bold summary labels (column A, rows 0 to summary.length-1)
      { repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: summary.length - 1, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      }},
      // Bold + background on header row
      { repeatCell: {
        range: { sheetId, startRowIndex: headerRowIndex, endRowIndex: headerRowIndex + 1, startColumnIndex: 0, endColumnIndex: header.length },
        cell: { userEnteredFormat: {
          textFormat: { bold: true },
          backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
        }},
        fields: 'userEnteredFormat(textFormat.bold,backgroundColor)',
      }},
      // Freeze header row
      { updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: headerRowIndex + 1 } },
        fields: 'gridProperties.frozenRowCount',
      }},
      // Auto-resize all columns
      { autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: header.length },
      }},
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: formatRequests },
    });

    log.info('exported to sheets', { tabName, rows: allRows.length, noShows: noShows.length });
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;
    res.json({ success: true, sheetUrl });

    // Fire-and-forget: audit trail for exports
    persistExport({
      meetingTitle: meetingTitle || 'Unknown',
      tabName,
      exportedAt,
      participantCount: allRows.length,
      sheetUrl,
    });

  } catch (err) {
    log.error('sheets export failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
