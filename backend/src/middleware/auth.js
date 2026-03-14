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
    const user = await getUser(decoded.email);

    if (!user || !user.refreshToken) {
      return res.status(401).json({ error: 'User not found or not authenticated' });
    }

    // Check if cached access token is still valid (with 5 min buffer)
    let accessToken = user.accessToken;
    const expiresAt = user.tokenExpiresAt?.toDate ? user.tokenExpiresAt.toDate() : user.tokenExpiresAt;
    const needsRefresh = !accessToken || !expiresAt || Date.now() > (new Date(expiresAt).getTime() - 5 * 60 * 1000);

    if (needsRefresh) {
      const credentials = await refreshAccessToken(user.refreshToken);
      accessToken = credentials.access_token;
      const tokenExpiresAt = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);
      await updateUserTokens(decoded.email, { accessToken, tokenExpiresAt });
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
