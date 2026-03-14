const required = (name) => {
  const val = process.env[name];
  if (!val) { console.error(`FATAL: ${name} env var not set`); process.exit(1); }
  return val;
};

const CONFIG = {
  impersonateEmail: required('IMPERSONATE_EMAIL'),
  sheetId:          required('SHEET_ID'),
  secretName:       required('SECRET_NAME'),
  allowedOrigins:  (process.env.ALLOWED_ORIGINS || 'https://derekgallardo01.github.io,https://meet.google.com').split(','),
  port:             process.env.PORT || 8080,
};

module.exports = CONFIG;
