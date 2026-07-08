import assert from 'node:assert/strict';
import test from 'node:test';

import { poolCodeMismatch } from '../src/modules/gameMaster/factory/drivers/chainDriver.js';

test('program pools with persisted programs are stale when code id changes', () => {
  const expected = '0x9e5e17dabbe4c1c0ae20b4c48981bbca866ffe24f1427fa807b98ddb57a72ff2';

  assert.equal(poolCodeMismatch({ codeId: expected, programs: ['0xabc'] }, expected), false);
  assert.equal(poolCodeMismatch({ codeId: '0xold', programs: ['0xabc'] }, expected), true);
  assert.equal(poolCodeMismatch({ programs: ['0xabc'] }, expected), true);
  assert.equal(poolCodeMismatch({ codeId: '0xold', programs: [] }, expected), false);
});
