// The deterministic tick step. Pure rules — no Phaser, no DOM, no audio, no
// Math.random / Date. All randomness comes from match.rng; all timing from
// match.tick. Faithful to the single-player rules in GameScene.js, re-derived
// from the config values so the engine is the canonical source of truth.

import {
  BLOCK, BLOCK_DATA, SURFACE_Y,
  UPGRADES, ITEMS, FUEL_PRICE, MIN_DIG_DURATION,
} from '../config.js';
import { getBlock, setBlock, isSolid, isClimbable } from '../world.js';
import { addToCargo, applyUpgrade } from '../robot.js';
import { rollLoot, chestTierForDepth } from '../config/chests.js';
import { ACTION, DIR_VEC, normalizeAction } from './actions.js';
import {
  MS_PER_TICK, SHAKE_TICKS, CASCADE_SHAKE_TICKS, PILLAR_FALL_GRACE_TICKS,
  LAVA_STEP_TICKS, LAVA_BUDGET, LAVA_MAX_SOURCES, DYNAMITE_FUSE_TICKS,
  RESPAWN_FUEL_FRACTION, DIAMOND_BONUS, SURFACE_ROW,
} from './constants.js';

// ---- helpers ---------------------------------------------------------------

function ev(match, type, data = {}) {
  match.events.push({ tick: match.tick, type, ...data });
}

function minerAt(match, x, y) {
  return match.miners.find((m) => m.alive && m.tx === x && m.ty === y) || null;
}

function blockName(type) {
  return BLOCK_DATA[type]?.name;
}

// Convert the original ms dig duration into a whole number of ticks.
function digTicksFor(type, miner) {
  const data = BLOCK_DATA[type];
  const ms = Math.max(MIN_DIG_DURATION, 420 * data.hardness * miner.drillSpeed);
  return Math.max(1, Math.round(ms / MS_PER_TICK));
}

function atShop(match, m) {
  return m.ty === SURFACE_ROW && Math.abs(m.tx - match.shopX) <= 1;
}

export function computeTeamScore(match) {
  let total = 0;
  for (const m of match.miners) total += m.money;
  if (match.diamondFound) total += DIAMOND_BONUS;
  return total;
}

// ---- top-level step --------------------------------------------------------

export function step(match, actions = {}) {
  if (match.finished) return match;
  match.tick++;
  match.events = [];

  // 1. World physics (deterministic, miner-independent).
  updateFallingStones(match);
  updateFallingPillars(match);
  updateLavaFlow(match);
  updateBombs(match);

  // 2. Miners, in ascending id order for determinism.
  const order = [...match.miners].sort((a, b) => a.id - b.id);
  for (const m of order) {
    if (!m.alive) {
      handleRespawn(match, m);
      continue;
    }
    if (m.busy) {
      progressDig(match, m);
      continue;
    }
    const act = normalizeAction(actions[m.id]);
    applyMinerAction(match, m, act);
  }

  // 3. Finish checks.
  if (!match.finished) {
    const target = match.config.victory.scoreTarget;
    if (target != null && computeTeamScore(match) >= target) finish(match, 'score_target');
  }
  if (!match.finished && match.tick >= match.maxTicks) {
    finish(match, 'time');
  }
  match.teamScore = computeTeamScore(match);
  return match;
}

function finish(match, reason) {
  match.finished = true;
  match.finishedReason = reason;
  match.teamScore = computeTeamScore(match);
  ev(match, 'finished', { reason, score: match.teamScore });
}

// ---- per-miner action resolution ------------------------------------------

function applyMinerAction(match, m, act) {
  // Gravity always runs first; a fall consumes the whole turn (mirrors
  // GameScene.tryMove).
  const beforeY = m.ty;
  applyGravity(match, m);
  if (m.ty !== beforeY) return;
  if (!m.alive) return; // died on landing

  // Optional lever restriction: a miner (or the whole match) can be limited to a
  // subset of the controls. WAIT is always allowed. Out-of-set actions idle.
  const allowed = m.allowed || match.config.allowedActions;
  if (allowed && act.type !== ACTION.WAIT && !allowed.includes(act.type)) {
    ev(match, 'action_not_allowed', { id: m.id, action: act.type });
    return;
  }

  switch (act.type) {
    case ACTION.MOVE: return doMove(match, m, act.dir);
    case ACTION.DIG: return doDig(match, m, act.dir);
    case ACTION.LADDER: return placeLadder(match, m);
    case ACTION.PILLAR: return placePillar(match, m);
    case ACTION.TELEPORT: return useTeleporter(match, m);
    case ACTION.DYNAMITE: return useDynamite(match, m, act.size, act.dir);
    case ACTION.UPGRADE: return shopUpgrade(match, m, act.stat);
    case ACTION.BUY: return shopBuy(match, m, act.item);
    case ACTION.REFUEL: return shopRefuel(match, m);
    case ACTION.TURN_IN: return turnInDiamond(match, m);
    case ACTION.WAIT:
    default:
      return;
  }
}

