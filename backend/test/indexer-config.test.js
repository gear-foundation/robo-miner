import assert from 'node:assert/strict';
import test from 'node:test';

import { programsFromConfig } from '../src/modules/indexer/liveReader.js';

test('programsFromConfig accepts parsed config lists and db world program objects', () => {
  const programs = programsFromConfig({
    worldProgramIds: [
      '0xb0860e1262e3677a65e24f821c8b6e4e5f5cd04b',
      { programType: 'world', programId: '0xcd8abd56353212b1c7b7107c150fbea366eb8663' },
    ],
    diggerProgramIds: ['0x1111111111111111111111111111111111111111'],
    resVmtProgramIds: ['0x2222222222222222222222222222222222222222'],
    redeemProgramIds: ['0x3333333333333333333333333333333333333333'],
  });

  assert.deepEqual(programs, [
    { programType: 'world', programId: '0xb0860e1262e3677a65e24f821c8b6e4e5f5cd04b' },
    { programType: 'world', programId: '0xcd8abd56353212b1c7b7107c150fbea366eb8663' },
    { programType: 'proxy', programId: '0x1111111111111111111111111111111111111111' },
    { programType: 'resVmt', programId: '0x2222222222222222222222222222222222222222' },
    { programType: 'redeem', programId: '0x3333333333333333333333333333333333333333' },
  ]);
});
