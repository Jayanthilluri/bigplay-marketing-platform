import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, isValidIsoDate, resolveDateRange, splitRange, todayInTimeZone } from '../../src/dateRange.js';
import { ConfigError } from '../../src/errors.js';

test('default lookback is today-7 through today (8 days inclusive)', () => {
  assert.deepEqual(resolveDateRange({ today: '2026-10-06' }), { start: '2026-09-29', end: '2026-10-06', days: 8 });
});

test('lookback is configurable', () => {
  assert.deepEqual(resolveDateRange({ today: '2026-10-06', lookbackDays: 3 }), { start: '2026-10-03', end: '2026-10-06', days: 4 });
  assert.deepEqual(resolveDateRange({ today: '2026-10-06', lookbackDays: 0 }), { start: '2026-10-06', end: '2026-10-06', days: 1 });
});

test('--days overrides lookback for backfills', () => {
  assert.deepEqual(resolveDateRange({ today: '2026-10-06', lookbackDays: 7, days: 90 }), { start: '2026-07-08', end: '2026-10-06', days: 91 });
});

test('explicit range wins and end is clamped to today', () => {
  assert.deepEqual(resolveDateRange({ today: '2026-10-06', start: '2026-10-01', end: '2026-10-03' }), { start: '2026-10-01', end: '2026-10-03', days: 3 });
  assert.deepEqual(resolveDateRange({ today: '2026-10-06', start: '2026-10-05', end: '2026-10-20' }), { start: '2026-10-05', end: '2026-10-06', days: 2 });
});

test('invalid ranges are rejected', () => {
  assert.throws(() => resolveDateRange({ today: '2026-10-06', start: '2026-10-05' }), ConfigError);
  assert.throws(() => resolveDateRange({ today: '2026-10-06', start: '2026-10-05', end: '2026-10-01' }), /after/);
  assert.throws(() => resolveDateRange({ today: '2026-10-06', start: '2026-02-30', end: '2026-03-01' }), /valid/);
  assert.throws(() => resolveDateRange({ today: '2026-10-06', start: '2026-11-01', end: '2026-11-02' }), /future/);
  assert.throws(() => resolveDateRange({ today: '2026-10-06', lookbackDays: -1 }), ConfigError);
});

test('month, year and leap-day boundaries', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(resolveDateRange({ today: '2026-01-03' }).start, '2025-12-27');
});

test('isValidIsoDate', () => {
  assert.ok(isValidIsoDate('2026-10-06'));
  for (const bad of ['2026-13-01', '2026-02-29', '20261006', '2026-1-6', '', null, 20261006]) assert.equal(isValidIsoDate(bad), false, String(bad));
});

test('today follows the account time zone, not UTC', () => {
  const now = new Date('2026-10-07T02:30:00Z'); // 22:30 on Oct 6 in New York
  assert.equal(todayInTimeZone('UTC', now), '2026-10-07');
  assert.equal(todayInTimeZone('America/New_York', now), '2026-10-06');
});

test('splitRange chunks a backfill without gaps or overlap', () => {
  const chunks = splitRange({ start: '2026-07-08', end: '2026-10-06' }, 30);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0].start, '2026-07-08');
  assert.equal(chunks.at(-1).end, '2026-10-06');
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, addDays(chunks[i - 1].end, 1));
  assert.equal(chunks.reduce((n, c) => n + c.days, 0), 91);
});
