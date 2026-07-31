import { corsHeaders } from "../middleware/cors.js";
import { findCustomerByMembershipId, redeemCustomerReward } from "../services/ghlClient.js";
import {
  isMockModeEnabled,
  mockFindCustomerByMembershipId,
  mockRedeemCustomerReward,
} from "../services/mockData.js";

function jsonResponse(body, status, env, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env, request),
    },
  });
}

function generateTransactionId() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

/** GET /api/customers/lookup?membershipId=BP-100234 */
export async function handleLookup(request, env) {
  const url = new URL(request.url);
  const membershipId = (url.searchParams.get("membershipId") || "").trim();

  if (!membershipId) {
    return jsonResponse({ ok: false, reason: "invalid_request" }, 400, env, request);
  }

  try {
    const customer = isMockModeEnabled(env)
      ? mockFindCustomerByMembershipId(membershipId)
      : await findCustomerByMembershipId(env, membershipId);

    if (!customer) {
      return jsonResponse({ ok: false, reason: "not_found" }, 404, env, request);
    }

    return jsonResponse({ ok: true, customer }, 200, env, request);
  } catch (error) {
    console.error("Lookup failed", error);
    return jsonResponse({ ok: false, reason: "upstream_error" }, 502, env, request);
  }
}

/** POST /api/redemptions  body: { membershipId, ghlContactId, redemptionState } */
export async function handleRedeem(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, reason: "invalid_request" }, 400, env, request);
  }

  const { membershipId, ghlContactId, redemptionState } = body || {};

  if (!membershipId) {
    return jsonResponse({ ok: false, reason: "invalid_request" }, 400, env, request);
  }

  if (redemptionState === "redeemed") {
    return jsonResponse({ ok: false, reason: "already_redeemed" }, 409, env, request);
  }
  if (redemptionState === "expired") {
    return jsonResponse({ ok: false, reason: "expired" }, 409, env, request);
  }

  const redeemedAt = new Date();

  try {
    const result = isMockModeEnabled(env)
      ? mockRedeemCustomerReward(membershipId)
      : await redeemCustomerReward(env, ghlContactId, redeemedAt.toISOString());

    if (!result.ok) {
      return jsonResponse({ ok: false, reason: "not_found" }, 404, env, request);
    }

    return jsonResponse(
      {
        ok: true,
        transaction: {
          transactionId: generateTransactionId(),
          redeemedAt: redeemedAt.toISOString(),
        },
      },
      200,
      env,
      request
    );
  } catch (error) {
    console.error("Redeem failed", error);
    return jsonResponse({ ok: false, reason: "upstream_error" }, 502, env, request);
  }
}
