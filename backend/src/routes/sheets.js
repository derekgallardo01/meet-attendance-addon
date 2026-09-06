const { Router } = require('express');
const { google } = require('googleapis');
const { getGoogleClient } = require('../services/googleAuth');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistExport, getUserSheetId, setUserSheetId, countUserExports, countUserMonthlyExports, getMeetingExcusedEmails, addMeetingExcusedEmails, getUserSettings, getUserMeetingSeries } = require('../services/firestore');
const { sendExportNotification, sendSlackDigest } = require('../lib/notifications');
const { planIsPro } = require('./billing');

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

// ── Digest row shaping ──
// The Slack post-export digest and the email digest both turn the raw
// participant + calendar-invitee lists into the same {displayName, email,
// status, durationMin} shape. Extracted so the two callers can't drift.

// Minutes a participant was actually in the meeting (0 if they never joined).
function digestDurationMin(p, fallbackEnd) {
  return p.joinTimeISO
    ? Math.round((new Date(p.leaveTimeISO || fallbackEnd) - new Date(p.joinTimeISO)) / 60000)
    : 0;
}

// The people who showed up. The email digest also wants a lateMin column;
// Slack omits it, so it's opt-in via lateMinFor.
function digestPresentRows(participants, fallbackEnd, lateMinFor) {
  return participants.map(p => {
    const row = {
      displayName: p.displayName,
      email: p.email || '',
      status: p.present ? 'Present' : (p.leaveTimeISO ? 'Left' : 'Present'),
      durationMin: digestDurationMin(p, fallbackEnd),
    };
    if (lateMinFor) row.lateMin = lateMinFor(p.joinTimeISO);
    return row;
  });
}

// Count how many invitees share each (lowercased) display name — used to decide
// when a name-match is trustworthy (unique name) vs ambiguous (Sweep-4).
function countInviteeNames(calendarAttendees) {
  const counts = {};
  for (const a of calendarAttendees || []) {
    const n = (a.displayName || '').toLowerCase().trim();
    if (n) counts[n] = (counts[n] || 0) + 1;
  }
  return counts;
}

// The calendar invitees who never attended → Absent (or Excused) rows.
// A name-match only counts when the name is UNIQUE among invitees (see the
// main no-show filter / Sweep-4) — otherwise a different same-named person's
// attendance would hide a real absence.
function digestAbsentRows(calendarAttendees, { attendedEmails, attendedNames, excusedSet, inviteeNameCounts }) {
  const nameCounts = inviteeNameCounts || countInviteeNames(calendarAttendees);
  return calendarAttendees
    .filter(a => {
      if (attendedEmails.has((a.email || '').toLowerCase())) return false;
      const n = (a.displayName || '').toLowerCase().trim();
      if (n && nameCounts[n] === 1 && attendedNames.has(n)) return false;
      return true;
    })
    .map(a => ({
      displayName: a.displayName,
      email: a.email,
      status: excusedSet.has((a.email || '').toLowerCase()) ? 'Excused' : 'Absent',
      durationMin: 0,
    }));
}

// Cumulative "Class Summary" values for a recurring series — the per-person
// attendance across ALL sessions (the education/teacher view a single-meeting
// export can't give). Pure: takes a series object from getUserMeetingSeries plus
// an ISO "generated" timestamp, returns the 2D values for the summary tab.
function buildClassSummaryValues(series, generatedAtIso) {
  const range = (series.firstAt && series.lastAt)
    ? `${series.firstAt.slice(0, 10)} – ${series.lastAt.slice(0, 10)}`
    : '';
  const summary = [
    ['Class', series.title || 'Recurring meeting'],
    ['Sessions', series.instanceCount],
    ['Unique people', series.uniquePeople],
    ...(range ? [['Date range', range]] : []),
    ['Generated', generatedAtIso],
    [],
  ];
  const header = ['Name', 'Email', 'Sessions Attended', 'Total Sessions', 'Attendance %', 'Total Time (min)'];
  const rows = (series.people || []).map(p => [
    sanitizeCell(p.displayName),
    sanitizeCell(p.email || ''),
    p.attended,
    series.instanceCount,
    Math.round((p.attendanceRate || 0) * 100) + '%',
    p.totalMinutes || 0,
  ]);
  return [...summary, header, ...rows];
}

