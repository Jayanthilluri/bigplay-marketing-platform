import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, assertTransition, determineStatus, summarizeRejections } from '../../src/pipeline/status.js';

test('determineStatus', () => {
  assert.equal(determineStatus({}), STATUS.SUCCESS);
  assert.equal(determineStatus({ rejected: 3 }), STATUS.PARTIAL);
  assert.equal(determineStatus({ checks: [{ passed: false, severity: 'warning' }] }), STATUS.SUCCESS);
  assert.equal(determineStatus({ rejected: 1, checks: [{ passed: false, severity: 'error' }] }), STATUS.FAILED);
  assert.equal(determineStatus({ fatalError: new Error('x') }), STATUS.FAILED);
});

test('only running can transition, and only to a terminal state', () => {
  for (const to of ['success', 'partial', 'failed']) assert.equal(assertTransition('running', to), to);
  assert.throws(() => assertTransition('running', 'running'));
  for (const from of ['success', 'partial', 'failed']) assert.throws(() => assertTransition(from, 'running'));
  assert.throws(() => assertTransition('success', 'failed'));
});

test('summarizeRejections groups reasons and strips row-specific values', () => {
  const s = summarizeRejections([
    { reasons: ['impressions is not an integer: "abc"'] },
    { reasons: ['impressions is not an integer: "x1"'] },
    { reasons: ['missing or invalid campaign.id'] },
  ]);
  assert.equal(s, 'impressions is not an integer: … (2); missing or invalid campaign.id (1)');
});
