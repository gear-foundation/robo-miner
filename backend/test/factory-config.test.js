import assert from 'node:assert/strict';
import test from 'node:test';

import { loadChainEnv, loadConfig } from '../src/modules/gameMaster/factory/config.js';

test('loadChainEnv uses the first configured RES VMT program for world economy setup', () => {
  const original = {
    DIGGER_RES_VMT_PROGRAM_ID: process.env.DIGGER_RES_VMT_PROGRAM_ID,
    INDEXER_RES_VMT_PROGRAM_IDS: process.env.INDEXER_RES_VMT_PROGRAM_IDS,
  };
  process.env.DIGGER_RES_VMT_PROGRAM_ID = '';
  process.env.INDEXER_RES_VMT_PROGRAM_IDS = '0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222';

  try {
    const env = loadChainEnv();
    assert.equal(env.resVmtProgramId, '0x1111111111111111111111111111111111111111');
  } finally {
    restoreEnv('DIGGER_RES_VMT_PROGRAM_ID', original.DIGGER_RES_VMT_PROGRAM_ID);
    restoreEnv('INDEXER_RES_VMT_PROGRAM_IDS', original.INDEXER_RES_VMT_PROGRAM_IDS);
  }
});

test('factory disables runtime program creation by default', () => {
  const original = snapshotEnv('FACTORY_ALLOW_CREATE', 'FACTORY_POOL_MAX', 'FACTORY_MIN_OPEN');
  delete process.env.FACTORY_ALLOW_CREATE;
  process.env.FACTORY_POOL_MAX = '6';
  process.env.FACTORY_MIN_OPEN = '3';

  try {
    const fixedPoolConfig = loadConfig();
    assert.equal(fixedPoolConfig.allowCreate, false);
    // FACTORY_MIN_OPEN is the base world count and must NOT be forced up to the pool
    // size — the factory keeps 3 running and only grows toward 6 on demand.
    assert.equal(fixedPoolConfig.baseWorlds, 3);
    assert.equal(fixedPoolConfig.poolSize, 6);

    process.env.FACTORY_ALLOW_CREATE = 'true';
    const expandableConfig = loadConfig();
    assert.equal(expandableConfig.allowCreate, true);
    assert.equal(expandableConfig.baseWorlds, 3);
  } finally {
    restoreSnapshot(original);
  }
});

test('baseWorlds clamps down to the pool size, never up', () => {
  const original = snapshotEnv('FACTORY_ALLOW_CREATE', 'FACTORY_POOL_MAX', 'FACTORY_MIN_OPEN');
  delete process.env.FACTORY_ALLOW_CREATE;
  process.env.FACTORY_POOL_MAX = '4';
  process.env.FACTORY_MIN_OPEN = '8'; // larger than the pool — base cannot exceed the cap

  try {
    const cfg = loadConfig();
    assert.equal(cfg.baseWorlds, 4);
  } finally {
    restoreSnapshot(original);
  }
});

function snapshotEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreSnapshot(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) restoreEnv(name, value);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
