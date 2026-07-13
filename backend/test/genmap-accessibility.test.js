import assert from 'node:assert/strict';
import test from 'node:test';

import { generateMap } from '../src/modules/gameMaster/genmap.js';
import { BLOCK } from '../../frontend/src/config.js';
import { setDims } from '../../frontend/src/world/dims.js';
import { idx } from '../../frontend/src/world/grid.js';
import { inspectDiggerCrystalAccess } from '../../frontend/src/world/steps/crystals.js';

const WIDTH = 40;
const HEIGHT = 64;
const SURFACE = 4;

function dirtMap() {
  setDims({ width: WIDTH, height: HEIGHT, surface: SURFACE });
  const grid = new Uint8Array(WIDTH * HEIGHT).fill(BLOCK.DIRT);
  for (let y = 0; y < SURFACE; y++) {
    for (let x = 0; x < WIDTH; x++) grid[idx(x, y)] = BLOCK.SKY;
  }
  return grid;
}

test('digger validator rejects a crystal sealed by a stone ring', () => {
  const grid = dirtMap();
  const x = 20;
  const y = 30;
  grid[idx(x, y)] = BLOCK.HCRST;
  grid[idx(x - 1, y)] = BLOCK.STONE;
  grid[idx(x + 1, y)] = BLOCK.STONE;
  grid[idx(x, y - 1)] = BLOCK.STONE;
  grid[idx(x, y + 1)] = BLOCK.STONE;

  const report = inspectDiggerCrystalAccess(grid);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [{ x, y, type: BLOCK.HCRST }]);
});

test('one thousand generated worlds give every crystal a lateral drilling route', () => {
  const worldCount = 1_000;

  for (let seed = 1; seed <= worldCount; seed++) {
    const generated = generateMap(seed);
    const access = inspectDiggerCrystalAccess(generated.renderMap);

    assert.equal(generated.valid, true, `seed ${seed} should produce a valid map`);
    assert.equal(access.ok, true, `seed ${seed} has sealed crystals: ${JSON.stringify(access.missing)}`);
  }
});