function doMove(match, m, dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx < 0) m.facing = 'left';
  else if (dx > 0) m.facing = 'right';
  else if (dy > 0) m.facing = 'down';
  else m.facing = 'up';

  const tx = m.tx + dx;
  const ty = m.ty + dy;
  const tile = getBlock(match.world, tx, ty);

  // Chest: walk into it to open + clear. Never starts a dig.
  if (tile === BLOCK.CHEST) {
    applyChestLoot(match, m, tx, ty);
    setBlock(match.world, tx, ty, BLOCK.SKY);
    scanUnsupportedAt(match, tx, ty - 1);
    scanUnsupportedPillarAt(match, tx, ty - 1);
    awakenLavaAround(match, tx, ty);
    if (!occupied(match, m, tx, ty)) moveTo(match, m, tx, ty);
    return;
  }

  if (dy < 0) {
    // Upward.
    if (ty < SURFACE_ROW) return; // can't fly above the surface
    if (isSolid(tile)) {
      startDig(match, m, tx, ty);
      return;
    }
    const here = getBlock(match.world, m.tx, m.ty);
    const needsLadder = here !== BLOCK.LADDER && m.ty > SURFACE_ROW;
    if (needsLadder) {
      if (m.items.ladder <= 0) {
        ev(match, 'no_ladder', { id: m.id });
        return;
      }
      setBlock(match.world, m.tx, m.ty, BLOCK.LADDER);
      m.items.ladder--;
    }
    if (occupied(match, m, tx, ty)) return;
    moveTo(match, m, tx, ty);
    return;
  }

  if (isSolid(tile)) {
    startDig(match, m, tx, ty);
  } else {
    if (occupied(match, m, tx, ty)) {
      ev(match, 'blocked', { id: m.id });
      return;
    }
    moveTo(match, m, tx, ty);
  }
}

// Explicit "dig that way" lever: break the adjacent solid (or open a chest);
// no-op on empty air. Like MOVE's dig branches but never walks into a gap.
function doDig(match, m, dir) {
  const [dx, dy] = DIR_VEC[dir];
  const tx = m.tx + dx;
  const ty = m.ty + dy;
  faceTarget(m, tx, ty);
  const tile = getBlock(match.world, tx, ty);
  if (tile === BLOCK.CHEST) {
    applyChestLoot(match, m, tx, ty);
    setBlock(match.world, tx, ty, BLOCK.SKY);
    scanUnsupportedAt(match, tx, ty - 1);
    scanUnsupportedPillarAt(match, tx, ty - 1);
    awakenLavaAround(match, tx, ty);
    if (dy >= 0 && !occupied(match, m, tx, ty)) moveTo(match, m, tx, ty);
    return;
  }
  if (isSolid(tile)) {
    if (dy < 0 && ty < SURFACE_ROW) return;
    startDig(match, m, tx, ty);
  } else {
    ev(match, 'nothing_to_dig', { id: m.id });
  }
}

// Cooperative: two miners can't share a tile.
function occupied(match, self, x, y) {
  return match.miners.some((o) => o !== self && o.alive && o.tx === x && o.ty === y);
}

function applyGravity(match, m) {
  if (m.ty === SURFACE_ROW) return;
  const below = getBlock(match.world, m.tx, m.ty + 1);
  const here = getBlock(match.world, m.tx, m.ty);
  const canFall = !isSolid(below) && !isClimbable(here) && !isClimbable(below) && m.ty < match.world.H - 1;
  if (canFall) {
    if (m.fallStartY == null) m.fallStartY = m.ty;
    moveTo(match, m, m.tx, m.ty + 1);
    return;
  }
  if (m.fallStartY != null) {
    const distance = m.ty - m.fallStartY;
    m.fallStartY = null;
    resolveFallLanding(match, m, distance);
  }
}

