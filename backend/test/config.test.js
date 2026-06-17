import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/index.js';

test('loadConfig defaults chain visibility timeout to 180 seconds', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
  });

  assert.equal(config.indexerTimeoutMs, 180000);
});

test('loadConfig exposes RES VMT program ids for backend services', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
    DIGGER_RES_VMT_PROGRAM_ID: '0x1111111111111111111111111111111111111111',
  });

  assert.deepEqual(config.resVmtProgramIds, ['0x1111111111111111111111111111111111111111']);
});
