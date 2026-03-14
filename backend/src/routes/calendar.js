const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT, makeUserClient } = require('../services/googleAuth');
const log = require('../lib/logger');
const { persistCalendarData } = require('../services/firestore');

const router = Router();

router.get('/calendar-attendees', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { meetingCode } = req.query;
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
      calendarId:   'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      maxResults:   250,
    });

    const events = eventsResp.data.items || [];
    log.info('calendar events scanned', { count: events.length, meetingCode });

    // Find all events matching this meeting code (recurring meetings share the same code)
    const matchingEvents = events.filter(e => {
      const meetLink    = e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '';
      const hangoutLink = e.hangoutLink || '';
      return meetLink.includes(meetingCode) || hangoutLink.includes(meetingCode);
    });

    // Pick the event closest to the current time (handles recurring meetings)
    let matchedEvent = null;
    if (matchingEvents.length === 1) {
      matchedEvent = matchingEvents[0];
    } else if (matchingEvents.length > 1) {
      const now = Date.now();
      matchedEvent = matchingEvents.reduce((closest, e) => {
        const eStart = new Date(e.start.dateTime || e.start.date).getTime();
        const closestStart = new Date(closest.start.dateTime || closest.start.date).getTime();
        return Math.abs(eStart - now) < Math.abs(closestStart - now) ? e : closest;
      });
      log.info('recurring meeting — picked closest instance', { total: matchingEvents.length, picked: matchedEvent.start.dateTime });
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

    res.json({ isScheduled: true, eventTitle: matchedEvent.summary || 'Scheduled Meeting', attendees });

    // Fire-and-forget: store title + invited attendees for analytics
    persistCalendarData(meetingCode, matchedEvent.summary || 'Scheduled Meeting', attendees);

  } catch (err) {
    log.error('calendar lookup failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
