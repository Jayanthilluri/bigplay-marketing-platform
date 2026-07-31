/**
 * Big Play Marketing Platform — Players Club Redemption Portal API
 *
 * Cloudflare Worker that proxies customer lookup/redemption requests to
 * GoHighLevel, keeping the GHL API key server-side only. Falls back to
 * mock data automatically when GHL_API_KEY is not configured, so the
 * Worker is safe to deploy to a preview environment without real
 * credentials.
 */

import { handlePreflight, corsHeaders } from "./middleware/cors.js";
import { handleLookup, handleRedeem } from "./routes/redemption.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handlePreflight(env, request);
    }

    if (url.pathname === "/api/customers/lookup" && request.method === "GET") {
      return handleLookup(request, env);
    }

    if (url.pathname === "/api/redemptions" && request.method === "POST") {
      return handleRedeem(request, env);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(
        JSON.stringify({ ok: true, mode: env.GHL_API_KEY ? "live" : "mock" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env, request) } }
      );
    }

    return new Response(JSON.stringify({ ok: false, reason: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
    });
  },
};
