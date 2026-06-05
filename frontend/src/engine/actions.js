// Action vocabulary for agents. One action per miner per tick; the engine
// resolves multi-tick work (digging) itself.

export const ACTION = {
  WAIT: 'WAIT',
  MOVE: 'MOVE', // {dir} — contextual: step / dig / climb / open-chest
  DIG: 'DIG', // {dir} — explicit "dig that way": breaks the adjacent solid /
  //            opens a chest; no-op on empty air (a pure mining lever)
  LADDER: 'LADDER',
  PILLAR: 'PILLAR',
  DYNAMITE: 'DYNAMITE', // {size:1|2, dir}
  TELEPORT: 'TELEPORT',
  UPGRADE: 'UPGRADE', // {stat} — at the shop door
  BUY: 'BUY', // {item} — at the shop door
  REFUEL: 'REFUEL', // at the shop door
  TURN_IN: 'TURN_IN', // at the shop door, holding the diamond → team win
};

export const DIRS = ['left', 'right', 'up', 'down'];

// dir → [dx, dy]
export const DIR_VEC = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

export const UPGRADE_STATS = ['drill', 'fuel', 'cargo', 'pack', 'radar'];
export const BUYABLE_ITEMS = ['pillar', 'dynamite', 'bigDynamite', 'parachute', 'teleporter'];

const WAIT = { type: ACTION.WAIT };

// Coerce whatever an agent sent into a well-formed action object. Anything
// invalid degrades to WAIT so a misbehaving agent can never crash the tick.
export function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object') return WAIT;
  const type = raw.type;
  switch (type) {
    case ACTION.MOVE:
    case ACTION.DIG: {
      const dir = DIRS.includes(raw.dir) ? raw.dir : null;
      return dir ? { type, dir } : WAIT;
    }
    case ACTION.DYNAMITE: {
      const size = raw.size === 2 ? 2 : 1;
      const dir = DIRS.includes(raw.dir) ? raw.dir : null;
      return { type, size, dir };
    }
    case ACTION.UPGRADE: {
      return UPGRADE_STATS.includes(raw.stat) ? { type, stat: raw.stat } : WAIT;
    }
    case ACTION.BUY: {
      return BUYABLE_ITEMS.includes(raw.item) ? { type, item: raw.item } : WAIT;
    }
    case ACTION.LADDER:
    case ACTION.PILLAR:
    case ACTION.TELEPORT:
    case ACTION.REFUEL:
    case ACTION.TURN_IN:
    case ACTION.WAIT:
      return { type };
    default:
      return WAIT;
  }
}
