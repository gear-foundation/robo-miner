import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';

import { loadConfig } from '../src/config/index.js';
import { MAINNET, TESTNET } from '../src/config/networks.js';

test('loadConfig defaults chain visibility timeout to 180 seconds', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
  });

  assert.equal(config.indexerTimeoutMs, 180000);
});

test('loadConfig configures bounded Vara.eth RPC and mainnet failover', () => {
  const config = loadConfig({ BACKEND_STORE: 'json', CHAIN_NETWORK: 'mainnet' });

  assert.deepEqual(config.varaEthWsEndpoints, [
    'wss://validator-1-eth.vara.network',
    'wss://validator-2-eth.vara.network',
  ]);
  assert.equal(config.varaEthRequestTimeoutMs, 15000);
  assert.equal(config.diggerDeployReceiptTimeoutMs, 120000);
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

test('loadConfig always enables redeem from the public network profile', () => {
  const treasuryKey = '0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const treasuryAddress = privateKeyToAccount(treasuryKey).address.toLowerCase();
  const config = loadConfig({
    BACKEND_STORE: 'json',
    CHAIN_NETWORK: 'mainnet',
    MAINNET_ADMIN_KEY: treasuryKey,
    REDEEM_TREASURY_ADDRESS: treasuryAddress,
    REDEEM_BACKEND_ENABLED: 'false',
  });

  assert.equal(Object.hasOwn(config, 'redeemBackendEnabled'), false);
  assert.equal(config.redeemTreasuryKey, treasuryKey);
  assert.equal(config.redeemTreasuryAddress, treasuryAddress);
  assert.equal(config.redeemUnit, BigInt(MAINNET.REDEEM_UNIT));
  assert.deepEqual(config.redeemRates, {
    scrst: BigInt(MAINNET.REDEEM_RATES.scrst),
    bcrst: BigInt(MAINNET.REDEEM_RATES.bcrst),
    hcrst: BigInt(MAINNET.REDEEM_RATES.hcrst),
  });
  assert.equal(config.redeemRequestTtlMs, MAINNET.REDEEM_REQUEST_TTL_MS);
  assert.equal(config.redeemWorkerIntervalMs, MAINNET.REDEEM_WORKER_INTERVAL_MS);
  assert.equal(config.redeemBurnTimeoutMs, MAINNET.REDEEM_BURN_TIMEOUT_MS);
  assert.equal(config.redeemLeaseMs, MAINNET.REDEEM_LEASE_MS);
  assert.equal(config.redeemMaxAttempts, MAINNET.REDEEM_MAX_ATTEMPTS);
});

test('loadConfig rejects a treasury key that does not match the public address', () => {
  assert.throws(() => loadConfig({
    BACKEND_STORE: 'json',
    CHAIN_NETWORK: 'mainnet',
    MAINNET_ADMIN_KEY: '0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a8412f4603b6b78690d',
  }), /expected 0x249579d43b0f3418f6e94b269c93714f106ee631/);
});
