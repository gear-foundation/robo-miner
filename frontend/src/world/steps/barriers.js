import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

// Unbreakable STONE structures. Three goals:
//   1. Starter zone (first ~20m) stays clean — no walls that force the
//      player to detour right off the spawn.
//   2. Density ramps up with depth so the world feels harder and more
//      "geological" as you go deeper.
//   3. Shapes are varied (blob / wall / pillar / arc) so the map has
//      readable geography instead of uniform static.
//
// Each stamper writes only over dirt/ore — it won't overwrite SKY (caves
// haven't been carved yet at this step, but we still guard in case).

function tryPlaceStone(grid, x, y) {
  if (x < 1 || x >= DIMS.W - 1 || y <= DIMS.S || y >= DIMS.H - 1) return;
  const t = grid[idx(x, y)];
  if (t === BLOCK.SKY) return;
  grid[idx(x, y)] = BLOCK.STONE;
}

function stampBlob(grid, rnd, cx, cy, r) {
  const rr = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > rr) continue;
      const softness = 1 - d2 / rr;
      if (rnd() < 0.30 + 0.55 * softness) tryPlaceStone(grid, x, y);
    }
  }
}

// Short horizontal-ish wall with small vertical drift — becomes a ledge or
// a ceiling shelf that the player has to mine around.
function stampWall(grid, rnd, cx, cy, len) {
  let x = cx - Math.floor(len / 2);
  let y = cy;
  for (let i = 0; i < len; i++) {
    tryPlaceStone(grid, x, y);
    tryPlaceStone(grid, x, y + 1);
    if (rnd() < 0.25) tryPlaceStone(grid, x, y - 1);
    x += 1;
    if (rnd() < 0.25) y += rnd() < 0.5 ? -1 : 1;
  }
}

// Small 2-3 tile column — a "stalactite" / pillar you can drop stones from
// or hide behind.
function stampPillar(grid, rnd, cx, cy, h) {
  for (let i = 0; i < h; i++) {
    tryPlaceStone(grid, cx, cy + i);
    if (rnd() < 0.20) tryPlaceStone(grid, cx + (rnd() < 0.5 ? -1 : 1), cy + i);
  }
}

// Half-ring around a center — reads as a "shell" that might protect a POI
// or chest later. Only the upper half so you can approach from below.
function stampArc(grid, rnd, cx, cy, r) {
  for (let ang = Math.PI; ang <= Math.PI * 2; ang += 0.25) {
    const x = Math.round(cx + Math.cos(ang) * r);
    const y = Math.round(cy + Math.sin(ang) * r);
    tryPlaceStone(grid, x, y);
    if (rnd() < 0.5) tryPlaceStone(grid, x, y - 1);
  }
}

// Base density for the cluster-seeded field fill. This is the per-tile
// probability BEFORE the neighbor bonus (see paintStoneField). The cap
// keeps clustering from going runaway at deeper levels where a mostly-
// stone neighborhood would otherwise lock in at ~100%.
// Target coverage: ~30% near spawn → ~65% in the deep layers.
// Target: ~60% coverage average with depth ramp. Field fill clusters so
// there are always *some* passages; fault lines guarantee global connectivity;
// sealing pass (see veins step / pipeline) walls some ore in so the player
// actually needs dynamite.
function stoneDensity(depth) {
  if (depth < 1)   return { base: 0,    cap: 0    };     // surface row clean
  if (depth < 20)  return { base: 0.22, cap: 0.58 };     // ~45%
  if (depth < 60)  return { base: 0.28, cap: 0.68 };     // ~55%
  if (depth < 150) return { base: 0.34, cap: 0.76 };     // ~65%
  return              { base: 0.40, cap: 0.82 };         // ~72%
}

function pickStructureType(rnd, depth) {
  if (depth < 30) {
    return rnd() < 0.70 ? 'blob' : 'pillar';
  }
  if (depth < 150) {
    const r = rnd();
    if (r < 0.40) return 'blob';
    if (r < 0.70) return 'wall';
    if (r < 0.85) return 'pillar';
    return 'arc';
  }
  const r = rnd();
  if (r < 0.20) return 'blob';
  if (r < 0.55) return 'wall';
  if (r < 0.75) return 'pillar';
  return 'arc';
}

