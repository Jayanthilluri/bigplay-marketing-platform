// Error taxonomy. `retryable` drives the retry loop: only transient failures
// (rate limits, 5xx, network) are retried. Auth and invalid-request errors
// fail fast so a bad refresh token never hammers Google.

export class PipelineError extends Error {
  constructor(message, { code = 'PIPELINE_ERROR', retryable = false, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export class ConfigError extends PipelineError {
  constructor(message, opts = {}) {
    super(message, { code: 'CONFIG_ERROR', ...opts });
  }
}

// Expired/revoked refresh token, bad client secret, unapproved developer
// token, missing account access. Never retried.
export class GoogleAdsAuthError extends PipelineError {
  constructor(message, opts = {}) {
    super(message, { code: 'GOOGLE_ADS_AUTH_ERROR', ...opts, retryable: false });
  }
}

export class GoogleAdsApiError extends PipelineError {
  constructor(message, { httpStatus, requestId, errorCodes = [], retryDelayMs, ...opts } = {}) {
    super(message, { code: 'GOOGLE_ADS_API_ERROR', ...opts });
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.errorCodes = errorCodes;
    this.retryDelayMs = retryDelayMs;
  }
}

export class DatabaseError extends PipelineError {
  constructor(message, opts = {}) {
    super(message, { code: 'DATABASE_ERROR', ...opts });
  }
}

// Another sync holds the advisory lock; this run exits without touching data.
export class ConcurrentRunError extends PipelineError {
  constructor(message) {
    super(message, { code: 'CONCURRENT_RUN' });
  }
}
