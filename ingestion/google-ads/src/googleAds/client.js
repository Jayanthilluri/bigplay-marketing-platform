// Google Ads API client over the official REST interface
// (https://developers.google.com/google-ads/api/rest/overview).
//
// Google publishes no official Node.js client library, so this talks to the
// documented REST endpoints directly with OAuth2 refresh-token auth. It is
// server-side only: it needs the client secret, refresh token and developer
// token, none of which may ever reach a browser.

import { GoogleAdsApiError, GoogleAdsAuthError, PipelineError } from '../errors.js';
import { logger as defaultLogger, redact } from '../logger.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://googleads.googleapis.com';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;
// A quota error asking us to wait longer than this is a daily-quota
// exhaustion; waiting inside a cron run would not help.
const MAX_HONOURED_RETRY_DELAY_MS = 5 * 60_000;

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'quotaError.RESOURCE_TEMPORARILY_EXHAUSTED',
  'quotaError.RESOURCE_EXHAUSTED',
  'internalError.INTERNAL_ERROR',
  'internalError.TRANSIENT_ERROR',
  'internalError.DEADLINE_EXCEEDED',
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseDurationMs(value) {
  // google.protobuf.Duration in JSON is e.g. "30s" or "1.5s".
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? ''));
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Turns an HTTP error response from the Google Ads API into a typed error. */
export function classifyApiError(httpStatus, body, headers) {
  const err = body?.error ?? {};
  const failure = (err.details ?? []).find((d) => String(d['@type'] ?? '').endsWith('GoogleAdsFailure'));
  const errors = failure?.errors ?? [];
  const errorCodes = errors.flatMap((e) => Object.entries(e.errorCode ?? {}).map(([k, v]) => `${k}.${v}`));
  const messages = errors.map((e) => e.message).filter(Boolean);
  const requestId = failure?.requestId ?? headers?.get?.('request-id') ?? undefined;
  const message = redact(messages.length ? messages.join('; ') : err.message || `HTTP ${httpStatus}`);

  let retryDelayMs = errors.map((e) => parseDurationMs(e.details?.quotaErrorDetails?.retryDelay)).find((v) => v !== undefined);
  const retryAfter = headers?.get?.('retry-after');
  if (retryDelayMs === undefined && retryAfter && /^\d+$/.test(retryAfter)) retryDelayMs = Number(retryAfter) * 1000;

  const isAuth = httpStatus === 401 || httpStatus === 403
    || errorCodes.some((c) => c.startsWith('authenticationError.') || c.startsWith('authorizationError.'));
  if (isAuth) {
    const e = new GoogleAdsAuthError(`Google Ads rejected the credentials: ${message}`, { details: { httpStatus, errorCodes, requestId } });
    e.httpStatus = httpStatus;
    e.errorCodes = errorCodes;
    e.requestId = requestId;
    e.tokenExpired = errorCodes.includes('authenticationError.OAUTH_TOKEN_EXPIRED')
      || (httpStatus === 401 && !errorCodes.length);
    return e;
  }

  let retryable = RETRYABLE_HTTP.has(httpStatus) || errorCodes.some((c) => RETRYABLE_CODES.has(c));
  if (retryable && retryDelayMs !== undefined && retryDelayMs > MAX_HONOURED_RETRY_DELAY_MS) retryable = false;
  return new GoogleAdsApiError(`Google Ads API error (HTTP ${httpStatus}): ${message}`, {
    httpStatus, requestId, errorCodes, retryDelayMs, retryable,
  });
}

function isNetworkError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError'
    || (err instanceof TypeError && /fetch failed|network|socket|terminated/i.test(String(err.message)));
}

export class GoogleAdsClient {
  constructor(googleConfig, { fetchImpl = globalThis.fetch, sleep = defaultSleep, logger = defaultLogger, random = Math.random } = {}) {
    this.config = googleConfig;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.logger = logger;
    this.random = random;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.stats = { requests: 0, retries: 0, pages: 0, tokenRefreshes: 0 };
  }

  backoffMs(attempt, hintMs) {
    if (hintMs !== undefined) return hintMs;
    const exp = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    return Math.round(exp / 2 + this.random() * exp / 2); // "equal jitter"
  }

