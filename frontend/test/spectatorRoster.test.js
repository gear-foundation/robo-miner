import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canFollowSpectatorAgent,
  findSpectatorAgent,
  localCargoCount,
  spectatorAgentKey,
  spectatorDepth,
  spectatorViewportPoint,
} from '../src/scenes/spectatorRoster.js';

test('spectator roster keeps chain and local diggers distinct and stable', () => {
  assert.equal(
    spectatorAgentKey({ owner: '0xABCD', id: 4 }),
    'chain:0xabcd',
  );
  assert.equal(spectatorAgentKey({ id: 4, name: 'local-bot' }), 'local:4');
});

test('spectator roster resolves the current digger after a snapshot replaces it', () => {
  const key = spectatorAgentKey({ owner: '0xABCD' });
  const stale = { owner: '0xabcd', drawX: 4, drawY: 8 };
  const live = { owner: '0xABCD', drawX: 17, drawY: 22 };

  assert.notEqual(stale, live);
  assert.equal(findSpectatorAgent([live], key), live);
  assert.equal(findSpectatorAgent([], key), null);
});

test('spectator roster derives depth, cargo, and follow eligibility', () => {
  assert.equal(spectatorDepth({ ty: 14 }, 4), 11);
  assert.equal(spectatorDepth({ ty: 1 }, 4), 0);
  assert.equal(localCargoCount({ cargoCount: 3, cargo: { iron: 9 } }), 3);
  assert.equal(localCargoCount({ cargo: { iron: 2, coal: 4 } }), 6);
  assert.equal(canFollowSpectatorAgent({ drawX: 8, drawY: 9 }), true);
  assert.equal(canFollowSpectatorAgent({ drawX: 8, drawY: 9, exited: true }), false);
});

test('spectator popup maps world coordinates into the CSS canvas viewport', () => {
  assert.deepEqual(
    spectatorViewportPoint(
      130,
      70,
      { x: 10, y: 20, scrollX: 100, scrollY: 50, zoom: 2, width: 400, height: 200 },
      { left: 30, top: 40, width: 800, height: 400 },
    ),
    { x: 170, y: 160 },
  );
});
