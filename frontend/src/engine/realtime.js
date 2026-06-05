// Real-time world — the continuous replacement for the lockstep tick engine.
//
// "Brain outside, body inside": each character runs a real-time action FSM
// (idle → move/dig/fall/cooldown), advancing by real milliseconds with smooth
// interpolated draw positions. An agent's decide(observation) is polled only
// when its character is IDLE (finished the previous action) — so movement and
// digging take real durations and animate smoothly, and falls are a fast drop
// (visibly distinct from walking). No global tick.
//
// The agent contract (decide(obs) -> action) and the observation are UNCHANGED
// from the tick engine — same bots, same SKILLS.md. Only the timing model
// differs. This is meant to become the single shared engine (single-player +
// agents both drive it); the tick engine in sim.js is kept only for the old
// headless tests during the transition.

import {
  BLOCK, BLOCK_DATA, SURFACE_Y, UPGRADES, ITEMS, FUEL_PRICE, MIN_DIG_DURATION,
} from '../config.js';
import { getBlock, setBlock, isSolid, isClimbable } from '../world.js';
import { addToCargo, applyUpgrade } from '../robot.js';
import { rollLoot } from '../config/chests.js';
import { ACTION, DIR_VEC, normalizeAction } from './actions.js';
import { createMatch } from './state.js';
import { observe } from './observation.js';
import { computeTeamScore } from './sim.js';
import { SURFACE_ROW, DIAMOND_BONUS } from './constants.js';

// Durations (ms) — real-time feel. Falling is much faster than walking, so a
// drop reads as a drop.
const MOVE_MS = 120;        // slide one tile (walk / climb) — matches single-player
const FALL_MS = 50;         // one tile of free-fall (≈3× faster than a walk)
const FAIL_DIG_MS = 360;    // bonk on undrillable stone
const COOLDOWN_MS = 110;    // pause after an instant action (shop / ladder / wait)
const STONE_SHAKE_MS = 1500;
const STONE_FALL_MS = 90;
const PILLAR_GRACE_MS = 250;
const LAVA_STEP_MS = 280;
const LAVA_BUDGET = 18;
const LAVA_MAX_SOURCES = 8;
const DYNAMITE_FUSE_MS = 4000;
const RESPAWN_MS = 700;
const RESPAWN_FUEL_FRACTION = 0.3;

const digMs = (type, m) =>
  Math.max(MIN_DIG_DURATION, 420 * BLOCK_DATA[type].hardness * m.drillSpeed);
const lerp = (a, b, p) => a + (b - a) * p;

export class RealtimeWorld {
  constructor(opts = {}) {
    this.match = createMatch(opts);
    this.s = this.match; // shorthand for state
    this.world = this.match.world;
    this.timeMs = 0;
    this.events = [];
    this.worldDirty = true;
    // Real-time physics (ms-scheduled), separate from the tick engine's arrays.
    this.stones = [];                 // { x, y, phase:'shake'|'fall', at }
    this.lava = new Map();            // key -> { x, y, budget, nextAt }
    this.bombs = [];                  // { x, y, radius, fuseAt, planter }
    // "Think time": a deliberate pause between actions so agents act like a
    // person deciding, not a continuous machine. Tunable.
    this.thinkMs = opts.thinkMs ?? 300;
    for (const m of this.s.miners) {
      m.act = null;        // { kind, fromX, fromY, tx, ty, blockType?, t, dur }
      m.fallStartY = null;
      m.drawX = m.tx;
      m.drawY = m.ty;
      m.respawnAtMs = null;
      m.nextDecisionAt = 0; // don't poll the agent before this time (think pause)
    }
    this.agents = [];
  }

  setAgents(agents) { this.agents = agents; }

  observe(id) { return observe(this.match, id); }
  get teamScore() { return computeTeamScore(this.match); }
  get finished() { return this.match.finished; }

  // ---- main loop -----------------------------------------------------------
  update(dt) {
    if (this.match.finished) return;
    this.timeMs += dt;
    this.events = [];
    this._physics(dt);

    for (const m of this.s.miners) {
      if (!m.alive) { this._respawn(m); continue; }
      if (m.act) { this._advanceAct(m, dt); continue; }
      // idle: gravity first
      if (this._canFall(m)) { this._startFall(m); continue; }
      if (m.fallStartY != null) {
        const dist = m.ty - m.fallStartY; m.fallStartY = null;
        this._land(m, dist);
        if (!m.alive) continue;
      }
      // Still "thinking" between actions? hold position (deliberate pace).
      if (this.timeMs < m.nextDecisionAt) continue;
      // poll the agent for the next action
      const decide = this.agents[m.id];
      const act = decide ? decide(this.observe(m.id)) : { type: ACTION.WAIT };
      this._begin(m, act);
    }

    this.match.teamScore = computeTeamScore(this.match);
  }