function resolveFallLanding(match, m, distance) {
  if (distance <= match.config.safeFall) return;
  if (m.items.parachute > 0) {
    m.items.parachute--;
    ev(match, 'parachute', { id: m.id });
    return;
  }
  killMiner(match, m, `fell ${distance} tiles`);
}

function moveTo(match, m, tx, ty) {
  m.tx = tx;
  m.ty = ty;
  if (ty === SURFACE_ROW) {
    if (m.items.ladder < m.maxLadders) m.items.ladder = m.maxLadders;
    if (m.items.pillar < m.maxPillars) m.items.pillar = m.maxPillars;
    const sold = autoSellCargo(match, m);
    if (sold > 0) ev(match, 'sold', { id: m.id, amount: sold });
  }
  applyHazard(match, m);
  if (m.alive && m.fuel <= 0) killMiner(match, m, 'out of fuel');
}

function autoSellCargo(match, m) {
  let total = 0;
  for (const [name, count] of Object.entries(m.cargo)) {
    const type = Object.values(BLOCK).find((t) => BLOCK_DATA[t]?.name === name);
    total += count * (BLOCK_DATA[type]?.price || 0);
  }
  if (total > 0) {
    m.money += total;
    m.stats.sold += total;
    match.teamBankSold += total;
    m.cargo = {};
    m.cargoCount = 0;
  }
  return total;
}

function applyHazard(match, m) {
  const type = getBlock(match.world, m.tx, m.ty);
  if (type === BLOCK.LAVA) {
    m.hp = Math.max(0, m.hp - (BLOCK_DATA[BLOCK.LAVA].damage ?? 30));
  } else if (type === BLOCK.WATER) {
    m.hp = Math.max(0, m.hp - (BLOCK_DATA[BLOCK.WATER].damage ?? 2));
  }
  if (m.hp <= 0) killMiner(match, m, 'crushed by the depths');
}

// ---- digging ---------------------------------------------------------------

function startDig(match, m, tx, ty) {
  const type = getBlock(match.world, tx, ty);
  const data = BLOCK_DATA[type];
  if (!data) return;
  faceTarget(m, tx, ty);
  if (data.hardness >= 999) {
    ev(match, 'dig_failed', { id: m.id, x: tx, y: ty });
    return;
  }
  const totalTicks = digTicksFor(type, m);
  m.busy = { type: 'dig', tx, ty, blockType: type, ticksLeft: totalTicks, totalTicks };
}

function faceTarget(m, tx, ty) {
  if (tx < m.tx) m.facing = 'left';
  else if (tx > m.tx) m.facing = 'right';
  else if (ty > m.ty) m.facing = 'down';
  else if (ty < m.ty) m.facing = 'up';
}

function progressDig(match, m) {
  m.busy.ticksLeft--;
  if (m.busy.ticksLeft <= 0) completeDig(match, m);
}

function completeDig(match, m) {
  const { tx, ty, blockType: type } = m.busy;
  const data = BLOCK_DATA[type];
  // The block may have been destroyed mid-dig (falling stone / lava). Bail.
  if (getBlock(match.world, tx, ty) !== type) {
    m.busy = null;
    return;
  }
  m.fuel = Math.max(0, m.fuel - data.hardness);

  // Diamond is the unique win pickup (price 0, never auto-sold, no cargo slot).
  if (type === BLOCK.DIAMOND) {
    m.hasDiamond = true;
    ev(match, 'diamond_found', { id: m.id });
  } else if (data.price > 0) {
    const added = addToCargo(m, data.name);
    if (!added) {
      // Cargo full: abort, leave the block intact.
      ev(match, 'cargo_full', { id: m.id });
      m.busy = null;
      return;
    }
    m.stats.oresCollected++;
    ev(match, 'ore', { id: m.id, ore: data.name });
  }

  if (type === BLOCK.SHRINE) activateShrine(match, m);

  const fromY = m.ty;
  setBlock(match.world, tx, ty, BLOCK.SKY);
  m.stats.tilesDug++;
  const diggingUp = ty < fromY;
  if (!diggingUp && !occupied(match, m, tx, ty)) {
    m.tx = tx;
    m.ty = ty;
  }
  m.busy = null;

  scanUnsupportedAt(match, tx, ty - 1);
  scanUnsupportedPillarAt(match, tx, ty - 1);
  awakenLavaAround(match, tx, ty);

  if (m.alive && m.fuel <= 0) killMiner(match, m, 'out of fuel');
}

