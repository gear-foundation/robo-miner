// Agent factory: scripted stand-in "bots" so we can watch matches and shake out
// the mechanics BEFORE wiring real LLM agents through the skill pack (Phase 3).
// Each agent is { name, kind, hat, color, items?, decide(observation) -> action }
// with private state in a closure. All policies are deterministic functions of
// the observation (no Math.random), so a match stays reproducible.
//
// DIGGER ECONOMY: the world holds 3 redeemable crystals (SCRST/BCRST/HCRST,
// value 66/330/1650). The loop every bot runs:
//   seek nearest visible crystal (avoiding lava) → mine toward it →
//   when cargo fills or fuel runs low → climb out → walk to its OWN column
//   (its totem/spot) → auto-bank + refuel → dive again.
// Bots route around undrillable STONE and never step into LAVA; an anti-stuck
// guard guarantees liveness against walls.

import { BLOCK } from '../config.js';
import { ACTION } from './actions.js';

const LOOK = {
  shuttle: { hat: 'hardhat', color: 'classic' },
  prospector: { hat: 'cap', color: 'mint' },
  deepdiver: { hat: 'horns', color: 'racer' },
  idler: { hat: 'beanie', color: 'carbon' },
};

const WAIT = { type: ACTION.WAIT };
const move = (dir) => ({ type: ACTION.MOVE, dir });

const DIR_D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function viewIndex(obs) {
  const map = new Map();
  for (const t of obs.view.tiles) map.set(`${t.x},${t.y}`, t);
  return map;
}
const tileAt = (idx, x, y) => idx.get(`${x},${y}`) || null;
const isStone = (t) => t && t.block === BLOCK.STONE;
const isLava = (t) => t && t.block === BLOCK.LAVA;
// A tile we must NOT move into: undrillable stone, or lethal lava.
const isBlocked = (t) => isStone(t) || isLava(t);
const neighbor = (idx, pos, dir) => {
  const [dx, dy] = DIR_D[dir];
  return tileAt(idx, pos.x + dx, pos.y + dy);
};

// Falls of more than SAFE tiles hurt/kill (matches the engine's safeFall). Bots
// must not step or dig into a tile from which they'd fatally fall.
const SAFE = 3;

// How far a miner that ends up at (x,ty) would fall: count open tiles below it
// until solid ground / a ladder. Infinity if no ground is visible (cautious —
// treat an unseen drop as a pit).
function fallFrom(idx, x, ty) {
  let d = 0;
  for (let k = 1; k <= SAFE + 2; k++) {
    const t = tileAt(idx, x, ty + k);
    if (!t) return Infinity;
    if (t.solid || t.block === BLOCK.LADDER) return d;
    d++;
  }
  return d; // open all the way down within view → deeper than SAFE
}

// May we move `dir`? Never into stone/lava, and never into a tile that would
// drop us more than SAFE tiles. Up is always fine (climbing auto-places ladders).
function dirOk(idx, s, dir) {
  const t = neighbor(idx, s.pos, dir);
  if (isBlocked(t)) return false;
  if (dir === 'up') return true;
  const [dx, dy] = DIR_D[dir];
  return fallFrom(idx, s.pos.x + dx, s.pos.y + dy) <= SAFE;
}

// Pick a downward dir: straight down if safe, else a safe side, else climb out.
function descend(idx, s, biasRight) {
  const order = ['down', biasRight ? 'right' : 'left', biasRight ? 'left' : 'right', 'up'];
  for (const d of order) if (dirOk(idx, s, d)) return d;
  return 'up';
}

// Pick an upward dir that routes around stone/lava overhead.
function ascend(idx, s) {
  const { x, y } = s.pos;
  if (!isBlocked(tileAt(idx, x, y - 1))) return 'up';
  if (!isBlocked(tileAt(idx, x - 1, y))) return 'left';
  if (!isBlocked(tileAt(idx, x + 1, y))) return 'right';
  return 'up';
}

// Horizontal scan (digs a side tunnel) to reveal crystals at the current depth.
function scanSideways(idx, s, biasRight) {
  const a = biasRight ? 'right' : 'left';
  const b = biasRight ? 'left' : 'right';
  if (dirOk(idx, s, a)) return a;
  if (dirOk(idx, s, b)) return b;
  if (dirOk(idx, s, 'down')) return 'down';
  return 'up';
}

