// Off-chain map generation for the operator.
//
// The map is generated HERE (not on-chain) with the SAME generator the frontend
// uses (frontend/src/world), so the grid we upload === the grid the renderer
// regenerates from the seed. We serialize it to the flat [u32] shape the
// contract's Admin.UploadMap(seed, map) expects (row-major, tile byte per cell).

import { randomInt } from 'node:crypto';
import { generateWorld } from '../../frontend/src/world/index.js';

// A random u32 seed (the contract field is u64; the generator uses the low 32
// bits). Random → each daily map differs; deterministic given the seed.
export function randomSeed() {
  return randomInt(0, 0xffffffff);
}

// Generate one digger map (40×64, 3 crystals, lava, stones) for a seed and
// return everything the operator needs to upload + verify it.
export function generateMap(seed = randomSeed()) {
  const s = seed >>> 0;
  const w = generateWorld(s, 'agents'); // 'agents' = digger preset
  const map = Array.from(w.grid);        // flat row-major [u32] tile bytes
  return {
    seed: s,
    width: w.W,
    height: w.H,
    surface: w.surface,
    map,
    valid: w.validation?.ok !== false,
  };
}

// FNV-1a 32-bit over the grid bytes — the same hash used in WORLDGEN_PORTING.md,
// so an uploaded map can be fingerprinted / matched against the frontend.
export function gridHash(map) {
  let h = 0x811c9dc5;
  for (const b of map) { h ^= b & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
