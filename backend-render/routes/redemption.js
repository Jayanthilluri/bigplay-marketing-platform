const express = require("express");
const { redeemCustomerReward } = require("../services/ghlClient");
const {
  isMockModeEnabled,
  mockRedeemCustomerReward,
} = require("../services/mockData");

const router = express.Router();

function generateTransactionId() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

/** POST /api/redemptions  body: { membershipId, ghlContactId, redemptionState } */
router.post("/", async (req, res) => {
  const { membershipId, ghlContactId, redemptionState } = req.body || {};

  if (!membershipId) {
    return res.status(400).json({ ok: false, reason: "invalid_request" });
  }

  if (redemptionState === "redeemed") {
    return res.status(409).json({ ok: false, reason: "already_redeemed" });
  }
  if (redemptionState === "expired") {
    return res.status(409).json({ ok: false, reason: "expired" });
  }

  const redeemedAt = new Date();

  try {
    const result = isMockModeEnabled()
      ? mockRedeemCustomerReward(membershipId)
      : await redeemCustomerReward(ghlContactId, redeemedAt.toISOString());

    if (!result.ok) {
      return res.status(404).json({ ok: false, reason: "not_found" });
    }

    return res.status(200).json({
      ok: true,
      transaction: {
        transactionId: generateTransactionId(),
        redeemedAt: redeemedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Redeem failed", error);
    return res.status(502).json({ ok: false, reason: "upstream_error" });
  }
});

module.exports = router;
