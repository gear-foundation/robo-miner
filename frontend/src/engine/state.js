// Match + miner state construction. Pure data — no Phaser, no DOM.

import { generateWorld } from '../world.js';
import { createRobot } from '../robot.js';
import { createRng } from './rng.js';
import { SURFACE_ROW, DEFAULT_MAX_TICKS, SAFE_FALL, RESPAWN_TICKS } from './constants.js';

let _seq = 0;

// One miner = a robot (reused from robot.js) + multiplayer/control fields.
function createMiner(id, tx, ty, spec = {}) {
  const base = createRobot(tx, ty);
  // Optional starting-item overrides (e.g. give a deep-diver bot dynamite).
  if (spec.items) base.items = { ...base.items, ...spec.items };
  // Optional radar (scan radius) override — test bots see farther than L1.
  if (spec.radar != null) base.radar = spec.radar;
  // Optional ladder budget override — sized to a bot's dive depth so it can
  // climb back out (start full + refill to this at the surface).
  if (spec.maxLadders != null) { base.maxLadders = spec.maxLadders; base.items.ladder = spec.maxLadders; }
  return {
    ...base,
    id,
    name: spec.name || `miner-${id}`,
    hat: spec.hat || 'hardhat',
    color: spec.color || 'classic',
    // Each miner's home spot — where it spawned, and where it respawns.
    spawnX: tx,
    spawnY: ty,
    // Optional per-miner lever whitelist (null = every lever available).
    allowed: spec.allowed || null,
    facing: 'right',
    alive: true,
    // null when idle; { type:'dig', tx, ty, blockType, ticksLeft, totalTicks } while busy.
    busy: null,
    // Tick at which a dead miner respawns (null while alive).
    respawnAt: null,
    // Tracks the start of a fall so landing damage knows the distance.
    fallStartY: null,
    stats: { tilesDug: 0, oresCollected: 0, deaths: 0, sold: 0, spent: 0 },
  };
}

// Spread spawn columns around the shop door: 0, +1, -1, +2, -2, ...
function spreadOffset(i) {
  const step = Math.ceil(i / 2);
  return i % 2 === 1 ? step : -step;
}

const clampCol = (c, W) => Math.max(1, Math.min(W - 2, c));

// Where the N miners start. 'cluster' packs them around the shop door (good for
// a small co-op squad); 'wide' fans them across the whole surface so 10 agents
// don't all fight over the same central shaft. Selling works anywhere on the
// surface row, so a wide spread only costs a walk to the shop for upgrades.
function spawnColumns(n, shopX, mode, W) {
  if (mode === 'cluster') {
    return Array.from({ length: n }, (_, i) => clampCol(shopX + spreadOffset(i), W));
  }
  // Margin scales with width so a narrow map (40-wide digger arena) still fans
  // the diggers across nearly the whole surface instead of bunching mid-map.
  const margin = Math.max(2, Math.round(W * 0.05));
  const lo = margin;
  const hi = W - 1 - margin;
  if (n <= 1) return [shopX];
  return Array.from({ length: n }, (_, i) => clampCol(Math.round(lo + ((hi - lo) * i) / (n - 1)), W));
}

/**
 * Build a fresh match.
 * @param {object} opts
 * @param {number} opts.seed         deterministic world + gameplay seed
 * @param {Array}  opts.miners       per-miner specs [{name, hat, color}, ...]
 * @param {string} opts.mode         'coop' (only mode for now)
 * @param {number} opts.maxTicks     hard ceiling on match length
 */
export function createMatch(opts = {}) {
  const seed = (opts.seed ?? 12345) >>> 0;
  const miners = opts.miners && opts.miners.length ? opts.miners : [{}];
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;

  // opts.spec picks the world preset/shape per mode ('solo'|'coop'|'arena' or a
  // partial WorldSpec). Defaults to solo = today's single-player world.
  const world = generateWorld(seed, opts.spec);
  // Distinct stream from the world generator so loot doesn't correlate with
  // terrain.
  const rng = createRng((seed ^ 0x5f3759df) >>> 0);
  const shopX = Math.floor(world.W / 2);

  // Default to a wide fan-out once the squad is bigger than a handful.
  const spawnMode = opts.spawn || (miners.length > 4 ? 'wide' : 'cluster');
  const cols = spawnColumns(miners.length, shopX, spawnMode, world.W);
  const built = [];
  for (let i = 0; i < miners.length; i++) {
    built.push(createMiner(i, cols[i], SURFACE_ROW, miners[i] || {}));
  }

  return {
    id: ++_seq,
    seed,
    mode: opts.mode || 'coop',
    tick: 0,
    maxTicks,
    world,
    rng,
    shopX,
    // Per-match balance knobs. Single-player uses the strict defaults; coop
    // agent matches can soften them (e.g. a larger safeFall so bots that dig
    // vertical shafts don't die on every drop). See MULTIPLAYER_PLAN.md §7b.
    config: {
      safeFall: opts.safeFall ?? SAFE_FALL,
      respawnTicks: opts.respawnTicks ?? RESPAWN_TICKS,
      // Match-wide lever whitelist (null = all levers; a per-miner `allowed`
      // overrides this). Lets you hand bots only a subset of the controls.
      allowedActions: opts.allowedActions ?? null,
      // Win conditions (tie generation/mode to how a match ends):
      //   diamondWins — turning in the diamond ends the match with a win
      //   scoreTarget — reaching this team score ends the match
      //   maxTicks (top-level) — always ends the match ('time')
      victory: {
        diamondWins: opts.victory?.diamondWins ?? true,
        scoreTarget: opts.victory?.scoreTarget ?? null,
      },
    },
    miners: built,
    // Physics state
    fallingStones: [], // { x, y, state:'shake'|'fall', shakeTicksLeft }
    fallingPillars: [], // { x, y, fallAtTick }
    activeLava: new Map(), // key -> { x, y, budget, nextStepTick }
    bombs: [], // { x, y, radius, fuseTicksLeft, planter }
    // Cooperative bookkeeping
    teamBankSold: 0, // total $ ever auto-sold by the team (informational)
    diamondFound: false,
    finished: false,
    finishedReason: null,
    teamScore: 0,
    // Per-tick event log (cleared each step), consumed by renderer / logging.
    events: [],
  };
}

export { createMiner, spreadOffset };
