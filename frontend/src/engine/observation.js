// Per-agent observation builder. Produces compact JSON tuned for an LLM:
// self status, a fog-limited local view (tile list + ASCII minimap),
// cooperative team info, and the list of currently-legal actions.

import { BLOCK, BLOCK_DATA, SURFACE_Y, ITEMS, UPGRADES } from '../config.js';
import { getBlock } from '../world.js';
import { ACTION, DIRS, UPGRADE_STATS, BUYABLE_ITEMS } from './actions.js';
import { SURFACE_ROW } from './constants.js';
import { computeTeamScore } from './sim.js';

// Single-character glyphs for the ASCII minimap.
const GLYPH = {
  [BLOCK.SKY]: '.',
  [BLOCK.DIRT]: '#',
  [BLOCK.STONE]: 'X',
  [BLOCK.LADDER]: 'H',
  [BLOCK.PILLAR]: 'I',
  [BLOCK.CHEST]: 'C',
  [BLOCK.LAVA]: '!',
  [BLOCK.WATER]: '~',
  [BLOCK.DIAMOND]: '*',
  [BLOCK.SHRINE]: 'S',
};

function glyphFor(type) {
  if (GLYPH[type] !== undefined) return GLYPH[type];
  // Any other ore / artifact: lowercase first letter of its name.
  const name = BLOCK_DATA[type]?.name;
  return name ? name[0] : '?';
}

function tileInfo(world, x, y) {
  const block = getBlock(world, x, y);
  const data = BLOCK_DATA[block] || {};
  return {
    x,
    y,
    block,
    name: data.name || 'unknown',
    solid: data.solid === true,
    hazard: (data.damage || 0) > 0 ? data.name : null,
    value: data.price || 0,
  };
}

function atShop(match, m) {
  return m.ty === SURFACE_ROW && Math.abs(m.tx - match.shopX) <= 1;
}

function legalActions(match, m) {
  const out = [ACTION.WAIT];
  if (m.busy) return out; // mid-dig: nothing else accepted this tick
  for (const dir of DIRS) out.push(`${ACTION.MOVE}:${dir}`);
  for (const dir of DIRS) out.push(`${ACTION.DIG}:${dir}`);
  if (m.items.ladder > 0) out.push(ACTION.LADDER);
  if (m.items.pillar > 0) out.push(ACTION.PILLAR);
  if (m.items.dynamite > 0) out.push(`${ACTION.DYNAMITE}:1`);
  if (m.items.bigDynamite > 0) out.push(`${ACTION.DYNAMITE}:2`);
  if (m.items.teleporter > 0) out.push(ACTION.TELEPORT);
  if (atShop(match, m)) {
    if (m.money >= ITEMS.dynamite.price || true) {
      for (const stat of UPGRADE_STATS) {
        if (m.upgrades[stat] < UPGRADES[stat].length) out.push(`${ACTION.UPGRADE}:${stat}`);
      }
      for (const item of BUYABLE_ITEMS) {
        if (m.money >= ITEMS[item].price) out.push(`${ACTION.BUY}:${item}`);
      }
    }
    if (m.fuel < m.maxFuel) out.push(ACTION.REFUEL);
    if (m.hasDiamond) out.push(ACTION.TURN_IN);
  }
  // Honour any lever restriction so an agent only sees the controls it may pull.
  const allowed = m.allowed || match.config.allowedActions;
  if (allowed) return out.filter((a) => a === ACTION.WAIT || allowed.includes(a.split(':')[0]));
  return out;
}

/**
 * Build the observation for one miner.
 * @param {object} match
 * @param {number} minerId
 * @param {object} [optsOverride] — { radius } to override the radar radius
 */
export function observe(match, minerId, optsOverride = {}) {
  const m = match.miners.find((x) => x.id === minerId);
  if (!m) return null;
  const world = match.world;
  const radius = optsOverride.radius ?? Math.round(m.radar);

  // Local fog-limited tile window (Chebyshev radius).
  const tiles = [];
  const rows = [];
  for (let dy = -radius; dy <= radius; dy++) {
    let row = '';
    for (let dx = -radius; dx <= radius; dx++) {
      const x = m.tx + dx;
      const y = m.ty + dy;
      if (x < 0 || x >= world.W || y < 0 || y >= world.H) {
        row += ' ';
        continue;
      }
      if (dx === 0 && dy === 0) {
        row += '@'; // self
      } else if (match.miners.some((o) => o !== m && o.alive && o.tx === x && o.ty === y)) {
        row += '&'; // teammate
      } else {
        row += glyphFor(getBlock(world, x, y));
      }
      tiles.push(tileInfo(world, x, y));
    }
    rows.push(row);
  }

  return {
    tick: match.tick,
    mode: match.mode,
    finished: match.finished,
    finishedReason: match.finishedReason,
    self: {
      id: m.id,
      name: m.name,
      pos: { x: m.tx, y: m.ty },
      depth: m.ty - SURFACE_ROW,
      facing: m.facing,
      alive: m.alive,
      respawnAt: m.respawnAt,
      fuel: Math.round(m.fuel),
      maxFuel: m.maxFuel,
      hp: Math.round(m.hp),
      maxHp: m.maxHp,
      cargo: { ...m.cargo },
      cargoCount: m.cargoCount,
      maxCargo: m.maxCargo,
      money: m.money,
      items: { ...m.items },
      upgrades: { ...m.upgrades },
      hasDiamond: m.hasDiamond,
      busy: m.busy ? { ...m.busy } : null,
      stats: { ...m.stats },
    },
    view: {
      radius,
      tiles,
      // Live bombs in range — agents need to see fuses to clear the blast.
      bombs: match.bombs
        .filter((b) => Math.abs(b.x - m.tx) <= radius && Math.abs(b.y - m.ty) <= radius)
        .map((b) => ({ x: b.x, y: b.y, ticksLeft: b.fuseTicksLeft, radius: b.radius })),
      ascii: rows.join('\n'),
    },
    team: {
      score: computeTeamScore(match),
      totalSold: match.teamBankSold,
      diamondFound: match.diamondFound,
      miners: match.miners.map((o) => ({
        id: o.id,
        name: o.name,
        pos: { x: o.tx, y: o.ty },
        depth: o.ty - SURFACE_ROW,
        alive: o.alive,
        hasDiamond: o.hasDiamond,
      })),
    },
    surface: { row: SURFACE_ROW, shopX: match.shopX, firstDugRow: SURFACE_Y },
    world: { width: world.W, height: world.H },
    legalActions: legalActions(match, m),
  };
}
