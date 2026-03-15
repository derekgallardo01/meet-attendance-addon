const jwt = require('jsonwebtoken');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { getUser, updateUserTokens } = require('../services/firestore');
const { refreshAccessToken } = require('../services/googleAuth');

// Validates session JWT and attaches req.user with fresh Google access token.
// If no Authorization header, req.user = null (backward compat with service account).
async function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), CONFIG.sessionSecret);
    const domain = decoded.domain || decoded.email.split('@')[1];
    const user = await getUser(domain, decoded.email);

    let accessToken = null;
    if (user?.refreshToken) {
      // Try to get/refresh access token
      accessToken = user.accessToken || null;
      const expiresAt = user.tokenExpiresAt?.toDate ? user.tokenExpiresAt.toDate() : user.tokenExpiresAt;
      const needsRefresh = !accessToken || !expiresAt || Date.now() > (new Date(expiresAt).getTime() - 5 * 60 * 1000);

      if (needsRefresh) {
        try {
          const credentials = await refreshAccessToken(user.refreshToken);
          accessToken = credentials.access_token;
          const tokenExpiresAt = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);
          await updateUserTokens(domain, decoded.email, { accessToken, tokenExpiresAt });
        } catch (refreshErr) {
          log.warn('token refresh failed, continuing without accessToken', { error: refreshErr.message });
          accessToken = null;
        }
      }
    } else {
      log.info('user not in Firestore or no refreshToken, continuing without accessToken', { email: decoded.email });
    }

    req.user = {
      email: decoded.email,
      domain: decoded.domain,
      displayName: decoded.displayName,
      accessToken,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired' });
    }
    log.error('auth middleware error', { error: err.message });
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = auth;
