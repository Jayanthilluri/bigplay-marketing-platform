const express = require("express");
const {
  redeemCustomerReward,
  isValidCustomerId,
} = require("../services/ghlClient");
const {
  isMockModeEnabled,
  mockRedeemCustomerReward,
} = require("../services/mockData");
const { requireEmployeeAuth } = require("../middleware/auth");
const { resolveCustomer } = require("./lookup");

const router = express.Router();

function generateTransactionId() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

/**
 * In-flight redemption lock, keyed by contact identifier. Two simultaneous
 * requests for the same customer: the first proceeds, the second is
 * rejected immediately instead of racing the GHL read-then-write.
 * (In-memory — same single-instance caveat as sessions; see README.)
 */
const inFlight = new Set();

/**
 * POST /api/redemptions  body: { membershipId, ghlContactId }
 * Employee auth required. The customer's redemption state is re-read from
 * the source of truth (GHL, or the mock store) immediately before the
 * write — any `redemptionState` sent by the browser is IGNORED.
 */
router.post("/", requireEmployeeAuth, async (req, res) => {
  const body = req.body || {};
  const membershipId = typeof body.membershipId === "string" ? body.membershipId.trim() : "";
  const ghlContactId = typeof body.ghlContactId === "string" ? body.ghlContactId.trim() : "";

  const lookupId = ghlContactId || membershipId;
  if (!isValidCustomerId(lookupId)) {
    return res.status(400).json({ ok: false, reason: "invalid_request" });
  }

  if (inFlight.has(lookupId)) {
    return res.status(409).json({ ok: false, reason: "redemption_in_progress" });
  }
  inFlight.add(lookupId);

  try {
    // Re-read current state from the source of truth right before writing.
    const customer = await resolveCustomer(lookupId);

    if (!customer) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }
    if (customer.redemptionState === "redeemed") {
      return res.status(409).json({ ok: false, reason: "already_redeemed" });
    }
    if (customer.redemptionState !== "ready") {
      return res.status(409).json({ ok: false, reason: "expired" });
    }

    const redeemedAt = new Date();
    const redeemedBy = (req.employeeSession && req.employeeSession.employeeName) || "";

    if (isMockModeEnabled()) {
      const result = mockRedeemCustomerReward(customer.membershipId);
      if (!result.ok) {
        return res.status(404).json({ ok: false, reason: "not_found" });
      }
    } else {
      await redeemCustomerReward(customer.ghlContactId, redeemedAt.toISOString(), redeemedBy);
    }

    const transaction = {
      transactionId: generateTransactionId(),
      redeemedAt: redeemedAt.toISOString(),
    };
    if (redeemedBy) transaction.redeemedBy = redeemedBy;

    return res.status(200).json({ ok: true, transaction });
  } catch (error) {
    console.error("Redeem failed:", error.message);
    return res.status(502).json({ ok: false, reason: "upstream_error" });
  } finally {
    inFlight.delete(lookupId);
  }
});

module.exports = router;
