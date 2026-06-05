import { ROBOT_BASE, UPGRADES } from './config.js';

export function createRobot(tileX, tileY) {
  // Pack L1 baseline — read straight from the upgrade table so changing
  // tier-1 numbers in config.js doesn't desync the spawn loadout.
  const packL1 = UPGRADES.pack[0].val; // [ladders, pillars, hp]
  return {
    // Grid position
    tx: tileX,
    ty: tileY,
    // Pixel-smooth draw position (tweened toward target tile)
    px: tileX,
    py: tileY,
    // Facing: 'left' | 'right' | 'down'
    facing: 'right',

    // Stats (current value after upgrades)
    maxFuel: ROBOT_BASE.maxFuel,
    fuel: ROBOT_BASE.maxFuel,
    maxHp: packL1[2],
    hp: packL1[2],
    maxCargo: ROBOT_BASE.maxCargo,
    drillSpeed: ROBOT_BASE.drillSpeed,
    radar: ROBOT_BASE.radar,
    // Pack-driven carry caps (replace the static MAX_LADDERS/MAX_PILLARS
    // constants — they're now per-robot so upgrades can grow them).
    maxLadders: packL1[0],
    maxPillars: packL1[1],

    // Upgrade levels
    upgrades: { fuel: 1, cargo: 1, drill: 1, pack: 1, radar: 1 },

    // Money and inventory of ores in cargo: { coal: 3, iron: 1, ... }
    money: 0,
    cargo: {},
    cargoCount: 0,

    // Consumables — start the player with their pack's full carry.
    items: { ladder: packL1[0], pillar: packL1[1], dynamite: 0, bigDynamite: 0, parachute: 0, teleporter: 0 },

    // Action state: null | { type: 'dig'|'move', tx, ty, startedAt, duration }
    action: null,

    // Has found the diamond?
    hasDiamond: false,
  };
}

export function applyUpgrade(robot, key) {
  const current = robot.upgrades[key];
  const next = UPGRADES[key][current]; // next level def
  if (!next) return { ok: false, reason: 'max level' };
  if (robot.money < next.price) return { ok: false, reason: 'not enough money' };
  robot.money -= next.price;
  robot.upgrades[key] = next.lvl;
  if (key === 'fuel')  { robot.maxFuel = next.val;  robot.fuel = Math.min(robot.fuel, next.val); }
  if (key === 'cargo') { robot.maxCargo = next.val; }
  if (key === 'drill') { robot.drillSpeed = next.val; }
  if (key === 'pack')  {
    // Pack levels carry [ladders, pillars, hp] in next.val.
    const [maxL, maxP, maxH] = next.val;
    robot.maxLadders = maxL;
    robot.maxPillars = maxP;
    robot.maxHp = maxH;
    // Top up to the new caps so the upgrade feels instant.
    robot.items.ladder = maxL;
    robot.items.pillar = maxP;
    robot.hp = maxH;
  }
  if (key === 'radar') { robot.radar = next.val; }
  return { ok: true };
}

export function cargoTotal(robot) {
  return robot.cargoCount;
}

export function addToCargo(robot, oreName) {
  if (robot.cargoCount >= robot.maxCargo) return false;
  robot.cargo[oreName] = (robot.cargo[oreName] || 0) + 1;
  robot.cargoCount++;
  return true;
}
