import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

// Seals the world in an unbreakable STONE border so the robot can't walk out.
export function frameWorld(grid) {
  const WALL = 1;
  for (let y = DIMS.S; y < DIMS.H; y++) {
    for (let w = 0; w < WALL; w++) {
      grid[idx(w, y)] = BLOCK.STONE;
      grid[idx(DIMS.W - 1 - w, y)] = BLOCK.STONE;
    }
  }
  for (let x = 0; x < DIMS.W; x++) {
    for (let w = 0; w < WALL; w++) grid[idx(x, DIMS.H - 1 - w)] = BLOCK.STONE;
  }
}
