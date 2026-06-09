import Phaser from 'phaser';
import { TILE, BLOCK, BLOCK_DATA, SURFACE_Y } from '../config.js';
import GameScene from './GameScene.js';
import { GAME_MODES } from '../engine/index.js';
import { createWorldSource } from '../chain/source.js';
import { createSquad } from '../engine/agents.js';
import { drawRobot as drawSharedRobot } from '../render/robot.js';
import { btnCss, wireBtn } from './arenaUI.js';

// Live spectator. Extends GameScene to REUSE the real game rendering (tiles,
// ore, shop, robot models) at 1:1 scale, but drives a CONTINUOUS real-time
// world (engine/realtime.js) — no ticks. Each character moves/digs/falls over
// real durations with smooth interpolation; the agent is polled when its
// character goes idle. Free-scroll camera; a speed control scales real time.
const FUSE_MS = 4000; // must match realtime.js DYNAMITE_FUSE_MS (for the fuse animation)

function shortAddress(address) {
  const addr = displayAddress(address);
  if (!addr || addr.length <= 16) return addr || '0x...';
  return `${addr.slice(0, 6)}...${addr.slice(-5)}`;
}

function displayAddress(address) {
  if (!address) return '';
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(address)
    ? `0x${address.slice(-40)}`
    : address;
}

