const { google } = require('googleapis');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const CONFIG = require('../config');
const log = require('../lib/logger');

let serviceAccountKey = null;

async function loadServiceAccountKey() {
  if (serviceAccountKey) return serviceAccountKey;
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: `${CONFIG.secretName}/versions/latest` });
  serviceAccountKey = JSON.parse(version.payload.data.toString());
  log.info('service account key loaded');
  return serviceAccountKey;
}

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

module.exports = { loadServiceAccountKey, makeJWT, getMeetToken };
