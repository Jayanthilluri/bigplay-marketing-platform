const express = require("express");
const crypto = require("crypto");
const {
  createSession,
  getSession,
  destroySession,
  isLoginBlocked,
  recordLoginFailure,
  recordLoginSuccess,
} = require("../services/sessionStore");
const { extractToken } = require("../middleware/auth");
const { isMockModeEnabled } = require("../services/mockData");

const router = express.Router();

/**
 * The employee PIN comes from the EMPLOYEE_PIN env var. In mock mode
 * (no GHL_API_KEY) a default of "1234" is provided so local development
 * and demos work out of the box. In live mode there is NO default: if
 * EMPLOYEE_PIN is unset, logins are rejected until it is configured.
 */
function configuredPin() {
  if (process.env.EMPLOYEE_PIN) return process.env.EMPLOYEE_PIN;
  if (isMockModeEnabled()) return "1234";
  return null;
}

/** Constant-time comparison; hashing first removes length leakage. */
function pinMatches(submitted, expected) {
  const a = crypto.createHash("sha256").update(String(submitted)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** POST /api/auth/login  body: { pin, employeeName? } */
router.post("/login", (req, res) => {
  const ip = req.ip || "unknown";

  if (isLoginBlocked(ip)) {
    return res.status(429).json({ ok: false, reason: "too_many_attempts" });
  }

  const { pin, employeeName } = req.body || {};
  if (typeof pin !== "string" || pin.length < 1 || pin.length > 64) {
    recordLoginFailure(ip);
    return res.status(400).json({ ok: false, reason: "invalid_pin" });
  }

  const expected = configuredPin();
  if (!expected) {
    // Deliberately no details: don't tell callers the server is missing config.
    console.error("Login rejected: EMPLOYEE_PIN is not configured");
    return res.status(503).json({ ok: false, reason: "not_configured" });
  }

  if (!pinMatches(pin, expected)) {
    recordLoginFailure(ip);
    return res.status(401).json({ ok: false, reason: "invalid_pin" });
  }

  recordLoginSuccess(ip);
  const token = createSession(employeeName);

  return res.status(200).json({ ok: true, authenticated: true, token });
});

/** POST /api/auth/logout */
router.post("/logout", (req, res) => {
  destroySession(extractToken(req));
  return res.status(200).json({ ok: true, authenticated: false });
});

/** GET /api/auth/session */
router.get("/session", (req, res) => {
  const session = getSession(extractToken(req));
  if (!session) {
    return res.status(200).json({ ok: true, authenticated: false });
  }
  return res.status(200).json({
    ok: true,
    authenticated: true,
    employeeName: session.employeeName || "",
  });
});

module.exports = router;
