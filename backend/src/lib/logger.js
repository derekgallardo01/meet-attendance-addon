const Sentry = require('@sentry/node');

function emit(severity, consoleFn, msg, data) {
  const entry = { severity, msg, ...data, ts: new Date().toISOString() };
  consoleFn(JSON.stringify(entry));
  // Also send errors/warnings to Sentry as breadcrumbs
  if (severity === 'ERROR') {
    Sentry.captureMessage(msg, { level: 'error', extra: data });
  }
}

const log = {
  info:  (msg, data = {}) => emit('INFO',    console.log,   msg, data),
  warn:  (msg, data = {}) => emit('WARNING', console.warn,  msg, data),
  error: (msg, data = {}) => emit('ERROR',   console.error, msg, data),
};

module.exports = log;
