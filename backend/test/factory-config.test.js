import assert from 'node:assert/strict';
import test from 'node:test';

import { loadChainEnv, loadConfig } from '../src/modules/gameMaster/factory/config.js';
import { adminKeyFor, DEFAULT_WORLD_CONFIG, MAINNET, TESTNET } from '../src/config/networks.js';

test('mainnet profile drives the factory config', () => {
  const prev = process.env.CHAIN_NETWORK;
  process.env.CHAIN_NETWORK = 'mainnet';
  try {
    const c = loadConfig();
    assert.equal(c.poolSize, MAINNET.POOL_MAX);
    assert.equal(c.baseWorlds, 6);
    assert.equal(c.allowCreate, false);
    assert.equal(c.lobbyMin, 1);
    assert.equal(c.lobbyCap, 10);
    assert.equal(c.sessionAutofinish, false);
    const e = loadChainEnv();
    assert.equal(e.network, 'mainnet');
    assert.equal(e.router, MAINNET.ROUTER);
    assert.equal(e.codeId, MAINNET.WORLD_CODE_ID);
    assert.deepEqual(e.worldConfig, DEFAULT_WORLD_CONFIG);
    assert.equal(e.balanceMinWvara, MAINNET.BALANCE_MIN_WVARA);
    assert.equal(e.topUp, MAINNET.TOP_UP_WEI);
  } finally {
    restoreEnv('CHAIN_NETWORK', prev);
  }
});

test('testnet profile drives the factory config', () => {
  const prev = process.env.CHAIN_NETWORK;
  process.env.CHAIN_NETWORK = 'testnet';
  try {
    const c = loadConfig();
    assert.equal(c.allowCreate, true);
    assert.equal(c.lobbyMin, 1);
    const e = loadChainEnv();
    assert.equal(e.network, 'testnet');
    assert.equal(e.router, TESTNET.ROUTER);
    assert.equal(e.varaWs, TESTNET.VARA_WS);
    assert.equal(e.codeId, TESTNET.WORLD_CODE_ID);
    assert.equal(e.codeId, '0xc0aee115c4256e5fa18ddd91764bf23354883989cf2cfe04ad4e6dedc118e8af');
    assert.equal(e.resVmtProgramId, '0x4888c0ed7cc9a61e0f537e88d6abc93e15d91240');
    assert.deepEqual(e.worldConfig, DEFAULT_WORLD_CONFIG);
  } finally {
    restoreEnv('CHAIN_NETWORK', prev);
  }
});

test('world config can be overridden for factory-created programs', () => {
  const prevNetwork = process.env.CHAIN_NETWORK;
  const prevConfig = process.env.DIGGER_WORLD_CONFIG;
  process.env.CHAIN_NETWORK = 'testnet';
  process.env.DIGGER_WORLD_CONFIG = JSON.stringify([
    [40, 64, 100, 77, 19, 4, 1, 35, 7, 2500],
    [2, 1, 2, 5, 1, 10],
  ]);
  try {
    assert.deepEqual(loadChainEnv().worldConfig, [
      [40, 64, 100, 77, 19, 4, 1, 35, 7, 2500],
      [2, 1, 2, 5, 1, 10],
    ]);
  } finally {
    restoreEnv('CHAIN_NETWORK', prevNetwork);
    restoreEnv('DIGGER_WORLD_CONFIG', prevConfig);
  }
});

test('baseWorlds never exceeds the pool cap', () => {
  assert.ok(loadConfig().baseWorlds <= loadConfig().poolSize);
});

test('admin key is resolved per network from env', () => {
  const env = { MAINNET_ADMIN_KEY: '0xmain', TESTNET_ADMIN_KEY: '0xtest' };
  assert.equal(adminKeyFor('mainnet', env), '0xmain');
  assert.equal(adminKeyFor('testnet', env), '0xtest');
  assert.equal(adminKeyFor('testnet', { DIGGER_ADMIN_KEY: '0xdigger' }), '0xdigger');
  assert.equal(adminKeyFor('testnet', { TESTNET_ADMIN_KEY: '0xtest', DIGGER_ADMIN_KEY: '0xdigger' }), '0xtest');
  assert.equal(adminKeyFor('mainnet', {}), '');
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