function hasLavaNeighbor(idx, t) {
  for (const dir of ['up', 'down', 'left', 'right']) {
    if (isLava(neighbor(idx, { x: t.x, y: t.y }, dir))) return true;
  }
  return false;
}

// Nearest ladder column at or above our row — a shared climb-out (ours OR a
// teammate's) we can reuse instead of spending our own ladders.
function ladderUpNear(obs, s) {
  let best = null;
  let bestD = Infinity;
  for (const t of obs.view.tiles) {
    if (t.block !== BLOCK.LADDER || t.y > s.pos.y) continue;
    const d = Math.abs(t.x - s.pos.x);
    if (d > 0 && d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Nearest valued tile (= a crystal) in view. `avoidLava` skips crystals ringed
// by lava so the shallow bots don't dive into a deep lava pocket and die.
function nearestCrystal(obs, s, idx, avoidLava) {
  let best = null;
  let bestD = Infinity;
  for (const t of obs.view.tiles) {
    if (!(t.value > 0)) continue;
    if (avoidLava && hasLavaNeighbor(idx, t)) continue;
    const d = Math.abs(t.x - s.pos.x) + Math.abs(t.y - s.pos.y);
    if (d > 0 && d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// One step toward (tx,ty): the distance-reducing dir that isn't stone/lava.
function stepToward(idx, s, tx, ty, biasRight) {
  const dxg = tx - s.pos.x;
  const dyg = ty - s.pos.y;
  const cands = [];
  if (Math.abs(dxg) >= Math.abs(dyg)) {
    if (dxg !== 0) cands.push(dxg > 0 ? 'right' : 'left');
    if (dyg !== 0) cands.push(dyg > 0 ? 'down' : 'up');
  } else {
    if (dyg !== 0) cands.push(dyg > 0 ? 'down' : 'up');
    if (dxg !== 0) cands.push(dxg > 0 ? 'right' : 'left');
  }
  // Fallbacks so we always keep moving even if the direct dirs are blocked.
  cands.push('down', biasRight ? 'right' : 'left', biasRight ? 'left' : 'right', 'up');
  for (const dir of cands) {
    if (dirOk(idx, s, dir)) return dir;
  }
  return 'up';
}

// ---- the one crystal-mining policy (parameterised per role) -----------------
//
// targetDepth : how deep this role explores when no crystal is visible
// bankTarget  : crystals to grab before heading home to bank. Small on purpose
//               — crystals are sparse, so we make lively short trips instead of
//               waiting for a full bag (which would never happen → death spiral).
function minerPolicy({ targetDepth, bankTarget, biasRight }) {
  let home = null;          // own surface column (= spawn x), captured on tick 1
  let mode = 'mine';        // 'mine' | 'home'
  let trip = 0;             // decisions since last bank (patience cap)
  return (obs) => {
    const s = obs.self;
    if (!s.alive) { mode = 'mine'; trip = 0; return WAIT; }
    if (s.busy) return WAIT;
    if (home === null) home = s.pos.x;
    const idx = viewIndex(obs);
    trip++;

    // Head home to bank when: enough crystals, too little fuel to climb back,
    // running low on ladders (climbing spends 1/tile — turn back while we can
    // still reach the surface), or we've wandered a while holding something.
    const lowFuel = s.fuel < Math.max(16, s.depth + 8);
    const lowLadders = s.items.ladder <= s.depth + 1;
    const enough = s.cargoCount >= bankTarget;
    const wandered = s.cargoCount >= 1 && trip > 140;
    if (mode === 'mine' && (enough || lowFuel || lowLadders || wandered)) mode = 'home';

    if (mode === 'home') {
      if (s.depth > 0) {
        // Cooperate: if a ladder (a teammate's or our own earlier shaft) is
        // close, sidestep onto it and climb it for free instead of spending a
        // fresh ladder. This is the "use other people's ladders" behaviour.
        const lad = ladderUpNear(obs, s);
        if (lad && lad.x !== s.pos.x && Math.abs(lad.x - s.pos.x) <= 3) {
          const dir = lad.x < s.pos.x ? 'left' : 'right';
          if (dirOk(idx, s, dir)) return move(dir);
        }
        return move(ascend(idx, s));                    // else climb out (auto-ladders)
      }
      if (s.pos.x !== home) return move(s.pos.x < home ? 'right' : 'left'); // to own totem
      // Arriving on our own spot already auto-banked the cargo. Refuel if we can,
      // then dive again.
      if (s.fuel < s.maxFuel && s.money >= 5) return { type: ACTION.REFUEL };
      mode = 'mine'; trip = 0;
      // fall through into mining this same tick
    }

    // MINING: chase the nearest visible crystal (never lava), else explore.
    const target = nearestCrystal(obs, s, idx, true);
    if (target) return move(stepToward(idx, s, target.x, target.y, biasRight));
    if (s.depth < targetDepth) return move(descend(idx, s, biasRight));
    return move(scanSideways(idx, s, biasRight));
  };
}

function idlerPolicy() {
  return () => WAIT;
}

// Role config. Every digger gets a budget of 10 ladders (the spec's limited
// consumable, refilled on returning to the surface). Climbing spends 1 ladder
// per tile, so 10 ladders caps a single dive at ~10 deep — the bots watch their
// count and turn back in time (see lowLadders). Deeper bands (mid/deep crystals,
// lava-locked HCRST) need ladder upgrades / smarter agents — left for later.
const ROLES = {
  shuttle:    { targetDepth: 7, bankTarget: 3, maxLadders: 10 },
  prospector: { targetDepth: 8, bankTarget: 4, maxLadders: 10 },
  deepdiver:  { targetDepth: 9, bankTarget: 4, maxLadders: 10 },
};

const POLICIES = {
  shuttle: ({ biasRight }) => minerPolicy({ ...ROLES.shuttle, biasRight }),
  prospector: ({ biasRight }) => minerPolicy({ ...ROLES.prospector, biasRight }),
  deepdiver: ({ biasRight }) => minerPolicy({ ...ROLES.deepdiver, biasRight }),
  idler: idlerPolicy,
};

export const AGENT_KINDS = Object.keys(POLICIES);

/**
 * Create one scripted agent.
 * @param {string} kind   one of AGENT_KINDS
 * @param {object} [opts] { name, hat, color, biasRight }
 */
export function createAgent(kind, opts = {}) {
  const make = POLICIES[kind] || idlerPolicy;
  const look = LOOK[kind] || LOOK.idler;
  const biasRight = opts.biasRight ?? true;
  const policy = make({ biasRight });

  // Anti-stuck guard: if the miner hasn't moved for a few non-digging ticks,
  // rotate through SAFE directions (never into stone/lava) to break out.
  let lastKey = null;
  let same = 0;
  let phase = 0;
  const ESCAPE = ['down', 'right', 'left', 'up'];
  const decide = (obs) => {
    const s = obs.self;
    if (!s.alive) { lastKey = null; same = 0; return WAIT; }
    if (s.busy) return WAIT; // mid-dig: don't count as stuck
    const key = `${s.pos.x},${s.pos.y}`;
    if (key === lastKey) same++; else { same = 0; lastKey = key; }
    if (same >= 3) {
      phase++;
      const idx = viewIndex(obs);
      const order = [ESCAPE[phase % ESCAPE.length], ...ESCAPE];
      for (const d of order) {
        if (dirOk(idx, s, d)) return move(d);
      }
      return move('up');
    }
    return policy(obs);
  };

  return {
    name: opts.name || kind,
    kind,
    hat: opts.hat || look.hat,
    color: opts.color || look.color,
    items: null,
    // Test bots get a wider scan than the L1 radar (2) so they actually SEE
    // crystals to chase; real agents would query world state instead.
    radar: opts.radar ?? 4,
    // Ladder budget sized to the role's depth so it can climb back to bank.
    maxLadders: ROLES[kind]?.maxLadders ?? 12,
    decide,
  };
}

/** Build a mixed roster, e.g. createSquad({ shuttle: 4, prospector: 3 }). */
export function createSquad(counts) {
  const roster = [];
  let i = 0;
  for (const [kind, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) {
      roster.push(createAgent(kind, { name: `${kind}-${k}`, biasRight: i % 2 === 0 }));
      i++;
    }
  }
  return roster;
}