  _advanceAct(m, dt) {
    const a = m.act;
    a.t += dt;
    const p = a.dur > 0 ? Math.min(1, a.t / a.dur) : 1;
    if (a.kind === 'move' || a.kind === 'climb' || a.kind === 'fall') {
      m.drawX = lerp(a.fromX, a.tx, p);
      m.drawY = lerp(a.fromY, a.ty, p);
    } else { m.drawX = m.tx; m.drawY = m.ty; }
    if (a.t >= a.dur) this._complete(m);
  }

  _complete(m) {
    const a = m.act; m.act = null;
    if (a.kind === 'move' || a.kind === 'climb') {
      m.tx = a.tx; m.ty = a.ty; m.drawX = a.tx; m.drawY = a.ty;
      this._onArrive(m);
      this.events.push({ type: 'moved', id: m.id, x: m.tx, y: m.ty });
    } else if (a.kind === 'fall') {
      m.tx = a.tx; m.ty = a.ty; m.drawX = a.tx; m.drawY = a.ty;
      return; // physics: gravity re-checked next frame; no think pause
    } else if (a.kind === 'dig') {
      this._completeDig(m, a); // may start a follow-up slide (sets m.act)
    }
    // Just went idle (no follow-up action)? schedule a think pause before the
    // next decision so the agent doesn't act continuously.
    if (m.act == null && m.alive) m.nextDecisionAt = this.timeMs + this.thinkMs;
  }

  // ---- per-miner actions ---------------------------------------------------
  _begin(m, raw) {
    const act = normalizeAction(raw);
    const allowed = m.allowed || this.match.config.allowedActions;
    if (allowed && act.type !== ACTION.WAIT && !allowed.includes(act.type)) {
      return this._cooldown(m);
    }
    switch (act.type) {
      case ACTION.MOVE: return this._beginMove(m, act.dir, false);
      case ACTION.DIG: return this._beginMove(m, act.dir, true);
      case ACTION.LADDER: this._placeLadder(m); return this._cooldown(m);
      case ACTION.PILLAR: this._placePillar(m); return this._cooldown(m);
      case ACTION.TELEPORT: this._teleport(m); return this._cooldown(m);
      case ACTION.DYNAMITE: this._dynamite(m, act.size); return this._cooldown(m);
      case ACTION.UPGRADE: this._shopUpgrade(m, act.stat); return this._cooldown(m);
      case ACTION.BUY: this._shopBuy(m, act.item); return this._cooldown(m);
      case ACTION.REFUEL: this._refuel(m); return this._cooldown(m);
      case ACTION.TURN_IN: this._turnIn(m); return this._cooldown(m);
      default: return this._cooldown(m);
    }
  }

  _beginMove(m, dir, digOnly) {
    const [dx, dy] = DIR_VEC[dir];
    if (dx < 0) m.facing = 'left'; else if (dx > 0) m.facing = 'right';
    else if (dy > 0) m.facing = 'down'; else m.facing = 'up';
    const tx = m.tx + dx, ty = m.ty + dy;
    const tile = getBlock(this.world, tx, ty);

    if (tile === BLOCK.CHEST) {
      this._openChest(m, tx, ty);
      setBlock(this.world, tx, ty, BLOCK.SKY); this.worldDirty = true;
      this._scanStone(tx, ty - 1); this._awakenLava(tx, ty);
      if (dy >= 0 && !this._occupied(m, tx, ty)) return this._startMove(m, tx, ty, 'move');
      return this._cooldown(m);
    }

    if (dy < 0) { // up
      if (ty < SURFACE_ROW) return this._cooldown(m);
      if (isSolid(tile)) return this._startDig(m, tx, ty);
      const here = getBlock(this.world, m.tx, m.ty);
      const needsLadder = here !== BLOCK.LADDER && m.ty > SURFACE_ROW;
      if (needsLadder) {
        if (m.items.ladder <= 0) return this._cooldown(m);
        setBlock(this.world, m.tx, m.ty, BLOCK.LADDER); m.items.ladder--; this.worldDirty = true;
        this.events.push({ type: 'ladder_placed', id: m.id, x: m.tx, y: m.ty });
      }
      if (this._occupied(m, tx, ty)) return this._cooldown(m);
      return this._startMove(m, tx, ty, 'climb');
    }

    // down / sideways
    if (isSolid(tile)) return this._startDig(m, tx, ty);
    if (digOnly) return this._cooldown(m); // DIG into air = nothing
    if (this._occupied(m, tx, ty)) return this._cooldown(m);
    return this._startMove(m, tx, ty, 'move');
  }

