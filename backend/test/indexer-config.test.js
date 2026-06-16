import assert from 'node:assert/strict';
import test from 'node:test';

import { programsFromConfig } from '../src/modules/indexer/liveReader.js';

test('programsFromConfig accepts parsed config lists and db world program objects', () => {
  const programs = programsFromConfig({
    worldProgramIds: [
      '0xdb0069475ed6d5fc3d9547e467de059a7cafc3ae',
      { programType: 'world', programId: '0x13bf8eb61a871b60d0d8cc1c3ad4ac8a7a58289d' },
    ],
    diggerProgramIds: ['0x1111111111111111111111111111111111111111'],
    resVmtProgramIds: ['0x2222222222222222222222222222222222222222'],
    redeemProgramIds: ['0x3333333333333333333333333333333333333333'],
  });

  assert.deepEqual(programs, [
    { programType: 'world', programId: '0xdb0069475ed6d5fc3d9547e467de059a7cafc3ae' },
    { programType: 'world', programId: '0x13bf8eb61a871b60d0d8cc1c3ad4ac8a7a58289d' },
    { programType: 'proxy', programId: '0x1111111111111111111111111111111111111111' },
    { programType: 'resVmt', programId: '0x2222222222222222222222222222222222222222' },
    { programType: 'redeem', programId: '0x3333333333333333333333333333333333333333' },
  ]);
});
