import assert from 'node:assert/strict';
import test from 'node:test';

import { loadChainEnv } from '../src/modules/gameMaster/factory/config.js';

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

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
