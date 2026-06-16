import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTRACT_TILE, generateMap, gridHash, histogram } from '../src/modules/gameMaster/genmap.js';

test('operator maps vary by seed while keeping the crystal economy fixed', () => {
  const seeds = Array.from({ length: 16 }, (_, index) => (1000 + index * 77777) >>> 0);
  const maps = seeds.map((seed) => generateMap(seed));
  const hashes = new Set();
  const stoneCounts = new Set();
  const lavaCounts = new Set();
  const emptyCounts = new Set();

  for (const map of maps) {
    const counts = histogram(map.map);
    assert.equal(map.valid, true, `seed ${map.seed} should generate a valid map`);
    assert.equal(counts[CONTRACT_TILE.SCRST], 77);
    assert.equal(counts[CONTRACT_TILE.BCRST], 19);
    assert.equal(counts[CONTRACT_TILE.HCRST], 4);
    hashes.add(gridHash(map.map));
    stoneCounts.add(counts[CONTRACT_TILE.STONE] || 0);
    lavaCounts.add(counts[CONTRACT_TILE.LAVA] || 0);
    emptyCounts.add(counts[CONTRACT_TILE.EMPTY] || 0);
  }

  assert.equal(hashes.size, seeds.length, 'each sampled seed should produce a distinct map hash');
  assert.ok(stoneCounts.size >= 6, 'stone obstacle density should vary across maps');
  assert.ok(lavaCounts.size >= 6, 'lava hazard density should vary across maps');
  assert.ok(emptyCounts.size >= 6, 'cave/open-space density should vary across maps');
});
