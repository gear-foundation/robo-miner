import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canFollowSpectatorAgent,
  localCargoCount,
  spectatorAgentKey,
  spectatorDepth,
} from '../src/scenes/spectatorRoster.js';

test('spectator roster keeps chain and local diggers distinct and stable', () => {
  assert.equal(
    spectatorAgentKey({ owner: '0xABCD', id: 4 }),
    'chain:0xabcd',
  );
  assert.equal(spectatorAgentKey({ id: 4, name: 'local-bot' }), 'local:4');
});

test('spectator roster derives depth, cargo, and follow eligibility', () => {
  assert.equal(spectatorDepth({ ty: 14 }, 4), 11);
  assert.equal(spectatorDepth({ ty: 1 }, 4), 0);
  assert.equal(localCargoCount({ cargoCount: 3, cargo: { iron: 9 } }), 3);
  assert.equal(localCargoCount({ cargo: { iron: 2, coal: 4 } }), 6);
  assert.equal(canFollowSpectatorAgent({ drawX: 8, drawY: 9 }), true);
  assert.equal(canFollowSpectatorAgent({ drawX: 8, drawY: 9, exited: true }), false);
});
