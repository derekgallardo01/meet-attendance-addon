const path = require('path');
const express = require('express');
const cors = require('cors');
const CONFIG = require('./config');
const auth = require('./middleware/auth');
const apiLimiter = require('./middleware/rateLimit');
const attendanceRoutes = require('./routes/attendance');
const sheetsRoutes = require('./routes/sheets');
const calendarRoutes = require('./routes/calendar');

const app = express();
app.set('trust proxy', 1); // Cloud Run runs behind a load balancer

app.use(express.json());
app.use(cors({ origin: CONFIG.allowedOrigins }));

// Rate limiting and auth on all /api routes
app.use('/api', apiLimiter);
app.use('/api', auth);

// API routes
app.use('/api', attendanceRoutes);
app.use('/api', sheetsRoutes);
app.use('/api', calendarRoutes);

// Serve frontend from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'meet-attendance-backend', ts: new Date().toISOString() }));

module.exports = app;
