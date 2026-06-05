import Phaser from 'phaser';
import { TILE, BLOCK } from '../config.js';
import GameScene from './GameScene.js';
import { GAME_MODES } from '../engine/index.js';
import { RealtimeWorld } from '../engine/realtime.js';
import { createSquad } from '../engine/agents.js';
import { drawRobot as drawSharedRobot } from '../render/robot.js';
import { btnCss, wireBtn } from './arenaUI.js';

// Live spectator. Extends GameScene to REUSE the real game rendering (tiles,
// ore, shop, robot models) at 1:1 scale, but drives a CONTINUOUS real-time
// world (engine/realtime.js) — no ticks. Each character moves/digs/falls over
// real durations with smooth interpolation; the agent is polled when its
// character goes idle. Free-scroll camera; a speed control scales real time.
const FUSE_MS = 4000; // must match realtime.js DYNAMITE_FUSE_MS (for the fuse animation)

function squadCounts(n) {
  const kinds = ['shuttle', 'prospector', 'deepdiver', 'shuttle', 'prospector'];
  const c = {};
  for (let i = 0; i < n; i++) { const k = kinds[i % kinds.length]; c[k] = (c[k] || 0) + 1; }
  return c;
}

export default class SpectatorScene extends GameScene {
  constructor() { super('Spectator'); }

  init(data) {
    this.specMode = data?.mode || 'coop-gem';
    this.specSeed = data?.seed ?? 1234;
  }

  create() {
    this.cleanupSceneDOM();
    this.spectator = true;
    this.mode = GAME_MODES[this.specMode] || GAME_MODES['coop-gem'];
    this.bots = createSquad(squadCounts(this.mode.miners));
    this.rt = new RealtimeWorld({
      seed: this.specSeed,
      spec: this.mode.spec,
      spawn: this.mode.spawn,
      victory: this.mode.victory,
      safeFall: 3, // same as single-player: a >3-tile fall hurts/kills
      miners: this.bots.map((b) => ({ name: b.name, hat: b.hat, color: b.color, items: b.items || undefined, radar: b.radar, maxLadders: b.maxLadders })),
    });
    this.rt.setAgents(this.bots.map((b) => b.decide));
    this.world = this.rt.world;
    // Each agent's home column → a surface totem (its personal base/sell spot).
    this.totemSpots = this.rt.s.miners.map((m) => m.spawnX);

    this.worldGfx = this.add.graphics();
    this.digFxGfx = this.add.graphics(); this.digFxGfx.setDepth(3);
    this.debrisGfx = this.add.graphics(); this.debrisGfx.setDepth(4);
    this.robotGfx = this.add.graphics(); this.robotGfx.setDepth(5);
    this.fxGfx = this.add.graphics(); this.fxGfx.setDepth(6);
    this.tilePool = []; this.tilePoolCursor = 0;
    this.fallingStones = []; this.digging = null; this.failedDig = null;
    this.debris = []; this.flashes = []; this.bankPops = [];

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.world.W * TILE, this.world.H * TILE);
    cam.setBackgroundColor('#4a7bbf');
    cam.setRoundPixels(true);
    cam.setZoom(1);
    cam.centerOn(this.rt.match.shopX * TILE, (this.world.surface + 7) * TILE);

    this.setupCameraControls();
    this.statsTimer = 0;
    this.worldDirty = true;
    this.buildHUD();