// Walk every tile top-to-bottom. Base chance is depth-driven; each already-
// stone neighbor above/left adds a bias so stones clump into boulders and
// short ridges instead of looking like TV static. We don't look at right/
// below because they haven't been decided yet — walking order IS the noise.
function paintStoneField(grid, rnd) {
  for (let y = DIMS.S + 1; y < DIMS.H - 1; y++) {
    const depth = y - DIMS.S;
    const { base, cap } = stoneDensity(depth);
    if (base <= 0) continue;
    for (let x = 1; x < DIMS.W - 1; x++) {
      if (grid[idx(x, y)] === BLOCK.SKY) continue;
      let bonus = 0;
      if (y > DIMS.S + 1 && grid[idx(x, y - 1)] === BLOCK.STONE) bonus += 0.18;
      if (x > 1           && grid[idx(x - 1, y)] === BLOCK.STONE) bonus += 0.18;
      // Diagonal bonus is smaller so clumps grow along axes, not diamond-shaped.
      if (y > DIMS.S + 1 && x > 1 && grid[idx(x - 1, y - 1)] === BLOCK.STONE) bonus += 0.08;
      const p = Math.min(cap, base + bonus);
      if (rnd() < p) grid[idx(x, y)] = BLOCK.STONE;
    }
  }
}

// A tiny 2x2 safe window directly below spawn so the player can always take
// the first step down. Without this the field fill can put stone right
// under the house.
function clearSpawnWindow(grid) {
  const cx = Math.floor(DIMS.W / 2);
  for (let y = DIMS.S + 1; y <= DIMS.S + 2; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (grid[idx(x, y)] === BLOCK.STONE) grid[idx(x, y)] = BLOCK.DIRT;
    }
  }
}

// Sprinkles dense stone "biome" clumps — big roughly-circular regions where
// stone coverage is ~85% so there are visible high-density zones mixed with
// calmer areas. These don't have to be reachable; they're local features
// the player routes around (or blasts through with dynamite).
function stampDenseClumps(grid, rnd) {
  const clumpCount = 16;
  for (let i = 0; i < clumpCount; i++) {
    const cy = DIMS.S + 30 + Math.floor(rnd() * (DIMS.H - DIMS.S - 40));
    const cx = 6 + Math.floor(rnd() * (DIMS.W - 12));
    const r = 4 + Math.floor(rnd() * 5);
    const r2 = r * r;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || x >= DIMS.W - 1 || y <= DIMS.S || y >= DIMS.H - 1) continue;
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = grid[idx(x, y)];
        if (t === BLOCK.SKY) continue;
        // Probability tapers off near the edge of the clump so it looks
        // organic rather than a perfect disc.
        const fill = 0.85 * (1 - d2 / r2) + 0.25;
        if (rnd() < fill) grid[idx(x, y)] = BLOCK.STONE;
      }
    }
  }
}

// Diagonal STONE faults — long slanted ridges (width 2) crossing big parts
// of the world at ~30-60°. Each has 1-2 gaps so the player can always
// squeeze through without dynamite, but routing around them creates detours
// that push cargo/ladder pressure. Drawn over dirt/ore; fault-line carving
// still punches vertical passages through them.
function stampDiagonalFaults(grid, rnd) {
  const count = 3;
  for (let i = 0; i < count; i++) {
    // Start at the top edge somewhere in the middle 60% of the width.
    let x = Math.floor(DIMS.W * 0.2) + Math.floor(rnd() * DIMS.W * 0.6);
    let y = DIMS.S + 10 + Math.floor(rnd() * 20);
    // slope: run 2-4 tiles horizontally per tile down, alternating sign
    // between faults so they criss-cross.
    const dir = i % 2 === 0 ? 1 : -1;
    const runPerDrop = 1 + Math.floor(rnd() * 2); // 1-2
    const length = 80 + Math.floor(rnd() * 80);   // 80-160 tiles traversed
    const gapStarts = [
      Math.floor(length * (0.25 + rnd() * 0.1)),
      Math.floor(length * (0.65 + rnd() * 0.1)),
    ];
    const gapLen = 4;
    for (let step = 0; step < length; step++) {
      // Are we in a gap?
      let inGap = false;
      for (const gs of gapStarts) {
        if (step >= gs && step < gs + gapLen) { inGap = true; break; }
      }
      if (!inGap) {
        for (let w = 0; w < 2; w++) {
          const xx = x + dir * w;
          tryPlaceStone(grid, xx, y);
          tryPlaceStone(grid, xx, y + 1);
        }
      }
      // advance: every runPerDrop steps we drop by 1, otherwise slide.
      if (step % (runPerDrop + 1) === 0) y += 1;
      else x += dir;
      if (x < 2 || x > DIMS.W - 3) break;
      if (y > DIMS.H - 4) break;
    }
  }
}