// Free-plan preview of the cumulative class report. Instead of silently dropping
// the Pro "Class Summary" tab for a free user, we add this compact teaser to the
// exported sheet so the value — and the upgrade path — is visible right where the
// teacher already looks, at the moment they feel the need for it.
function buildClassSummaryTeaserValues(series) {
  // Caller guarantees instanceCount >= 2; uniquePeople comes straight from the
  // series aggregation — no defensive fallbacks needed (keeps branches tight).
  const people = series.uniquePeople;
  return [
    [`Class Summary — ${series.title || 'Recurring class'}`],
    [`This class has met ${series.instanceCount} times with ${people} ${people === 1 ? 'person' : 'people'} so far.`],
    [],
    ['⭐ Attendance Tracker Pro adds a cumulative per-student summary right here:'],
    ['    • Attendance % for each student across every session'],
    ['    • Sessions attended vs. total held, per person'],
    ['    • Who is trending down — before they disappear'],
    [],
    ['You are on the free plan, so this tab shows just this preview.'],
    ['Unlock the full class report for all your classes:'],
    ['https://attendancetracker.dev/pricing'],
  ];
}

// Build the attendance sheet + all its side effects (audit trail, excused
// persist, Slack + email digests) for one export. Extracted from the
// /save-to-sheets route so the auto-capture sweep can reuse the exact same
// export pipeline.
//   user:       { domain, email, displayName } | null  (legacy shared-sheet)
//   sheetsAuth: an authorized Google API client (OAuth or service account)
//   data:       meeting + participants payload (same shape as the request body)
//   options:    { sendEmail, autoExport, proAllowed } — proAllowed gates the
//               Slack/email digests; the caller enforces the auto-export paywall.
// Returns { sheetUrl, isFirstExport }; throws with err.status=400 (legacy
// no-sheet) or err.exportCode='DRIVE_PERMISSION_MISSING' for the route to map.
async function buildAndSaveExport({ user, sheetsAuth, data, options }) {
  // Shim so the extracted body's existing `req.user` reads work unchanged.
  const req = { user };
  const { meetingTitle, tabName: clientTabName, exportedAt, participants, calendarAttendees = [], meetingStartTime, meetingType, eventStart, eventEnd, conferenceId, timezone, recurringEventId, excusedFromClient = [] } = data;
  const { sendEmail, autoExport, proAllowed } = options;
  const sheets = google.sheets({ version: 'v4', auth: sheetsAuth });

  try {

    // Resolve spreadsheet ID: per-user sheet (OAuth) or shared sheet (legacy)
    let spreadsheetId;
    if (req.user) {
      spreadsheetId = await getUserSheetId(req.user.domain, req.user.email);

      // Verify the stored spreadsheet still exists (user may have deleted it)
      if (spreadsheetId) {
        try {
          await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId' });
        } catch (e) {
          log.warn('stored spreadsheet not found, creating new one', { email: req.user.email, spreadsheetId });
          spreadsheetId = null;
          await setUserSheetId(req.user.domain, req.user.email, null);
        }
      }

      if (!spreadsheetId) {
        // First export: create folder + spreadsheet in user's Drive
        const drive = google.drive({ version: 'v3', auth: sheetsAuth });

        // Find or create "Meet Attendance Tracker" folder
        let folderId;
        const folderSearch = await drive.files.list({
          q: "name='Meet Attendance Tracker' and mimeType='application/vnd.google-apps.folder' and trashed=false",
          fields: 'files(id)',
          spaces: 'drive',
        });
        if (folderSearch.data.files?.length > 0) {
          folderId = folderSearch.data.files[0].id;
        } else {
          const folderResp = await drive.files.create({
            requestBody: {
              name: 'Meet Attendance Tracker',
              mimeType: 'application/vnd.google-apps.folder',
            },
            fields: 'id',
          });
          folderId = folderResp.data.id;
          log.info('created Drive folder', { email: req.user.email, folderId });
        }

        // Create spreadsheet
        const createResp = await sheets.spreadsheets.create({
          requestBody: {
            properties: { title: 'Meet Attendance Tracker' },
            sheets: [{ properties: { title: 'Info' } }],
          },
        });
        spreadsheetId = createResp.data.spreadsheetId;

        // Move spreadsheet into the folder
        const file = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: folderId,
          removeParents: (file.data.parents || []).join(','),
          fields: 'id, parents',
        });

        await setUserSheetId(req.user.domain, req.user.email, spreadsheetId);
        log.info('created user spreadsheet in folder', { email: req.user.email, spreadsheetId, folderId });
      }
    } else {
      spreadsheetId = CONFIG.sheetId;
      if (!spreadsheetId) {
        throw Object.assign(new Error('Sign in required to export (no shared sheet configured)'), { status: 400 });
      }
    }

    // Load the union of previously-tagged and just-checked excused emails so
    // the sheet shows "Absent (excused)" consistently across re-exports.
    // Cheap single-doc read; on no auth (legacy shared-sheet path) we skip.
    const domain = req.user?.domain || 'default';
    const persistedExcused = req.user ? await getMeetingExcusedEmails(domain, conferenceId) : [];
    const excusedSet = new Set([
      ...persistedExcused,
      // excusedFromClient is destructured with a [] default, so it's always an
      // array here — the `|| []` is defensive-only.
      ...(/* istanbul ignore next */ (excusedFromClient || [])).map(e => (e || '').toLowerCase()),
    ]);

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
      rsvpMap[(a.email || '').toLowerCase()] = a.status;
    }

    // Format helpers — display in user's timezone (falls back to US Eastern)
    const tz = timezone || 'America/New_York';
    const tzAbbr = (() => { try {
      return new Date().toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
    } catch { return 'ET'; } })();
    const fmtTime = (iso) => {
      if (!iso) return '';
      return new Date(iso).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) + ' ' + tzAbbr;
    };
    /* istanbul ignore next: only ever called with meetingStartTime||exportedAt (always truthy) */
    const fmtDate = iso => iso ? fmtTime(iso) : '';
    const totalInvited = calendarAttendees.length || participants.length;
    const totalAttended = participants.length;
    // participants is guaranteed non-empty (validated at the top), so
    // totalInvited is always >= 1 — the 'N/A' fallback is defensive-only.
    /* istanbul ignore next */
    // Cap at 100%: with forwarded invites there can be more attendees than
    // invitees, which otherwise prints a nonsensical ">100%" summary rate.
    const attendanceRate = totalInvited > 0 ? Math.min(100, Math.round((totalAttended / totalInvited) * 100)) + '%' : 'N/A';

    // Format scheduled time range
    const fmtTimeOnly = (iso) => {
      /* istanbul ignore next: only called when eventStart && eventEnd are truthy */
      if (!iso) return '';
      return new Date(iso).toLocaleString('en-US', { timeZone: tz, timeStyle: 'short' }) + ' ' + tzAbbr;
    };
    const scheduledRange = eventStart && eventEnd
      ? `${fmtTimeOnly(eventStart)} – ${fmtTimeOnly(eventEnd)}`
      : null;

    const summary = [
      ['Meeting', meetingTitle || 'Google Meet'],
      ['Meeting ID', conferenceId || 'N/A'],
      ['Type', meetingType === 'scheduled' ? 'Scheduled Event' : 'Instant Meeting'],
      ...(scheduledRange ? [['Scheduled Time', scheduledRange]] : []),
      ['Date', fmtDate(meetingStartTime || exportedAt)],
      ['Duration (min)', meetStart ? (meetDurationMin || '< 1') : 'N/A'],
      ['Total Invited', totalInvited],
      ['Total Attended', totalAttended],
      ['Attendance Rate', attendanceRate],
      [],
    ];

    // Build participant rows.
    // Late? column flags anyone who joined more than LATE_THRESHOLD_MIN past
    // the meeting's true start. Baseline is calendar start when scheduled,
    // else the actual Meet conference start — matches the in-panel chip.
    const LATE_THRESHOLD_MIN = 5;
    const lateBaselineMs = eventStart
      ? new Date(eventStart).getTime()
      : (meetingStartTime ? new Date(meetingStartTime).getTime() : 0);
    const lateMinFor = (joinIso) => {
      if (!lateBaselineMs || !joinIso) return 0;
      const diff = Math.round((new Date(joinIso).getTime() - lateBaselineMs) / 60000);
      return diff > LATE_THRESHOLD_MIN ? diff : 0;
    };

    const header = ['Name', 'Email', 'RSVP Status', 'Late?', `Join Time (${tzAbbr})`, `Leave Time (${tzAbbr})`, 'Duration (min)', 'Attendance %', 'Sessions', 'Status'];

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
      const lateMin = lateMinFor(p.joinTimeISO);
      const lateCell = lateMin > 0 ? `+${lateMin}m` : '';
      return [sanitizeCell(p.displayName), sanitizeCell(p.email || ''), fmtRsvp(rsvpMap[email]), lateCell, fmtTime(p.joinTimeISO), fmtTime(p.leaveTimeISO), dur, pct, p.sessions, p.present ? 'Present' : 'Left'];
    });

    // Fix 2: Also capture emails from rows (includes manual overrides from frontend)
    rows.forEach(row => {
      const email = (row[1] || '').toLowerCase();
      if (email) attendedEmails.add(email);
    });

    // No-shows: calendar invitees who never joined (check email AND exact full name)
    // First-name fallback removed — too many false matches with common names.
    // Directory API email enrichment handles the different-email-same-person case now.
    // Name-match only when the name is UNIQUE among invitees — otherwise a
    // different same-named attendee would wrongly hide a real absence (Sweep-4).
    const inviteeNameCounts = countInviteeNames(calendarAttendees);
    const noShows = calendarAttendees
      .filter(a => {
        if (attendedEmails.has((a.email || '').toLowerCase())) return false;
        const aName = (a.displayName || '').toLowerCase().trim();
        if (aName && inviteeNameCounts[aName] === 1 && attendedNames.has(aName)) return false;
        return true;
      })
      .map(a => {
        const status = excusedSet.has((a.email || '').toLowerCase()) ? 'Absent (excused)' : 'Absent';
        return [sanitizeCell(a.displayName), sanitizeCell(a.email), fmtRsvp(a.status), '', '', '', '', '0%', 0, status];
      });

    const allRows = [...rows, ...noShows];

    const footer = [
      [],
      ['Tracked automatically with Attendance Tracker for Google Meet · https://attendancetracker.dev'],
    ];

    const allValues = [...summary, header, ...allRows, ...footer];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: allValues },
    });

    // Cumulative "Class Summary" tab for a recurring series — per-person
    // attendance across every session (the teacher/education view). For Pro users
    // this is the real cross-session report (the individual-Pro hook: gated by
    // planIsPro(domain, EMAIL) so a personal-Gmail user's own plan is checked for
    // per-user billing, while the org tier uses the domain plan). For FREE users
    // we still add a compact "Class Summary (Pro)" preview tab showing what Pro
    // unlocks + an upgrade link — so the shared sheet itself surfaces the paywall
    // at the moment of value, instead of silently dropping the feature.
    // Best-effort (never fails the export). Only for series with 2+ instances.
    if (recurringEventId && req.user) {
      try {
        const { series } = await getUserMeetingSeries(req.user.domain, req.user.email);
        const match = (series || []).find(s => s.recurringEventId === recurringEventId);
        if (match && match.instanceCount >= 2) {
          const isPro = await planIsPro(req.user.domain, req.user.email);
          const summaryTab = sanitizeTabName(
            isPro
              ? `Class Summary — ${match.title || 'Recurring'}`
              : `Class Summary (Pro) — ${match.title || 'Recurring'}`
          );
          try {
            await sheets.spreadsheets.batchUpdate({
              spreadsheetId,
              requestBody: { requests: [{ addSheet: { properties: { title: summaryTab } } }] },
            });
          } catch (_) { /* tab already exists — reuse and overwrite it */ }
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `'${summaryTab}'!A1`,
            valueInputOption: 'RAW',
            requestBody: {
              values: isPro
                ? buildClassSummaryValues(match, new Date(exportedAt).toISOString())
                : buildClassSummaryTeaserValues(match),
            },
          });
        }
      } catch (e) {
        log.warn('class summary tab failed', { error: e.message, conferenceId });
      }
    }

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

    // First-export detection — drives the in-app celebration moment.
    // Check the event log before persisting this one.
    const isFirstExport = req.user?.email
      ? (await countUserExports(domain, req.user.email)) === 0
      : false;

    // Fire-and-forget: audit trail for exports
    persistExport(domain, {
      meetingTitle: meetingTitle || 'Unknown',
      tabName,
      exportedAt,
      participantCount: allRows.length,
      sheetUrl,
      email: req.user?.email || null,
      autoExport: !!autoExport,
      recurringEventId: recurringEventId || null,
      conferenceId: conferenceId || null,
    });

    // Fire-and-forget: persist newly-checked excused emails to the meeting doc
    // so future re-exports remember the tagging without the user re-checking.
    // arrayUnion handles concurrent writes from parallel exports.
    if (req.user && excusedFromClient.length > 0 && conferenceId) {
      addMeetingExcusedEmails(domain, conferenceId, excusedFromClient);
    }

    // Fire-and-forget: Slack post-meeting digest if the user has a webhook
    // configured. Independent of the email send (sendEmail flag) — Slack
    // fires on EVERY export, manual or auto, because the user already opted
    // in by saving the webhook. Failure is logged, doesn't affect the export.
    // Pro-gated: free domains don't get the digest even with a webhook saved.
    if (req.user?.email && proAllowed) {
      (async () => {
        try {
          const settings = await getUserSettings(domain, req.user.email);
          if (!settings.slackWebhookUrl) return;
          await sendSlackDigest({
            webhookUrl: settings.slackWebhookUrl,
            meetingTitle: meetingTitle || 'Google Meet',
            totalAttended,
            totalInvited,
            participants: digestPresentRows(participants, exportedAt).concat(
              digestAbsentRows(calendarAttendees, { attendedEmails, attendedNames, excusedSet, inviteeNameCounts })
            ),
            sheetUrl,
            durationMin: meetDurationMin,
            startTime: meetingStartTime || exportedAt,
          });
        } catch (err) {
          log.warn('slack digest post-export failed', { error: err.message, email: req.user.email });
        }
      })();
    }

    // Fire-and-forget: email the organizer the sheet link. Only when explicitly
    // requested by the client (auto-export flow) — manual exports get the
    // in-product toast and don't need inbox noise. Pro-gated.
    if (sendEmail && req.user?.email && proAllowed) {
      // Build a digest-friendly participant list (top 25, present first) so the
      // email can render an inline table without exposing the raw row arrays.
      const digestPresent = digestPresentRows(participants, exportedAt, lateMinFor);
      const digestAbsent = digestAbsentRows(calendarAttendees, { attendedEmails, attendedNames, excusedSet, inviteeNameCounts });
      const digestParticipants = [...digestPresent, ...digestAbsent].slice(0, 25);
      const digestOverflow = (digestPresent.length + digestAbsent.length) - digestParticipants.length;

      sendExportNotification({
        to: req.user.email,
        displayName: req.user.displayName || null,
        sheetUrl,
        meetingTitle: meetingTitle || 'Google Meet',
        totalAttended,
        totalInvited,
        exportedAt,
        participants: digestParticipants,
        overflow: digestOverflow > 0 ? digestOverflow : 0,
        conferenceId: conferenceId || null,
        recurringEventId: recurringEventId || null,
      });
    }

    return { sheetUrl, isFirstExport };
  } catch (err) {
    // Tag a missing-Drive-scope failure so the route can map it to a 403.
    if (err.code === 403 || /insufficient permission/i.test(err.message || '')) {
      err.exportCode = 'DRIVE_PERMISSION_MISSING';
    }
    throw err;
  }
}

