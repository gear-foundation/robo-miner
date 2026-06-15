import assert from 'node:assert/strict';
import test from 'node:test';

import { inferDeathCause, inferStoneMoves, isAgentDead } from '../src/modules/gameMaster/sim/event-recovery.js';

const W = 40;
const H = 8;
const TILE = { EMPTY: 0, DIRT: 1, STONE: 2, LAVA: 3 };
const idx = (x, y) => y * W + x;

function mapWith(updates = []) {
  const map = new Array(W * H).fill(TILE.DIRT);
  for (let x = 0; x < W; x += 1) map[idx(x, 0)] = TILE.EMPTY;
  for (const [x, y, tile] of updates) map[idx(x, y)] = tile;
  return map;
}

test('infers a single StoneMoved from a confirmed map diff', () => {
  const before = mapWith([
    [3, 1, TILE.STONE],
    [3, 2, TILE.EMPTY],
    [3, 3, TILE.EMPTY],
    [3, 4, TILE.DIRT],
  ]);
  const after = before.slice();
  after[idx(3, 1)] = TILE.EMPTY;
  after[idx(3, 3)] = TILE.STONE;

  assert.deepEqual(inferStoneMoves(before, after, {
    width: W,
    columns: [3],
    drilledTarget: { x: 3, y: 2 },
  }), [{ fromX: 3, fromY: 1, x: 3, y: 3 }]);
});

test('infers chained StoneMoved events bottom-first like the contract', () => {
  const before = mapWith([
    [3, 1, TILE.STONE],
    [3, 2, TILE.STONE],
    [3, 3, TILE.EMPTY],
    [3, 4, TILE.EMPTY],
    [3, 5, TILE.EMPTY],
    [3, 6, TILE.DIRT],
  ]);
  const after = before.slice();
  after[idx(3, 1)] = TILE.EMPTY;
  after[idx(3, 2)] = TILE.EMPTY;
  after[idx(3, 4)] = TILE.STONE;
  after[idx(3, 5)] = TILE.STONE;

  assert.deepEqual(inferStoneMoves(before, after, {
    width: W,
    columns: [3],
    drilledTarget: { x: 3, y: 3 },
  }), [
    { fromX: 3, fromY: 2, x: 3, y: 5 },
    { fromX: 3, fromY: 1, x: 3, y: 4 },
  ]);
});

test('does not turn the drilled stone itself into a StoneMoved event', () => {
  const before = mapWith([[3, 2, TILE.STONE]]);
  const after = before.slice();
  after[idx(3, 2)] = TILE.EMPTY;

  assert.deepEqual(inferStoneMoves(before, after, {
    width: W,
    columns: [3],
    drilledTarget: { x: 3, y: 2 },
  }), []);
});

test('detects dead agents and infers lava or stone death cause', () => {
  assert.equal(isAgentDead({ status: 1, hp: 1 }), false);
  assert.equal(isAgentDead({ status: 3, hp: 0 }), true);

  const before = mapWith([[4, 2, TILE.LAVA]]);
  assert.equal(inferDeathCause({
    action: { fn: 'move', target: { x: 4, y: 2 } },
    beforeMap: before,
    after: { x: 4, y: 2 },
    width: W,
    tiles: TILE,
  }), TILE.LAVA);

  assert.equal(inferDeathCause({
    action: { fn: 'drill', target: { x: 3, y: 2 } },
    beforeMap: before,
    after: { x: 3, y: 3 },
    stoneMoves: [{ fromX: 3, fromY: 1, x: 3, y: 3 }],
    width: W,
    tiles: TILE,
  }), TILE.STONE);
});
