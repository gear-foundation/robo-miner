import assert from 'node:assert/strict';
import test from 'node:test';

import { resetRequestDecision } from '../src/modules/gameMaster/factory/resetRequest.js';

test('pending reset requests are applied by any matching factory process', () => {
  assert.deepEqual(
    resetRequestDecision({
      status: 'pending',
      network: 'testnet',
      createdAt: '2026-06-25T11:50:12.658Z',
    }, {
      network: 'testnet',
      processStartedAtMs: Date.parse('2026-06-25T11:51:00.000Z'),
    }),
    { action: 'apply', reason: 'pending' },
  );
});

test('already-applied reset requests stop factory processes that predate the reset', () => {
  assert.deepEqual(
    resetRequestDecision({
      status: 'applied',
      network: 'testnet',
      createdAt: '2026-06-25T11:50:12.658Z',
    }, {
      network: 'testnet',
      processStartedAtMs: Date.parse('2026-06-25T11:49:00.000Z'),
    }),
    { action: 'scrub_and_exit', reason: 'applied_after_process_start' },
  );
});

test('already-applied reset requests are ignored by replacement factory processes', () => {
  assert.deepEqual(
    resetRequestDecision({
      status: 'applied',
      network: 'testnet',
      createdAt: '2026-06-25T11:50:12.658Z',
    }, {
      network: 'testnet',
      processStartedAtMs: Date.parse('2026-06-25T11:51:00.000Z'),
    }),
    { action: 'ignore', reason: 'applied' },
  );
});

test('reset requests for another network are ignored', () => {
  assert.deepEqual(
    resetRequestDecision({
      status: 'pending',
      network: 'mainnet',
      createdAt: '2026-06-25T11:50:12.658Z',
    }, {
      network: 'testnet',
      processStartedAtMs: Date.parse('2026-06-25T11:49:00.000Z'),
    }),
    { action: 'ignore', reason: 'network_mismatch' },
  );
});
