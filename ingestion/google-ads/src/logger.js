// Minimal structured logger. Every message and field passes through a
// redactor that masks the values of known secrets, so a token that leaks
// into an error message from a library is still never printed.

const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

export function redact(input) {
  if (input === undefined || input === null) return input;
  let text = typeof input === 'string' ? input : JSON.stringify(input);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  // Bearer tokens / OAuth access tokens that were never registered.
  text = text.replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED]');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
  // Passwords embedded in postgres:// URLs.
  text = text.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@');
  return text;
}

function emit(level, message, fields) {
  const line = { ts: new Date().toISOString(), level, msg: message };
  if (fields && Object.keys(fields).length) line.data = fields;
  const out = redact(JSON.stringify(line));
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  silent: false,
  info(msg, fields) { if (!this.silent) emit('info', msg, fields); },
  warn(msg, fields) { if (!this.silent) emit('warn', msg, fields); },
  error(msg, fields) { if (!this.silent) emit('error', msg, fields); },
};

export function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [`${err.name || 'Error'}: ${err.message}`];
  if (err.httpStatus) parts.push(`http=${err.httpStatus}`);
  if (err.errorCodes?.length) parts.push(`codes=${err.errorCodes.join(',')}`);
  if (err.requestId) parts.push(`requestId=${err.requestId}`);
  return redact(parts.join(' '));
}
