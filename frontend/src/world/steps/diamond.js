import { BLOCK } from '../../config.js';
import { DIMS, scaleDepth } from '../dims.js';
import { idx } from '../grid.js';
import { carvePocket } from './caves.js';

// Places the unique DIAMOND near the bottom, with a small cave pocket
// nearby so the radar has a reachable target on the final approach.
export function placeDiamond(grid, rnd) {
  const WALL = 1;
  const dx = WALL + 1 + Math.floor(rnd() * (DIMS.W - WALL * 2 - 2));
  const dy = DIMS.S + scaleDepth(225) + Math.floor(rnd() * Math.max(1, scaleDepth(18)));
  const safeY = Math.min(dy, DIMS.H - 3);
  carvePocket(
    grid,
    rnd,
    Math.max(4, Math.min(DIMS.W - 5, dx + (rnd() < 0.5 ? -4 : 4))),
    safeY,
    5,
    3,
  );
  grid[idx(dx, safeY)] = BLOCK.DIAMOND;
  return { x: dx, y: safeY };
}