// ---- consumables -----------------------------------------------------------

function placeLadder(match, m) {
  if (m.items.ladder <= 0) {
    ev(match, 'no_ladder', { id: m.id });
    return;
  }
  if (getBlock(match.world, m.tx, m.ty) === BLOCK.LADDER) return;
  setBlock(match.world, m.tx, m.ty, BLOCK.LADDER);
  m.items.ladder--;
}

function placePillar(match, m) {
  if (m.items.pillar <= 0) {
    ev(match, 'no_pillar', { id: m.id });
    return;
  }
  setBlock(match.world, m.tx, m.ty, BLOCK.PILLAR);
  m.items.pillar--;
  scanUnsupportedPillarAt(match, m.tx, m.ty);
}

function useTeleporter(match, m) {
  if ((m.items.teleporter || 0) <= 0) {
    ev(match, 'no_teleporter', { id: m.id });
    return;
  }
  m.items.teleporter--;
  m.fallStartY = null;
  moveTo(match, m, match.shopX, SURFACE_ROW);
  ev(match, 'teleport', { id: m.id });
}

// ---- dynamite / bombs ------------------------------------------------------

function useDynamite(match, m, size) {
  const key = size === 2 ? 'bigDynamite' : 'dynamite';
  if ((m.items[key] || 0) <= 0) {
    ev(match, 'no_dynamite', { id: m.id });
    return;
  }
  m.items[key]--;
  // Planted at the robot's OWN tile (exactly like the real game) — the miner
  // must run out of the blast radius before the fuse ends, or take the hit.
  match.bombs.push({
    x: m.tx,
    y: m.ty,
    radius: size === 2 ? 2 : 1,
    fuseTicksLeft: DYNAMITE_FUSE_TICKS,
    planter: m.id,
  });
  ev(match, 'dynamite_planted', { id: m.id, size });
}

function updateBombs(match) {
  for (let i = match.bombs.length - 1; i >= 0; i--) {
    const b = match.bombs[i];
    if (--b.fuseTicksLeft <= 0) {
      detonate(match, b);
      match.bombs.splice(i, 1);
    }
  }
}

function detonate(match, b) {
  const planter = match.miners.find((x) => x.id === b.planter) || null;
  const r = b.radius;
  const damage = r >= 2 ? 200 : 120;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = b.x + dx;
      const y = b.y + dy;
      if (x <= 0 || x >= match.world.W - 1 || y <= SURFACE_ROW || y >= match.world.H - 1) continue;
      const t = getBlock(match.world, x, y);
      if (t === BLOCK.SKY || t === BLOCK.DIAMOND) continue;
      // Scoop ore into the planter's cargo if there's room.
      if (BLOCK_DATA[t]?.price > 0 && planter && planter.alive) {
        addToCargo(planter, BLOCK_DATA[t].name);
      }
      // Chests / shrines caught in the blast still resolve (like the real game).
      if (t === BLOCK.CHEST && planter && planter.alive) applyChestLoot(match, planter, x, y);
      if (t === BLOCK.SHRINE && planter && planter.alive) activateShrine(match, planter);
      setBlock(match.world, x, y, BLOCK.SKY);
    }
  }
  // Damage any miner in the blast box.
  for (const m of match.miners) {
    if (!m.alive) continue;
    if (Math.abs(m.tx - b.x) <= r && Math.abs(m.ty - b.y) <= r) {
      m.hp = Math.max(0, m.hp - damage);
      if (m.hp <= 0) killMiner(match, m, 'caught in a blast');
    }
  }
  // Cascade + lava around the cleared region.
  for (let dx = -r; dx <= r; dx++) {
    scanUnsupportedAt(match, b.x + dx, b.y - r - 1, CASCADE_SHAKE_TICKS);
  }
  awakenLavaAround(match, b.x, b.y);
  ev(match, 'detonation', { x: b.x, y: b.y, radius: r });
}

// ---- chest loot ------------------------------------------------------------

function applyChestLoot(match, m, x, y) {
  const chest = match.world.chestsAt?.get(y * match.world.W + x);
  if (!chest || chest.opened) return;
  chest.opened = true;
  const rnd = () => match.rng.next();
  const outcome = rollLoot(chest.tier, rnd);
  resolveLootOutcome(match, m, outcome, x, y);
}

