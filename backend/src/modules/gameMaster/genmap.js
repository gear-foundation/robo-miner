// Off-chain map generation for the operator.
//
// The map is generated HERE (not on-chain) with the SAME generator the frontend
// uses (frontend/src/world). The frontend renderer has its own BLOCK ids, while
// the live DiggerWorld contract stores compact tile ids, so this file is the
// single boundary that turns a render grid into the Admin.UploadMap payload.

import { randomInt } from 'node:crypto';
import { generateWorld } from '../../../../frontend/src/world/index.js';
import { BLOCK } from '../../../../frontend/src/config.js';

// DiggerWorld contract tile ids. Keep in sync with
// contracts/digger-world/app/src/constants.rs.
export const CONTRACT_TILE = {
  EMPTY: 0,
  DIRT: 1,
  STONE: 2,
  LAVA: 3,
  LADDER: 4,
  SCRST: 10,
  BCRST: 11,
  HCRST: 12,
  SURFACE: 20,
};

const RESOURCE_COUNTS_40x64 = {
  [CONTRACT_TILE.SCRST]: 77,
  [CONTRACT_TILE.BCRST]: 19,
  [CONTRACT_TILE.HCRST]: 4,
};

export const DEFAULT_CONTRACT_SURFACE = 1;

// A random u32 seed (the contract field is u64; the generator uses the low 32
// bits). Random → each daily map differs; deterministic given the seed.
export function randomSeed() {
  return randomInt(0, 0xffffffff);
}

export function histogram(map) {
  const counts = {};
  for (const tile of map) counts[tile] = (counts[tile] || 0) + 1;
  return counts;
}

function encodeTile(renderTile, y, renderSurface, contractSurface) {
  if (y < contractSurface) return CONTRACT_TILE.SURFACE;
  if (y < renderSurface) return CONTRACT_TILE.DIRT;

  switch (renderTile) {
    case BLOCK.SKY: return CONTRACT_TILE.EMPTY;
    case BLOCK.DIRT: return CONTRACT_TILE.DIRT;
    case BLOCK.STONE: return CONTRACT_TILE.STONE;
    case BLOCK.LAVA: return CONTRACT_TILE.LAVA;
    case BLOCK.LADDER: return CONTRACT_TILE.LADDER;
    case BLOCK.SCRST: return CONTRACT_TILE.SCRST;
    case BLOCK.BCRST: return CONTRACT_TILE.BCRST;
    case BLOCK.HCRST: return CONTRACT_TILE.HCRST;
    default:
      throw new Error(`unsupported render tile ${renderTile} for DiggerWorld upload`);
  }
}

export function encodeContractMap(world, opts = {}) {
  const contractSurface = opts.contractSurface ?? DEFAULT_CONTRACT_SURFACE;
  const out = new Array(world.W * world.H);
  for (let y = 0; y < world.H; y++) {
    for (let x = 0; x < world.W; x++) {
      const i = y * world.W + x;
      out[i] = encodeTile(world.grid[i], y, world.surface, contractSurface);
    }
  }
  return out;
}

function expectedResourceCounts(width, height) {
  const scale = (width * height) / (40 * 64);
  return Object.fromEntries(
    Object.entries(RESOURCE_COUNTS_40x64).map(([tile, count]) => [tile, Math.max(1, Math.round(count * scale))]),
  );
}

function validateContractMap(world, map, opts = {}) {
  const contractSurface = opts.contractSurface ?? DEFAULT_CONTRACT_SURFACE;
  const warnings = [];
  const expectedCells = world.W * world.H;
  if (map.length !== expectedCells) warnings.push(`map length ${map.length} != ${expectedCells}`);

  const counts = histogram(map);
  for (const [tile, expected] of Object.entries(expectedResourceCounts(world.W, world.H))) {
    const actual = counts[tile] || 0;
    if (actual !== expected) warnings.push(`tile ${tile} count ${actual} != ${expected}`);
  }

  for (let y = 0; y < contractSurface; y++) {
    for (let x = 0; x < world.W; x++) {
      if (map[y * world.W + x] !== CONTRACT_TILE.SURFACE) {
        warnings.push(`non-surface tile above mine at ${x},${y}`);
        x = world.W;
        y = contractSurface;
      }
    }
  }

  for (let y = contractSurface; y < world.surface; y++) {
    for (let x = 0; x < world.W; x++) {
      if (map[y * world.W + x] !== CONTRACT_TILE.DIRT) {
        warnings.push(`non-dirt visual padding at ${x},${y}`);
        x = world.W;
        y = world.surface;
      }
    }
  }

  return { counts, warnings };
}

// Generate one digger map (40×64, 3 crystals, lava, stones) for a seed and
// return everything the operator needs to upload + verify it.
export function generateMap(seed = randomSeed(), opts = {}) {
  const s = seed >>> 0;
  const contractSurface = opts.contractSurface ?? DEFAULT_CONTRACT_SURFACE;
  const w = generateWorld(s, 'agents'); // 'agents' = digger preset
  const renderMap = Array.from(w.grid);  // frontend BLOCK ids, useful for debug
  const map = encodeContractMap(w, { contractSurface }); // row-major [u32] UploadMap payload
  const { counts, warnings } = validateContractMap(w, map, { contractSurface });
  const validationWarnings = [
    ...(w.validation?.warnings || []),
    ...warnings,
  ];
  return {
    seed: s,
    width: w.W,
    height: w.H,
    surface: w.surface,
    contractSurface,
    map,
    renderMap,
    counts,
    warnings: validationWarnings,
    valid: w.validation?.ok !== false && validationWarnings.length === 0,
  };
}

// FNV-1a 32-bit over the UploadMap bytes, so the exact contract payload can be
// fingerprinted in logs and matched against dry-run JSON.
export function gridHash(map) {
  let h = 0x811c9dc5;
  for (const b of map) { h ^= b & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
