// Digger-campaign resource placement (agent arena).
//
// Replaces the 8-ore base-fill + diamond with the brief's 3-crystal
// model: ~100 resources on the 40×64 map (77 SCRST / 19 BCRST / 4 HCRST),
// deeper = rarer/more valuable. Counts scale with map area so other sizes keep
// the same density. Digger hazards now come from contract-resolved chests.
//
// Economy (redeem VARA): SCRST 6 · BCRST 30 · HCRST 150  (see config.js).

import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

const AREA_REF = 40 * 64;                       // brief reference map
const BASE_COUNTS = { scrst: 77, bcrst: 19, hcrst: 4 };
const CHEST_PROFILES = [
  { shallow: 7, mid: 8, deep: 5 },  // 20
  { shallow: 7, mid: 9, deep: 5 },  // 21
  { shallow: 8, mid: 9, deep: 5 },  // 22
  { shallow: 8, mid: 9, deep: 6 },  // 23
  { shallow: 8, mid: 10, deep: 6 }, // 24
];
const CHEST_BANDS = {
  shallow: { from: 0.10, to: 0.34, spacing: 4 },
  mid: { from: 0.35, to: 0.68, spacing: 5 },
  deep: { from: 0.69, to: 0.96, spacing: 6 },
};
const STONE_PROFILES = [
  { loose: 18, shallow: 14, boulders: 3, shelves: 2, columns: 1 },
  { loose: 24, shallow: 20, boulders: 4, shelves: 1, columns: 2 },
  { loose: 16, shallow: 10, boulders: 6, shelves: 3, columns: 2 },
  { loose: 12, shallow: 8, boulders: 2, shelves: 5, columns: 3 },
];

function playable() { return DIMS.H - DIMS.S; }
function depthRow(frac) { return DIMS.S + Math.floor(frac * playable()); }

// Crystals and chests embed into solid dirt only, so we do not plug cave
// passages, overwrite stones, or disturb fixed resource counts.
function isDirt(grid, x, y) {
  return x >= 1 && x < DIMS.W - 1 && y > DIMS.S && y < DIMS.H - 1 &&
    grid[idx(x, y)] === BLOCK.DIRT;
}

function canPlaceLooseStone(grid, x, y) {
  return isDirt(grid, x, y) && grid[idx(x, y + 1)] !== BLOCK.SKY;
}

// Scattered stone clumps — obstacles to route around, and the falling-rock
// hazard when a miner digs out their support. Concentrated a bit more in the
// shallow band (where most of the action is) so the top layer isn't a free
// straight dig. Small + sparse so they never seal the narrow map;
// validateDigger + regen keep the deep band reachable.
function scatterStones(grid, rnd, clumps, f0, f1) {
  for (let i = 0; i < clumps; i++) {
    const cx = 2 + Math.floor(rnd() * (DIMS.W - 4));
    const cy = depthRow(f0 + rnd() * (f1 - f0));
    const size = 1 + Math.floor(rnd() * 3); // 1–3 tiles
    for (let j = 0; j < size; j++) {
      const x = cx + (Math.floor(rnd() * 3) - 1);
      const y = cy + Math.floor(rnd() * 2);
      if (canPlaceLooseStone(grid, x, y)) grid[idx(x, y)] = BLOCK.STONE;
    }
  }
}

function stampBoulder(grid, rnd, cx, cy, r) {
  const rr = r * r;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > rr) continue;
      const fill = 0.35 + 0.45 * (1 - d2 / rr);
      if (rnd() < fill && canPlaceLooseStone(grid, x, y)) grid[idx(x, y)] = BLOCK.STONE;
    }
  }
}

function stampShelf(grid, rnd, cx, cy, len) {
  let y = cy;
  for (let i = 0; i < len; i++) {
    const x = cx - Math.floor(len / 2) + i;
    if (canPlaceLooseStone(grid, x, y)) grid[idx(x, y)] = BLOCK.STONE;
    if (rnd() < 0.35 && canPlaceLooseStone(grid, x, y + 1)) grid[idx(x, y + 1)] = BLOCK.STONE;
    if (rnd() < 0.25) y += rnd() < 0.5 ? -1 : 1;
  }
}

