// Digger-campaign resource placement (agent arena).
//
// Replaces the 8-ore base-fill + diamond + chests with the brief's 3-crystal
// model: ~100 resources on the 40×64 map (77 SCRST / 19 BCRST / 4 HCRST),
// deeper = rarer/more valuable, HCRST lava-adjacent. Counts scale with map
// area so other sizes keep the same density.
//
// Economy (redeem VARA): SCRST 66 · BCRST 330 · HCRST 1650  (see config.js).

import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

const AREA_REF = 40 * 64;                       // brief reference map
const BASE_COUNTS = { scrst: 77, bcrst: 19, hcrst: 4 };
const STONE_PROFILES = [
  { loose: 18, shallow: 14, boulders: 3, shelves: 2, columns: 1 },
  { loose: 24, shallow: 20, boulders: 4, shelves: 1, columns: 2 },
  { loose: 16, shallow: 10, boulders: 6, shelves: 3, columns: 2 },
  { loose: 12, shallow: 8, boulders: 2, shelves: 5, columns: 3 },
];
const LAVA_PROFILES = [
  { pools: 3, rxMin: 3, rxRange: 4, ryMin: 1, ryRange: 2, fill: 0.90 },
  { pools: 5, rxMin: 2, rxRange: 3, ryMin: 1, ryRange: 2, fill: 0.82 },
  { pools: 6, rxMin: 1, rxRange: 3, ryMin: 1, ryRange: 1, fill: 0.72 },
];

function playable() { return DIMS.H - DIMS.S; }
function depthRow(frac) { return DIMS.S + Math.floor(frac * playable()); }

// Only crystals/lava embed into solid dirt — never sky (caves), stone, or
// existing lava — so we don't plug passages or overwrite hazards.
function isDirt(grid, x, y) {
  return x >= 1 && x < DIMS.W - 1 && y > DIMS.S && y < DIMS.H - 1 &&
    grid[idx(x, y)] === BLOCK.DIRT;
}

function canPlaceLooseStone(grid, x, y) {
  return isDirt(grid, x, y) && grid[idx(x, y + 1)] !== BLOCK.SKY;
}

function lavaNear(grid, x, y, r) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= DIMS.W || ny < 0 || ny >= DIMS.H) continue;
      if (grid[idx(nx, ny)] === BLOCK.LAVA) return true;
    }
  }
  return false;
}

// Deep lava pools that guard the bottom (HCRST) band. Tuned small for the
// narrow digger map so lava clusters *guard*, not flood.
export function placeDeepLava(grid, rnd) {
  const scale = (DIMS.W * DIMS.H) / AREA_REF;
  const profile = pick(LAVA_PROFILES, rnd);
  const pools = Math.max(2, Math.round(profile.pools * scale));
  for (let i = 0; i < pools; i++) {
    const cy = depthRow(0.70 + rnd() * 0.28);
    const cx = 3 + Math.floor(rnd() * Math.max(1, DIMS.W - 6));
    const rx = profile.rxMin + Math.floor(rnd() * profile.rxRange);
    const ry = profile.ryMin + Math.floor(rnd() * profile.ryRange);
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        const ux = (x - cx) / rx, uy = (y - cy) / ry;
        if (ux * ux + uy * uy > 1) continue;
        if (isDirt(grid, x, y) && rnd() < profile.fill) grid[idx(x, y)] = BLOCK.LAVA;
      }
    }
  }
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

function scatter(grid, rnd, block, count, frac0, frac1, opts = {}) {
  const placed = [];
  const tryOnce = (requireLava) => {
    let tries = count * 60;
    while (placed.length < count && tries-- > 0) {
      const x = 1 + Math.floor(rnd() * (DIMS.W - 2));
      const y = depthRow(frac0 + rnd() * (frac1 - frac0));
      if (!isDirt(grid, x, y)) continue;
      if (requireLava && !lavaNear(grid, x, y, 3)) continue;
      grid[idx(x, y)] = block;
      placed.push({ x, y, type: block });
    }
  };
  tryOnce(!!opts.nearLava);
  // Fallback: if the lava-adjacency constraint starved placement, drop it so
  // the rare crystals still appear (just not guaranteed lava-adjacent).
  if (placed.length < count && opts.nearLava) tryOnce(false);
  return placed;
}

// Place the 3 redeemable crystals. Returns the placement list so the runtime
// world can carry it (entity metadata, not just grid bytes).
export function placeCrystals(grid, rnd) {
  const scale = (DIMS.W * DIMS.H) / AREA_REF;
  const n = (k) => Math.max(1, Math.round(BASE_COUNTS[k] * scale));
  const crystals = [];
  crystals.push(...scatter(grid, rnd, BLOCK.SCRST, n('scrst'), 0.05, 0.55));
  crystals.push(...scatter(grid, rnd, BLOCK.BCRST, n('bcrst'), 0.35, 0.80));
  crystals.push(...scatter(grid, rnd, BLOCK.HCRST, n('hcrst'), 0.72, 0.99, { nearLava: true }));
  return crystals;
}

function pick(items, rnd) {
  return items[Math.floor(rnd() * items.length)] || items[0];
}

// Lightweight reachability check: can an agent reach the deep (bottom-most)
// crystal from the surface through drillable (non-STONE) tiles? Mirrors the
// classic validator so `regen` can retry seeds that seal the deep band off.
export function validateDigger(world) {
  const report = { ok: true, warnings: [] };
  const { grid, crystals } = world;
  if (!crystals || !crystals.length) {
    report.ok = false;
    report.warnings.push('no crystals placed');
    return report;
  }
  const deep = [...crystals].sort((a, b) => b.y - a.y)[0];
  const spawn = { x: Math.floor(DIMS.W / 2), y: DIMS.S };
  if (!reachable(grid, spawn, deep)) {
    report.ok = false;
    report.warnings.push('deep crystals unreachable from surface');
  }
  return report;
}

function reachable(grid, from, to) {
  const W = DIMS.W, H = DIMS.H;
  const visited = new Uint8Array(W * H);
  const queue = [from.x, from.y];
  visited[idx(from.x, from.y)] = 1;
  while (queue.length) {
    const y = queue.pop(), x = queue.pop();
    if (x === to.x && y === to.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (visited[idx(nx, ny)]) continue;
      if (grid[idx(nx, ny)] === BLOCK.STONE) continue; // unbreakable blocks path
      visited[idx(nx, ny)] = 1;
      queue.push(nx, ny);
    }
  }
  return false;
}
