import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAdsClient, classifyApiError } from '../../src/googleAds/client.js';
import { GoogleAdsApiError, GoogleAdsAuthError } from '../../src/errors.js';

const config = { clientId: 'cid', clientSecret: 'csecret', developerToken: 'devtok', refreshToken: 'rtok', loginCustomerId: '9999999999', apiVersion: 'v25', maxRetries: 3 };
const quiet = { info() {}, warn() {}, error() {} };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function adsFailure(status, codeKey, codeValue, extra = {}) {
  return json(status, {
    error: {
      code: status, message: 'Request contains an invalid argument.', status: 'X',
      details: [{
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [{ errorCode: { [codeKey]: codeValue }, message: `${codeValue} happened`, ...extra }],
        requestId: 'req-123',
      }],
    },
  });
}

/** Scripted fetch: token requests always succeed unless overridden; search responses follow `script`. */
function scriptedFetch(script, { tokenResponses = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2')) {
      const next = tokenResponses.shift();
      if (next) return typeof next === 'function' ? next() : next;
      return json(200, { access_token: `ya29.token${calls.length}`, expires_in: 3599 });
    }
    const next = script.shift();
    if (!next) throw new Error('script exhausted');
    return typeof next === 'function' ? next(init) : next;
  };
  return { fetchImpl, calls };
}

function client(fetchImpl, sleeps = []) {
  return new GoogleAdsClient(config, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, logger: quiet, random: () => 0 });
}

test('follows nextPageToken across pages and sends the required headers', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    json(200, { results: [{ n: 1 }, { n: 2 }], nextPageToken: 'p2' }),
    json(200, { results: [{ n: 3 }], nextPageToken: 'p3' }),
    json(200, { results: [{ n: 4 }] }),
  ]);
  const rows = await client(fetchImpl).searchAll('1234567890', 'SELECT x FROM y');
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4]);
  const searches = calls.filter((c) => c.url.includes('googleAds:search'));
  assert.equal(searches.length, 3);
  assert.equal(searches[0].url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
  assert.deepEqual(JSON.parse(searches[1].init.body), { query: 'SELECT x FROM y', pageToken: 'p2' });
  assert.equal(searches[0].init.headers['developer-token'], 'devtok');
  assert.equal(searches[0].init.headers['login-customer-id'], '9999999999');
  assert.match(searches[0].init.headers.authorization, /^Bearer ya29\./);
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'access token reused across pages');
});

test('empty result (no "results" key) is an empty list', async () => {
  const { fetchImpl } = scriptedFetch([json(200, { fieldMask: 'x' })]);
  assert.deepEqual(await client(fetchImpl).searchAll('1', 'q'), []);
});

test('rate limit: retries and honours the quota retryDelay', async () => {
  const sleeps = [];
  const { fetchImpl } = scriptedFetch([
    adsFailure(429, 'quotaError', 'RESOURCE_TEMPORARILY_EXHAUSTED', { details: { quotaErrorDetails: { retryDelay: '7s' } } }),
    json(200, { results: [{ ok: true }] }),
  ]);
  const rows = await client(fetchImpl, sleeps).searchAll('1', 'q');
  assert.equal(rows.length, 1);
  assert.deepEqual(sleeps, [7000]);
});

test('daily-quota exhaustion with a long retryDelay fails fast', async () => {
  const sleeps = [];
  const { fetchImpl } = scriptedFetch([
    adsFailure(429, 'quotaError', 'RESOURCE_EXHAUSTED', { details: { quotaErrorDetails: { retryDelay: '86400s' } } }),
  ]);
  await assert.rejects(client(fetchImpl, sleeps).searchAll('1', 'q'), (e) => e instanceof GoogleAdsApiError && !e.retryable);
  assert.deepEqual(sleeps, []);
});

