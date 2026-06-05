// Room map preview / thumbnail.
//
// Downsamples a generated world into a small grid for the lobby gallery (a 2-D
// array of hex colors the menu can paint to a tiny canvas / Phaser texture) and
// an ASCII version for terminals and quick debugging. Optionally overlays live
// agent positions so the same function doubles as a terminal "spectator" view.
//
// Pure + deterministic. Each output cell scans the tiles it covers and keeps the
// most interesting block (diamond > lava > chest > ore > stone > dirt > sky) so
// landmarks survive the downscale instead of being averaged away.

import { BLOCK, BLOCK_DATA } from '../config.js';
import { getBlock } from '../world.js';

// Low rank = boring, high rank = a landmark worth surfacing in the thumbnail.
const PRIORITY = [
  BLOCK.SKY, BLOCK.DIRT, BLOCK.LADDER, BLOCK.PILLAR, BLOCK.STONE, BLOCK.WATER,
  BLOCK.COAL, BLOCK.IRON, BLOCK.COPPER, BLOCK.SILVER, BLOCK.GOLD, BLOCK.EMERALD,
  BLOCK.RUBY, BLOCK.BONE, BLOCK.COIN, BLOCK.RING, BLOCK.SKULL,
  BLOCK.SHRINE, BLOCK.CHEST, BLOCK.LAVA, BLOCK.DIAMOND,
];
const RANK = new Map(PRIORITY.map((b, i) => [b, i]));
const rankOf = (t) => (RANK.has(t) ? RANK.get(t) : 1);

const GLYPH = {
  [BLOCK.SKY]: ' ',
  [BLOCK.DIRT]: '.',
  [BLOCK.STONE]: 'X',
  [BLOCK.WATER]: '~',
  [BLOCK.LAVA]: '!',
  [BLOCK.LADDER]: 'H',
  [BLOCK.PILLAR]: 'I',
  [BLOCK.CHEST]: 'C',
  [BLOCK.SHRINE]: 'S',
  [BLOCK.DIAMOND]: '*',
};
const ORE = new Set([
  BLOCK.COAL, BLOCK.IRON, BLOCK.COPPER, BLOCK.SILVER, BLOCK.GOLD,
  BLOCK.EMERALD, BLOCK.RUBY, BLOCK.BONE, BLOCK.COIN, BLOCK.RING, BLOCK.SKULL,
]);
function glyphFor(type) {
  if (GLYPH[type] !== undefined) return GLYPH[type];
  if (ORE.has(type)) return '+';
  return '?';
}

const AGENT_GLYPH = '@';
const AGENT_COLOR = 0xffffff;

/**
 * @param {object} world  generated world (grid + metadata)
 * @param {object} [opts]
 * @param {number} [opts.cols=48] thumbnail width in cells
 * @param {number} [opts.rows=64] thumbnail height in cells
 * @param {Array}  [opts.miners]  optional [{x,y}, ...] live overlay
 * @returns {{cols, rows, colors: number[][], ascii: string}}
 */
export function roomThumbnail(world, opts = {}) {
  const cols = opts.cols || 48;
  const rows = opts.rows || 64;
  const colW = world.W / cols;
  const rowH = world.H / rows;

  const colors = [];
  const lines = [];
  for (let ry = 0; ry < rows; ry++) {
    const crow = [];
    let line = '';
    const y0 = Math.floor(ry * rowH);
    const y1 = Math.max(y0 + 1, Math.floor((ry + 1) * rowH));
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor(rx * colW);
      const x1 = Math.max(x0 + 1, Math.floor((rx + 1) * colW));
      let best = BLOCK.SKY;
      let bestRank = -1;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const t = getBlock(world, x, y);
          const r = rankOf(t);
          if (r > bestRank) { bestRank = r; best = t; }
        }
      }
      crow.push(BLOCK_DATA[best]?.color ?? 0x000000);
      line += glyphFor(best);
    }
    colors.push(crow);
    lines.push(line);
  }

  // Overlay live agents on top of the terrain.
  if (opts.miners && opts.miners.length) {
    const arr = lines.map((l) => l.split(''));
    for (const m of opts.miners) {
      if (m.x == null || m.y == null) continue;
      const rx = Math.min(cols - 1, Math.floor(m.x / colW));
      const ry = Math.min(rows - 1, Math.floor(m.y / rowH));
      arr[ry][rx] = AGENT_GLYPH;
      colors[ry][rx] = AGENT_COLOR;
    }
    for (let i = 0; i < arr.length; i++) lines[i] = arr[i].join('');
  }

  return { cols, rows, colors, ascii: lines.join('\n') };
}
