const cors = require("cors");

/**
 * ALLOWED_ORIGIN restricts which frontend origin may call this API; set it
 * to the deployed Cloudflare Pages URL in production. Defaults to "*" for
 * local development / early testing.
 */
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

module.exports = cors({
  origin: allowedOrigin,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});
