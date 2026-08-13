/**
 * Employee authentication middleware.
 *
 * Expects `Authorization: Bearer <session token>` issued by
 * POST /api/auth/login. Bearer tokens (not cookies) are used deliberately:
 * the frontend and backend live on different onrender.com subdomains, and
 * onrender.com is on the Public Suffix List, so the two sites are
 * third-party to each other — cross-site cookies would be blocked by
 * Safari and modern Chrome. See backend-render/README.md for the tradeoff.
 */

const { getSession } = require("../services/sessionStore");

function extractToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+([A-Za-z0-9._-]{16,256})$/);
  return match ? match[1] : null;
}

function requireEmployeeAuth(req, res, next) {
  const token = extractToken(req);
  const session = getSession(token);

  if (!session) {
    return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  req.employeeSession = session;
  req.sessionToken = token;
  next();
}

module.exports = { requireEmployeeAuth, extractToken };