  _startMove(m, tx, ty, kind) {
    m.act = { kind, fromX: m.tx, fromY: m.ty, tx, ty, t: 0, dur: MOVE_MS };
  }

  _startDig(m, tx, ty) {
    const type = getBlock(this.world, tx, ty);
    const data = BLOCK_DATA[type];
    if (!data) return this._cooldown(m);
    this._face(m, tx, ty);
    if (data.hardness >= 999) {
      m.act = { kind: 'cooldown', t: 0, dur: FAIL_DIG_MS };
      return;
    }
    m.act = { kind: 'dig', tx, ty, blockType: type, t: 0, dur: digMs(type, m) };
  }

  _startFall(m) {
    if (m.fallStartY == null) m.fallStartY = m.ty;
    m.act = { kind: 'fall', fromX: m.tx, fromY: m.ty, tx: m.tx, ty: m.ty + 1, t: 0, dur: FALL_MS };
  }

  _cooldown(m) { m.act = { kind: 'cooldown', t: 0, dur: COOLDOWN_MS }; }

  _completeDig(m, a) {
    const { tx, ty, blockType: type } = a;
    const data = BLOCK_DATA[type];
    if (getBlock(this.world, tx, ty) !== type) return; // changed mid-dig
    m.fuel = Math.max(0, m.fuel - data.hardness);

    if (type === BLOCK.DIAMOND) {
      m.hasDiamond = true;
      this.events.push({ type: 'diamond_found', id: m.id });
    } else if (data.price > 0) {
      if (!addToCargo(m, data.name)) return; // cargo full → leave block
      m.stats.oresCollected++;
    }
    if (type === BLOCK.SHRINE) this._shrine(m);

    const fromY = m.ty;
    setBlock(this.world, tx, ty, BLOCK.SKY); this.worldDirty = true;
    this.events.push({ type: 'dug', id: m.id, x: tx, y: ty, block: type });
    if ((data.price || 0) > 0) this.events.push({ type: 'resource_extracted', id: m.id, x: tx, y: ty, block: type });
    m.stats.tilesDug++;
    this._scanStone(tx, ty - 1); this._awakenLava(tx, ty);
    if (m.alive && m.fuel <= 0) { this._kill(m, 'out of fuel'); return; }
    const diggingUp = ty < fromY;
    if (!diggingUp && !this._occupied(m, tx, ty)) {
      // SLIDE into the freshly dug tile (like single-player's tween) rather than
      // snapping — keeps the descent feel + speed 1:1 with the real game.
      m.act = { kind: 'move', fromX: m.tx, fromY: m.ty, tx, ty, t: 0, dur: MOVE_MS };
    }
  }

  _onArrive(m) {
    if (m.ty === SURFACE_ROW) {
      if (m.items.ladder < m.maxLadders) m.items.ladder = m.maxLadders;
      if (m.items.pillar < m.maxPillars) m.items.pillar = m.maxPillars;
      this._autoSell(m);
    }
    this._hazard(m);
    if (m.alive && m.fuel <= 0) this._kill(m, 'out of fuel');
  }

  _land(m, distance) {
    const safe = this.match.config.safeFall;
    if (distance > safe) {
      if (m.items.parachute > 0) { m.items.parachute--; }
      else { this._kill(m, `fell ${distance} tiles`); return; }
    }
    this._onArrive(m);
    if (m.alive) m.nextDecisionAt = this.timeMs + this.thinkMs;
  }

  // ---- economy / effects (rules identical to the tick engine) --------------
  _autoSell(m) {
    let total = 0;
    for (const [name, count] of Object.entries(m.cargo)) {
      const type = Object.values(BLOCK).find((t) => BLOCK_DATA[t]?.name === name);
      total += count * (BLOCK_DATA[type]?.price || 0);
    }
    if (total > 0) {
      m.money += total; m.stats.sold += total; this.match.teamBankSold += total;
      m.cargo = {}; m.cargoCount = 0;
      this.events.push({ type: 'sold', id: m.id, amount: total });
    }
  }

