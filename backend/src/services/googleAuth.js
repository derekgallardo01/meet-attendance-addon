const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const CONFIG = require('../config');
const log = require('../lib/logger');

// ── Cached secrets ──
let serviceAccountKey = null;
let oauthClientSecret = null;

async function loadServiceAccountKey() {
  if (serviceAccountKey) return serviceAccountKey;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: `${CONFIG.secretName}/versions/latest` });
  serviceAccountKey = JSON.parse(version.payload.data.toString());
  log.info('service account key loaded');
  return serviceAccountKey;
}

async function loadOAuthClientSecret() {
  if (oauthClientSecret) return oauthClientSecret;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: `${CONFIG.oauthClientSecretName}/versions/latest` });
  oauthClientSecret = version.payload.data.toString().trim();
  log.info('oauth client secret loaded');
  return oauthClientSecret;
}

// ── Service Account (Meet API, Directory API) ──

async function makeJWT(scopes) {
  const key = await loadServiceAccountKey();
  const jwt = new google.auth.JWT({
    email:   key.client_email,
    key:     key.private_key,
    scopes,
    subject: CONFIG.impersonateEmail,
  });
  await jwt.authorize();
  return jwt;
}

async function getMeetToken() {
  const jwt = await makeJWT(['https://www.googleapis.com/auth/meetings.space.readonly']);
  const tokens = await jwt.authorize();
  return tokens.access_token;
}

// ── OAuth (Phase 3 — user tokens for Calendar, Sheets) ──

async function getOAuthClient() {
  const secret = await loadOAuthClientSecret();
  return new google.auth.OAuth2(CONFIG.googleClientId, secret);
}

async function exchangeCode(code) {
  const client = await getOAuthClient();
  // GIS popup mode uses 'postmessage' as the redirect URI
  client.redirectUri = 'postmessage';
  const { tokens } = await client.getToken(code);
  log.info('oauth: code exchanged', { hasRefreshToken: !!tokens.refresh_token });
  return tokens;
}

async function refreshAccessToken(refreshToken) {
  const client = await getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  log.info('oauth: token refreshed');
  return credentials;
}

function makeUserClient(accessToken) {
  const client = new google.auth.OAuth2(CONFIG.googleClientId);
  client.setCredentials({ access_token: accessToken });
  return client;
}

async function revokeToken(token) {
  const client = await getOAuthClient();
  try {
    await client.revokeToken(token);
    log.info('oauth: token revoked');
  } catch (err) {
    log.warn('oauth: revoke failed (token may already be invalid)', { error: err.message });
  }
}

module.exports = {
  loadServiceAccountKey, makeJWT, getMeetToken,
  getOAuthClient, exchangeCode, refreshAccessToken, makeUserClient, revokeToken,
};
