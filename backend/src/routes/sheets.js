const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT } = require('../services/googleAuth');
const CONFIG = require('../config');
const log = require('../lib/logger');

const router = Router();

// Google Sheets tab names cannot contain these characters
function sanitizeTabName(name) {
  return name
    .replace(/[\[\]*?/\\]/g, '-')  // Replace forbidden chars with dash
    .replace(/^'|'$/g, '')         // Cannot start or end with apostrophe
    .slice(0, 100)                 // Google Sheets limit
    || 'Meeting';                  // Fallback if empty after sanitization
}

router.post('/save-to-sheets', async (req, res) => {
  const { meetingTitle, tabName: clientTabName, exportedAt, participants } = req.body;
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
      range: `'${tabName}'!A1`,
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

module.exports = router;