  _hazard(m) {
    const t = getBlock(this.world, m.tx, m.ty);
    if (t === BLOCK.LAVA) m.hp = Math.max(0, m.hp - (BLOCK_DATA[BLOCK.LAVA].damage ?? 30));
    else if (t === BLOCK.WATER) m.hp = Math.max(0, m.hp - (BLOCK_DATA[BLOCK.WATER].damage ?? 2));
    if (m.hp <= 0) this._kill(m, 'crushed by the depths');
  }

  _placeLadder(m) {
    if (m.items.ladder <= 0) return;
    if (getBlock(this.world, m.tx, m.ty) === BLOCK.LADDER) return;
    setBlock(this.world, m.tx, m.ty, BLOCK.LADDER); m.items.ladder--; this.worldDirty = true;
    this.events.push({ type: 'ladder_placed', id: m.id, x: m.tx, y: m.ty });
  }

  _placePillar(m) {
    if (m.items.pillar <= 0) return;
    setBlock(this.world, m.tx, m.ty, BLOCK.PILLAR); m.items.pillar--; this.worldDirty = true;
  }

  _teleport(m) {
    if ((m.items.teleporter || 0) <= 0) return;
    m.items.teleporter--; m.fallStartY = null;
    m.tx = m.spawnX; m.ty = SURFACE_ROW; m.drawX = m.tx; m.drawY = m.ty; // back to own spot
    this._onArrive(m);
  }

  // Digger model: there is no central shop. Each agent's own surface spot is
  // its base/totem — being on the surface row means "at base" (bank / refuel /
  // upgrade), so it never has to walk to the middle of the map.
  _atShop(m) { return m.ty === SURFACE_ROW; }
  _refuel(m) {
    if (!this._atShop(m) || m.fuel >= m.maxFuel || m.money < FUEL_PRICE) return;
    m.money -= FUEL_PRICE; m.stats.spent += FUEL_PRICE; m.fuel = m.maxFuel;
    this.events.push({ type: 'refueled', id: m.id, cost: FUEL_PRICE });
  }
  _shopUpgrade(m, stat) {
    if (!this._atShop(m)) return;
    const before = m.money; const res = applyUpgrade(m, stat);
    if (res.ok) { m.stats.spent += before - m.money; this.events.push({ type: 'upgraded', id: m.id, stat, level: m.upgrades[stat], cost: before - m.money }); }
  }
  _shopBuy(m, item) {
    if (!this._atShop(m)) return;
    const def = ITEMS[item]; if (!def || m.money < def.price) return;
    m.money -= def.price; m.stats.spent += def.price; m.items[item] = (m.items[item] || 0) + 1;
    this.events.push({ type: 'bought', id: m.id, item, cost: def.price });
  }
  _turnIn(m) {
    if (!this._atShop(m) || !m.hasDiamond) return;
    m.hasDiamond = false; this.match.diamondFound = true;
    this.events.push({ type: 'turn_in', id: m.id });
    if (this.match.config.victory.diamondWins) {
      this.match.finished = true; this.match.finishedReason = 'diamond';
      this.match.teamScore = computeTeamScore(this.match);
    }
  }