  /** Runs `fn` with retries for transient failures only. */
  async withRetry(label, fn) {
    const max = this.config.maxRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (rawErr) {
        const err = isNetworkError(rawErr)
          ? new GoogleAdsApiError(`Network error calling Google (${label}): ${redact(rawErr.message)}`, { retryable: true, cause: rawErr })
          : rawErr;
        if (!(err instanceof PipelineError) || !err.retryable || attempt >= max) {
          if (err instanceof PipelineError && err.retryable) {
            err.message = `${err.message} (gave up after ${attempt + 1} attempts)`;
          }
          throw err;
        }
        const wait = this.backoffMs(attempt, err.retryDelayMs);
        this.stats.retries++;
        this.logger.warn('google_ads.retry', { label, attempt: attempt + 1, maxRetries: max, waitMs: wait, error: err.message });
        await this.sleep(wait);
      }
    }
  }

  async getAccessToken({ force = false } = {}) {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    return this.withRetry('oauth_token', async () => {
      const res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      let body = {};
      try { body = await res.json(); } catch { /* handled below */ }
      if (res.ok && body.access_token) {
        this.accessToken = body.access_token;
        this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
        this.stats.tokenRefreshes++;
        return this.accessToken;
      }
      if (res.status >= 500 || res.status === 429) {
        throw new GoogleAdsApiError(`OAuth token endpoint returned HTTP ${res.status}`, { httpStatus: res.status, retryable: true });
      }
      const reason = body.error === 'invalid_grant'
        ? 'refresh token is expired or revoked (invalid_grant) — generate a new GOOGLE_ADS_REFRESH_TOKEN'
        : body.error === 'invalid_client' || body.error === 'unauthorized_client'
          ? `OAuth client rejected (${body.error}) — check GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET`
          : `token endpoint returned HTTP ${res.status} ${body.error ?? ''}`.trim();
      throw new GoogleAdsAuthError(`Google OAuth failed: ${reason}`);
    });
  }

  headers(token) {
    const h = {
      authorization: `Bearer ${token}`,
      'developer-token': this.config.developerToken,
      'content-type': 'application/json',
    };
    if (this.config.loginCustomerId) h['login-customer-id'] = this.config.loginCustomerId;
    return h;
  }

  /** One googleAds:search call (one page), with retry and one token refresh on expiry. */
  async searchPage(customerId, query, pageToken) {
    const url = `${API_BASE}/${this.config.apiVersion}/customers/${customerId}/googleAds:search`;
    const body = JSON.stringify(pageToken ? { query, pageToken } : { query });
    let refreshed = false;
    return this.withRetry('search', async () => {
      for (;;) {
        const token = await this.getAccessToken();
        this.stats.requests++;
        const res = await this.fetch(url, { method: 'POST', headers: this.headers(token), body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        let parsed;
        const text = await res.text();
        try { parsed = text ? JSON.parse(text) : {}; } catch {
          throw new GoogleAdsApiError(`Google Ads returned a non-JSON response (HTTP ${res.status})`, { httpStatus: res.status, retryable: res.ok || res.status >= 500 });
        }
        if (res.ok) {
          if (parsed.results !== undefined && !Array.isArray(parsed.results)) {
            throw new GoogleAdsApiError('Unexpected Google Ads response: "results" is not an array', { httpStatus: res.status });
          }
          return parsed;
        }
        const err = classifyApiError(res.status, parsed, res.headers);
        if (err instanceof GoogleAdsAuthError && err.tokenExpired && !refreshed) {
          refreshed = true;
          this.logger.warn('google_ads.access_token_rejected', { action: 'refreshing once' });
          await this.getAccessToken({ force: true });
          continue;
        }
        throw err;
      }
    });
  }

  /** Runs a GAQL query and returns every row across all pages. */
  async searchAll(customerId, query) {
    const rows = [];
    let pageToken;
    const seenTokens = new Set();
    do {
      const page = await this.searchPage(customerId, query, pageToken);
      this.stats.pages++;
      rows.push(...(page.results ?? []));
      pageToken = page.nextPageToken || undefined;
      if (pageToken) {
        if (seenTokens.has(pageToken)) throw new GoogleAdsApiError('Google Ads pagination returned a repeated page token; aborting to avoid an infinite loop');
        seenTokens.add(pageToken);
      }
    } while (pageToken);
    return rows;
  }
}
