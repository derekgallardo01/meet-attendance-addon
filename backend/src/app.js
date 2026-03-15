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

const app = express();
app.set('trust proxy', 1); // Cloud Run runs behind a load balancer

// Security headers — allow framing from meet.google.com (side panel iframe)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://apis.google.com", "https://www.gstatic.com", "https://browser.sentry-cdn.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["https://accounts.google.com"],
      frameAncestors: ["https://meet.google.com", "'self'"],
      connectSrc: ["'self'", "https://accounts.google.com", "https://*.ingest.us.sentry.io"],
    },
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for GIS popup
}));

app.use(express.json({ limit: '100kb' }));
app.use(cors({ origin: CONFIG.allowedOrigins }));

// Request correlation IDs
app.use(requestId);

// OAuth routes — no auth middleware, own rate limit (10 req/min)
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later.' },
});
app.use('/api/oauth', oauthLimiter, oauthRoutes);

// Rate limiting and auth on all other /api routes
app.use('/api', apiLimiter);
app.use('/api', auth);

// API routes
app.use('/api', attendanceRoutes);
app.use('/api', sheetsRoutes);
app.use('/api', calendarRoutes);
app.use('/api', adminRoutes);

// Serve frontend from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Sentry test — triggers a real exception that Sentry captures
app.get('/debug-sentry', function mainHandler(_req, _res) {
  throw new Error('Sentry test error from Cloud Run');
});

// Sentry error handler — must be after all routes
Sentry.setupExpressErrorHandler(app);

module.exports = app;