// POST /api/save-to-sheets — client-driven export (the in-panel "Export" button
// + auto-export-on-end). Thin wrapper: enforce the auto-export paywall, resolve
// the caller's Google client, then delegate to the shared buildAndSaveExport.
router.post('/save-to-sheets', async (req, res) => {
  const b = req.body || {};
  if (!b.participants?.length) return res.status(400).json({ error: 'participants array is required' });
  try {
    // Pro gating. Manual export + the Sheet itself stay free; the convenience
    // layers — auto-export, email + Slack digests — are Pro. Pass the email so a
    // personal-Gmail user is gated by their own Individual Pro plan (Workspace
    // domains ignore the email and use the tenant plan). Pre-launch (billing
    // unconfigured) planIsPro is always true so nothing changes.
    const proAllowed = req.user ? await planIsPro(req.user.domain, req.user.email) : true;
    if (b.autoExport && req.user && !proAllowed) {
      return res.status(402).json({ error: 'Auto-export on meeting end is a Pro feature.', upgrade: true, feature: 'autoExport' });
    }

    // Monthly export quota check for Free users (2 exports per calendar month)
    const FREE_MONTHLY_EXPORT_LIMIT = 2;
    if (req.user && !proAllowed) {
      const monthlyExports = await countUserMonthlyExports(req.user.domain, req.user.email);
      if (monthlyExports >= FREE_MONTHLY_EXPORT_LIMIT) {
        log.info('sheets: free tier export quota reached', { domain: req.user.domain, email: req.user.email, count: monthlyExports });
        return res.status(402).json({
          error: `You have reached your limit of ${FREE_MONTHLY_EXPORT_LIMIT} free exports this month. Upgrade to Pro for unlimited exports.`,
          upgrade: true,
          feature: 'exportQuota',
          quota: { used: monthlyExports, limit: FREE_MONTHLY_EXPORT_LIMIT },
        });
      }
    }
    const sheetsAuth = await getGoogleClient(req, 'https://www.googleapis.com/auth/spreadsheets');
    const { sheetUrl, isFirstExport } = await buildAndSaveExport({
      user: req.user ? { domain: req.user.domain, email: req.user.email, displayName: req.user.displayName } : null,
      sheetsAuth,
      data: {
        meetingTitle: b.meetingTitle, tabName: b.tabName, exportedAt: b.exportedAt, participants: b.participants,
        calendarAttendees: b.calendarAttendees || [], meetingStartTime: b.meetingStartTime, meetingType: b.meetingType,
        eventStart: b.eventStart, eventEnd: b.eventEnd, conferenceId: b.conferenceId, timezone: b.timezone,
        recurringEventId: b.recurringEventId, excusedFromClient: b.excusedEmails || [],
      },
      options: { sendEmail: b.sendEmail, autoExport: b.autoExport, proAllowed },
    });
    res.json({ success: true, sheetUrl, isFirstExport });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.exportCode === 'DRIVE_PERMISSION_MISSING') {
      log.warn('sheets export blocked by missing drive permission', { email: req.user?.email });
      return res.status(403).json({
        error: 'Google Drive permission is required to export attendance to Sheets. Please sign out and sign in again, keeping the Drive permission checked.',
        code: 'DRIVE_PERMISSION_MISSING',
      });
    }
    log.error('sheets export failed', { error: err.message });
    res.status(500).json({ error: 'Failed to export to Google Sheets.' });
  }
});

module.exports = router;
module.exports.buildAndSaveExport = buildAndSaveExport;
