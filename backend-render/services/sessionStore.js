/**
 * In-memory employee session store + login rate limiting.
 *
 * Sessions are random 256-bit tokens with a server-side expiry. They are
 * held in process memory, which is acceptable for this MVP but means:
 *   - a server restart/redeploy logs every employee out (they re-enter the PIN);
 *   - this only works on a single instance (Render web services run one
 *     instance per service on the current plan, so that holds today).
 * If the service ever scales to multiple instances, move this to Redis or
 * a database — the interface below is deliberately small to make that swap easy.
 */

const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — covers a full shift

/** @type {Map<string, {expiresAt: number, employeeName: string}>} */
const sessions = new Map();

function createSession(employeeName) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    expiresAt: Date.now() + SESSION_TTL_MS,
    employeeName: (employeeName || "").toString().slice(0, 64),
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

/** Periodic sweep so expired sessions don't accumulate forever. */
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}, 15 * 60 * 1000).unref();

/* ------------------------------------------------------------------
 * Login rate limiting (per client IP)
 *
 * Blocks an IP after MAX_FAILURES failed PIN attempts within WINDOW_MS,
 * for LOCKOUT_MS. In-memory, same single-instance caveat as sessions.
 * ---------------------------------------------------------------- */

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/** @type {Map<string, {failures: number, windowStart: number, lockedUntil: number}>} */
const loginAttempts = new Map();

function isLoginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return false;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  loginAttempts.set(ip, entry);
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.windowStart > WINDOW_MS && now > entry.lockedUntil) {
      loginAttempts.delete(ip);
    }
  }
}, 15 * 60 * 1000).unref();

module.exports = {
  createSession,
  getSession,
  destroySession,
  isLoginBlocked,
  recordLoginFailure,
  recordLoginSuccess,
};