function resolveLootOutcome(match, m, outcome, x, y) {
  switch (outcome.kind) {
    case 'money':
      m.money += outcome.amount;
      ev(match, 'loot_money', { id: m.id, amount: outcome.amount });
      return;
    case 'items': {
      for (const [name, n] of Object.entries(outcome.give)) {
        if (n <= 0) continue;
        if (name === 'ladder') m.items.ladder = Math.min(m.maxLadders, m.items.ladder + n);
        else if (name === 'pillar') m.items.pillar = Math.min(m.maxPillars, m.items.pillar + n);
        else m.items[name] = (m.items[name] || 0) + n;
      }
      ev(match, 'loot_items', { id: m.id, give: outcome.give });
      return;
    }
    case 'fuel': {
      const refill = Math.round(m.maxFuel * ((outcome.pct ?? 30) / 100));
      m.fuel = Math.min(m.maxFuel, m.fuel + refill);
      ev(match, 'loot_fuel', { id: m.id, pct: outcome.pct });
      return;
    }
    case 'trap': {
      // Like the real game: plant a real timed bomb at the chest tile with a
      // visible fuse — the miner can still run out of the blast radius.
      const isBig = outcome.size === 'big';
      match.bombs.push({
        x, y,
        radius: isBig ? 2 : 1,
        fuseTicksLeft: Math.max(1, Math.round((outcome.fuseMs ?? 2500) / MS_PER_TICK)),
        planter: m.id,
      });
      ev(match, 'loot_trap', { id: m.id, size: outcome.size });
      return;
    }
    case 'blueprint':
      applyFreeUpgrade(match, m);
      return;
    case 'empty':
    default:
      ev(match, 'loot_empty', { id: m.id });
  }
}

function applyFreeUpgrade(match, m) {
  const candidates = ['drill', 'fuel', 'cargo', 'pack', 'radar']
    .filter((k) => m.upgrades[k] < UPGRADES[k].length);
  if (candidates.length === 0) {
    m.money += 1500;
    return;
  }
  const key = candidates[match.rng.int(candidates.length)];
  const next = UPGRADES[key][m.upgrades[key]];
  m.upgrades[key] = next.lvl;
  applyUpgradeStat(m, key, next);
  ev(match, 'blueprint', { id: m.id, stat: key });
}

// Apply an upgrade's stat effect WITHOUT charging money (used by blueprint loot
// and the shrine). Mirrors the money-spending branches in robot.applyUpgrade.
function applyUpgradeStat(m, key, next) {
  if (key === 'fuel') { m.maxFuel = next.val; m.fuel = next.val; }
  if (key === 'cargo') { m.maxCargo = next.val; }
  if (key === 'drill') { m.drillSpeed = next.val; }
  if (key === 'pack') {
    const [maxL, maxP, maxH] = next.val;
    m.maxLadders = maxL; m.maxPillars = maxP; m.maxHp = maxH;
    m.items.ladder = maxL; m.items.pillar = maxP; m.hp = maxH;
  }
  if (key === 'radar') { m.radar = next.val; }
}

// ---- shrine ----------------------------------------------------------------

function activateShrine(match, m) {
  // TODO(parity): GameScene's shrine has a 4-way reward roll (blueprint / drill
  // buff / +teleporter / cash). Simplified deterministic version here: sacrifice
  // one cargo ore, grant cash or a teleporter.
  const names = Object.keys(m.cargo).filter((n) => m.cargo[n] > 0);
  if (names.length > 0) {
    const pick = names[match.rng.int(names.length)];
    m.cargo[pick]--;
    if (m.cargo[pick] <= 0) delete m.cargo[pick];
    m.cargoCount = Math.max(0, m.cargoCount - 1);
  }
  if (match.rng.next() < 0.5) {
    const cash = 250 + match.rng.int(751);
    m.money += cash;
    ev(match, 'shrine', { id: m.id, reward: 'cash', amount: cash });
  } else {
    m.items.teleporter = (m.items.teleporter || 0) + 1;
    ev(match, 'shrine', { id: m.id, reward: 'teleporter' });
  }
}

// ---- shop ------------------------------------------------------------------

