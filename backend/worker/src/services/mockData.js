/**
 * Fallback mock customer data, used only when GHL_API_KEY is not configured
 * (e.g. local development, or a demo environment). Mirrors the Phase 1
 * frontend mock data so behavior is consistent across environments.
 */

const MOCK_CUSTOMERS = {
  "BP-100234": {
    membershipId: "BP-100234",
    name: "John Smith",
    membershipStatus: "Players Club Member",
    promotion: "Summer Free Play Giveaway",
    reward: "Free $10 Game Card",
    redemptionState: "ready",
  },
  "BP-100777": {
    membershipId: "BP-100777",
    name: "Maria Alvarez",
    membershipStatus: "Players Club VIP",
    promotion: "Birthday Rewards",
    reward: "50 Bonus Arcade Credits",
    redemptionState: "redeemed",
  },
  "BP-100999": {
    membershipId: "BP-100999",
    name: "David Chen",
    membershipStatus: "Players Club Member",
    promotion: "Holiday Promotion",
    reward: "Free Laser Tag Pass",
    redemptionState: "expired",
  },
};

export function isMockModeEnabled(env) {
  return !env.GHL_API_KEY;
}

export function mockFindCustomerByMembershipId(membershipId) {
  const customer = MOCK_CUSTOMERS[membershipId.trim().toUpperCase()];
  return customer ? { ...customer, ghlContactId: customer.membershipId } : null;
}

export function mockRedeemCustomerReward(membershipId) {
  const key = membershipId.trim().toUpperCase();
  const customer = MOCK_CUSTOMERS[key];
  if (!customer) return { ok: false };
  customer.redemptionState = "redeemed";
  return { ok: true };
}
