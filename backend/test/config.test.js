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

test('loadConfig sources RES VMT / redeem program ids from the network profile', () => {
  const mainnet = loadConfig({ BACKEND_STORE: 'json', CHAIN_NETWORK: 'mainnet' });
  assert.deepEqual(mainnet.resVmtProgramIds, [MAINNET.RES_VMT_PROGRAM_ID]);
  assert.deepEqual(mainnet.redeemProgramIds, [MAINNET.REDEEM_PROGRAM_ID]);

  const testnet = loadConfig({ BACKEND_STORE: 'json', CHAIN_NETWORK: 'testnet' });
  assert.deepEqual(testnet.resVmtProgramIds, [TESTNET.RES_VMT_PROGRAM_ID]);
  assert.deepEqual(testnet.redeemProgramIds, [TESTNET.REDEEM_PROGRAM_ID]);
});