function shopRefuel(match, m) {
  if (!atShop(match, m)) { ev(match, 'not_at_shop', { id: m.id }); return; }
  if (m.fuel >= m.maxFuel) return;
  if (m.money < FUEL_PRICE) { ev(match, 'too_poor', { id: m.id }); return; }
  m.money -= FUEL_PRICE;
  m.stats.spent += FUEL_PRICE;
  m.fuel = m.maxFuel;
  ev(match, 'refuel', { id: m.id });
}

function shopUpgrade(match, m, stat) {
  if (!atShop(match, m)) { ev(match, 'not_at_shop', { id: m.id }); return; }
  const before = m.money;
  const res = applyUpgrade(m, stat);
  if (res.ok) {
    m.stats.spent += before - m.money;
    ev(match, 'upgrade', { id: m.id, stat });
  } else {
    ev(match, 'upgrade_failed', { id: m.id, stat, reason: res.reason });
  }
}

function shopBuy(match, m, item) {
  if (!atShop(match, m)) { ev(match, 'not_at_shop', { id: m.id }); return; }
  const def = ITEMS[item];
  if (!def) return;
  if (m.money < def.price) { ev(match, 'too_poor', { id: m.id }); return; }
  m.money -= def.price;
  m.stats.spent += def.price;
  m.items[item] = (m.items[item] || 0) + 1;
  ev(match, 'buy', { id: m.id, item });
}

function turnInDiamond(match, m) {
  if (!atShop(match, m)) { ev(match, 'not_at_shop', { id: m.id }); return; }
  if (!m.hasDiamond) { ev(match, 'no_diamond', { id: m.id }); return; }
  m.hasDiamond = false;
  match.diamondFound = true;
  ev(match, 'turn_in', { id: m.id });
  if (match.config.victory.diamondWins) finish(match, 'diamond');
}

// ---- death / respawn -------------------------------------------------------

function killMiner(match, m, reason) {
  if (!m.alive) return;
  m.alive = false;
  m.busy = null;
  m.respawnAt = match.tick + match.config.respawnTicks;
  m.stats.deaths++;
  // Penalty: drop the cargo.
  m.cargo = {};
  m.cargoCount = 0;
  // The diamond is NOT lost — it drops at the death tile as a diggable DIAMOND
  // block again, so it can be recovered (coop: a teammate carries it home).
  if (m.hasDiamond) {
    setBlock(match.world, m.tx, m.ty, BLOCK.DIAMOND);
    m.hasDiamond = false;
    ev(match, 'diamond_dropped', { id: m.id, x: m.tx, y: m.ty });
  }
  ev(match, 'death', { id: m.id, reason });
}

function handleRespawn(match, m) {
  if (m.respawnAt == null || match.tick < m.respawnAt) return;
  m.alive = true;
  m.respawnAt = null;
  // Respawn at its OWN home spot (where it first appeared), not the shop — so a
  // spread-out squad keeps its territory instead of piling up in the centre.
  m.tx = m.spawnX;
  m.ty = m.spawnY;
  m.hp = m.maxHp;
  m.fuel = Math.max(m.fuel, Math.round(m.maxFuel * RESPAWN_FUEL_FRACTION));
  m.items.ladder = m.maxLadders;
  m.items.pillar = m.maxPillars;
  m.fallStartY = null;
  ev(match, 'respawn', { id: m.id });
}

// ---- falling stones / pillars / lava --------------------------------------

function scanUnsupportedAt(match, x, y, shakeTicks = SHAKE_TICKS) {
  if (y < 0 || y >= match.world.H) return;
  if (getBlock(match.world, x, y) !== BLOCK.STONE) return;
  const below = getBlock(match.world, x, y + 1);
  if (below === BLOCK.SKY || below === BLOCK.LADDER) {
    if (!match.fallingStones.some((s) => s.x === x && s.y === y)) {
      match.fallingStones.push({ x, y, state: 'shake', shakeTicksLeft: shakeTicks });
    }
  }
}

function scanUnsupportedPillarAt(match, x, y) {
  if (y < 0 || y >= match.world.H) return;
  if (getBlock(match.world, x, y) !== BLOCK.PILLAR) return;
  const below = getBlock(match.world, x, y + 1);
  if (below === BLOCK.SKY || below === BLOCK.LADDER) {
    if (!match.fallingPillars.some((p) => p.x === x && p.y === y)) {
      match.fallingPillars.push({ x, y, fallAtTick: match.tick + PILLAR_FALL_GRACE_TICKS });
    }
  }
}

