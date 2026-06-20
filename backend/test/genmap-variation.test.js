import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTRACT_TILE, generateMap, gridHash, histogram } from '../src/modules/gameMaster/genmap.js';

test('operator maps vary by seed while keeping the crystal economy fixed', () => {
  const seeds = Array.from({ length: 16 }, (_, index) => (1000 + index * 77777) >>> 0);
  const maps = seeds.map((seed) => generateMap(seed));
  const hashes = new Set();
  const stoneCounts = new Set();
  const chestCounts = new Set();
  const chestPositions = new Set();
  const emptyCounts = new Set();

  for (const map of maps) {
    const counts = histogram(map.map);
    assert.equal(map.valid, true, `seed ${map.seed} should generate a valid map`);
    assert.equal(counts[CONTRACT_TILE.SCRST], 77);
    assert.equal(counts[CONTRACT_TILE.BCRST], 19);
    assert.equal(counts[CONTRACT_TILE.HCRST], 4);
    const chestCount = counts[CONTRACT_TILE.CHEST] || 0;
    assert.ok(chestCount >= 20 && chestCount <= 24, `seed ${map.seed} should include 20-24 chests, got ${chestCount}`);
    hashes.add(gridHash(map.map));
    stoneCounts.add(counts[CONTRACT_TILE.STONE] || 0);
    chestCounts.add(chestCount);
    chestPositions.add(map.map.map((tile, index) => tile === CONTRACT_TILE.CHEST ? index : -1).filter((index) => index >= 0).join(','));
    emptyCounts.add(counts[CONTRACT_TILE.EMPTY] || 0);
  }

  assert.equal(hashes.size, seeds.length, 'each sampled seed should produce a distinct map hash');
  assert.ok(stoneCounts.size >= 6, 'stone obstacle density should vary across maps');
  assert.ok(chestCounts.size >= 2, 'chest count should vary within the balanced profile range');
  assert.ok(chestPositions.size >= 6, 'chest placement should vary across maps');
  assert.ok(emptyCounts.size >= 6, 'cave/open-space density should vary across maps');
});
