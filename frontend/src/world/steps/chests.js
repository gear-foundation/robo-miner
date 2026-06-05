// Chest placement step.
//
// Approach: for each carved cave pocket, try to find a "floor" cell — a SKY
// tile whose neighbor below is a solid drillable block. Replace that SKY with
// BLOCK.CHEST and record an entity descriptor. Tier is chosen by depth.
//
// Chests are returned as both:
//   - chests[]      (array, stable order — for save/load and debugging)
//   - chestsAt      (Map<idx, chest> — for O(1) renderer / completeDig lookup)
//
// Density is roughly one chest every ~3 pockets in the upper layers, a bit
// more often in mid/deep tiers. We do NOT place a chest directly adjacent to
// another chest (min spacing) so loot feels like an event, not a pile.

import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';
import { CHEST_TIERS, chestTierForDepth } from '../../config/chests.js';

const BASE_CHANCE_BY_TIER = {
  shallow: 0.85,
  mid:     0.85,
  deep:    0.90,
};

// How many extra random placement attempts to run per depth band on top of
// the pocket-based pass. Keeps shallow regions populated even where there
// aren't many cave pockets.
const SCATTER_ATTEMPTS = {
  shallow: 35,
  mid:     22,
  deep:    16,
};

// Tier-specific min spacing (Chebyshev). Shallow is tighter so chests feel
// genuinely plentiful up top the way the player expects from pickaxe-loop
// games; deeper tiers keep them spaced so a find still feels like an event.
const MIN_CHEST_SPACING_BY_TIER = {
  shallow: 3,
  mid:     5,
  deep:    7,
};

function isSky(grid, x, y) {
  return grid[idx(x, y)] === BLOCK.SKY;
}

function isDrillable(grid, x, y) {
  const t = grid[idx(x, y)];
  // Any solid non-unbreakable block counts as a floor tile.
  return t !== BLOCK.SKY && t !== BLOCK.STONE && t !== BLOCK.LADDER && t !== BLOCK.PILLAR;
}

function tooCloseToExisting(x, y, tierId, existing) {
  const spacing = MIN_CHEST_SPACING_BY_TIER[tierId] ?? 5;
  for (const c of existing) {
    if (Math.abs(c.x - x) < spacing && Math.abs(c.y - y) < spacing) {
      return true;
    }
  }
  return false;
}

// Scan the rim of the pocket for a valid floor cell.
function findFloorNearPocket(grid, rnd, px, py) {
  const candidates = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = px + dx;
      const y = py + dy;
      if (x < 2 || x >= DIMS.W - 2 || y < DIMS.S + 2) continue;
      if (!isSky(grid, x, y)) continue;
      if (!isDrillable(grid, x, y + 1)) continue;
      // Skip the cell the player would spawn into directly above.
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rnd() * candidates.length)];
}

// Scan random columns for a floor cell (SKY with drillable block below) in
// the given depth band. Used by the scatter pass so the shallow layers get
// populated even when cave pockets are sparse.
function findRandomFloor(grid, rnd, depthFrom, depthTo) {
  for (let tries = 0; tries < 20; tries++) {
    const x = 2 + Math.floor(rnd() * (DIMS.W - 4));
    const depth = depthFrom + Math.floor(rnd() * (depthTo - depthFrom));
    const y = DIMS.S + depth;
    if (y < DIMS.S + 2 || y >= DIMS.H - 2) continue;
    if (!isSky(grid, x, y)) continue;
    if (!isDrillable(grid, x, y + 1)) continue;
    return { x, y };
  }
  return null;
}

// Find a tile buried in drillable dirt/ore (no SKY required). Used to seed
// chests in the top few meters where no cave floors exist yet — the player
// discovers them while digging straight down.
function findBuriedSpot(grid, rnd, depthFrom, depthTo) {
  for (let tries = 0; tries < 25; tries++) {
    const x = 3 + Math.floor(rnd() * (DIMS.W - 6));
    const depth = depthFrom + Math.floor(rnd() * (depthTo - depthFrom));
    const y = DIMS.S + depth;
    if (y < DIMS.S + 2 || y >= DIMS.H - 2) continue;
    if (!isDrillable(grid, x, y)) continue;
    // Prefer spots fully surrounded by drillable — reads as a sealed cache.
    if (!isDrillable(grid, x - 1, y) || !isDrillable(grid, x + 1, y)) continue;
    if (!isDrillable(grid, x, y + 1)) continue;
    return { x, y };
  }
  return null;
}

function recordChest(grid, chests, chestsAt, spot, tierId) {
  if (tooCloseToExisting(spot.x, spot.y, tierId, chests)) return false;
  grid[idx(spot.x, spot.y)] = BLOCK.CHEST;
  const chest = {
    id: chests.length,
    x: spot.x,
    y: spot.y,
    tier: tierId,
    opened: false,
  };
  chests.push(chest);
  chestsAt.set(idx(spot.x, spot.y), chest);
  return true;
}

export function placeChests(grid, rnd, ctx) {
  const chests = [];
  const chestsAt = new Map();
  const pockets = ctx?.pockets ?? [];

  // Pass 1: one chest per cave pocket, weighted by tier.
  for (const p of pockets) {
    const depth = p.y - DIMS.S;
    const tier = chestTierForDepth(depth);
    const chance = BASE_CHANCE_BY_TIER[tier.id] ?? 0;
    if (rnd() >= chance) continue;
    const spot = findFloorNearPocket(grid, rnd, p.x, p.y);
    if (!spot) continue;
    recordChest(grid, chests, chestsAt, spot, tier.id);
  }

  // Pass 2: scatter — random floor tiles per tier band. Keeps shallow levels
  // populated even when the cave carver produced few pockets up top.
  for (const [tierId, attempts] of Object.entries(SCATTER_ATTEMPTS)) {
    const tier = CHEST_TIERS[tierId];
    for (let i = 0; i < attempts; i++) {
      const spot = findRandomFloor(grid, rnd, tier.fromDepth, tier.toDepth);
      if (!spot) continue;
      recordChest(grid, chests, chestsAt, spot, tierId);
    }
  }

  // Pass 3: buried — chests embedded in solid dirt/ore. Shallow tier only.
  // The top 0-20m band is where chests should feel truly plentiful (supply
  // drops that keep the player stocked on ladders) so we aim for many.
  const buriedAttempts = 40;
  for (let i = 0; i < buriedAttempts; i++) {
    const spot = findBuriedSpot(grid, rnd, 2, 22);
    if (!spot) continue;
    recordChest(grid, chests, chestsAt, spot, 'shallow');
  }

  return { chests, chestsAt };
}

export { CHEST_TIERS };