function stampColumn(grid, rnd, cx, cy, height) {
  for (let i = 0; i < height; i++) {
    const y = cy + i;
    if (canPlaceLooseStone(grid, cx, y)) grid[idx(cx, y)] = BLOCK.STONE;
    if (rnd() < 0.20 && canPlaceLooseStone(grid, cx + 1, y)) grid[idx(cx + 1, y)] = BLOCK.STONE;
    if (rnd() < 0.20 && canPlaceLooseStone(grid, cx - 1, y)) grid[idx(cx - 1, y)] = BLOCK.STONE;
  }
}

export function placeStones(grid, rnd) {
  const scale = (DIMS.W * DIMS.H) / AREA_REF;
  const profile = pick(STONE_PROFILES, rnd);
  scatterStones(grid, rnd, Math.max(8, Math.round(profile.loose * scale)), 0.06, 0.85); // whole depth
  scatterStones(grid, rnd, Math.max(6, Math.round(profile.shallow * scale)), 0.03, 0.34); // extra up top
  for (let i = 0; i < Math.max(1, Math.round(profile.boulders * scale)); i++) {
    stampBoulder(
      grid,
      rnd,
      3 + Math.floor(rnd() * Math.max(1, DIMS.W - 6)),
      depthRow(0.18 + rnd() * 0.72),
      1 + Math.floor(rnd() * 3),
    );
  }
  for (let i = 0; i < Math.max(1, Math.round(profile.shelves * scale)); i++) {
    stampShelf(
      grid,
      rnd,
      4 + Math.floor(rnd() * Math.max(1, DIMS.W - 8)),
      depthRow(0.12 + rnd() * 0.70),
      4 + Math.floor(rnd() * 7),
    );
  }
  for (let i = 0; i < Math.max(1, Math.round(profile.columns * scale)); i++) {
    stampColumn(
      grid,
      rnd,
      3 + Math.floor(rnd() * Math.max(1, DIMS.W - 6)),
      depthRow(0.08 + rnd() * 0.55),
      2 + Math.floor(rnd() * 5),
    );
  }
}

function scatter(grid, rnd, block, count, frac0, frac1, canPlace = (x, y) => isDirt(grid, x, y)) {
  const placed = [];
  let tries = count * 80;
  while (placed.length < count && tries-- > 0) {
    const x = 1 + Math.floor(rnd() * (DIMS.W - 2));
    const y = depthRow(frac0 + rnd() * (frac1 - frac0));
    if (!canPlace(x, y)) continue;
    grid[idx(x, y)] = block;
    placed.push({ x, y, type: block });
  }
  return placed;
}

// Place the 3 redeemable crystals. Returns the placement list so the runtime
// world can carry it (entity metadata, not just grid bytes).
export function placeCrystals(grid, rnd) {
  const scale = (DIMS.W * DIMS.H) / AREA_REF;
  const n = (k) => Math.max(1, Math.round(BASE_COUNTS[k] * scale));
  const reachableFromSurface = floodFromSurface(grid);
  const canPlaceCrystal = (x, y) =>
    isDirt(grid, x, y) && hasReachableLateralCell(reachableFromSurface, x, y);
  const crystals = [];
  crystals.push(...scatter(grid, rnd, BLOCK.SCRST, n('scrst'), 0.05, 0.55, canPlaceCrystal));
  crystals.push(...scatter(grid, rnd, BLOCK.BCRST, n('bcrst'), 0.35, 0.80, canPlaceCrystal));
  crystals.push(...scatter(grid, rnd, BLOCK.HCRST, n('hcrst'), 0.72, 0.99, canPlaceCrystal));
  return crystals;
}

function tooCloseToChest(x, y, spacing, chests) {
  for (const chest of chests) {
    if (Math.abs(chest.x - x) < spacing && Math.abs(chest.y - y) < spacing) return true;
  }
  return false;
}

function placeChest(grid, chests, chestsAt, x, y, tier) {
  grid[idx(x, y)] = BLOCK.CHEST;
  const chest = { id: chests.length, x, y, tier, opened: false };
  chests.push(chest);
  chestsAt.set(idx(x, y), chest);
}