function addressScanUrl(address) {
  const addr = displayAddress(address);
  return addr ? `https://hoodi.etherscan.io/address/${addr}` : '#';
}

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
    this.specProgramId = data?.programId || '';
  }

  create() {
    this.cleanupSceneDOM();
    this.spectator = true;
    this.mode = GAME_MODES[this.specMode] || {
      name: 'chain-live',
      label: 'Live World',
      spec: 'agents',
      spawn: 'wide',
      victory: {},
      maxTicks: 0,
      miners: 10,
      description: 'Live Vara.eth world.',
    };
    this.bots = createSquad(squadCounts(this.mode.miners));
    // Data source: local engine today, Vara.eth ChainSource once the World
    // contract is live (chain/source.js decides from env). Same surface either way.
    this.rt = createWorldSource({
      seed: this.specSeed,
      programId: this.specProgramId,
      spec: this.mode.spec,
      spawn: this.mode.spawn,
      victory: this.mode.victory,
      safeFall: 3, // same as single-player: a >3-tile fall hurts/kills
      miners: this.bots.map((b) => ({ name: b.name, hat: b.hat, color: b.color, items: b.items || undefined, radar: b.radar, maxLadders: b.maxLadders })),
    });
    this.rt.setAgents(this.bots.map((b) => b.decide));
    this._tornDown = false;
    this.sourceReady = false;
    this.sourceError = null;

    if (this.rt.ready) {
      this.showLoading();
      this.rt.ready
        .then(() => this.setupLoadedWorld())
        .catch((error) => this.showSourceError(error));
      this.events.once('shutdown', () => this.teardown());
      this.events.once('destroy', () => this.teardown());
      return;
    }

    this.setupLoadedWorld();
    this.events.once('shutdown', () => this.teardown());
    this.events.once('destroy', () => this.teardown());
  }

  setupLoadedWorld() {
    if (this._tornDown || !this.rt?.world) return;
    this.sourceReady = true;
    this.loadingText?.destroy();
    this.loadingText = null;
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
    // On-chain TX console: rolling log of agent actions as if they were txs.
    this.eventLog = []; this.txCount = 0; this.consoleOpen = false; this.consoleTimer = 0;

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.world.W * TILE, this.world.H * TILE);
    cam.setBackgroundColor('#4a7bbf');
    cam.setRoundPixels(true);
    cam.setZoom(1);
    cam.centerOn(this.rt.match.shopX * TILE, (this.world.surface + 7) * TILE);
    this.fullWorldRender = true;

    this.setupCameraControls();
    this.statsTimer = 0;
    this.worldDirty = true;
    this.buildHUD();
    this.robotChirpSound = this.sound.add('robot-chirp', { volume: 0.42 });
    this.robotQuestionSound = this.sound.add('robot-question', { volume: 0.42 });
    this.robotTouchSounds = [this.robotChirpSound, this.robotQuestionSound];
    this.scale.on('resize', this.onSpecResize, this);
  }

  showLoading() {
    this.cameras.main.setBackgroundColor('#101820');
    this.loadingText = this.add.text(this.scale.width / 2, this.scale.height / 2, 'CONNECTING TO VARA.ETH...', {
      fontFamily: 'Courier New, monospace',
      fontSize: '18px',
      color: '#7CFFB0',
      backgroundColor: '#000000aa',
      padding: { x: 16, y: 10 },
    }).setOrigin(0.5);
  }

  showSourceError(error) {
    this.sourceError = error;
    const msg = error?.message || String(error);
    if (this.loadingText) {
      this.loadingText.setText(`CHAIN SOURCE ERROR\n${msg}`);
      this.loadingText.setColor('#ff6a6a');
      return;
    }
    this.add.text(this.scale.width / 2, this.scale.height / 2, `CHAIN SOURCE ERROR\n${msg}`, {
      fontFamily: 'Courier New, monospace',
      fontSize: '16px',
      color: '#ff6a6a',
      backgroundColor: '#000000cc',
      padding: { x: 16, y: 10 },
      align: 'center',
      wordWrap: { width: Math.min(720, this.scale.width - 40) },
    }).setOrigin(0.5);
  }

  onSpecResize() { this.scene.restart({ mode: this.specMode, seed: this.specSeed, programId: this.specProgramId }); }

  setupCameraControls() {
    // Fixed 1:1 zoom. Drag or mouse-wheel to scroll (pan). No zoom.
    const cam = this.cameras.main;
    const dragThreshold = 6;
    this._pointerDrag = null;
    this.input.on('pointerdown', (p) => {
      this._pointerDrag = { x: p.x, y: p.y, dragging: false };
    });
    this.input.on('pointermove', (p) => {
      if (!p.isDown || !this._pointerDrag) return;
      const dist = Math.hypot(p.x - this._pointerDrag.x, p.y - this._pointerDrag.y);
      if (!this._pointerDrag.dragging && dist >= dragThreshold) {
        this._pointerDrag.dragging = true;
        this.hideAgentBubble();
      }
      if (!this._pointerDrag.dragging) return;
      cam.scrollX -= p.x - p.prevPosition.x;
      cam.scrollY -= p.y - p.prevPosition.y;
    });
    this.input.on('pointerup', (p) => {
      const drag = this._pointerDrag;
      this._pointerDrag = null;
      if (drag?.dragging) return;
      this.handleAgentPointerClick(p);
    });
    this.input.on('wheel', (_p, _o, dx, dy) => {
      this.hideAgentBubble();
      cam.scrollX += dx;
      cam.scrollY += dy;
    });
  }

  update(time, dt) {
    if (!this.sourceReady || !this.rt?.world) return;
    if (this.cameraViewportChanged()) this.worldDirty = true;
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
        this.pushEvent(e);
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
    this.positionAgentBubble();
    this.drawFx(time);
    this.updateBankPops(dt);
    if (this.consoleOpen) {
      this.consoleTimer += dt;
      if (this.consoleTimer >= 120) { this.consoleTimer = 0; this.renderConsole(); }
    }

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

  handleAgentPointerClick(pointer) {
    const agent = this.findAgentAtPointer(pointer);
    if (!agent) {
      this.hideAgentBubble();
      return;
    }
    this.playAgentChirp();
    this.sayAgentBubble(agent, 2600);
  }

  findAgentAtPointer(pointer) {
    if (!this.rt?.s?.miners?.length) return null;
    const cam = this.cameras.main;
    const worldPoint = cam.getWorldPoint(pointer.x, pointer.y);
    return this.rt.s.miners.find((m) => {
      if (!m.alive || !m.owner) return false;
      const cx = m.drawX * TILE + TILE / 2;
      const cy = m.drawY * TILE + TILE / 2;
      return Math.abs(worldPoint.x - cx) <= TILE * 0.62 &&
        Math.abs(worldPoint.y - cy) <= TILE * 0.74;
    });
  }

  playAgentChirp() {
    const sounds = this.robotTouchSounds?.filter(Boolean) || [];
    if (!sounds.length) return;
    for (const sound of sounds) sound.stop();
    sounds[Math.floor(Math.random() * sounds.length)].play();
  }

  sayAgentBubble(agent, ms = 2200) {
    if (!this.agentBubbleEl || !agent) return;
    const address = displayAddress(agent.owner);
    this.agentBubblePrefixEl.textContent = 'I am ';
    this.agentBubbleLinkEl.textContent = shortAddress(agent.owner);
    this.agentBubbleLinkEl.href = addressScanUrl(agent.owner);
    this.agentBubbleLinkEl.title = address;
    this.agentBubbleEl.title = address;
    this.agentBubbleEl.style.display = 'block';
    this.agentBubbleMiner = agent;
    this.positionAgentBubble();
    clearTimeout(this._agentBubbleTimer);
    this._agentBubbleTimer = setTimeout(() => this.hideAgentBubble(), ms);
  }

  hideAgentBubble() {
    if (this.agentBubbleEl) this.agentBubbleEl.style.display = 'none';
    this.agentBubbleMiner = null;
    clearTimeout(this._agentBubbleTimer);
  }

  positionAgentBubble() {
    if (!this.agentBubbleEl || this.agentBubbleEl.style.display === 'none' || !this.agentBubbleMiner) return;
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    const m = this.agentBubbleMiner;
    const sx = (m.drawX * TILE + TILE / 2 - cam.scrollX) * zoom;
    const sy = (m.drawY * TILE - 6 - cam.scrollY) * zoom;
    const side = m.facing === 'left' ? -1 : 1;
    this.agentBubbleEl.style.left = `${sx + side * 36}px`;
    this.agentBubbleEl.style.top = `${sy}px`;
    this.agentBubbleEl.style.setProperty('--tail-x', side > 0 ? '38%' : '62%');
  }

  cameraViewportChanged() {
    if (this.fullWorldRender) return false;
    const cam = this.cameras.main;
    const coverage = this._worldDrawCoverage;
    if (!coverage) return true;

    const zoom = cam.zoom || 1;
    const guard = TILE * 4;
    const left = cam.scrollX;
    const top = cam.scrollY;
    const right = cam.scrollX + cam.width / zoom;
    const bottom = cam.scrollY + cam.height / zoom;

    return left < coverage.left + guard ||
      top < coverage.top + guard ||
      right > coverage.right - guard ||
      bottom > coverage.bottom - guard;
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

    // On-chain TX-log toggle (terminal-style side console).
    const logBtn = wireBtn(document.createElement('button'));
    logBtn.id = 'spec-logbtn';
    logBtn.textContent = '⛓ TX LOG';
    logBtn.style.cssText = btnCss('#7CFFB0') + 'font-size:13px;padding:6px 12px;margin-left:14px;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
    logBtn.onclick = () => this.toggleConsole();
    bar.appendChild(logBtn);
    this.logBtn = logBtn;

    document.body.appendChild(bar);
    this.statsEl = stats;
    this.buildConsole();
    this.buildAgentBubble();
    this.updateHUD();
  }

  buildAgentBubble() {
    const bubble = document.createElement('div');
    bubble.id = 'spec-agent-bubble';
    bubble.style.cssText = `
      position: fixed; transform: translate(-50%, -100%);
      background: #fff; color: #222; font-family: 'Courier New', monospace;
      font-size: 14px; padding: 6px 10px; border-radius: 10px;
      border: 2px solid #222; box-shadow: 2px 2px 0 rgba(0,0,0,0.3);
      white-space: nowrap; pointer-events: auto; z-index: 18;
      display: none; max-width: 260px;
    `;
    bubble.innerHTML = `<span id="spec-agent-bubble-prefix"></span><a id="spec-agent-bubble-link"
        target="_blank" rel="noreferrer"
        style="color:#0b57d0;text-decoration:none;font-weight:bold"></a>
      <div style="position:absolute;bottom:-8px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;
        border-top:8px solid #222;pointer-events:none"></div>
      <div style="position:absolute;bottom:-5px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
        border-top:6px solid #fff;pointer-events:none"></div>`;
    document.body.appendChild(bubble);
    this.agentBubbleEl = bubble;
    this.agentBubblePrefixEl = bubble.querySelector('#spec-agent-bubble-prefix');
    this.agentBubbleLinkEl = bubble.querySelector('#spec-agent-bubble-link');
  }

  // Slide-out terminal that streams agent actions as if they were on-chain txs.
  buildConsole() {
    const c = document.createElement('div');
    c.id = 'spec-console';
    c.style.cssText = `position:fixed;right:0;top:46px;bottom:0;width:360px;z-index:19;
      transform:translateX(100%);transition:transform .18s ease;
      background:rgba(7,11,9,.86);backdrop-filter:blur(2px);border-left:2px solid #2f6a3f;
      box-shadow:-6px 0 24px rgba(0,0,0,.4);font-family:'Courier New',monospace;
      display:flex;flex-direction:column`;
    c.innerHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid #2f6a3f;color:#7CFFB0;
        font-size:12px;font-weight:bold;letter-spacing:.5px;display:flex;justify-content:space-between">
        <span>▮ VARA.ETH · LIVE TX</span><span id="spec-tx-count" style="color:#5a8a6a">0 tx</span>
      </div>
      <div id="spec-console-body" style="flex:1;overflow:hidden;padding:6px 9px;
        font-size:11px;line-height:1.55"></div>
      <div style="padding:5px 10px;border-top:1px solid #1f3a28;color:#3a6a4a;font-size:10px">
        pre-confirmed ~200ms · injected tx · reverse-gas
      </div>`;
    document.body.appendChild(c);
    this.consoleEl = c;
  }

  toggleConsole() {
    this.consoleOpen = !this.consoleOpen;
    if (this.consoleEl) this.consoleEl.style.transform = this.consoleOpen ? 'translateX(0)' : 'translateX(100%)';
    if (this.logBtn) this.logBtn.style.filter = this.consoleOpen ? 'brightness(1.5)' : '';
    if (this.consoleOpen) this.renderConsole();
  }

  // Turn an engine event into a console line {hash,t,name,msg,color}; null = skip.
  pushEvent(e) {
    const line = this.formatEvent(e);
    if (!line) return;
    this.txCount++;
    line.hash = '0x' + ((0x9e3779b1 * this.txCount) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
    this.eventLog.push(line);
    if (this.eventLog.length > 220) this.eventLog.splice(0, this.eventLog.length - 220);
  }

  formatEvent(e) {
    const miner = e.id != null ? this.rt.s.miners[e.id] : null;
    const name = (miner?.name || (e.id != null ? `agent-${e.id}` : 'world')).slice(0, 12);
    const t = (this.rt.timeMs / 1000).toFixed(1);
    const surface = this.world?.surface ?? SURFACE_Y;
    const depth = e.y != null ? Math.max(0, e.y - (surface - 1)) : null;
    let msg, color;
    switch (e.type) {
      case 'moved': msg = `move → ${e.x},${e.y}`; color = '#5f7a66'; break;
      case 'dug':
        if ((BLOCK_DATA[e.block]?.price || 0) > 0) return null; // crystal → resource_extracted
        msg = `drill ${e.x},${e.y}`; color = '#7a8c80'; break;
      case 'resource_extracted': {
        const nm = (BLOCK_DATA[e.block]?.name || '?').toUpperCase();
        const v = BLOCK_DATA[e.block]?.price || 0;
        color = e.block === BLOCK.HCRST ? '#ff8fdc' : e.block === BLOCK.BCRST ? '#9bffbf' : '#8fe9ff';
        msg = `⛏ EXTRACT ${nm} −${depth}m +${v}`; break;
      }
      case 'ladder_placed': msg = `place_ladder −${depth}m`; color = '#b9823c'; break;
      case 'sold': msg = `◆ BANK +${e.amount} VARA`; color = '#ffec6e'; break;
      case 'refueled': msg = `⛽ REFUEL −${e.cost}`; color = '#9bd0ff'; break;
      case 'upgraded': msg = `▲ UPGRADE ${(e.stat || '').toUpperCase()} L${e.level} −${e.cost}`; color = '#ffd14a'; break;
      case 'bought': msg = `+ BUY ${e.item} −${e.cost}`; color = '#ffc14a'; break;
      case 'death': msg = `✝ DIED ${e.reason || ''} −${depth}m`; color = '#ff6a6a'; break;
      case 'respawned': msg = 'respawn'; color = '#6a8aff'; break;
      case 'registered': msg = 'REGISTER'; color = '#7CFFB0'; break;
      case 'spawned': msg = `spawn ${e.x},${e.y}`; color = '#9bb0a4'; break;
      case 'surfaced': msg = `▲ SURFACE${e.amount ? ` +${e.amount}` : ''}`; color = '#ffec6e'; break;
      case 'exited': msg = 'EXIT'; color = '#9bb0a4'; break;
      case 'detonation': msg = `dynamite r${e.radius}`; color = '#ffae42'; break;
      default: return null;
    }
    return { t, name, msg, color };
  }

  renderConsole() {
    const body = document.getElementById('spec-console-body');
    if (!body) return;
    // Newest at top; older scroll off the bottom (no scrollbar needed).
    const rows = this.eventLog.slice(-90).reverse();
    body.innerHTML = rows.map((l) =>
      `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">` +
      `<span style="color:#3a6a4a">${l.hash}</span> ` +
      `<span style="color:#566">${l.t}s</span> ` +
      `<span style="color:#9bb0a4">${l.name}</span> ` +
      `<span style="color:${l.color}">${l.msg}</span></div>`,
    ).join('');
    const cnt = document.getElementById('spec-tx-count');
    if (cnt) cnt.textContent = `${this.txCount} tx`;
  }

  updateHUD() {
    if (!this.statsEl) return;
    const ms = this.rt.s.miners;
    const alive = ms.filter((m) => m.alive).length;
    const dug = ms.reduce((a, m) => a + m.stats.tilesDug, 0);
    const fps = Math.round(this.game.loop.actualFps);
    const fc = fps >= 55 ? '#7CFFB0' : fps >= 30 ? '#ffd14a' : '#ff6a6a';
    this.statsEl.innerHTML =
      `<span style="color:${fc}">${fps} fps</span>　` +
      `${(this.rt.timeMs / 1000).toFixed(0)}s　agents <b>${alive}/${ms.length}</b>　` +
      `dug <b>${dug}</b>　team <b style="color:#ffec6e">${this.rt.teamScore} VARA</b>` +
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
    this._tornDown = true;
    this.rt?.dispose?.();
    this.loadingText?.destroy();
    clearTimeout(this._agentBubbleTimer);
    document.getElementById('spec-hud')?.remove();
    document.getElementById('spec-finish')?.remove();
    document.getElementById('spec-console')?.remove();
    document.getElementById('spec-agent-bubble')?.remove();
  }
}
