const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'https://95d14af111a0266aeb57c888802e4fae@o4510162222448640.ingest.us.sentry.io/4511049251094528',
  sendDefaultPii: true,
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.1,
  debug: true,
});

console.log('[Sentry] initialized');
