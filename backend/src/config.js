const required = (name) => {
  const val = process.env[name];
  if (!val) { console.error(`FATAL: ${name} env var not set`); process.exit(1); }
  return val;
};

const CONFIG = {
  // OAuth (Phase 3)
  googleClientId:        required('GOOGLE_CLIENT_ID'),
  oauthClientSecretName: required('OAUTH_CLIENT_SECRET_NAME'),
  sessionSecret:         required('SESSION_SECRET'),

  // Service account (legacy / Meet API)
  secretName:       required('SECRET_NAME'),
  impersonateEmail: process.env.IMPERSONATE_EMAIL || null,
  sheetId:          process.env.SHEET_ID || null,
  adminEmail:       process.env.ADMIN_EMAIL || null,

  // General
  allowedOrigins:  (process.env.ALLOWED_ORIGINS || 'https://derekgallardo01.github.io,https://meet.google.com').split(','),
  port:             process.env.PORT || 8080,
  gcpProjectId:     process.env.GCP_PROJECT_ID || null,
};

module.exports = CONFIG;
