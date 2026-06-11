// Operator-local map generation.
//
// We reuse the backend/frontend generator but STRIP the outer stone ring before
// upload. The DiggerWorld contract already clamps movement at the map edges
// (contracts/.../map.rs target_position: RIGHT errors at x+1>=W, LEFT at x==0,
// DOWN at y+1>=H, UP at y==0), so the stone border is redundant for physics and
// only steals the outer ring — leaving 38 of 40 columns and one less depth row
// playable. The frame is UI decoration drawn outside the playfield in the
// spectator, so here we make every contract-addressable cell playable.
//
// We only flip border-position STONE → DIRT below the surface row, so the
// contract's validate_uploaded_map still passes (row 0 stays all SURFACE,
// resource counts are unchanged — stone is not a resource).

import {
  generateMap as generateBorderedMap,
  CONTRACT_TILE,
  DEFAULT_CONTRACT_SURFACE,
  randomSeed,
  histogram,
  gridHash,
  encodeContractMap,
} from '../../backend/src/modules/gameMaster/genmap.js';

export { CONTRACT_TILE, DEFAULT_CONTRACT_SURFACE, randomSeed, histogram, gridHash, encodeContractMap };

// Turn the outer stone ring (left/right columns + bottom row, below row 0) into
// dirt. Interior stone, lava, resources and the surface row are untouched.
function stripBorder(map, w, h) {
  const out = map.slice();
  for (let y = 1; y < h; y += 1) {
    if (out[y * w] === CONTRACT_TILE.STONE) out[y * w] = CONTRACT_TILE.DIRT;
    if (out[y * w + (w - 1)] === CONTRACT_TILE.STONE) out[y * w + (w - 1)] = CONTRACT_TILE.DIRT;
  }
  for (let x = 0; x < w; x += 1) {
    const i = (h - 1) * w + x;
    if (out[i] === CONTRACT_TILE.STONE) out[i] = CONTRACT_TILE.DIRT;
  }
  return out;
}

export function generateMap(seed = randomSeed(), opts = {}) {
  const base = generateBorderedMap(seed, opts);
  const map = stripBorder(base.map, base.width, base.height);
  // The backend validator expects a stone border (left/right/bottom wall) — now
  // intentionally gone — so drop those warnings; keep the rest (resource counts).
  const warnings = (base.warnings || []).filter((w) => !/wall/i.test(w));
  return {
    ...base,
    map,
    counts: histogram(map),
    warnings,
    valid: warnings.length === 0,
  };
}