function placeChestBand(grid, rnd, chests, chestsAt, tier, count) {
  const band = CHEST_BANDS[tier];
  let placed = 0;
  let tries = count * 180;
  while (placed < count && tries-- > 0) {
    const x = 2 + Math.floor(rnd() * Math.max(1, DIMS.W - 4));
    const y = depthRow(band.from + rnd() * (band.to - band.from));
    if (!isDirt(grid, x, y)) continue;
    if (tooCloseToChest(x, y, band.spacing, chests)) continue;
    placeChest(grid, chests, chestsAt, x, y, tier);
    placed += 1;
  }
}

// Contract chests. The map only stores TILE_CHEST; when a miner drills it the
// contract resolves the actual outcome (dynamite or extra ladders) and emits
// ChestOpened. We keep tier only as renderer metadata for nicer colors.
export function placeDiggerChests(grid, rnd) {
  const scale = (DIMS.W * DIMS.H) / AREA_REF;
  const profile = pick(CHEST_PROFILES, rnd);
  const chests = [];
  const chestsAt = new Map();
  for (const [tier, count] of Object.entries(profile)) {
    placeChestBand(grid, rnd, chests, chestsAt, tier, Math.max(1, Math.round(count * scale)));
  }
  return { chests, chestsAt };
}

function pick(items, rnd) {
  return items[Math.floor(rnd() * items.length)] || items[0];
}

// Every crystal must have a reachable position to its left or right. This
// deliberately permits stones above or below the crystal: agents still have
// to account for falling rocks, but no resource is permanently sealed away.
export function validateDigger(world) {
  const report = { ok: true, warnings: [] };
  const { grid, crystals } = world;
  if (!crystals || !crystals.length) {
    report.ok = false;
    report.warnings.push('no crystals placed');
    return report;
  }
  const access = inspectDiggerCrystalAccess(grid);
  if (!access.ok) {
    report.ok = false;
    report.warnings.push(`crystals without a reachable lateral approach: ${access.missing.length}`);
  }
  return report;
}

export function inspectDiggerCrystalAccess(grid) {
  const missing = [];
  for (let y = DIMS.S; y < DIMS.H; y++) {
    for (let x = 0; x < DIMS.W; x++) {
      const tile = grid[idx(x, y)];
      if (!isCrystal(tile)) continue;

      // Treat the target crystal as blocked. A side cell reachable only by
      // passing through that crystal is not a valid drilling position.
      const reachable = floodFromSurface(grid, idx(x, y));
      if (!hasReachableLateralCell(reachable, x, y)) {
        missing.push({ x, y, type: tile });
      }
    }
  }
  return { ok: missing.length === 0, missing };
}

function isCrystal(tile) {
  return tile === BLOCK.SCRST || tile === BLOCK.BCRST || tile === BLOCK.HCRST;
}

function hasReachableLateralCell(reachable, x, y) {
  return (x > 0 && reachable[idx(x - 1, y)] === 1) ||
    (x + 1 < DIMS.W && reachable[idx(x + 1, y)] === 1);
}

function floodFromSurface(grid, blockedIndex = -1) {
  const W = DIMS.W, H = DIMS.H;
  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;

  // The live contract's entire top row is traversable surface. Starting from
  // every ground cell below it models a miner choosing any surface column.
  for (let x = 0; x < W; x++) {
    const start = idx(x, DIMS.S);
    if (start === blockedIndex || grid[start] === BLOCK.STONE) continue;
    visited[start] = 1;
    queue[tail++] = start;
  }

  while (head < tail) {
    const cell = queue[head++];
    const x = cell % W;
    const y = (cell / W) | 0;
    if (x > 0) visit(cell - 1);
    if (x + 1 < W) visit(cell + 1);
    if (y > 0) visit(cell - W);
    if (y + 1 < H) visit(cell + W);
  }
  return visited;

  function visit(next) {
    if (next === blockedIndex || visited[next] || grid[next] === BLOCK.STONE) return;
    visited[next] = 1;
    queue[tail++] = next;
  }
}
