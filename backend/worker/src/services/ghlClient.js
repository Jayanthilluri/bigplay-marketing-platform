/**
 * GoHighLevel (LeadConnector) API client.
 *
 * Isolates all GHL HTTP calls behind a small interface so the redemption
 * route doesn't need to know about GHL's request/response shapes. If the
 * underlying endpoint or field-mapping strategy changes, only this file
 * should need to change.
 *
 * NOTE: The advanced contact search filter syntax below (filtering by a
 * custom field via `customFields.<fieldKey>`) matches GoHighLevel's
 * documented v2 Search Contacts behavior, but was not exercised against a
 * live account while building this. Run the smoke test in
 * docs/ghl-integration.md against your real location before go-live.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

function buildHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Custom field keys expected on the GHL Contact record. These must match
 * the "Field Key" of custom fields created in the GHL location (Settings ->
 * Custom Fields), configurable via env so they can be renamed without a
 * code change.
 */
function fieldKeys(env) {
  return {
    membershipId: env.GHL_FIELD_MEMBERSHIP_ID || "membership_id",
    membershipStatus: env.GHL_FIELD_MEMBERSHIP_STATUS || "membership_status",
    promotion: env.GHL_FIELD_PROMOTION || "active_promotion",
    reward: env.GHL_FIELD_REWARD || "active_reward",
    redemptionStatus: env.GHL_FIELD_REDEMPTION_STATUS || "redemption_status",
    redeemedAt: env.GHL_FIELD_REDEEMED_AT || "redeemed_at",
  };
}

function getCustomFieldValue(contact, fieldKey) {
  const field = (contact.customFields || []).find(
    (entry) => entry.key === fieldKey || entry.id === fieldKey
  );
  return field ? field.value : undefined;
}

function normalizeRedemptionState(rawValue) {
  const value = (rawValue || "").toString().trim().toLowerCase();
  if (value === "redeemed") return "redeemed";
  if (value === "expired") return "expired";
  return "ready";
}

/**
 * Maps a raw GHL contact record into the shape the frontend expects.
 */
export function mapContactToCustomer(contact, env) {
  const keys = fieldKeys(env);
  const name =
    contact.contactName ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    contact.email ||
    "Unknown Customer";

  return {
    membershipId: getCustomFieldValue(contact, keys.membershipId) || contact.id,
    name,
    membershipStatus: getCustomFieldValue(contact, keys.membershipStatus) || "Players Club Member",
    promotion: getCustomFieldValue(contact, keys.promotion) || "No Active Promotion",
    reward: getCustomFieldValue(contact, keys.reward) || "No Reward Available",
    redemptionState: normalizeRedemptionState(getCustomFieldValue(contact, keys.redemptionStatus)),
    ghlContactId: contact.id,
  };
}

/**
 * Looks up a single contact by the membership ID custom field.
 * @returns {Promise<object|null>} mapped customer, or null if not found
 */
export async function findCustomerByMembershipId(env, membershipId) {
  const keys = fieldKeys(env);

  const response = await fetch(`${GHL_API_BASE}/contacts/search`, {
    method: "POST",
    headers: buildHeaders(env.GHL_API_KEY),
    body: JSON.stringify({
      locationId: env.GHL_LOCATION_ID,
      pageLimit: 1,
      filters: [
        {
          field: `customFields.${keys.membershipId}`,
          operator: "eq",
          value: membershipId,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`GHL search failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const contact = (data.contacts || [])[0];
  if (!contact) return null;

  return mapContactToCustomer(contact, env);
}

/**
 * Marks the active reward as redeemed on the contact record.
 * @returns {Promise<{ok: boolean}>}
 */
export async function redeemCustomerReward(env, ghlContactId, redeemedAtIso) {
  const keys = fieldKeys(env);

  const response = await fetch(`${GHL_API_BASE}/contacts/${ghlContactId}`, {
    method: "PUT",
    headers: buildHeaders(env.GHL_API_KEY),
    body: JSON.stringify({
      customFields: [
        { key: keys.redemptionStatus, field_value: "redeemed" },
        { key: keys.redeemedAt, field_value: redeemedAtIso },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`GHL update failed (${response.status}): ${errorBody}`);
  }

  return { ok: true };
}
