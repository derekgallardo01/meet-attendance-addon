let Sentry;
try { Sentry = require('@sentry/node'); } catch { Sentry = null; }

function emit(severity, consoleFn, msg, data) {
  const entry = { severity, msg, ...data, ts: new Date().toISOString() };
  consoleFn(JSON.stringify(entry));
  // Send errors to Sentry
  if (severity === 'ERROR' && Sentry) {
    Sentry.withScope(scope => {
      scope.setLevel('error');
      if (data) scope.setExtras(data);
      Sentry.captureMessage(msg);
    });
  }
}

const log = {
  info:  (msg, data = {}) => emit('INFO',    console.log,   msg, data),
  warn:  (msg, data = {}) => emit('WARNING', console.warn,  msg, data),
  error: (msg, data = {}) => emit('ERROR',   console.error, msg, data),
};

module.exports = log;
