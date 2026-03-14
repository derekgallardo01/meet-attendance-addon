const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT } = require('../services/googleAuth');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistExport } = require('../services/firestore');

const router = Router();

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
  const { meetingTitle, tabName: clientTabName, exportedAt, participants, calendarAttendees = [], meetingStartTime } = req.body;
  if (!participants?.length) return res.status(400).json({ error: 'participants array is required' });

  try {
    const sheetsAuth = await makeJWT(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
    let tabName = sanitizeTabName(clientTabName || `${meetingTitle || 'Meeting'} ${new Date(exportedAt).toISOString()}`);

    // Handle duplicate tab names by appending a counter
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const tryName = attempt === 0 ? tabName : `${tabName} (${attempt + 1})`;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: CONFIG.sheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tryName } } }] },
        });
        tabName = tryName;
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

    // Summary rows at top of sheet
    const fmtDate = iso => iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : '';
    const totalInvited = calendarAttendees.length || participants.length;
    const totalAttended = participants.length;
    const attendanceRate = totalInvited > 0 ? Math.round((totalAttended / totalInvited) * 100) + '%' : 'N/A';

    const summary = [
      ['Meeting', meetingTitle || 'Google Meet'],
      ['Date', fmtDate(meetingStartTime || exportedAt)],
      ['Duration (min)', meetDurationMin || 'N/A'],
      ['Total Invited', totalInvited],
      ['Total Attended', totalAttended],
      ['Attendance Rate', attendanceRate],
      [],
    ];

    // Build participant rows
    const header = ['Name', 'Email', 'RSVP Status', 'Join Time (UTC)', 'Leave Time (UTC)', 'Duration (min)', 'Attendance %', 'Sessions', 'Status'];
    const fmtUTC = iso => iso ? iso.replace('T', ' ').substring(0, 16) + ' UTC' : '';

    const attendedEmails = new Set();
    const rows = participants.map(p => {
      const email = (p.email || '').toLowerCase();
      if (email) attendedEmails.add(email);
      const dur = p.joinTimeISO
        ? Math.round((new Date(p.leaveTimeISO || exportedAt) - new Date(p.joinTimeISO)) / 60000)
        : '';
      const pct = (dur !== '' && meetDurationMin > 0)
        ? Math.min(100, Math.round((dur / meetDurationMin) * 100)) + '%'
        : '';
      return [p.displayName, p.email || '', fmtRsvp(rsvpMap[email]), fmtUTC(p.joinTimeISO), fmtUTC(p.leaveTimeISO), dur, pct, p.sessions, p.present ? 'Present' : 'Left'];
    });

    // No-shows: calendar invitees who never joined
    const noShows = calendarAttendees
      .filter(a => !attendedEmails.has(a.email.toLowerCase()))
      .map(a => [a.displayName, a.email, fmtRsvp(a.status), '', '', '', '0%', 0, 'Absent']);

    const allRows = [...rows, ...noShows];

    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.sheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [...summary, header, ...allRows] },
    });

    log.info('exported to sheets', { tabName, rows: allRows.length, noShows: noShows.length });
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}`;
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
