import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { RESOURCES } from '../../config/resources.js';
import { idx } from '../grid.js';

function stampOre(grid, x, y, ore, radius) {
  const r2 = radius * radius;
  for (let yy = Math.floor(y - radius - 1); yy <= Math.ceil(y + radius + 1); yy++) {
    for (let xx = Math.floor(x - radius - 1); xx <= Math.ceil(x + radius + 1); xx++) {
      if (xx <= 1 || xx >= DIMS.W - 2 || yy <= DIMS.S || yy >= DIMS.H - 2) continue;
      const dx = xx - x;
      const dy = yy - y;
      if (dx * dx + dy * dy > r2) continue;
      const current = grid[idx(xx, yy)];
      // Rarer ores (placed later in the iteration order) are allowed to
      // upgrade tiles that are still common — dirt and any earlier ore
      // tier — so ruby walks in the deep zone can claim space from
      // emerald/gold deposits. Diamond + stone + sky are never touched.
      if (current === BLOCK.DIRT
          || current === BLOCK.COAL
          || current === BLOCK.IRON
          || current === BLOCK.COPPER
          || current === BLOCK.SILVER
          || current === BLOCK.GOLD
          || current === BLOCK.EMERALD) {
        grid[idx(xx, yy)] = ore;
      }
    }
  }
}

// Triangular sample biased toward peakDepth. (rnd+rnd)/2 gives a triangle
// centered at 0.5; scaling by the half-window around peak concentrates
// origins near the peak without completely removing the tails.
function sampleDepth(rnd, res) {
  const halfWindow = Math.max(
    res.peakDepth - res.minDepth,
    res.maxDepth - res.peakDepth,
  );
  const t = (rnd() + rnd()) - 1; // triangular in [-1, 1]
  const depth = Math.round(res.peakDepth + t * halfWindow);
  return Math.max(res.minDepth, Math.min(res.maxDepth, depth));
}

// Diagonal zigzag walker. Moves one tile diagonally per step, flipping the
// vertical component every 1-2 steps so the trail reads as a sawtooth / sine
// wave instead of a straight line. Short by design (veinLen drives it) — we
// want many readable "wavy veins" strewn across each depth band, not long
// corridors. Anchored at (x0, y0).
function walkZigzagVein(grid, rnd, x0, y0, res) {
  let x = x0;
  let y = y0;
  let vx = rnd() < 0.5 ? -1 : 1;
  let vy = rnd() < 0.5 ? -1 : 1;
  let flipIn = 1 + Math.floor(rnd() * 2); // flip vy every 1-2 steps
  const len = res.veinLen[0] + Math.floor(rnd() * (res.veinLen[1] - res.veinLen[0] + 1));
  for (let step = 0; step < len; step++) {
    const radius = res.veinRadius[0] + rnd() * (res.veinRadius[1] - res.veinRadius[0]);
    stampOre(grid, x, y, res.type, radius);
    if (--flipIn <= 0) {
      vy = -vy;
      flipIn = 1 + Math.floor(rnd() * 2);
    }
    // Occasional horizontal jitter so veins aren't perfectly uniform.
    if (rnd() < 0.18) vx = -vx;
    x = Math.max(2, Math.min(DIMS.W - 3, x + vx));
    y = Math.max(DIMS.S + res.minDepth, Math.min(DIMS.S + res.maxDepth, y + vy));
  }
}

// Old "wobble" walker — kept for clustered ores (coal) where we want fat
// blotches rather than narrow zigzags.
function walkClusterVein(grid, rnd, x0, y0, res) {
  let x = x0;
  let y = y0;
  let vx = rnd() < 0.5 ? -1 : 1;
  let vy = (rnd() - 0.5) * 0.8;
  const len = res.veinLen[0] + Math.floor(rnd() * (res.veinLen[1] - res.veinLen[0] + 1));
  for (let step = 0; step < len; step++) {
    const radius = res.veinRadius[0] + rnd() * (res.veinRadius[1] - res.veinRadius[0]);
    stampOre(grid, x, y, res.type, radius);
    if (rnd() < 0.35) vx += rnd() < 0.5 ? -0.5 : 0.5;
    if (rnd() < 0.30) vy += (rnd() - 0.5) * 0.7;
    vx = Math.max(-1.4, Math.min(1.4, vx));
    vy = Math.max(-1.0, Math.min(1.0, vy));
    x = Math.max(2, Math.min(DIMS.W - 3, x + Math.round(vx)));
    y = Math.max(DIMS.S + res.minDepth, Math.min(DIMS.S + res.maxDepth, y + Math.round(vy)));
  }
}

