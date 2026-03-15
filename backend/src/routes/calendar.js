const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT, makeUserClient } = require('../services/googleAuth');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { persistCalendarData } = require('../services/firestore');

const router = Router();

// Extract meeting code from a Meet URL (e.g., "https://meet.google.com/abc-defg-hij" → "abc-defg-hij")
function extractMeetCode(url) {
  const match = (url || '').match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return match ? match[1] : null;
}

router.get('/calendar-attendees', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { meetingCode, calendarId } = req.query;
  if (!meetingCode) return res.status(400).json({ error: 'meetingCode is required' });

  try {
    // Use user's OAuth token if available, otherwise fall back to service account
    const calAuth = req.user
      ? makeUserClient(req.user.accessToken)
      : await makeJWT(['https://www.googleapis.com/auth/calendar.readonly']);
    const calendar = google.calendar({ version: 'v3', auth: calAuth });

    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() +  7 * 24 * 60 * 60 * 1000).toISOString();

    const eventsResp = await calendar.events.list({
      calendarId:   calendarId || 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults:   250,
      conferenceDataVersion: 1, // ensure conferenceData is populated
    });

    const events = eventsResp.data.items || [];
    log.info('calendar events scanned', { count: events.length, meetingCode, calendarId: calendarId || 'primary' });

    // Find all events matching this meeting code — exact segment match, skip all-day events
    const matchingEvents = events.filter(e => {
      // Skip all-day events (they rarely have Meet links, and distance calc breaks)
      if (!e.start.dateTime) return false;
      const meetCode    = extractMeetCode(e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri);
      const hangoutCode = extractMeetCode(e.hangoutLink);
      return meetCode === meetingCode || hangoutCode === meetingCode;
    });

    // Pick the event closest to the current time (handles recurring meetings)
    let matchedEvent = null;
    if (matchingEvents.length === 1) {
      matchedEvent = matchingEvents[0];
    } else if (matchingEvents.length > 1) {
      const now = Date.now();
      matchedEvent = matchingEvents.reduce((closest, e) => {
        const eStart = new Date(e.start.dateTime).getTime();
        const closestStart = new Date(closest.start.dateTime).getTime();
        return Math.abs(eStart - now) < Math.abs(closestStart - now) ? e : closest;
      });
      log.info('recurring meeting — picked closest instance', { total: matchingEvents.length, picked: matchedEvent.start.dateTime });
    }

    // Fallback: if no event matches by meeting code, find the closest event
    // happening right now (within 30 min) that has any Meet link
    if (!matchedEvent) {
      const now = Date.now();
      const WINDOW_MS = 30 * 60 * 1000; // 30 minutes
      const nearbyEvents = events.filter(e => {
        if (!e.start?.dateTime) return false;
        if (!e.conferenceData && !e.hangoutLink) return false; // must have a Meet link
        const start = new Date(e.start.dateTime).getTime();
        const end = new Date(e.end?.dateTime || e.start.dateTime).getTime();
        // Event is currently happening or within 30 min of starting
        return (start - WINDOW_MS <= now && now <= end + WINDOW_MS);
      });

      if (nearbyEvents.length === 1) {
        matchedEvent = nearbyEvents[0];
        log.info('matched calendar event by time proximity', { title: matchedEvent.summary });
      } else if (nearbyEvents.length > 1) {
        // Pick the one closest to now
        matchedEvent = nearbyEvents.reduce((closest, e) => {
          const eStart = new Date(e.start.dateTime).getTime();
          const closestStart = new Date(closest.start.dateTime).getTime();
          return Math.abs(eStart - now) < Math.abs(closestStart - now) ? e : closest;
        });
        log.info('matched calendar event by time proximity (closest of multiple)', { title: matchedEvent.summary, total: nearbyEvents.length });
      }
    }

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

    res.json({
      isScheduled: true,
      eventTitle: matchedEvent.summary || 'Scheduled Meeting',
      eventStart: matchedEvent.start?.dateTime || matchedEvent.start?.date || null,
      eventEnd: matchedEvent.end?.dateTime || matchedEvent.end?.date || null,
      attendees,
    });

    // Fire-and-forget: store title + invited attendees for analytics
    const domain = req.user?.domain || 'default';
    persistCalendarData(domain, meetingCode, matchedEvent.summary || 'Scheduled Meeting', attendees);

  } catch (err) {
    log.error('calendar lookup failed', { error: err.message });
    res.status(500).json({ error: 'Failed to look up calendar data.' });
  }
});

module.exports = router;
