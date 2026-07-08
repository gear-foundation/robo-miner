import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRestorableProgramSnapshot,
  persistedWorldLooksOpened,
} from '../src/modules/gameMaster/factory/recovery.js';

test('factory recovery does not publish uninitialized pooled programs', () => {
  assert.equal(persistedWorldLooksOpened({
    id: 'w001',
    programId: '0x29849e06a45e8fe3e480125cc0252c096bbd0213',
    sessionId: 0,
    seed: '0',
    mapHash: '9d8d7e9f',
  }), false);

  assert.equal(isRestorableProgramSnapshot({
    session: [0, 0, 0, 0],
    rawGrid: [544235885, 1847620457, 1814066287, 1701077359, 100, 0],
  }), false);
});

test('factory recovery accepts opened contract sessions with a real map', () => {
  assert.equal(persistedWorldLooksOpened({
    id: 'w001',
    programId: '0x433992e1ab3a0cc3b7828ca0e260288aa4cdeb6b',
    sessionId: 1,
    seed: '1139913956',
    mapHash: 'abc123',
  }), true);

  assert.equal(isRestorableProgramSnapshot({
    session: [1, 1139913956, 0, 0],
    rawGrid: [20, 20, 20, 1],
  }), true);
});
