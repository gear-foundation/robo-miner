// Agent factory: scripted stand-in "bots" so we can watch matches and shake out
// the mechanics BEFORE wiring real LLM agents through the skill pack.
// Each agent is { name, kind, hat, color, radar, maxLadders, decide(obs)->action }
// with private state in a closure. All policies are deterministic functions of
// the observation (no Math.random), so a match stays reproducible.
//
// The bot is VISION-LIMITED: it only sees a radar window (not the whole map),
// so every decision is local. Each tick, in priority order:
//   0. UNSTICK — if it has sat in one tile too long, dig into fresh dirt to break out.
//   1. BANK    — cargo full / low on ladders / low fuel → climb home, sell, refuel.
//   2. CHASE   — a crystal is visible and we're making progress → mine toward it.
//   3. EXPLORE — serpentine-sweep our slice (across, then down a row, flip) so we
//                use tunnels left/right and cover ground instead of only digging down.
// All movement avoids undrillable STONE, lethal LAVA, fatal (>SAFE) falls, and
// digging into a tile with a STONE directly above (it would fall on us).

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
const SURFACE_ROW = 3; // matches engine SURFACE_ROW (depth 0)
const SAFE = 3;        // a fall of more than this hurts/kills (engine safeFall)

function viewIndex(obs) {
  const map = new Map();
  for (const t of obs.view.tiles) map.set(`${t.x},${t.y}`, t);
  return map;
}
const tileAt = (idx, x, y) => idx.get(`${x},${y}`) || null;
const isStone = (t) => t && t.block === BLOCK.STONE;
const isLava = (t) => t && t.block === BLOCK.LAVA;
const isBlocked = (t) => isStone(t) || isLava(t);          // never move into these
const neighbor = (idx, pos, dir) => {
  const [dx, dy] = DIR_D[dir];
  return tileAt(idx, pos.x + dx, pos.y + dy);
};
const stoneAbove = (idx, x, y) => isStone(tileAt(idx, x, y - 1)); // would fall on us

// How far a miner that ends up at (x,ty) would fall: count open tiles below it
// until solid ground / a ladder. Infinity if no ground is in view (cautious).
function fallFrom(idx, x, ty) {
  let d = 0;
  for (let k = 1; k <= SAFE + 2; k++) {
    const t = tileAt(idx, x, ty + k);
    if (!t) return Infinity;
    if (t.solid || t.block === BLOCK.LADDER) return d;
    d++;
  }
  return d;
}

// May we move `dir`? Never into stone/lava, never into a >SAFE drop, never into
// a tile with a stone directly above (it would fall). Up is always allowed
// (climbing auto-places a ladder).
function dirOk(idx, s, dir) {
  const t = neighbor(idx, s.pos, dir);
  if (isBlocked(t)) return false;
  if (dir === 'up') return true;
  const [dx, dy] = DIR_D[dir];
  const tx = s.pos.x + dx, ty = s.pos.y + dy;
  if (stoneAbove(idx, tx, ty)) return false;
  return fallFrom(idx, tx, ty) <= SAFE;
}

