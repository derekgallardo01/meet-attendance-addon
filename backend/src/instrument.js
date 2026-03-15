const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'https://ca6640c2e0299ad6aa313f210faae19f@o4510162222448640.ingest.us.sentry.io/4511049298280448',
  sendDefaultPii: true,
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.1,
  debug: true,
});

console.log('[Sentry] initialized');