// Punch a winding non-stone fault line from near the surface to deep bottom.
// Guarantees reachability even when the field fill happens to choke off
// certain columns. Starts as a tight corridor, widens slightly deeper.
export function carveFaultLine(grid, rnd, startX) {
  let x = startX;
  const maxY = DIMS.H - 4;
  for (let y = DIMS.S + 2; y < maxY; y++) {
    const radius = 1 + Math.floor(y / 120); // 1 near surface, 2 deep
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx;
      if (xx < 1 || xx >= DIMS.W - 1) continue;
      if (grid[idx(xx, y)] === BLOCK.STONE) grid[idx(xx, y)] = BLOCK.DIRT;
    }
    // drift horizontally
    if (rnd() < 0.35) x += rnd() < 0.5 ? -1 : 1;
    x = Math.max(3, Math.min(DIMS.W - 4, x));
  }
}

export function placeBarriers(grid, rnd) {
  // Stage 1: cluster-seeded field fill. Does the heavy lifting — stones
  // become a genuine obstacle substrate the player has to mine around.
  paintStoneField(grid, rnd);

  // Stage 2: overlay distinctive structures (walls, arcs, pillars) on top
  // of the field so the geology has readable shapes, not just clumps.
  for (let y = DIMS.S + 2; y < DIMS.H - 2; y += 4) {
    const depth = y - DIMS.S;
    if (depth < 8) continue; // keep very top purely field-based
    const maxAttempts = 3;
    for (let a = 0; a < maxAttempts; a++) {
      if (rnd() > 0.55) continue;
      const cx = 2 + Math.floor(rnd() * (DIMS.W - 4));
      const cy = y + Math.floor(rnd() * 4);
      const type = pickStructureType(rnd, depth);

      if (type === 'blob') {
        const r = 1.2 + rnd() * (1.5 + depth / 200);
        stampBlob(grid, rnd, cx, cy, r);
      } else if (type === 'wall') {
        const len = 4 + Math.floor(rnd() * 6);
        stampWall(grid, rnd, cx, cy, len);
      } else if (type === 'pillar') {
        const h = 2 + Math.floor(rnd() * 3);
        stampPillar(grid, rnd, cx, cy, h);
      } else {
        const r = 2 + Math.floor(rnd() * 3);
        stampArc(grid, rnd, cx, cy, r);
      }
    }
  }

  // Stage 3: dense clumps — biome-scale high-stone zones the player has to
  // route around. Runs AFTER structure stamps so it dominates locally.
  stampDenseClumps(grid, rnd);

  // Stage 3.5: diagonal faults — long slanted STONE ridges that criss-cross
  // the world. Give the map readable geological features and force detours.
  stampDiagonalFaults(grid, rnd);

  // Stage 4: guarantee vertical passability. Four random winding corridors
  // from surface to bottom — without this the combination of field fill +
  // clumps can wall the diamond off entirely.
  const cx = Math.floor(DIMS.W / 2);
  carveFaultLine(grid, rnd, cx);
  carveFaultLine(grid, rnd, 10 + Math.floor(rnd() * 20));
  carveFaultLine(grid, rnd, 60 + Math.floor(rnd() * 20));
  carveFaultLine(grid, rnd, DIMS.W - 30 + Math.floor(rnd() * 20));

  clearSpawnWindow(grid);
}
