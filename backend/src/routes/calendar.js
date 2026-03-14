const { Router } = require('express');
const { google } = require('googleapis');
const { makeJWT } = require('../services/googleAuth');
const log = require('../lib/logger');
const { persistCalendarData } = require('../services/firestore');

const router = Router();

router.get('/calendar-attendees', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { meetingCode } = req.query;
  if (!meetingCode) return res.status(400).json({ error: 'meetingCode is required' });

  try {
    const calAuth = await makeJWT(['https://www.googleapis.com/auth/calendar.readonly']);
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

    const matchedEvent = events.find(e => {
      const meetLink    = e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === 'video')?.uri || '';
      const hangoutLink = e.hangoutLink || '';
      return meetLink.includes(meetingCode) || hangoutLink.includes(meetingCode);
    });

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