  _openChest(m, x, y) {
    const chest = this.world.chestsAt?.get(y * this.world.W + x);
    if (!chest || chest.opened) return;
    chest.opened = true;
    const outcome = rollLoot(chest.tier, () => this.match.rng.next());
    this._loot(m, outcome, x, y);
  }
  _loot(m, o, x, y) {
    switch (o.kind) {
      case 'money': m.money += o.amount; return;
      case 'items':
        for (const [name, n] of Object.entries(o.give)) {
          if (n <= 0) continue;
          if (name === 'ladder') m.items.ladder = Math.min(m.maxLadders, m.items.ladder + n);
          else if (name === 'pillar') m.items.pillar = Math.min(m.maxPillars, m.items.pillar + n);
          else m.items[name] = (m.items[name] || 0) + n;
        } return;
      case 'fuel': m.fuel = Math.min(m.maxFuel, m.fuel + Math.round(m.maxFuel * ((o.pct ?? 30) / 100))); return;
      case 'trap':
        this.bombs.push({ x, y, radius: o.size === 'big' ? 2 : 1, fuseAt: this.timeMs + (o.fuseMs ?? 2500), planter: m.id });
        return;
      case 'blueprint': {
        const cands = ['drill', 'fuel', 'cargo', 'pack', 'radar'].filter((k) => m.upgrades[k] < UPGRADES[k].length);
        if (!cands.length) { m.money += 1500; return; }
        const key = cands[this.match.rng.int(cands.length)];
        const next = UPGRADES[key][m.upgrades[key]];
        m.upgrades[key] = next.lvl;
        if (key === 'fuel') { m.maxFuel = next.val; m.fuel = next.val; }
        if (key === 'cargo') m.maxCargo = next.val;
        if (key === 'drill') m.drillSpeed = next.val;
        if (key === 'pack') { const [l, p, h] = next.val; m.maxLadders = l; m.maxPillars = p; m.maxHp = h; m.items.ladder = l; m.items.pillar = p; m.hp = h; }
        if (key === 'radar') m.radar = next.val;
        return;
      }
      default: return;
    }
  }
  _shrine(m) {
    const names = Object.keys(m.cargo).filter((n) => m.cargo[n] > 0);
    if (names.length) { const pick = names[this.match.rng.int(names.length)]; m.cargo[pick]--; if (m.cargo[pick] <= 0) delete m.cargo[pick]; m.cargoCount = Math.max(0, m.cargoCount - 1); }
    if (this.match.rng.next() < 0.5) m.money += 250 + this.match.rng.int(751);
    else m.items.teleporter = (m.items.teleporter || 0) + 1;
  }

  // ---- death / respawn -----------------------------------------------------
  _kill(m, reason) {
    if (!m.alive) return;
    m.alive = false; m.act = null; m.respawnAtMs = this.timeMs + RESPAWN_MS; m.stats.deaths++;
    m.cargo = {}; m.cargoCount = 0;
    if (m.hasDiamond) {
      setBlock(this.world, m.tx, m.ty, BLOCK.DIAMOND); this.worldDirty = true;
      m.hasDiamond = false;
      this.events.push({ type: 'diamond_dropped', x: m.tx, y: m.ty });
    }
    this.events.push({ type: 'death', id: m.id, reason, x: m.tx, y: m.ty });
  }
  _respawn(m) {
    if (m.respawnAtMs == null || this.timeMs < m.respawnAtMs) return;
    m.alive = true; m.respawnAtMs = null;
    m.tx = m.spawnX; m.ty = m.spawnY; m.drawX = m.tx; m.drawY = m.ty;
    m.hp = m.maxHp; m.fuel = Math.max(m.fuel, Math.round(m.maxFuel * RESPAWN_FUEL_FRACTION));
    m.items.ladder = m.maxLadders; m.items.pillar = m.maxPillars; m.fallStartY = null;
    m.nextDecisionAt = this.timeMs;
    this.events.push({ type: 'respawned', id: m.id });
  }