test('5xx and network errors retry with exponential backoff, then give up', async () => {
  const sleeps = [];
  const netErr = () => { throw new TypeError('fetch failed'); };
  const { fetchImpl } = scriptedFetch([json(503, { error: { code: 503, message: 'unavailable' } }), netErr, json(500, {}), json(502, {})]);
  await assert.rejects(client(fetchImpl, sleeps).searchAll('1', 'q'), (e) => {
    assert.ok(e instanceof GoogleAdsApiError);
    assert.match(e.message, /gave up after 4 attempts/);
    return true;
  });
  assert.deepEqual(sleeps, [500, 1000, 2000]); // equal-jitter with random()=0: base/2
});

test('transient failure then success', async () => {
  const { fetchImpl } = scriptedFetch([json(500, {}), json(200, { results: [{ a: 1 }] })]);
  assert.equal((await client(fetchImpl).searchAll('1', 'q')).length, 1);
});

test('expired/revoked refresh token (invalid_grant) fails immediately, no retries', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = scriptedFetch([], { tokenResponses: [json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })] });
  await assert.rejects(client(fetchImpl, sleeps).searchAll('1', 'q'), (e) => {
    assert.ok(e instanceof GoogleAdsAuthError);
    assert.match(e.message, /expired or revoked/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('bad OAuth client fails immediately with a clear message', async () => {
  const { fetchImpl } = scriptedFetch([], { tokenResponses: [json(401, { error: 'invalid_client' })] });
  await assert.rejects(client(fetchImpl).getAccessToken(), /GOOGLE_ADS_CLIENT_ID/);
});

test('rejected access token is refreshed once, then the call succeeds', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    adsFailure(401, 'authenticationError', 'OAUTH_TOKEN_EXPIRED'),
    json(200, { results: [{ ok: 1 }] }),
  ]);
  const c = client(fetchImpl);
  assert.equal((await c.searchAll('1', 'q')).length, 1);
  assert.equal(calls.filter((x) => x.url.includes('oauth2')).length, 2);
  assert.equal(c.stats.tokenRefreshes, 2);
});

test('persistent 401 after a refresh is an auth error, not an endless loop', async () => {
  const { fetchImpl } = scriptedFetch([adsFailure(401, 'authenticationError', 'OAUTH_TOKEN_EXPIRED'), adsFailure(401, 'authenticationError', 'OAUTH_TOKEN_EXPIRED')]);
  await assert.rejects(client(fetchImpl).searchAll('1', 'q'), GoogleAdsAuthError);
});

test('permission / developer-token problems are auth errors and not retried', async () => {
  const sleeps = [];
  const { fetchImpl } = scriptedFetch([adsFailure(403, 'authorizationError', 'DEVELOPER_TOKEN_NOT_APPROVED')]);
  await assert.rejects(client(fetchImpl, sleeps).searchAll('1', 'q'), (e) => e instanceof GoogleAdsAuthError && /DEVELOPER_TOKEN_NOT_APPROVED/.test(e.message));
  assert.deepEqual(sleeps, []);
});

test('invalid query (400) is not retried and carries the request id', async () => {
  const sleeps = [];
  const { fetchImpl } = scriptedFetch([adsFailure(400, 'queryError', 'UNRECOGNIZED_FIELD')]);
  await assert.rejects(client(fetchImpl, sleeps).searchAll('1', 'q'), (e) => {
    assert.ok(e instanceof GoogleAdsApiError);
    assert.equal(e.retryable, false);
    assert.equal(e.requestId, 'req-123');
    assert.deepEqual(e.errorCodes, ['queryError.UNRECOGNIZED_FIELD']);
    return true;
  });
  assert.deepEqual(sleeps, []);
});

test('unexpected response shapes are errors', async () => {
  const { fetchImpl } = scriptedFetch([json(200, { results: 'nope' })]);
  await assert.rejects(client(fetchImpl).searchAll('1', 'q'), /not an array/);
  const { fetchImpl: f2 } = scriptedFetch([json(200, { results: [], nextPageToken: 'same' }), json(200, { results: [], nextPageToken: 'same' })]);
  await assert.rejects(client(f2).searchAll('1', 'q'), /repeated page token/);
});

test('classifyApiError falls back to Retry-After header', () => {
  const e = classifyApiError(429, {}, new Headers({ 'retry-after': '12' }));
  assert.equal(e.retryable, true);
  assert.equal(e.retryDelayMs, 12000);
});