// An upward dir that routes around stone/lava overhead.
function ascend(idx, s) {
  const { x, y } = s.pos;
  if (!isBlocked(tileAt(idx, x, y - 1))) return 'up';
  if (!isBlocked(tileAt(idx, x - 1, y))) return 'left';
  if (!isBlocked(tileAt(idx, x + 1, y))) return 'right';
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
  let best = null, bestD = Infinity;
  for (const t of obs.view.tiles) {
    if (t.block !== BLOCK.LADDER || t.y > s.pos.y) continue;
    const d = Math.abs(t.x - s.pos.x);
    if (d > 0 && d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Nearest valued tile (= a crystal) in view; skip lava-ringed ones so a bot
// never dives into a deep lava pocket and dies.
function nearestCrystal(obs, s, idx) {
  let best = null, bestD = Infinity;
  for (const t of obs.view.tiles) {
    if (!(t.value > 0)) continue;
    if (hasLavaNeighbor(idx, t)) continue;
    const d = Math.abs(t.x - s.pos.x) + Math.abs(t.y - s.pos.y);
    if (d > 0 && d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// One safe step toward (tx,ty): the distance-reducing dir that passes dirOk.
function stepToward(idx, s, tx, ty, biasRight) {
  const dxg = tx - s.pos.x, dyg = ty - s.pos.y;
  const cands = [];
  if (Math.abs(dxg) >= Math.abs(dyg)) {
    if (dxg !== 0) cands.push(dxg > 0 ? 'right' : 'left');
    if (dyg !== 0) cands.push(dyg > 0 ? 'down' : 'up');
  } else {
    if (dyg !== 0) cands.push(dyg > 0 ? 'down' : 'up');
    if (dxg !== 0) cands.push(dxg > 0 ? 'right' : 'left');
  }
  cands.push('down', biasRight ? 'right' : 'left', biasRight ? 'left' : 'right', 'up');
  for (const dir of cands) if (dirOk(idx, s, dir)) return dir;
  return null;
}

// First safe direction from a list (safe = not stone/lava, no fatal fall, no
// stone overhead). null if none are safe.
function safeDir(idx, s, dirs) {
  for (const d of dirs) if (dirOk(idx, s, d)) return d;
  return null;
}

// Is the tile that way fresh diggable ground (dirt or a crystal)? Used so the
// dummy prefers to actually BREAK ground rather than drift through open tunnels.
function digAhead(idx, s, d) {
  const [dx, dy] = DIR_D[d];
  const t = tileAt(idx, s.pos.x + dx, s.pos.y + dy);
  return t && t.solid && t.block !== BLOCK.STONE;
}

// ---- the policy -------------------------------------------------------------
// Roaming miner. Bank works at ANY surface tile, so the bot never walks "home":
// it sinks a shallow shaft (within ladder reach), grabs crystals it sees, climbs
// straight up to bank where it stands, then strolls sideways to FRESH GROUND and
// sinks again — rolling across the map. An exhaustion timer relocates it once
// its local patch is dug out, so it never spins in its own ladder mesh.
const FIRST_DIRT = SURFACE_ROW + 1; // row 4: the first diggable row

// Deliberately SIMPLE test "dummy". It sees a small window around itself, counts
// its ladders + fuel, and makes basic moves: dig down, step left/right, grab a
// crystal it can see, climb out when low, refuel/upgrade at the surface, and
// now and then drop a ladder/pillar or a stick of dynamite. It is NOT an
// optimiser — its job is to keep moving and to exercise every action so we can
// watch the levers fire (and, later, the contract receive each message type).
function minerPolicy({ dynamite } = {}) {
  let phase = 0, heading = null, retreat = 0;
  return (obs) => {
    const s = obs.self;
    if (!s.alive || s.busy) return WAIT;
    const idx = viewIndex(obs);
    const W = obs.world.width;
    if (heading === null) heading = s.pos.x < W / 2 ? 'right' : 'left';
    phase++;
    const deep = s.depth > 0;
    const other = heading === 'right' ? 'left' : 'right';

    // Just lit a dynamite fuse → step clear for a few moves.
    if (retreat > 0) { retreat--; return move(safeDir(idx, s, ['up', heading, other]) || 'up'); }

    // Count ladders + fuel — head up while we can still climb out.
    if (deep && (s.items.ladder <= s.depth + 1 || s.fuel < s.depth + 12)) {
      return move(safeDir(idx, s, ['up', heading, other]) || 'up');
    }

    // At the surface: refuel, buy a cheap item now and then (exercise BUY), and
    // when we've banked enough, buy an upgrade (exercise UPGRADE).
    if (!deep) {
      if (s.fuel < s.maxFuel && s.money >= 5) return { type: ACTION.REFUEL };
      if (phase % 11 === 0 && s.money >= 40 && (s.items.parachute || 0) < 2) return { type: ACTION.BUY, item: 'parachute' };
      if (phase % 16 === 0 && s.money >= 100) {
        const stat = ['drill', 'cargo', 'radar'][(phase >> 2) % 3];
        if (s.upgrades[stat] < 6) return { type: ACTION.UPGRADE, stat };
      }
    }

    // Grab a crystal we can see.
    const c = nearestCrystal(obs, s, idx);
    if (c) { const d = stepToward(idx, s, c.x, c.y, heading === 'right'); if (d) return move(d); }

    // Now and then show the placement / blast levers.
    if (deep && phase % 18 === 0 && s.items.ladder > s.depth + 2) return { type: ACTION.LADDER };
    if (deep && phase % 29 === 0 && (s.items.pillar || 0) > 0) return { type: ACTION.PILLAR };
    if (deep && dynamite && phase % 24 === 0 && (s.items.dynamite || 0) > 0) {
      retreat = 8; return { type: ACTION.DYNAMITE, size: 1, dir: 'down' };
    }

    // Simple movement: mostly tunnel sideways (keeps the ground walkable), now
    // and then dig down. Prefer a move that actually breaks fresh ground; else
    // drift through an open tunnel. Flip at walls; if truly boxed, go up.
    const wander = phase % 4 === 0 ? ['down', heading, other] : [heading, 'down', other];
    for (const d of wander) if (dirOk(idx, s, d) && digAhead(idx, s, d)) return move(d);
    const open = safeDir(idx, s, wander);
    if (open) return move(open);
    heading = other;
    return move(safeDir(idx, s, [heading, 'up', 'down']) || 'up');
  };
}

function idlerPolicy() { return () => WAIT; }

// Role config. Every digger has a 10-ladder budget (limited consumable, refilled
// on surfacing); roles differ only in how full a bag they fill before banking.
const ROLES = {
  shuttle:    { maxLadders: 10 },
  prospector: { maxLadders: 10 },
  deepdiver:  { maxLadders: 12, items: { dynamite: 12 } },
};

const POLICIES = {
  shuttle: () => minerPolicy(),
  prospector: () => minerPolicy(),
  deepdiver: () => minerPolicy({ dynamite: true }),
  idler: idlerPolicy,
};

export const AGENT_KINDS = Object.keys(POLICIES);

/**
 * Create one scripted agent.
 * @param {string} kind   one of AGENT_KINDS
 * @param {object} [opts] { name, hat, color, radar }
 */
export function createAgent(kind, opts = {}) {
  const make = POLICIES[kind] || idlerPolicy;
  const look = LOOK[kind] || LOOK.idler;
  return {
    name: opts.name || kind,
    kind,
    hat: opts.hat || look.hat,
    color: opts.color || look.color,
    items: ROLES[kind]?.items || null,
    // Wider scan than the L1 radar (2) so test bots actually SEE crystals to
    // chase; real agents would query world state instead.
    radar: opts.radar ?? 4,
    // Ladder budget (spec's limited consumable).
    maxLadders: ROLES[kind]?.maxLadders ?? 10,
    decide: make(), // the policy is self-sufficient (handles alive/busy/unstick)
  };
}

/** Build a mixed roster, e.g. createSquad({ shuttle: 4, prospector: 3 }). */
export function createSquad(counts) {
  const roster = [];
  for (const [kind, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) roster.push(createAgent(kind, { name: `${kind}-${k}` }));
  }
  return roster;
}
