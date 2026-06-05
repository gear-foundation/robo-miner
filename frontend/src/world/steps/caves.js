import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

function carveCell(grid, x, y) {
  if (x <= 2 || x >= DIMS.W - 3 || y <= DIMS.S + 3 || y >= DIMS.H - 3) return;
  const i = idx(x, y);
  if (grid[i] === BLOCK.DIAMOND) return;
  grid[i] = BLOCK.SKY;
}

function carvePocket(grid, rnd, cx, cy, w, h) {
  const xMin = Math.max(3, Math.floor(cx - w / 2));
  const xMax = Math.min(DIMS.W - 4, Math.ceil(cx + w / 2));
  const yMin = Math.max(DIMS.S + 4, Math.floor(cy - h / 2));
  const yMax = Math.min(DIMS.H - 4, Math.ceil(cy + h / 2));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const nx = Math.abs((x - cx) / Math.max(1, w / 2));
      const ny = Math.abs((y - cy) / Math.max(1, h / 2));
      if (nx + ny * 0.85 < 1.05 || rnd() < 0.18) carveCell(grid, x, y);
    }
  }
}

function carveShortPassage(grid, rnd, x, y, len, dir) {
  let cx = x;
  let cy = y;
  for (let i = 0; i < len; i++) {
    carveCell(grid, cx, cy);
    if (rnd() < 0.30) carveCell(grid, cx, cy + (rnd() < 0.5 ? -1 : 1));
    if (dir === 'h') {
      cx += rnd() < 0.5 ? -1 : 1;
      if (rnd() < 0.25) cy += rnd() < 0.5 ? -1 : 1;
    } else {
      cy += 1;
      if (rnd() < 0.35) cx += rnd() < 0.5 ? -1 : 1;
    }
    cx = Math.max(4, Math.min(DIMS.W - 5, cx));
    cy = Math.max(DIMS.S + 4, Math.min(DIMS.H - 5, cy));
  }
}

// Carves elliptical pockets + short passages. Returns pocket centers so later
// steps (veins, POIs) can cluster interesting content around them.
export function carveCaves(grid, rnd) {
  const pockets = [];
  const pocketCount = Math.floor((DIMS.W * (DIMS.H - DIMS.S)) / 620);
  for (let i = 0; i < pocketCount; i++) {
    const depth = 12 + Math.floor(rnd() * (DIMS.H - DIMS.S - 22));
    const cx = 5 + Math.floor(rnd() * (DIMS.W - 10));
    const cy = DIMS.S + depth;
    const w = 3 + Math.floor(rnd() * 6);
    const h = 2 + Math.floor(rnd() * 4);
    carvePocket(grid, rnd, cx, cy, w, h);
    pockets.push({ x: cx, y: cy });
    if (rnd() < 0.55) carveShortPassage(grid, rnd, cx, cy, 4 + Math.floor(rnd() * 10), 'h');
    if (rnd() < 0.28) carveShortPassage(grid, rnd, cx, cy, 5 + Math.floor(rnd() * 10), 'v');
  }
  return pockets;
}

export { carvePocket };