  // ---- dynamite ------------------------------------------------------------
  _dynamite(m, size) {
    const key = size === 2 ? 'bigDynamite' : 'dynamite';
    if ((m.items[key] || 0) <= 0) return;
    m.items[key]--;
    this.bombs.push({ x: m.tx, y: m.ty, radius: size === 2 ? 2 : 1, fuseAt: this.timeMs + DYNAMITE_FUSE_MS, planter: m.id });
  }
  _detonate(b) {
    const planter = this.s.miners.find((x) => x.id === b.planter) || null;
    const r = b.radius; const damage = r >= 2 ? 200 : 120;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = b.x + dx, y = b.y + dy;
      if (x <= 0 || x >= this.world.W - 1 || y <= SURFACE_ROW || y >= this.world.H - 1) continue;
      const t = getBlock(this.world, x, y);
      if (t === BLOCK.SKY || t === BLOCK.DIAMOND) continue;
      if (BLOCK_DATA[t]?.price > 0 && planter && planter.alive) addToCargo(planter, BLOCK_DATA[t].name);
      if (t === BLOCK.CHEST && planter && planter.alive) this._openChest(planter, x, y);
      setBlock(this.world, x, y, BLOCK.SKY);
    }
    this.worldDirty = true;
    for (const m of this.s.miners) {
      if (m.alive && Math.abs(m.tx - b.x) <= r && Math.abs(m.ty - b.y) <= r) {
        m.hp = Math.max(0, m.hp - damage); if (m.hp <= 0) this._kill(m, 'caught in a blast');
      }
    }
    for (let dx = -r; dx <= r; dx++) this._scanStone(b.x + dx, b.y - r - 1);
    this._awakenLava(b.x, b.y);
    this.events.push({ type: 'detonation', x: b.x, y: b.y, radius: r });
  }

  // ---- world physics (ms-scheduled) ----------------------------------------
  _physics(dt) {
    // bombs
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      if (this.timeMs >= this.bombs[i].fuseAt) { const b = this.bombs[i]; this.bombs.splice(i, 1); this._detonate(b); }
    }
    // falling stones
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const st = this.stones[i];
      const below = getBlock(this.world, st.x, st.y + 1);
      const open = below === BLOCK.SKY || below === BLOCK.LADDER;
      if (st.phase === 'shake') {
        if (!open) { this.stones.splice(i, 1); continue; }
        if (this.timeMs >= st.at) { st.phase = 'fall'; st.at = this.timeMs; }
        continue;
      }
      if (this.timeMs < st.at) continue;
      if (!open) { this.stones.splice(i, 1); this._scanStone(st.x, st.y - 1); continue; }
      const victim = this.s.miners.find((mm) => mm.alive && mm.tx === st.x && mm.ty === st.y + 1);
      setBlock(this.world, st.x, st.y, BLOCK.SKY);
      st.y += 1; setBlock(this.world, st.x, st.y, BLOCK.STONE); this.worldDirty = true;
      st.at = this.timeMs + STONE_FALL_MS;
      if (victim) { this.stones.splice(i, 1); this._kill(victim, 'crushed by a falling rock'); }
      this._scanStone(st.x, st.y - 2);
    }
    // lava
    if (this.lava.size) {
      for (const [key, src] of this.lava) {
        if (this.timeMs < src.nextAt) continue;
        src.nextAt = this.timeMs + LAVA_STEP_MS;
        if (src.budget <= 0 || getBlock(this.world, src.x, src.y) !== BLOCK.LAVA) { this.lava.delete(key); continue; }
        let flowed = false;
        for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0]]) {
          const nx = src.x + dx, ny = src.y + dy;
          if (nx <= 0 || nx >= this.world.W - 1 || ny >= this.world.H - 1) continue;
          const t = getBlock(this.world, nx, ny);
          if (t !== BLOCK.SKY && t !== BLOCK.LADDER) continue;
          setBlock(this.world, nx, ny, BLOCK.LAVA); src.budget--; flowed = true; this.worldDirty = true;
          const victim = this.s.miners.find((mm) => mm.alive && mm.tx === nx && mm.ty === ny);
          if (victim) this._kill(victim, 'engulfed by lava');
          break;
        }
        if (!flowed) this.lava.delete(key);
      }
    }
  }

  _scanStone(x, y) {
    if (y < 0 || y >= this.world.H) return;
    if (getBlock(this.world, x, y) !== BLOCK.STONE) return;
    const below = getBlock(this.world, x, y + 1);
    if ((below === BLOCK.SKY || below === BLOCK.LADDER) && !this.stones.some((s) => s.x === x && s.y === y)) {
      this.stones.push({ x, y, phase: 'shake', at: this.timeMs + STONE_SHAKE_MS });
    }
  }
  _awakenLava(x, y) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const lx = x + dx, ly = y + dy;
      if (getBlock(this.world, lx, ly) !== BLOCK.LAVA) continue;
      if (this.lava.size >= LAVA_MAX_SOURCES) return;
      const key = ly * this.world.W + lx;
      if (this.lava.has(key)) continue;
      this.lava.set(key, { x: lx, y: ly, budget: LAVA_BUDGET, nextAt: this.timeMs + LAVA_STEP_MS });
    }
  }

  // ---- helpers -------------------------------------------------------------
  _canFall(m) {
    if (m.ty === SURFACE_ROW) return false;
    const below = getBlock(this.world, m.tx, m.ty + 1);
    const here = getBlock(this.world, m.tx, m.ty);
    return !isSolid(below) && !isClimbable(here) && !isClimbable(below) && m.ty < this.world.H - 1;
  }
  _occupied(self, x, y) {
    return this.s.miners.some((o) => o !== self && o.alive && o.tx === x && o.ty === y);
  }
  _face(m, tx, ty) {
    if (tx < m.tx) m.facing = 'left'; else if (tx > m.tx) m.facing = 'right';
    else if (ty > m.ty) m.facing = 'down'; else if (ty < m.ty) m.facing = 'up';
  }
}
