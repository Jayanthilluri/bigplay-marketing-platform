require("dotenv").config();

const express = require("express");
const corsMiddleware = require("./middleware/cors");
const lookupRouter = require("./routes/lookup");
const redemptionRouter = require("./routes/redemption");

const app = express();

app.use(corsMiddleware);
app.use(express.json());

/** GET /api/health */
app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true, mode: process.env.GHL_API_KEY ? "live" : "mock" });
});

app.use("/api/customers", lookupRouter);
app.use("/api/redemptions", redemptionRouter);

app.use((req, res) => {
  res.status(404).json({ ok: false, reason: "not_found" });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Players Club Redemption API listening on port ${PORT}`);
});

module.exports = app;
