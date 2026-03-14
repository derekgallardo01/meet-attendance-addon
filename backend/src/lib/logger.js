const log = {
  info:  (msg, data = {}) => console.log(JSON.stringify({ severity: 'INFO',    msg, ...data, ts: new Date().toISOString() })),
  warn:  (msg, data = {}) => console.warn(JSON.stringify({ severity: 'WARNING', msg, ...data, ts: new Date().toISOString() })),
  error: (msg, data = {}) => console.error(JSON.stringify({ severity: 'ERROR',  msg, ...data, ts: new Date().toISOString() })),
};

module.exports = log;
