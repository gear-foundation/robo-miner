// Shallow-zone water pools. For a fraction of the cave pockets carved in
// the first ~60m of depth we flood the bottom rows — water sits on top of
// a solid floor (or stone) like a real puddle. Passing through drains
// fuel and chips HP (see BLOCK_DATA[BLOCK.WATER]).
//
// Why only shallow: deep layers get lava instead. Mixing both up top would
// dilute the hazard identity.

import { BLOCK } from '../../config.js';
import { DIMS, scaleDepth } from '../dims.js';
import { idx } from '../grid.js';

const WATER_MIN_DEPTH = 12;
const WATER_MAX_DEPTH = 90;
const WATER_POCKET_FRACTION = 0.35;

function isOpen(grid, x, y) {
  return grid[idx(x, y)] === BLOCK.SKY;
}
function isFloor(grid, x, y) {
  const t = grid[idx(x, y)];
  return t !== BLOCK.SKY && t !== BLOCK.WATER;
}

// Flood-fill the bottom rows of one pocket up to `levels` rows high. We walk
// the pocket column-by-column: in each column find the lowest SKY tile, then
// fill upward while there's SKY and a floor below — so water doesn't spill
// into connected passages unpredictably.
function floodPocket(grid, cx, cy, wRadius, hRadius, levels) {
  const xMin = Math.max(2, cx - wRadius);
  const xMax = Math.min(DIMS.W - 3, cx + wRadius);
  for (let x = xMin; x <= xMax; x++) {
    // Find the lowest sky cell in the pocket's vertical band.
    let bottom = -1;
    for (let y = cy + hRadius; y >= cy - hRadius; y--) {
      if (y <= DIMS.S + 1 || y >= DIMS.H - 2) continue;
      if (isOpen(grid, x, y) && isFloor(grid, x, y + 1)) {
        bottom = y;
        break;
      }
    }
    if (bottom < 0) continue;
    for (let i = 0; i < levels; i++) {
      const y = bottom - i;
      if (y <= DIMS.S + 1) break;
      if (!isOpen(grid, x, y)) break;
      grid[idx(x, y)] = BLOCK.WATER;
    }
  }
}

export function placeWater(grid, rnd, pockets) {
  const minD = scaleDepth(WATER_MIN_DEPTH);
  const maxD = scaleDepth(WATER_MAX_DEPTH);
  const eligible = pockets.filter(p => {
    const depth = p.y - DIMS.S;
    return depth >= minD && depth <= maxD;
  });
  const count = Math.floor(eligible.length * WATER_POCKET_FRACTION);
  // Simple reservoir sampling: shuffle-light by swapping with a random index.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rnd() * (eligible.length - i));
    const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    const p = eligible[i];
    const wRad = 3 + Math.floor(rnd() * 4);
    const hRad = 2 + Math.floor(rnd() * 2);
    const levels = 1 + Math.floor(rnd() * 2); // puddle 1-2 deep
    floodPocket(grid, p.x, p.y, wRad, hRad, levels);
  }
}
