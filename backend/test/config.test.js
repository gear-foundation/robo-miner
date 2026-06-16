import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/index.js';

test('loadConfig defaults chain visibility timeout to 180 seconds', () => {
  const config = loadConfig({
    BACKEND_STORE: 'json',
  });

  assert.equal(config.indexerTimeoutMs, 180000);
});
