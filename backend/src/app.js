const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const CONFIG = require('./config');
const auth = require('./middleware/auth');
const apiLimiter = require('./middleware/rateLimit');
const requestId = require('./middleware/requestId');
const attendanceRoutes = require('./routes/attendance');
const sheetsRoutes = require('./routes/sheets');
const calendarRoutes = require('./routes/calendar');
const oauthRoutes = require('./routes/oauth');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const historyRoutes = require('./routes/history');
const pdfRoutes = require('./routes/pdf');
const teamRoutes = require('./routes/team');
const settingsRoutes = require('./routes/settings');
const { router: billingRoutes, webhookHandler: billingWebhookHandler } = require('./routes/billing');

const app = express();
app.set('trust proxy', 1); // Cloud Run runs behind a load balancer

// Security headers — allow framing from meet.google.com (side panel iframe)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://apis.google.com", "https://www.gstatic.com", "https://browser.sentry-cdn.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://*.googleusercontent.com"],
      frameSrc: ["https://accounts.google.com"],
      frameAncestors: ["https://meet.google.com", "'self'"],
      connectSrc: ["'self'", "https://accounts.google.com", "https://*.ingest.us.sentry.io"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for GIS popup
}));

// Stripe webhook MUST see the raw request body to verify the signature, so it
// is mounted BEFORE express.json() with its own raw parser. Everything else
// uses JSON parsing below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler);

app.use(express.json({ limit: '100kb' }));
// credentials:true is required because navigator.sendBeacon (used by the
// landing-page pageview beacon) auto-includes cookies for cross-origin
// requests. Without this header on the preflight response the browser
// drops the beacon silently and we lose visit telemetry. Origin is still
// restricted to the allowedOrigins whitelist so nothing's been opened up.
app.use(cors({ origin: CONFIG.allowedOrigins, credentials: true }));

// Request correlation IDs
app.use(requestId);

// OAuth routes — no auth middleware, own rate limit (10 req/min)
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later.' },
  skip: () => process.env.NODE_ENV === 'test',
});
app.use('/api/oauth', oauthLimiter, oauthRoutes);

// Public routes — no auth, but share the general rate limit so they can't be
// abused. Mounted before the auth middleware so anonymous traffic works.
app.use('/api', apiLimiter, publicRoutes);

// Rate limiting and auth on all other /api routes
app.use('/api', apiLimiter);
app.use('/api', auth);

// API routes
app.use('/api', attendanceRoutes);
app.use('/api', sheetsRoutes);
app.use('/api', calendarRoutes);
app.use('/api', adminRoutes);
app.use('/api', historyRoutes);
app.use('/api', pdfRoutes);
app.use('/api', teamRoutes);
app.use('/api', settingsRoutes);
app.use('/api', billingRoutes); // checkout / portal / status (webhook mounted above)

// Serve frontend from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Sentry error handler — must be after all routes
Sentry.setupExpressErrorHandler(app);

module.exports = app;
