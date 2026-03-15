const crypto = require('crypto');

function requestId(req, _res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  _res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = requestId;
