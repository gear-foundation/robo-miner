// Lava pools at the deepest layers. Visually red wavy bands (drawn in
// GameScene); mechanically unbreakable + damaging to the player on contact.
//
// We place a handful of pool centers in the bottom band and stamp wide,
// shallow puddles (more horizontal than vertical) so they read as pools,
// not columns. Lava only replaces DIRT/ore — never SKY (so it doesn't
// plug existing caves) and never STONE (so the stone silhouette stays
// intact).

import { BLOCK } from '../../config.js';
import { DIMS, scaleDepth } from '../dims.js';
import { idx } from '../grid.js';

const LAVA_START_DEPTH = 200;

function tryPlaceLava(grid, x, y) {
  if (x < 1 || x >= DIMS.W - 1 || y <= DIMS.S || y >= DIMS.H - 1) return;
  const t = grid[idx(x, y)];
  if (t === BLOCK.SKY || t === BLOCK.STONE || t === BLOCK.DIAMOND) return;
  grid[idx(x, y)] = BLOCK.LAVA;
}

function stampPuddle(grid, rnd, cx, cy, rx, ry) {
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      if (rnd() < 0.85) tryPlaceLava(grid, x, y);
    }
  }
}

export function placeLava(grid, rnd) {
  const poolCount = 5;
  const start = scaleDepth(LAVA_START_DEPTH);
  for (let i = 0; i < poolCount; i++) {
    const range = Math.max(1, DIMS.H - DIMS.S - start - 4);
    const depth = start + Math.floor(rnd() * range);
    const cy = DIMS.S + depth;
    const cx = 6 + Math.floor(rnd() * (DIMS.W - 12));
    const rx = 4 + Math.floor(rnd() * 5);
    const ry = 1 + Math.floor(rnd() * 2);
    stampPuddle(grid, rnd, cx, cy, rx, ry);
  }
}
