const { Router } = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const CONFIG = require('../config');
const log = require('../lib/logger');
const { exchangeCode, revokeToken } = require('../services/googleAuth');
const { upsertUser, getUser, updateUserTokens } = require('../services/firestore');

const router = Router();

// POST /api/oauth/exchange — swap authorization code for session token
router.post('/exchange', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code required' });

    // Exchange code for Google tokens
    const tokens = await exchangeCode(code);

    // Verify ID token to get user info
    const ticket = await new google.auth.OAuth2(CONFIG.googleClientId)
      .verifyIdToken({ idToken: tokens.id_token, audience: CONFIG.googleClientId });
    const payload = ticket.getPayload();

    const email = payload.email;
    const domain = payload.hd || email.split('@')[1];
    const displayName = payload.name || email;

    // Store user + tokens in tenant-scoped Firestore
    await upsertUser(domain, {
      email,
      displayName,
      refreshToken: tokens.refresh_token || undefined,
    });

    // Always store the fresh access token from the exchange
    if (tokens.access_token) {
      await updateUserTokens(domain, email, {
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
      });
    }

    // Issue backend session JWT (8 hour expiry — covers full-day meetings)
    const sessionToken = jwt.sign(
      { email, domain, displayName },
      CONFIG.sessionSecret,
      { expiresIn: '8h' }
    );

    log.info('oauth: user authenticated', { email, domain });
    res.json({ sessionToken, email, displayName });
  } catch (err) {
    log.error('oauth: exchange failed', { error: err.message });
    res.status(401).json({ error: 'Authentication failed' });
  }
});

// POST /api/oauth/revoke — sign out and revoke refresh token
router.post('/revoke', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const decoded = jwt.verify(authHeader.slice(7), CONFIG.sessionSecret);
    const domain = decoded.domain || decoded.email.split('@')[1];
    const user = await getUser(domain, decoded.email);

    if (user?.refreshToken) {
      await revokeToken(user.refreshToken);
    }

    log.info('oauth: user signed out', { email: decoded.email });
    res.json({ success: true });
  } catch (err) {
    log.error('oauth: revoke failed', { error: err.message });
    res.status(500).json({ error: 'Sign out failed' });
  }
});

module.exports = router;