function updateFallingStones(match) {
  for (let i = match.fallingStones.length - 1; i >= 0; i--) {
    const s = match.fallingStones[i];
    if (s.state === 'shake') {
      const below = getBlock(match.world, s.x, s.y + 1);
      if (!(below === BLOCK.SKY || below === BLOCK.LADDER)) {
        match.fallingStones.splice(i, 1);
        continue;
      }
      if (--s.shakeTicksLeft <= 0) s.state = 'fall';
      continue;
    }
    // Falling: one tile per tick.
    const below = getBlock(match.world, s.x, s.y + 1);
    const willFall = below === BLOCK.SKY || below === BLOCK.LADDER;
    const victim = willFall ? minerAt(match, s.x, s.y + 1) : null;
    if (willFall && victim) {
      setBlock(match.world, s.x, s.y, BLOCK.SKY);
      setBlock(match.world, s.x, s.y + 1, BLOCK.STONE);
      match.fallingStones.splice(i, 1);
      killMiner(match, victim, 'crushed by a falling rock');
      scanUnsupportedAt(match, s.x, s.y - 1, CASCADE_SHAKE_TICKS);
      scanUnsupportedPillarAt(match, s.x, s.y - 1);
      continue;
    }
    if (willFall) {
      setBlock(match.world, s.x, s.y, BLOCK.SKY);
      s.y += 1;
      setBlock(match.world, s.x, s.y, BLOCK.STONE);
      scanUnsupportedAt(match, s.x, s.y - 2, CASCADE_SHAKE_TICKS);
      scanUnsupportedPillarAt(match, s.x, s.y - 2);
    } else {
      match.fallingStones.splice(i, 1);
      scanUnsupportedAt(match, s.x, s.y - 1, CASCADE_SHAKE_TICKS);
      scanUnsupportedPillarAt(match, s.x, s.y - 1);
    }
  }
}

function updateFallingPillars(match) {
  for (let i = match.fallingPillars.length - 1; i >= 0; i--) {
    const p = match.fallingPillars[i];
    if (match.tick < p.fallAtTick) continue;
    const below = getBlock(match.world, p.x, p.y + 1);
    if (below === BLOCK.SKY || below === BLOCK.LADDER) {
      setBlock(match.world, p.x, p.y, BLOCK.SKY);
      p.y += 1;
      setBlock(match.world, p.x, p.y, BLOCK.PILLAR);
      p.fallAtTick = match.tick + 1;
    } else {
      match.fallingPillars.splice(i, 1);
    }
  }
}

function registerLavaFlow(match, x, y) {
  if (getBlock(match.world, x, y) !== BLOCK.LAVA) return;
  if (match.activeLava.size >= LAVA_MAX_SOURCES) return;
  const key = y * match.world.W + x;
  if (match.activeLava.has(key)) return;
  match.activeLava.set(key, { x, y, budget: LAVA_BUDGET, nextStepTick: match.tick + LAVA_STEP_TICKS });
}

function awakenLavaAround(match, x, y) {
  registerLavaFlow(match, x - 1, y);
  registerLavaFlow(match, x + 1, y);
  registerLavaFlow(match, x, y - 1);
  registerLavaFlow(match, x, y + 1);
}

function updateLavaFlow(match) {
  if (match.activeLava.size === 0) return;
  for (const [key, src] of match.activeLava) {
    if (match.tick < src.nextStepTick) continue;
    src.nextStepTick = match.tick + LAVA_STEP_TICKS;
    if (src.budget <= 0 || getBlock(match.world, src.x, src.y) !== BLOCK.LAVA) {
      match.activeLava.delete(key);
      continue;
    }
    const candidates = [
      [0, 1], [-1, 0], [1, 0], // down first, then sideways
    ];
    let flowed = false;
    for (const [dx, dy] of candidates) {
      const nx = src.x + dx;
      const ny = src.y + dy;
      if (nx <= 0 || nx >= match.world.W - 1 || ny >= match.world.H - 1) continue;
      const t = getBlock(match.world, nx, ny);
      if (t !== BLOCK.SKY && t !== BLOCK.LADDER) continue;
      setBlock(match.world, nx, ny, BLOCK.LAVA);
      src.budget--;
      flowed = true;
      const victim = minerAt(match, nx, ny);
      if (victim) killMiner(match, victim, 'engulfed by lava');
      break;
    }
    if (!flowed) match.activeLava.delete(key);
  }
}
