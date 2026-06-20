// World generation pipeline.
//
// Order matters. Each step gets the shared grid (Uint8Array) plus the seeded
// RNG, and returns any artifacts later steps need (pocket list, diamond
// position, chest list, etc). Stub steps (pois/chests/clues/signals) are
// already wired so adding content later is a one-file change.
//
// Stages roughly follow the design doc section 14:
//   1. base fill        → raw per-tile ore rolls + sky above surface
//   2. barriers         → unbreakable STONE clusters
//   3. caves            → elliptical pockets + passages (returns pocket list)
//   4. veins            → clustered ore walkers, biased toward pockets
//   5. diamond          → single end-game target near the bottom
//   6. POIs             → stub (vaults, miner rooms, ...)
//   7. chests           → stub (entity list, not grid blocks)
//   8. clues            → stub (predecessor hints)
//   9. signals          → stub (precomputed radar data)
//  10. validate         → reachability / budget checks

import { setDims } from './dims.js';
import { resolveSpec } from './spec.js';
import { makeRng } from './rng.js';
import { baseFill, baseFillDirt } from './steps/baseFill.js';
import { placeCrystals, placeDiggerChests, placeStones, validateDigger } from './steps/crystals.js';
import { placeBarriers, carveFaultLine } from './steps/barriers.js';
import { carveCaves } from './steps/caves.js';
import { placeOreVeins } from './steps/veins.js';
import { sealSomeVeins } from './steps/sealVeins.js';
import { placeDiamond } from './steps/diamond.js';
import { placePOIs } from './steps/pois.js';
import { placeChests } from './steps/chests.js';
import { placeClues } from './steps/clues.js';
import { placeSignals } from './steps/signals.js';
import { placeLava } from './steps/lava.js';
import { placeWater } from './steps/water.js';
import { validate } from './steps/validate.js';

export function generateWorld(seed = Date.now(), spec) {
  const resolved = resolveSpec(spec);
  const dims = setDims(resolved);
  // Agent presets retry with fresh seeds until the diamond is reachable; solo
  // keeps the original warn-only behaviour (attempts === 1 ⇒ byte-identical).
  const attempts = resolved.regen ? 8 : 1;
  let world;
  for (let a = 0; a < attempts; a++) {
    const passSeed = (seed + a * 0x9e3779b1) >>> 0;
    world = resolved.model === 'digger'
      ? generateDiggerPass(passSeed, dims)
      : generatePass(passSeed, dims);
    if (world.validation.ok) break;
  }
  if (!world.validation.ok) {
    // eslint-disable-next-line no-console
    console.warn('[world] validation warnings:', world.validation.warnings);
  }
  return world;
}

// Digger (agent-arena) generation pass — the brief's compact world: dirt +
// caves + stones + 3 redeemable crystals + contract-resolved chests. No 8-ore
// base fill, no diamond, POIs, water, artifacts, or lava. The stone border is a
// renderer-only frame, so the whole generated grid stays playable and
// contract-owned.
function generateDiggerPass(seed, dims) {
  const rnd = makeRng(seed);
  const grid = new Uint8Array(dims.W * dims.H);

  baseFillDirt(grid);                 // sky + solid dirt
  const pockets = carveCaves(grid, rnd, pickDiggerCaveProfile(rnd)); // navigable pockets / passages
  placeStones(grid, rnd);             // scattered rock obstacles (also fall when undermined)
  const crystals = placeCrystals(grid, rnd); // SCRST / BCRST / HCRST
  const { chests, chestsAt } = placeDiggerChests(grid, rnd); // contract decides loot/trap on drill

  const world = {
    grid, seed, W: dims.W, H: dims.H, surface: dims.S, model: 'digger',
    crystals, pockets,
    // Fields the runtime/renderer read on any world.
    diamondPos: null, pois: [], chests, chestsAt, signals: null,
  };
  world.validation = validateDigger(world);
  return world;
}

function pickDiggerCaveProfile(rnd) {
  const r = rnd();
  if (r < 0.30) {
    return {
      extraPockets: 0,
      widthMin: 3,
      widthRange: 5,
      heightMin: 2,
      heightRange: 3,
      horizontalPassageChance: 0.45,
      verticalPassageChance: 0.18,
    };
  }
  if (r < 0.68) {
    return {
      extraPockets: 1,
      widthMin: 4,
      widthRange: 6,
      heightMin: 2,
      heightRange: 4,
      horizontalPassageChance: 0.58,
      verticalPassageChance: 0.30,
    };
  }
  return {
    extraPockets: 2,
    widthMin: 3,
    widthRange: 8,
    heightMin: 2,
    heightRange: 5,
    horizontalPassageChance: 0.70,
    verticalPassageChance: 0.42,
    horizontalPassageRange: 14,
    verticalPassageRange: 13,
  };
}

function generatePass(seed, dims) {
  const rnd = makeRng(seed);
  const grid = new Uint8Array(dims.W * dims.H);

  baseFill(grid, rnd);
  placeBarriers(grid, rnd);
  const pockets = carveCaves(grid, rnd);
  placeOreVeins(grid, rnd, pockets);
  sealSomeVeins(grid, rnd);
  const diamondPos = placeDiamond(grid, rnd);
  // Re-carve a fault toward the diamond so the sealing pass can't strand it.
  carveFaultLine(grid, rnd, diamondPos.x);

  const ctx = { pockets, diamondPos };
  const { chests, chestsAt } = placeChests(grid, rnd, { ...ctx });
  // POIs come AFTER chests so vault contents (premium chests inside a
  // stone shell) can register into the chestsAt map directly.
  const pois = placePOIs(grid, rnd, { ...ctx, chests, chestsAt });
  placeClues(grid, rnd, { ...ctx, pois, chests });
  const signals = placeSignals(grid, rnd, { ...ctx, pois, chests });

  placeLava(grid, rnd);
  placeWater(grid, rnd, pockets);

  const world = { grid, seed, W: dims.W, H: dims.H, surface: dims.S, diamondPos, pockets, pois, chests, chestsAt, signals };
  world.validation = validate(world, ctx);
  return world;
}
