// Wraps some ore clusters in a stone shell so the player genuinely needs
// dynamite to reach them. Runs AFTER veins so it can see where ore
// actually ended up.
//
// Strategy: sample random points, if the tile is an ore, stamp a ring
// around the 3x3 neighborhood where any DIRT becomes STONE. Ore tiles
// themselves are untouched — only the dirt "skin" gets sealed.

import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

// Only ores worth spending a dynamite on. Coal is excluded — it's $5, sealing
// it behind a $100 charge is anti-fun. Iron is borderline and only gets
// sealed at deeper depths where it's part of a mixed vein.
const SEALABLE_ORES = new Set([
  BLOCK.IRON, BLOCK.COPPER, BLOCK.SILVER, BLOCK.GOLD, BLOCK.EMERALD, BLOCK.RUBY,
]);

// Minimum depth before sealing kicks in. Shallow band stays accessible — the
// player is still collecting early coal/iron cash and shouldn't be forced to
// dynamite for it.
const SEAL_MIN_DEPTH = 50;

function sealRingAround(grid, cx, cy, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 1 || x >= DIMS.W - 1 || y <= DIMS.S || y >= DIMS.H - 1) continue;
      if (Math.abs(dx) + Math.abs(dy) < radius - 1) continue; // ring, not disc
      if (grid[idx(x, y)] === BLOCK.DIRT) grid[idx(x, y)] = BLOCK.STONE;
    }
  }
}

export function sealSomeVeins(grid, rnd) {
  const attempts = 70;
  for (let i = 0; i < attempts; i++) {
    const x = 3 + Math.floor(rnd() * (DIMS.W - 6));
    const y = DIMS.S + SEAL_MIN_DEPTH + Math.floor(rnd() * (DIMS.H - DIMS.S - SEAL_MIN_DEPTH - 5));
    if (!SEALABLE_ORES.has(grid[idx(x, y)])) continue;
    const radius = 2 + Math.floor(rnd() * 2);
    sealRingAround(grid, x, y, radius);
  }
}
