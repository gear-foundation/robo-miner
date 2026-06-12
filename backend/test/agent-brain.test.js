import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAgentProfile,
  decideAction,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE,
} from '../src/modules/gameMaster/sim/agent-brain.js';

function blankMap(fill = TILE.EMPTY) {
  const map = new Array(MAP_WIDTH * MAP_HEIGHT).fill(fill);
  for (let x = 0; x < MAP_WIDTH; x += 1) map[x] = TILE.SURFACE;
  return map;
}

function setTile(map, x, y, tile) {
  map[y * MAP_WIDTH + x] = tile;
}

function agent(overrides = {}) {
  return {
    status: 1,
    x: 10,
    y: 10,
    hp: 1,
    ladders: 50,
    invScrst: 0,
    invBcrst: 0,
    invHcrst: 0,
    bankedScrst: 0,
    bankedBcrst: 0,
    bankedHcrst: 0,
    capacity: 10,
    lastActionSeq: 0,
    ...overrides,
  };
}

test('agent profiles are deterministic and independent', () => {
  assert.equal(createAgentProfile(0).name, 'balanced');
  assert.equal(createAgentProfile(1).name, 'sprinter');
  assert.equal(createAgentProfile(10).name, 'balanced');
});

test('resource profile can prefer a rarer mineral over an equally reachable common one', () => {
  const map = blankMap();
  setTile(map, 11, 10, TILE.SCRST);
  setTile(map, 10, 11, TILE.HCRST);

  const { action } = decideAction(agent(), map, {
    profile: {
      name: 'hcrst-test',
      valueWeight: 0,
      depthWeight: 0,
      resourceWeights: { [TILE.HCRST]: 100 },
    },
  });

  assert.equal(action?.fn, 'drill');
  assert.equal(action?.dir.name, 'down');
  assert.equal(action?.target.x, 10);
  assert.equal(action?.target.y, 11);
});

test('full backpack makes the agent return and place a ladder before climbing', () => {
  const map = blankMap();
  const { action, mode } = decideAction(agent({
    x: 5,
    y: 1,
    invScrst: 10,
    capacity: 10,
  }), map, { mode: 'mine', profile: createAgentProfile(0) });

  assert.equal(mode, 'surface');
  assert.equal(action?.fn, 'placeLadder');
  assert.equal(action?.dir.name, 'current');
  assert.deepEqual(action?.target, { x: 5, y: 1 });
});

test('agent refuses to dig itself into a hole when it has no ladder budget', () => {
  const map = blankMap();
  setTile(map, 10, 2, TILE.DIRT);
  setTile(map, 10, 3, TILE.SCRST);

  const { action } = decideAction(agent({
    x: 10,
    y: 1,
    ladders: 0,
  }), map, { mode: 'mine', profile: createAgentProfile(0) });

  assert.equal(action, null);
});
