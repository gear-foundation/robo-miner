import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/index.js';
import { MAINNET, TESTNET } from '../src/config/networks.js';

test('loadConfig defaults chain visibility timeout to 180 seconds', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
  });

  assert.equal(config.indexerTimeoutMs, 180000);
});

test('loadConfig defaults Postgres writes to bounded retries', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
  });

  assert.equal(config.databaseConnectionTimeoutMs, 5000);
  assert.equal(config.databaseQueryTimeoutMs, 20000);
  assert.equal(config.databaseLockTimeoutMs, 5000);
  assert.equal(config.databaseStatementTimeoutMs, 15000);
  assert.equal(config.databaseIdleTransactionTimeoutMs, 15000);
  assert.equal(config.databaseUpdateMaxAttempts, 3);
  assert.equal(config.databaseUpdateRetryBaseMs, 100);
});

test('loadConfig sources RES VMT / redeem program ids from the network profile', () => {
  const mainnet = loadConfig({ BACKEND_STORE: 'json', CHAIN_NETWORK: 'mainnet' });
  assert.deepEqual(mainnet.resVmtProgramIds, [MAINNET.RES_VMT_PROGRAM_ID]);
  assert.deepEqual(mainnet.redeemProgramIds, [MAINNET.REDEEM_PROGRAM_ID]);

  const testnet = loadConfig({ BACKEND_STORE: 'json', CHAIN_NETWORK: 'testnet' });
  assert.deepEqual(testnet.resVmtProgramIds, [TESTNET.RES_VMT_PROGRAM_ID]);
  assert.deepEqual(testnet.redeemProgramIds, [TESTNET.REDEEM_PROGRAM_ID]);
});
