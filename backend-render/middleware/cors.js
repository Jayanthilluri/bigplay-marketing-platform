const cors = require("cors");

/**
 * ALLOWED_ORIGIN restricts which frontend origin may call this API — in
 * production set it to https://bigplay-players-club.onrender.com (no
 * trailing slash). Defaults to "*" only so local development works out of
 * the box; do not leave it as "*" in production.
 *
 * Supports a comma-separated list so local dev and production can both be
 * allowed at once, e.g.:
 *   ALLOWED_ORIGIN=https://bigplay-players-club.onrender.com,http://localhost:8080
 */
const raw = process.env.ALLOWED_ORIGIN || "*";
const allowedOrigins = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
const allowAny = allowedOrigins.includes("*");

module.exports = cors({
  origin: allowAny ? "*" : allowedOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});
