// Passthrough middleware — placeholder for OAuth token validation in Phase 3.
// Will eventually extract and verify Bearer tokens from the Authorization header.
function auth(req, res, next) {
  next();
}

module.exports = auth;
