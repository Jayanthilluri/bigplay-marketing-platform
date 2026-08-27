require("dotenv").config();

const express = require("express");
const corsMiddleware = require("./middleware/cors");
const authRouter = require("./routes/auth");
const lookupRouter = require("./routes/lookup");
const redemptionRouter = require("./routes/redemption");

const app = express();

// Render terminates TLS at its proxy; trust it so req.ip is the real
// client IP (login rate limiting keys off req.ip).
app.set("trust proxy", 1);

app.use(corsMiddleware);
app.use(express.json({ limit: "16kb" }));

/** GET /api/health */
app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true, mode: process.env.GHL_API_KEY ? "live" : "mock" });
});

app.use("/api/auth", authRouter);
app.use("/api/customers", lookupRouter);
app.use("/api/redemptions", redemptionRouter);

app.use((req, res) => {
  res.status(404).json({ ok: false, reason: "not_found" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Players Club Redemption API listening on port ${PORT}`);
  if (!process.env.EMPLOYEE_PIN && process.env.GHL_API_KEY) {
    console.warn("WARNING: EMPLOYEE_PIN is not set — employee logins will be rejected.");
  }
});

module.exports = app;
