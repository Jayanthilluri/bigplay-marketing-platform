import { ConfigError } from './errors.js';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date written as YYYY-MM-DD. */
export function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetweenInclusive(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
}

/**
 * "Today" in the ad account's time zone. Google Ads reports by account-local
 * date, so a UTC "today" would be a day ahead for a US account every evening.
 */
export function todayInTimeZone(timeZone = 'UTC', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Resolves the sync window.
 *  - explicit --start/--end wins;
 *  - otherwise --days N (backfill) or the configured lookback:
 *    [today - lookbackDays, today], i.e. lookback 7 => 8 calendar days.
 * The end date is clamped to today; future dates have no data.
 */
export function resolveDateRange({ today, lookbackDays = 7, start, end, days } = {}) {
  if (!isValidIsoDate(today)) throw new ConfigError(`Invalid "today" date: ${today}`);
  if ((start && !end) || (!start && end)) throw new ConfigError('--start and --end must be given together');

  let range;
  if (start) {
    for (const [name, v] of [['--start', start], ['--end', end]]) {
      if (!isValidIsoDate(v)) throw new ConfigError(`${name} must be a valid YYYY-MM-DD date, got "${v}"`);
    }
    if (start > end) throw new ConfigError(`--start (${start}) is after --end (${end})`);
    if (start > today) throw new ConfigError(`--start (${start}) is in the future (today is ${today})`);
    range = { start, end: end > today ? today : end };
  } else {
    const n = days ?? lookbackDays;
    if (!Number.isInteger(n) || n < 0) throw new ConfigError(`Lookback days must be a non-negative integer, got ${n}`);
    range = { start: addDays(today, -n), end: today };
  }
  return { ...range, days: daysBetweenInclusive(range.start, range.end) };
}

/** Splits a long backfill into consecutive windows of at most chunkDays. */
export function splitRange({ start, end }, chunkDays) {
  if (!Number.isInteger(chunkDays) || chunkDays < 1) throw new ConfigError(`chunkDays must be >= 1, got ${chunkDays}`);
  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = addDays(cursor, chunkDays - 1);
    const e = chunkEnd > end ? end : chunkEnd;
    chunks.push({ start: cursor, end: e, days: daysBetweenInclusive(cursor, e) });
    cursor = addDays(e, 1);
  }
  return chunks;
}