    this.scale.on('resize', this.onSpecResize, this);
    this.events.once('shutdown', () => this.teardown());
    this.events.once('destroy', () => this.teardown());
  }

  onSpecResize() { this.scene.restart({ mode: this.specMode, seed: this.specSeed }); }

  setupCameraControls() {
    // Fixed 1:1 zoom. Drag or mouse-wheel to scroll (pan). No zoom.
    const cam = this.cameras.main;
    this.input.on('pointermove', (p) => {
      if (!p.isDown) return;
      cam.scrollX -= p.x - p.prevPosition.x;
      cam.scrollY -= p.y - p.prevPosition.y;
    });
    this.input.on('wheel', (_p, _o, dx, dy) => { cam.scrollX += dx; cam.scrollY += dy; });
  }

  update(time, dt) {
    if (!this.rt.finished) {
      // Advance real time (cap dt so a tab-stall doesn't teleport everyone).
      this.rt.update(Math.min(50, dt));
      for (const e of this.rt.events) {
        if (e.type === 'dug') this.spawnDebris(e.x, e.y, e.block, 8);
        else if (e.type === 'detonation') {
          this.flashes.push({ x: e.x, y: e.y, maxR: (e.radius + 1) * TILE, life: 320, maxLife: 320 });
          this.spawnDebris(e.x, e.y, BLOCK.STONE, 16);
          this.cameras.main.shake(160, 0.004 * (e.radius + 1));
        }
        else if (e.type === 'sold') this.spawnBankPop(e.id, e.amount);
      }
      if (this.rt.worldDirty) { this.worldDirty = true; this.rt.worldDirty = false; }
    }

    // Feed the realtime falling stones into the inherited drawTile so they get
    // the same wobble/jitter as single-player; keep redrawing while any wobble.
    this.fallingStones = this.rt.stones.map((s) => ({ x: s.x, y: s.y, state: s.phase }));
    if (this.rt.stones.length) this.worldDirty = true;

    if (this.debris.length) this.updateDebris(dt);
    for (let i = this.flashes.length - 1; i >= 0; i--) { this.flashes[i].life -= dt; if (this.flashes[i].life <= 0) this.flashes.splice(i, 1); }

    if (this.worldDirty) { this.drawWorld(); this.worldDirty = false; } // inherited — real tiles
    this.drawDigCracks();
    this.debrisGfx.clear();
    if (this.debris.length) this.drawDebris();      // inherited
    this._syncBombs();
    this.drawBombs();                                // inherited — real dynamite sticks + fuses
    this.drawSpecRobots(time);
    this.drawFx(time);
    this.updateBankPops(dt);

    this.statsTimer += dt;
    if (this.statsTimer >= 200) { this.statsTimer = 0; this.updateHUD(); if (this.rt.finished) this.showFinish(); }
  }

  drawSpecRobots(time) {
    const g = this.robotGfx; g.clear();
    for (const m of this.rt.s.miners) {
      const dying = !m.alive && m.respawnAtMs != null; // show the squashed corpse until respawn
      if (!m.alive && !dying) continue;
      const digging = !!(m.act && m.act.kind === 'dig') && !dying;
      // Same dig shake as single-player drawRobot.
      const shake = digging
        ? { x: (Math.floor(time / 55) % 2 === 0) ? 1 : -1, y: (Math.floor(time / 80) % 2 === 0) ? 1 : 0 }
        : { x: 0, y: 0 };
      drawSharedRobot(g, m.drawX * TILE + TILE / 2, m.drawY * TILE + TILE / 2, TILE, {
        facing: m.facing, digging, time, hasDiamond: m.hasDiamond,
        shake, squashed: dying, hat: m.hat, bodyColor: m.color, tier: 1,
      });
      // Dust puffs around the dig target — identical to single-player.
      if (digging) {
        g.fillStyle(0x8b5a2b, 0.7);
        const dx = m.act.tx * TILE + TILE / 2, dy = m.act.ty * TILE + TILE / 2;
        for (let i = 0; i < 3; i++) {
          const a = (time / 100 + i * 2) % 6.28;
          const rr = 6 + (time / 50 + i * 7) % 14;
          g.fillRect(Math.round(dx + Math.cos(a) * rr), Math.round(dy + Math.sin(a) * rr), 3, 3);
        }
      }
    }
  }

  // Mirror the realtime bombs into GameScene's bomb format so the inherited
  // drawBombs() renders the exact same dynamite stick + animated fuse.
  _syncBombs() {
    const now = this.time.now;
    this.bombs = this.rt.bombs.map((b) => {
      const elapsed = FUSE_MS - Math.max(0, b.fuseAt - this.rt.timeMs);
      return { tx: b.x, ty: b.y, isBig: b.radius >= 2, fuse: FUSE_MS, placedAt: now - elapsed };
    });
  }

  drawDigCracks() {
    const g = this.digFxGfx; g.clear();
    for (const m of this.rt.s.miners) {
      if (!m.alive || !m.act || m.act.kind !== 'dig') continue;
      const { tx, ty, t, dur } = m.act;
      const progress = dur ? Math.min(1, t / dur) : 0;
      const px = tx * TILE, py = ty * TILE;
      g.lineStyle(3, 0x000000, 0.85);
      if (progress >= 0.25) {
        g.strokeLineShape(new Phaser.Geom.Line(px + 8, py + 10, px + TILE / 2, py + TILE / 2));
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + TILE / 2, px + TILE - 14, py + TILE - 8));
      }
      if (progress >= 0.5) {
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE - 8, py + 6, px + TILE / 2 + 4, py + TILE / 2));
        g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2 - 2, py + TILE / 2 + 2, px + 10, py + TILE - 4));
      }
      if (progress >= 0.75) g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + 4, px + TILE / 2 + 3, py + TILE / 2));
      g.fillStyle(0x000000, 0.55); g.fillRect(px + 3, py - 9, TILE - 6, 6);
      g.fillStyle(0xffdd55, 1); g.fillRect(px + 4, py - 8, (TILE - 8) * progress, 4);
    }
  }

  // A digger surfaced and banked its crystals → float a "+N VARA" over its
  // totem. This is the visible per-agent earning = a future on-chain tx.
  spawnBankPop(id, amount) {
    if (!amount) return;
    const m = this.rt.s.miners.find((x) => x.id === id);
    if (!m) return;
    const x = (m.spawnX + 0.5) * TILE;
    const y = (this.world.surface - 0.3) * TILE;
    const t = this.add.text(x, y, `+${amount} VARA`, {
      fontFamily: 'Courier New, monospace', fontSize: '15px', color: '#8affc0',
      stroke: '#05311b', strokeThickness: 4, fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(8);
    this.bankPops.push({ t, age: 0, life: 1300 });
  }

  updateBankPops(dt) {
    if (!this.bankPops) return;
    for (let i = this.bankPops.length - 1; i >= 0; i--) {
      const p = this.bankPops[i];
      p.age += dt;
      p.t.y -= dt * 0.022;                       // float upward
      p.t.setAlpha(Math.max(0, 1 - p.age / p.life));
      if (p.age >= p.life) { p.t.destroy(); this.bankPops.splice(i, 1); }
    }
  }

  drawFx() {
    const g = this.fxGfx; g.clear();
    for (const f of this.flashes) {
      const a = f.life / f.maxLife; const r = 8 + f.maxR * (1 - a);
      const cx = f.x * TILE + TILE / 2, cy = f.y * TILE + TILE / 2;
      g.fillStyle(0xff7a1f, 0.25 * a); g.fillCircle(cx, cy, r);
      g.lineStyle(4, 0xffd14a, a); g.strokeCircle(cx, cy, r);
    }
  }

  // ---- HUD (DOM) ----
  buildHUD() {
    const bar = document.createElement('div');
    bar.id = 'spec-hud';
    bar.style.cssText = `position:fixed;left:0;top:0;width:100%;height:46px;z-index:20;
      display:flex;align-items:center;gap:14px;padding:0 14px;box-sizing:border-box;
      background:linear-gradient(#000c,#0007);font-family:'Courier New',monospace;color:#fff`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'font-size:14px;padding:6px 13px;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
    back.onclick = () => this.goLobby();
    bar.appendChild(back);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;color:#ffdd55;font-size:17px';
    title.textContent = this.mode.label;
    bar.appendChild(title);

    const stats = document.createElement('div');
    stats.id = 'spec-stats';
    stats.style.cssText = 'margin-left:auto;font-size:14px';
    bar.appendChild(stats);

    document.body.appendChild(bar);
    this.statsEl = stats;
    this.updateHUD();
  }

  updateHUD() {
    if (!this.statsEl) return;
    const ms = this.rt.s.miners;
    const alive = ms.filter((m) => m.alive).length;
    const dug = ms.reduce((a, m) => a + m.stats.tilesDug, 0);
    this.statsEl.innerHTML =
      `${(this.rt.timeMs / 1000).toFixed(0)}s　agents <b>${alive}/${ms.length}</b>　` +
      `dug <b>${dug}</b>　team <b style="color:#ffec6e">$${this.rt.teamScore}</b>` +
      (this.rt.match.diamondFound ? '　<b style="color:#5ff6ff">💎</b>' : '');
  }

  showFinish() {
    if (document.getElementById('spec-finish')) return;
    const ov = document.createElement('div');
    ov.id = 'spec-finish';
    ov.style.cssText = `position:fixed;inset:0;z-index:22;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:18px;background:#000a;
      font-family:'Courier New',monospace;color:#fff;text-align:center`;
    const reason = this.rt.match.finishedReason === 'diamond' ? '💎 DIAMOND DELIVERED'
      : this.rt.match.finishedReason === 'score_target' ? '🏁 SCORE TARGET REACHED' : '⏱ TIME UP';
    ov.innerHTML = `<div style="font-size:40px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">${reason}</div>
      <div style="font-size:22px">team score: <b style="color:#ffec6e">$${this.rt.teamScore}</b></div>`;
    const again = wireBtn(document.createElement('button'));
    again.textContent = '↺  LOBBY';
    again.style.cssText = btnCss('#5fd0e6') + 'font-size:18px;padding:12px 30px';
    again.onclick = () => this.goLobby();
    ov.appendChild(again);
    document.body.appendChild(ov);
  }

  goLobby() {
    this.scale.off('resize', this.onSpecResize, this);
    this.scene.start('Lobby');
  }

  teardown() {
    document.getElementById('spec-hud')?.remove();
    document.getElementById('spec-finish')?.remove();
  }
}
