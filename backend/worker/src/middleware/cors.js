/**
 * CORS handling. ALLOWED_ORIGIN restricts which frontend origin may call
 * this Worker; set it to the deployed Cloudflare Pages URL in production.
 */

export function corsHeaders(env, request) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  const requestOrigin = request.headers.get("Origin");

  const origin =
    allowedOrigin === "*" ? "*" : requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export function handlePreflight(env, request) {
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}
