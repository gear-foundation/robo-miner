import assert from 'node:assert/strict';
import test from 'node:test';

import { loadChainEnv, loadConfig } from '../src/modules/gameMaster/factory/config.js';
import { adminKeyFor, MAINNET, TESTNET } from '../src/config/networks.js';

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
  } finally {
    restoreEnv('CHAIN_NETWORK', prev);
  }
});

test('baseWorlds never exceeds the pool cap', () => {
  assert.ok(loadConfig().baseWorlds <= loadConfig().poolSize);
});

test('admin key is resolved per network from env', () => {
  const env = { MAINNET_ADMIN_KEY: '0xmain', TESTNET_ADMIN_KEY: '0xtest' };
  assert.equal(adminKeyFor('mainnet', env), '0xmain');
  assert.equal(adminKeyFor('testnet', env), '0xtest');
  assert.equal(adminKeyFor('mainnet', {}), '');
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
