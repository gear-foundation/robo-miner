import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { RESOURCES_BY_RARITY, oreRollChance } from '../../config/resources.js';
import { idx } from '../grid.js';

// Per-tile ore roll. Walks resources rarest-first, so a tile inside the
// overlap of gold/silver windows gets the rarer one. Chance per resource
// is gaussian around its peak depth — concentration near peak, thin tails.
function pickOreForDepth(rnd, depth) {
  for (const r of RESOURCES_BY_RARITY) {
    const chance = oreRollChance(depth, r);
    if (chance <= 0) continue;
    if (rnd() < chance) return r.type;
  }
  return BLOCK.DIRT;
}

// Fills sky above DIMS.S, and rolls per-tile ore/dirt below it.
export function baseFill(grid, rnd) {
  for (let y = 0; y < DIMS.H; y++) {
    for (let x = 0; x < DIMS.W; x++) {
      grid[idx(x, y)] = y < DIMS.S ? BLOCK.SKY : pickOreForDepth(rnd, y - DIMS.S);
    }
  }
}

// Dirt-only fill for the digger (agent-arena) model: sky above surface,
// solid dirt below. Crystals / lava / caves are carved by their own steps —
// no per-tile ore rolls here (the 8-ore economy is single-player only).
export function baseFillDirt(grid) {
  for (let y = 0; y < DIMS.H; y++) {
    for (let x = 0; x < DIMS.W; x++) {
      grid[idx(x, y)] = y < DIMS.S ? BLOCK.SKY : BLOCK.DIRT;
    }
  }
}