// Dense ore "hotspots" — 3×3 ore pocket surrounded by a STONE ring with a
// single gap. Reads as a reward you have to drill into: you see the ring,
// you see the gem flash inside, you commit to blasting. Skip coal (too
// cheap to warrant a puzzle) and diamond (placed separately).
function sprinkleOreHotspots(grid, rnd) {
  const tiers = RESOURCES.filter(r => r.type !== BLOCK.COAL);
  const count = 12;
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 6) {
    const res = tiers[Math.floor(rnd() * tiers.length)];
    const cx = 4 + Math.floor(rnd() * (DIMS.W - 8));
    const cy = DIMS.S + res.minDepth + Math.floor(rnd() * (res.maxDepth - res.minDepth));
    if (cy < DIMS.S + 4 || cy > DIMS.H - 4) continue;
    // Skip if the spot overlaps a cave — we'd end up with floating ore.
    let onCave = false;
    for (let dy = -2; dy <= 2 && !onCave; dy++) {
      for (let dx = -2; dx <= 2 && !onCave; dx++) {
        if (grid[idx(cx + dx, cy + dy)] === BLOCK.SKY) onCave = true;
      }
    }
    if (onCave) continue;
    // Fill inner 3×3 with ore, overwriting whatever's there.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        grid[idx(cx + dx, cy + dy)] = res.type;
      }
    }
    // Stone ring at radius 2, with one gap at a random side.
    const gapDir = Math.floor(rnd() * 4); // 0=up 1=right 2=down 3=left
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
        if (gapDir === 0 && dy === -2 && Math.abs(dx) <= 1) continue;
        if (gapDir === 1 && dx ===  2 && Math.abs(dy) <= 1) continue;
        if (gapDir === 2 && dy ===  2 && Math.abs(dx) <= 1) continue;
        if (gapDir === 3 && dx === -2 && Math.abs(dy) <= 1) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 1 || x >= DIMS.W - 1 || y <= DIMS.S || y >= DIMS.H - 1) continue;
        if (grid[idx(x, y)] === BLOCK.SKY) continue;
        grid[idx(x, y)] = BLOCK.STONE;
      }
    }
    placed++;
  }
}

// Places clustered ore veins. 45% chance to anchor near a cave pocket,
// otherwise triangular-sampled around peakDepth. Pattern per-resource:
// 'cluster' → fat wobble (coal); everything else → short diagonal zigzag.
// Iteration order is common→rare so rarer ores can overwrite common ones.
export function placeOreVeins(grid, rnd, pockets) {
  for (const res of RESOURCES) {
    const nearby = pockets.filter(p => {
      const d = p.y - DIMS.S;
      return d >= res.minDepth && d <= res.maxDepth;
    });
    const walk = res.pattern === 'cluster' ? walkClusterVein : walkZigzagVein;
    for (let i = 0; i < res.veinCount; i++) {
      let x;
      let y;
      if (nearby.length > 0 && rnd() < 0.45) {
        const p = nearby[Math.floor(rnd() * nearby.length)];
        x = p.x + Math.floor((rnd() - 0.5) * 10);
        y = p.y + Math.floor((rnd() - 0.5) * 8);
      } else {
        x = 3 + Math.floor(rnd() * (DIMS.W - 6));
        y = DIMS.S + sampleDepth(rnd, res);
      }
      walk(grid, rnd, x, y, res);
    }
  }
  sprinkleOreHotspots(grid, rnd);
}
