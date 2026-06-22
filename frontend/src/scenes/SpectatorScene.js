import Phaser from 'phaser';
import { TILE, BLOCK, BLOCK_DATA, SURFACE_Y } from '../config.js';
import { getBlock } from '../world.js';
import GameScene from './GameScene.js';
import { GAME_MODES } from '../engine/index.js';
import { createWorldSource } from '../chain/source.js';
import { CHAIN, discoveryBaseUrl } from '../chain/config.js';
import { createSquad } from '../engine/agents.js';
import { drawRobot as drawSharedRobot } from '../render/robot.js';
import { generateAgentName } from '../agentNames.js';
import { backendEnabled, fetchAgentStats } from '../backend/api.js';
import { btnCss, wireBtn } from './arenaUI.js';
import { navigateBack } from '../router.js';

// Live spectator. Extends GameScene to REUSE the real game rendering (tiles,
// ore, shop, robot models) at 1:1 scale, but drives a CONTINUOUS real-time
// world (engine/realtime.js) — no ticks. Each character moves/digs/falls over
// real durations with smooth interpolation; the agent is polled when its
// character goes idle. Free-scroll camera; a speed control scales real time.
const FUSE_MS = 4000; // must match realtime.js DYNAMITE_FUSE_MS (for the fuse animation)
const CHUNK_TILES = 8;
const RENDER_MODES = new Set(['chunks', 'viewport', 'full']);
const CHEST_OUTCOME = { DYNAMITE: 1, LADDERS: 2 };

function sfxSources(name) {
  return [`/assets/sfx/${name}.mp3`, `/assets/sfx/${name}.ogg`, `/assets/sfx/${name}.wav`];
}

const SFX = {
  DRILL: 'spec-rock-drill',
  BREAK: 'spec-rock-break',
  DRILL_FAIL: 'spec-drill-fail',
  ORE_CASH: 'spec-ore-cash',
  ROBOT_CHIRP: 'spec-robot-chirp',
  ROBOT_QUESTION: 'spec-robot-question',
  ROBOT_SAD: 'spec-robot-sad',
  LADDER: 'spec-ladder-place',
  FUSE: 'spec-dynamite-fuse',
  BOOM: 'spec-dynamite-boom',
  SHAKE: 'spec-rock-shake',
  IMPACT: 'spec-rock-impact',
};

const SFX_ASSETS = [
  [SFX.DRILL, sfxSources('rock-drill-generated'), { instances: 2 }],
  [SFX.BREAK, sfxSources('rock-break'), { instances: 8 }],
  [SFX.DRILL_FAIL, sfxSources('drill-fail'), { instances: 4 }],
  [SFX.ORE_CASH, sfxSources('ore-cash'), { instances: 6 }],
  [SFX.ROBOT_CHIRP, sfxSources('robot-chirp'), { instances: 3 }],
  [SFX.ROBOT_QUESTION, sfxSources('robot-question'), { instances: 3 }],
  [SFX.ROBOT_SAD, sfxSources('robot-sad'), { instances: 4 }],
  [SFX.LADDER, sfxSources('ladder-place'), { instances: 6 }],
  [SFX.FUSE, sfxSources('dynamite-fuse'), { instances: 2 }],
  [SFX.BOOM, sfxSources('dynamite-boom'), { instances: 4 }],
  [SFX.SHAKE, sfxSources('rock-shake'), { instances: 2 }],
  [SFX.IMPACT, sfxSources('rock-impact'), { instances: 6 }],
];

const SPATIAL_AUDIO = {
  nearTiles: 5,
  maxTiles: 32,
  offscreenMultiplier: 0.34,
  minVolume: 0.035,
};

const SFX_FRAME_LIMIT = {
  [SFX.BREAK]: 5,
  [SFX.ORE_CASH]: 4,
  [SFX.LADDER]: 4,
  [SFX.BOOM]: 2,
  [SFX.ROBOT_SAD]: 3,
  [SFX.IMPACT]: 4,
};

function formatClock(ms) {
  if (!Number.isFinite(ms)) return 'waiting';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')} left`;
}

function normalizeWorldStatus(metaStatus, rt) {
  const chainStatus = Number(rt?.session?.[2]);
  if (chainStatus === 1) return 'active';
  if (chainStatus === 2) return 'archived';
  if (chainStatus === 0) return 'open';

  const value = String(metaStatus || '').toLowerCase();
  if (['active', 'running', 'in_game'].includes(value)) return 'active';
  if (['finished', 'archived', 'retired'].includes(value)) return 'archived';
  if (['open', 'waiting_agents', 'map_ready', 'deployed'].includes(value)) return 'open';
  return value || 'unknown';
}

function statusLabel(status) {
  switch (status) {
    case 'active': return 'IN GAME';
    case 'open': return 'REGISTRATION';
    case 'archived': return 'ARCHIVE';
    case 'configured': return 'CONFIGURED';
    default: return status ? status.toUpperCase().slice(0, 14) : 'UNKNOWN';
  }
}

function hudStateLabel(status, remainingMs) {
  if (status === 'archived') return statusLabel(status);
  if (Number.isFinite(remainingMs)) {
    return `${statusLabel(status)} · ${formatClock(remainingMs)}`;
  }
  return statusLabel(status);
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sameDisplayAddress(a, b) {
  const left = displayAddress(a).toLowerCase();
  const right = displayAddress(b).toLowerCase();
  return Boolean(left && right && left === right);
}

function agentStatusMeta(status) {
  switch (Number(status)) {
    case 1: return { color: '#36c96c', label: 'alive' };
    case 2: return { color: '#58a6ff', label: 'surfaced' };
    case 3: return { color: '#d13c3c', label: 'dead' };
    case 4: return { color: '#9aa1aa', label: 'exited' };
    default: return { color: '#9aa1aa', label: 'unknown' };
  }
}

function addressScanUrl(address) {
  const addr = displayAddress(address);
  return addr ? `https://hoodi.etherscan.io/address/${addr}` : '#';
}

const BANK_RESOURCE_LABELS = {
  scrst: { label: 'SCRST', color: '#8fe9ff' },
  bcrst: { label: 'BCRST', color: '#9bffbf' },
  hcrst: { label: 'HCRST', color: '#ff8fdc' },
};

function squadCounts(n) {
  const kinds = ['shuttle', 'prospector', 'deepdiver', 'shuttle', 'prospector'];
  const c = {};
  for (let i = 0; i < n; i++) { const k = kinds[i % kinds.length]; c[k] = (c[k] || 0) + 1; }
  return c;
}

export default class SpectatorScene extends GameScene {
  constructor() { super('Spectator'); }

  preload() {
    // Live worlds render tiles procedurally, but they still need the arcade sfx.
    // Load only files that exist in public/assets/sfx so direct /world entries
    // sound the same as entering through the original game/menu.
    for (const [key, url, config] of SFX_ASSETS) {
      if (!this.cache.audio.exists(key)) this.load.audio(key, url, config);
    }
  }

  init(data) {
    this.specMode = data?.mode || 'coop-gem';
    this.specSeed = data?.seed ?? 1234;
    this.specProgramId = data?.programId || '';
    this.specArchiveId = data?.archiveId || '';
    this.specArchiveUrl = data?.archiveUrl || '';
    this.isArchiveReplay = Boolean(this.specArchiveId || this.specMode === 'chain-replay');
    this.backTo = data?.backTo || 'Lobby';
    this.worldMeta = null;
    this.worldMetaPollMs = 0;
    this.agentNameMap = new Map();
    this.agentNamePollMs = 0;
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
      mode: this.specMode,
      programId: this.specProgramId,
      archiveId: this.specArchiveId,
      archiveUrl: this.specArchiveUrl,
      spec: this.mode.spec,
      spawn: this.mode.spawn,
      victory: this.mode.victory,
      safeFall: 3, // same as single-player: a >3-tile fall hurts/kills
      miners: this.bots.map((b) => ({ name: b.name, hat: b.hat, color: b.color, items: b.items || undefined, radar: b.radar, maxLadders: b.maxLadders })),
    });
    this.rt.setAgents(this.bots.map((b) => b.decide));
    this.refreshAgentNames();
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
    // Chain spectator worlds should show only contract-relevant objects.
    // Surface sell markers from the local arcade mode are intentionally hidden.
    this.totemSpots = [];

    this.frameGfx = this.add.graphics(); this.frameGfx.setDepth(0);
    this.worldGfx = this.add.graphics(); this.worldGfx.setDepth(1);
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
    cam.setBounds(-TILE, 0, (this.world.W + 2) * TILE, (this.world.H + 1) * TILE);
    cam.setBackgroundColor('#4a7bbf');
    cam.setRoundPixels(true);
    cam.setZoom(1);
    cam.centerOn(this.rt.match.shopX * TILE, (this.world.surface + 7) * TILE);
    const requestedRenderMode = String(CHAIN.renderMode || 'chunks').toLowerCase();
    this.worldRenderMode = RENDER_MODES.has(requestedRenderMode) ? requestedRenderMode : 'chunks';
    this.fullWorldRender = this.worldRenderMode === 'full';
    this.worldRenderPadPx = this.worldRenderMode === 'viewport' ? TILE * 12 : 0;
    this.forceProceduralTiles = this.worldRenderMode === 'chunks';
    this._chunks = null;
    this._dirtyChunks = null;
    this._lastChunkGrid = null;
    this._frameDrawSignature = null;

    this.setupSpectatorSounds();
    this.setupCameraControls();
    this.statsTimer = 0;
    this.worldDirty = true;
    this.buildHUD();
    this.refreshWorldMeta();
    this.scale.on('resize', this.onSpecResize, this);
  }

  makeSound(key, config = {}) {
    return this.cache.audio.exists(key) ? this.sound.add(key, config) : null;
  }

  makeSoundPool(key, size, config = {}) {
    const pool = [];
    for (let i = 0; i < size; i += 1) {
      const sound = this.makeSound(key, config);
      if (sound) pool.push(sound);
    }
    return pool;
  }

  setupSpectatorSounds() {
    this.applySpectatorVolume(this.readStoredVolume(), { persist: false });
    this.installSpectatorAudioUnlock();
    this.drillLoop = this.makeSound(SFX.DRILL, { loop: true, volume: 0 });
    this.fuseLoop = this.makeSound(SFX.FUSE, { loop: true, volume: 0 });
    this.shakeLoop = this.makeSound(SFX.SHAKE, { loop: true, volume: 0 });

    this.soundPools = {
      [SFX.BREAK]: this.makeSoundPool(SFX.BREAK, 6, { volume: 0.7 }),
      [SFX.DRILL_FAIL]: this.makeSoundPool(SFX.DRILL_FAIL, 3, { volume: 0.68 }),
      [SFX.ORE_CASH]: this.makeSoundPool(SFX.ORE_CASH, 5, { volume: 0.55 }),
      [SFX.ROBOT_SAD]: this.makeSoundPool(SFX.ROBOT_SAD, 3, { volume: 0.42 }),
      [SFX.LADDER]: this.makeSoundPool(SFX.LADDER, 5, { volume: 0.55 }),
      [SFX.BOOM]: this.makeSoundPool(SFX.BOOM, 3, { volume: 0.85 }),
      [SFX.IMPACT]: this.makeSoundPool(SFX.IMPACT, 5, { volume: 0.72 }),
    };

    this.robotChirpSound = this.makeSound(SFX.ROBOT_CHIRP, { volume: 0.42 });
    this.robotQuestionSound = this.makeSound(SFX.ROBOT_QUESTION, { volume: 0.42 });
    this.robotTouchSounds = [this.robotChirpSound, this.robotQuestionSound].filter(Boolean);
    this.spectatorSounds = [
      this.drillLoop,
      this.robotChirpSound,
      this.robotQuestionSound,
      this.fuseLoop,
      this.shakeLoop,
      ...Object.values(this.soundPools).flat(),
    ].filter(Boolean);
    this._lastStoneSoundCount = 0;
    this._pendingSfx = [];
    this._drillLevel = 0;
    this._fuseLevel = 0;
    this._shakeLevel = 0;
  }

  installSpectatorAudioUnlock() {
    if (this._audioUnlockHandler) return;
    this._audioUnlockHandler = () => this.unlockSpectatorAudio();
    for (const eventName of ['pointerdown', 'click', 'touchstart', 'keydown', 'focus']) {
      window.addEventListener(eventName, this._audioUnlockHandler, { passive: true });
    }
    this.input?.on?.('pointerdown', this._audioUnlockHandler);
  }

  unlockSpectatorAudio() {
    const manager = this.game?.sound || this.sound;
    if (!manager) return;
    try { manager.unlock?.(); } catch { /* Phaser sound manager differs by backend. */ }
    const context = manager.context || this.sound?.context;
    if (context?.state === 'suspended') {
      context.resume?.().catch?.(() => {});
    }
    if ((this._volume ?? 1) > 0) manager.mute = false;
  }

  readStoredVolume() {
    try {
      const value = Number.parseFloat(localStorage.getItem('robo.volume'));
      return Number.isFinite(value) ? Phaser.Math.Clamp(value, 0, 1) : 1;
    } catch {
      return 1;
    }
  }

  applySpectatorVolume(volume, options = {}) {
    const next = Phaser.Math.Clamp(Number(volume) || 0, 0, 1);
    this._volume = next;
    this.game.sound.volume = next;
    this.game.sound.mute = next === 0;
    if (options.persist !== false) {
      try { localStorage.setItem('robo.volume', String(next)); } catch { /* noop */ }
    }
    this.refreshSoundButton();
  }

  cycleSpectatorVolume() {
    const current = this._volume ?? this.game.sound.volume ?? 1;
    let next;
    if (current > 0.85) next = 0.66;
    else if (current > 0.5) next = 0.33;
    else if (current > 0) next = 0;
    else next = 1;
    this.applySpectatorVolume(next);
    this.unlockSpectatorAudio();
    if (next > 0) this.playAgentChirp();
  }

  refreshSoundButton() {
    if (!this.soundBtn) return;
    const volume = this._volume ?? this.game.sound.volume ?? 1;
    const bars = volume === 0 ? 0 : (volume <= 0.4 ? 1 : volume <= 0.75 ? 2 : 3);
    const muted = volume === 0;
    this.soundBtn.title = muted ? 'Sound: muted' : `Sound: ${bars}/3`;
    this.soundBtn.setAttribute('aria-label', this.soundBtn.title);
    this.soundBtn.style.filter = muted ? 'grayscale(1) brightness(.86)' : '';
    this.soundBtn.innerHTML = `
      <svg viewBox="0 0 32 32" width="26" height="26" style="display:block" aria-hidden="true">
        <path d="M5,12 L11,12 L18,7 L18,25 L11,20 L5,20 Z"
          fill="#222" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
        ${bars >= 1 ? '<path d="M21,13 Q23,16 21,19" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        ${bars >= 2 ? '<path d="M24,11 Q27,16 24,21" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        ${bars >= 3 ? '<path d="M27,9  Q31,16 27,23" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        ${muted ? '<line x1="6" y1="26" x2="28" y2="6" stroke="#e23a4f" stroke-width="3" stroke-linecap="round"/>' : ''}
      </svg>
    `;
  }

  drawVisualFrame() {
    const world = this.world;
    if (!world) return;
    const signature = `${world.W}:${world.H}:${world.surface}:${world.model}`;
    if (this._frameDrawSignature === signature) return;
    this._frameDrawSignature = signature;
    super.drawVisualFrame();
  }

  drawWorld() {
    if (this.worldRenderMode !== 'chunks') {
      super.drawWorld();
      return;
    }

    this.drawVisualFrame();
    this._ensureChunkRenderer();
    this._markChangedChunks();
    this._markAnimatedStoneChunks();
    this._refreshChunkVisibility();
  }

  _ensureChunkRenderer() {
    if (this._chunks && this._chunkWorld === this.world) return;
    this.worldGfx?.clear();
    this._chunkWorld = this.world;
    this._chunks = new Map();
    this._dirtyChunks = new Set();
    this._lastChunkGrid = this.world?.grid?.slice?.() || null;
    this._chunkCols = Math.ceil((this.world?.W || 0) / CHUNK_TILES);
    this._chunkRows = Math.ceil((this.world?.H || 0) / CHUNK_TILES);
    for (let cy = 0; cy < this._chunkRows; cy += 1) {
      for (let cx = 0; cx < this._chunkCols; cx += 1) {
        this._dirtyChunks.add(this._chunkKey(cx, cy));
      }
    }
  }

  _chunkKey(cx, cy) {
    return `${cx}:${cy}`;
  }

  _markChunkForTile(x, y) {
    if (!this._dirtyChunks || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    if (cx < 0 || cy < 0 || cx >= this._chunkCols || cy >= this._chunkRows) return;
    this._dirtyChunks.add(this._chunkKey(cx, cy));
  }

  _markChangedChunks() {
    const grid = this.world?.grid;
    if (!grid) return;
    if (!this._lastChunkGrid || this._lastChunkGrid.length !== grid.length) {
      this._lastChunkGrid = grid.slice();
      for (let cy = 0; cy < this._chunkRows; cy += 1) {
        for (let cx = 0; cx < this._chunkCols; cx += 1) this._dirtyChunks.add(this._chunkKey(cx, cy));
      }
      return;
    }

    const W = this.world.W;
    for (let i = 0; i < grid.length; i += 1) {
      if (grid[i] === this._lastChunkGrid[i]) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      for (let yy = y - 1; yy <= y + 1; yy += 1) {
        for (let xx = x - 1; xx <= x + 1; xx += 1) this._markChunkForTile(xx, yy);
      }
      this._lastChunkGrid[i] = grid[i];
    }
  }

  _markAnimatedStoneChunks() {
    for (const stone of this.fallingStones || []) {
      this._markChunkForTile(stone.x, stone.y);
      this._markChunkForTile(stone.x, stone.y - 1);
      this._markChunkForTile(stone.x, stone.y + 1);
    }
  }

  _refreshChunkVisibility() {
    if (!this._chunks || !this.world) return;
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    const pad = TILE * 2;
    const leftPx = cam.scrollX - pad;
    const topPx = cam.scrollY - pad;
    const rightPx = cam.scrollX + cam.width / zoom + pad;
    const bottomPx = cam.scrollY + cam.height / zoom + pad;
    const left = Math.max(0, Math.floor(leftPx / TILE));
    const right = Math.min(this.world.W - 1, Math.floor(rightPx / TILE));
    const top = Math.max(0, Math.floor(topPx / TILE));
    const bottom = Math.min(this.world.H - 1, Math.floor(bottomPx / TILE));
    const minCx = Math.max(0, Math.floor(left / CHUNK_TILES));
    const maxCx = Math.min(this._chunkCols - 1, Math.floor(right / CHUNK_TILES));
    const minCy = Math.max(0, Math.floor(top / CHUNK_TILES));
    const maxCy = Math.min(this._chunkRows - 1, Math.floor(bottom / CHUNK_TILES));
    const visibleKeys = new Set();

    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const key = this._chunkKey(cx, cy);
        visibleKeys.add(key);
        const chunk = this._getChunk(cx, cy);
        chunk.g.setVisible(true);
        if (this._dirtyChunks.has(key) || !chunk.rendered) this._drawChunk(chunk);
      }
    }

    for (const [key, chunk] of this._chunks) {
      if (!visibleKeys.has(key)) chunk.g.setVisible(false);
    }
  }

  _getChunk(cx, cy) {
    const key = this._chunkKey(cx, cy);
    let chunk = this._chunks.get(key);
    if (!chunk) {
      const g = this.add.graphics();
      g.setDepth(1);
      chunk = {
        key,
        cx,
        cy,
        x0: cx * CHUNK_TILES,
        y0: cy * CHUNK_TILES,
        x1: Math.min(this.world.W, (cx + 1) * CHUNK_TILES),
        y1: Math.min(this.world.H, (cy + 1) * CHUNK_TILES),
        rendered: false,
        g,
      };
      this._chunks.set(key, chunk);
    }
    return chunk;
  }

  _drawChunk(chunk) {
    const g = chunk.g;
    g.clear();
    this._drawChunkBackground(g, chunk);
    for (let y = chunk.y0; y < chunk.y1; y += 1) {
      for (let x = chunk.x0; x < chunk.x1; x += 1) {
        const type = getBlock(this.world, x, y);
        if (type === BLOCK.SKY) continue;
        this.drawTile(g, x, y, type, BLOCK_DATA[type]);
      }
    }
    chunk.rendered = true;
    this._dirtyChunks.delete(chunk.key);
  }

  _drawChunkBackground(g, chunk) {
    const surfaceY = this.world?.surface ?? SURFACE_Y;
    const px = chunk.x0 * TILE;
    const py = chunk.y0 * TILE;
    const width = (chunk.x1 - chunk.x0) * TILE;
    const height = (chunk.y1 - chunk.y0) * TILE;
    const bottom = py + height;
    const surfacePx = surfaceY * TILE;

    const skyBottom = Math.min(bottom, surfacePx);
    if (skyBottom > py) {
      g.fillStyle(0x4a7bbf, 1);
      g.fillRect(px, py, width, skyBottom - py);
    }

    const dugTop = Math.max(py, surfacePx);
    if (bottom > dugTop) {
      g.fillStyle(0x3a2412, 1);
      g.fillRect(px, dugTop, width, bottom - dugTop);
      g.fillStyle(0x1f130a, 0.55);
      const step = 24;
      const startX = Math.floor(px / step) * step;
      const startY = Math.floor(dugTop / step) * step;
      for (let yy = startY; yy < bottom; yy += step) {
        for (let xx = startX; xx < px + width; xx += step) {
          const s = (xx * 73856093 ^ yy * 19349663) >>> 0;
          const ox = s % 10;
          const oy = (s >>> 8) % 10;
          const sz = 3 + ((s >>> 16) % 3);
          g.fillRect(xx + ox, yy + oy, sz, sz);
        }
      }
    }
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

  onSpecResize() {
    this.scene.restart({
      mode: this.specMode,
      seed: this.specSeed,
      programId: this.specProgramId,
      archiveId: this.specArchiveId,
      archiveUrl: this.specArchiveUrl,
    });
  }

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
      this._pendingSfx = [];
      for (const e of this.rt.events) {
        this.playSoundForEvent(e);
        if (e.type === 'dug') this.spawnDebris(e.x, e.y, e.block, 8);
        else if (e.type === 'detonation') {
          this.flashes.push({ x: e.x, y: e.y, maxR: (e.radius + 1) * TILE, life: 320, maxLife: 320 });
          this.spawnDebris(e.x, e.y, BLOCK.STONE, 16);
          this.cameras.main.shake(160, 0.004 * (e.radius + 1));
        }
        else if (e.type === 'sold' || e.type === 'surfaced') {
          this.spawnBankPop(e.owner || e.id, e.amount || 0, e.deltaBanked);
        }
        this.pushEvent(e);
      }
      this.flushQueuedSounds();
      if (this.rt.worldDirty) { this.worldDirty = true; this.rt.worldDirty = false; }
    }

    // Feed the realtime falling stones into the inherited drawTile so they get
    // the same wobble/jitter as single-player; keep redrawing while any wobble.
    this.fallingStones = this.rt.stones.map((s) => ({ x: s.x, y: s.y, state: s.phase }));
    this.updateContinuousSounds(dt);
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

    this.worldMetaPollMs += dt;
    if (this.worldMetaPollMs >= 5000) {
      this.worldMetaPollMs = 0;
      this.refreshWorldMeta();
    }
    this.agentNamePollMs += dt;
    if (this.agentNamePollMs >= 10000) {
      this.agentNamePollMs = 0;
      this.refreshAgentNames();
    }

    this.statsTimer += dt;
    if (this.statsTimer >= 200) {
      this.statsTimer = 0;
      this.updateHUD();
      if (this.rt.finished && !this.isArchiveReplay) this.showFinish();
    }
  }

  playSoundForEvent(e) {
    switch (e?.type) {
      case 'dug':
        this.queueSpatialSound(SFX.BREAK, e.x, e.y, { base: 0.7 });
        break;
      case 'resource_extracted':
        this.queueSpatialSound(SFX.ORE_CASH, e.x, e.y, { base: 0.55, nearTiles: 7, maxTiles: 36 });
        break;
      case 'chest_opened':
        if (e.outcome === CHEST_OUTCOME.LADDERS) {
          this.queueSpatialSound(SFX.LADDER, e.x, e.y, { base: 0.48, nearTiles: 7, maxTiles: 34 });
        }
        break;
      case 'ladder_placed':
        this.queueSpatialSound(SFX.LADDER, e.x, e.y, { base: 0.55 });
        break;
      case 'detonation':
        this.queueSpatialSound(SFX.BOOM, e.x, e.y, {
          base: Number(e.radius) >= 2 ? 1 : 0.85,
          nearTiles: 9,
          maxTiles: 54,
          minVolume: 0.05,
          priority: 2,
        });
        break;
      case 'death':
        this.queueSpatialSound(SFX.ROBOT_SAD, e.x, e.y, { base: 0.46, nearTiles: 7, maxTiles: 34, priority: 1 });
        break;
      case 'exited':
        this.queueSpatialSound(SFX.ROBOT_SAD, ...this.eventSoundTile(e), { base: 0.34, nearTiles: 7, maxTiles: 28 });
        break;
      case 'stone_moved':
        break;
      case 'stone_impact':
        this.queueSpatialSound(SFX.IMPACT, e.x, e.y, { base: 0.52, nearTiles: 6, maxTiles: 32, priority: 1 });
        break;
      default:
        break;
    }
  }

  eventSoundTile(e) {
    if (Number.isFinite(e?.x) && Number.isFinite(e?.y)) return [e.x, e.y];
    const miner = e?.owner
      ? this.rt?.s?.miners?.find((m) => m.owner && m.owner.toLowerCase() === e.owner.toLowerCase())
      : e?.id != null ? this.rt?.s?.miners?.find((m) => m.id === e.id) : null;
    return [miner?.drawX ?? miner?.tx ?? NaN, miner?.drawY ?? miner?.ty ?? NaN];
  }

  cameraCenterTile() {
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    return {
      x: (cam.scrollX + cam.width / zoom / 2) / TILE,
      y: (cam.scrollY + cam.height / zoom / 2) / TILE,
      left: cam.scrollX / TILE,
      top: cam.scrollY / TILE,
      right: (cam.scrollX + cam.width / zoom) / TILE,
      bottom: (cam.scrollY + cam.height / zoom) / TILE,
    };
  }

  spatialVolumeForTile(x, y, options = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return options.base ?? 0;
    const {
      base = 1,
      nearTiles = SPATIAL_AUDIO.nearTiles,
      maxTiles = SPATIAL_AUDIO.maxTiles,
      offscreenMultiplier = SPATIAL_AUDIO.offscreenMultiplier,
      minVolume = SPATIAL_AUDIO.minVolume,
    } = options;
    const view = this.cameraCenterTile();
    const dx = x + 0.5 - view.x;
    const dy = y + 0.5 - view.y;
    const distance = Math.hypot(dx, dy);
    const range = Math.max(1, maxTiles - nearTiles);
    let level = distance <= nearTiles ? 1 : 1 - ((distance - nearTiles) / range);
    level = Phaser.Math.Clamp(level, 0, 1);
    level = level * level * (3 - 2 * level);

    const pad = 2;
    const onscreen = x >= view.left - pad && x <= view.right + pad && y >= view.top - pad && y <= view.bottom + pad;
    if (!onscreen) level *= offscreenMultiplier;

    const volume = Phaser.Math.Clamp(base * level, 0, 1);
    return volume >= minVolume ? volume : 0;
  }

  aggregateSpatialVolumes(points, options = {}) {
    const volumes = points
      .map(([x, y]) => this.spatialVolumeForTile(x, y, options))
      .filter((v) => v > 0)
      .sort((a, b) => b - a)
      .slice(0, 4);
    let combined = 0;
    for (const volume of volumes) combined = 1 - ((1 - combined) * (1 - volume));
    return Phaser.Math.Clamp(combined, 0, options.cap ?? 1);
  }

  queueSpatialSound(key, x, y, options = {}) {
    const volume = this.spatialVolumeForTile(x, y, options);
    if (volume <= 0) return;
    this._pendingSfx ||= [];
    this._pendingSfx.push({
      key,
      volume,
      rate: options.rate,
      priority: (options.priority || 0) + volume,
    });
  }

  flushQueuedSounds() {
    if (!this._pendingSfx?.length) return;
    const counts = new Map();
    const events = this._pendingSfx.sort((a, b) => b.priority - a.priority);
    for (const event of events) {
      const limit = SFX_FRAME_LIMIT[event.key] || 4;
      const count = counts.get(event.key) || 0;
      if (count >= limit) continue;
      if (this.playPooledSound(event.key, { volume: event.volume, rate: event.rate })) {
        counts.set(event.key, count + 1);
      }
    }
    this._pendingSfx.length = 0;
  }

  playPooledSound(key, config = {}) {
    const pool = this.soundPools?.[key] || [];
    if (!pool.length) return false;
    this.unlockSpectatorAudio();
    const sound = pool.find((s) => !s.isPlaying);
    if (!sound) return false;
    sound.play({
      volume: Number.isFinite(config.volume) ? config.volume : 1,
      rate: config.rate || 1,
    });
    return true;
  }

  updateContinuousSounds(dt = 16) {
    const digPoints = (this.rt?.s?.miners || [])
      .filter((m) => m.alive && m.act?.kind === 'dig')
      .map((m) => [m.act.tx, m.act.ty]);
    const drillVolume = this.aggregateSpatialVolumes(digPoints, {
      base: 0.42,
      nearTiles: 6,
      maxTiles: 35,
      cap: 0.62,
    });
    this.updateLoopSound(this.drillLoop, '_drillLevel', drillVolume, dt);

    const stoneCount = this.rt?.stones?.length || 0;
    const fuseVolume = this.aggregateSpatialVolumes((this.rt?.bombs || []).map((b) => [b.x, b.y]), {
      base: 0.43,
      nearTiles: 7,
      maxTiles: 38,
      cap: 0.48,
    });
    this.updateLoopSound(this.fuseLoop, '_fuseLevel', fuseVolume, dt);

    const shakeVolume = this.aggregateSpatialVolumes((this.rt?.stones || [])
      .filter((s) => s.phase === 'shake')
      .map((s) => [s.x, s.y]), {
      base: 0.38,
      nearTiles: 6,
      maxTiles: 32,
      cap: 0.44,
    });
    this.updateLoopSound(this.shakeLoop, '_shakeLevel', shakeVolume, dt);

    this._lastStoneSoundCount = stoneCount;
  }

  nearestCameraTile() {
    const view = this.cameraCenterTile();
    return [Math.round(view.x), Math.round(view.y)];
  }

  updateLoopSound(sound, field, targetVolume, dt) {
    if (!sound) return;
    const current = this[field] || 0;
    const attackMs = 120;
    const releaseMs = 280;
    const ms = targetVolume > current ? attackMs : releaseMs;
    const alpha = 1 - Math.exp(-Math.max(0, dt) / ms);
    const next = current + (targetVolume - current) * alpha;
    this[field] = next;

    if (next > 0.035) {
      this.unlockSpectatorAudio();
      if (!sound.isPlaying) sound.play({ volume: next });
      else sound.setVolume(next);
    } else if (sound.isPlaying) {
      sound.stop();
    }
  }

  startDrillSound(volume = 0.42) {
    if (!this.drillLoop) return;
    this.unlockSpectatorAudio();
    this.drillLoop.setVolume?.(volume);
    if (!this.drillLoop.isPlaying) this.drillLoop.play({ volume });
  }

  stopDrillSound() {
    if (!this.drillLoop || !this.drillLoop.isPlaying) return;
    this.drillLoop.stop();
  }

  playBreakSound() {
    this.playPooledSound(SFX.BREAK, { volume: 0.7 });
  }

  playOreCashSound() {
    this.playPooledSound(SFX.ORE_CASH, { volume: 0.55 });
  }

  playRobotSadSound() {
    this.playPooledSound(SFX.ROBOT_SAD, { volume: 0.42 });
  }

  playLadderPlaceSound() {
    this.playPooledSound(SFX.LADDER, { volume: 0.55 });
  }

  playBoomSound(radius = 1) {
    this.playPooledSound(SFX.BOOM, { volume: Number(radius) >= 2 ? 1 : 0.85 });
  }

  playRockImpact() {
    this.playPooledSound(SFX.IMPACT, {
      volume: 0.66 + Math.random() * 0.14,
      rate: 0.92 + Math.random() * 0.16,
    });
  }

  teardownSpectatorSounds() {
    if (this._audioUnlockHandler) {
      for (const eventName of ['pointerdown', 'click', 'touchstart', 'keydown', 'focus']) {
        window.removeEventListener(eventName, this._audioUnlockHandler);
      }
      this.input?.off?.('pointerdown', this._audioUnlockHandler);
      this._audioUnlockHandler = null;
    }
    for (const sound of this.spectatorSounds || []) {
      if (sound.isPlaying) sound.stop();
      sound.destroy?.();
    }
    this.spectatorSounds = [];
    this.robotTouchSounds = [];
    this.soundPools = {};
    this._pendingSfx = [];
    this.drillLoop = null;
    this.robotChirpSound = null;
    this.robotQuestionSound = null;
    this.fuseLoop = null;
    this.shakeLoop = null;
    this._drillLevel = 0;
    this._fuseLevel = 0;
    this._shakeLevel = 0;
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
    this.sayAgentBubble(agent, 6200);
    this.refreshAgentBubbleDetails(agent);
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
    this.unlockSpectatorAudio();
    for (const sound of sounds) sound.stop();
    sounds[Math.floor(Math.random() * sounds.length)].play();
  }

  sayAgentBubble(agent, ms = 2200) {
    if (!this.agentBubbleEl || !agent) return;
    const address = displayAddress(agent.owner);
    if (this.agentBubbleContentEl) {
      this.agentBubbleContentEl.innerHTML = this.agentBubbleHtml(agent, null);
    }
    this.agentBubbleEl.title = address;
    this.agentBubbleEl.style.display = 'block';
    this.agentBubbleMiner = agent;
    this.positionAgentBubble();
    clearTimeout(this._agentBubbleTimer);
    this._agentBubbleTimer = setTimeout(() => this.hideAgentBubble(), ms);
  }

  async refreshAgentBubbleDetails(agent) {
    if (!agent?.owner || typeof this.rt?.inspectAgent !== 'function') return;
    const requestId = (this._agentInspectRequestId || 0) + 1;
    this._agentInspectRequestId = requestId;
    try {
      const detail = await this.rt.inspectAgent(agent.owner);
      if (this._agentInspectRequestId !== requestId) return;
      if (!this.agentBubbleMiner || !sameDisplayAddress(this.agentBubbleMiner.owner, agent.owner)) return;
      if (this.agentBubbleContentEl) {
        this.agentBubbleContentEl.innerHTML = this.agentBubbleHtml(this.agentBubbleMiner, detail);
      }
      this.positionAgentBubble();
    } catch {
      // Snapshot data is enough for the bubble; a missed query should not make
      // the click feel broken.
    }
  }

  agentBubbleHtml(agent, detail = null) {
    const state = Array.isArray(detail?.state) ? detail.state : [];
    const inv = Array.isArray(detail?.inventory) ? detail.inventory : agent.inventory || [];
    const statusCode = Number(state[0] ?? agent.status ?? 1);
    const status = agentStatusMeta(statusCode);
    const x = Number(state[1] ?? agent.tx ?? 0);
    const y = Number(state[2] ?? agent.ty ?? 0);
    const ladders = Number(state[4] ?? agent.items?.ladder ?? 0);
    const capacity = Number(state[11] ?? agent.backpackCapacity ?? agent.maxCargo ?? 0);
    const carried = {
      scrst: Number(inv[0] ?? state[5] ?? 0),
      bcrst: Number(inv[1] ?? state[6] ?? 0),
      hcrst: Number(inv[2] ?? state[7] ?? 0),
    };
    const cargo = carried.scrst + carried.bcrst + carried.hcrst;
    const address = displayAddress(agent.owner);
    const agentName = this.agentDisplayName(agent);
    const wallet = detail?.walletOwner ? displayAddress(detail.walletOwner) : '';
    const walletRow = wallet && wallet.toLowerCase() !== address.toLowerCase()
      ? `<div style="opacity:.72;overflow:hidden;text-overflow:ellipsis">${miniIcon('owner')} ${escapeHtml(shortAddress(wallet))}</div>`
      : '';
    function miniIcon(kind, color = '#333') {
      const base = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:14px;vertical-align:-2px;margin-right:3px;position:relative;box-sizing:border-box';
      if (kind === 'status') {
        return `<span style="${base}"><span style="width:9px;height:9px;border:1px solid #17313a;border-radius:50%;background:${color};display:block"></span></span>`;
      }
      if (kind === 'pos') {
        return `<span style="${base}"><span style="position:absolute;left:7px;top:2px;width:2px;height:10px;background:#5b4127"></span><span style="position:absolute;left:3px;top:6px;width:10px;height:2px;background:#5b4127"></span></span>`;
      }
      if (kind === 'ladder') {
        return `<span style="${base}"><span style="position:absolute;left:4px;top:1px;width:2px;height:12px;background:#9a6229"></span><span style="position:absolute;right:4px;top:1px;width:2px;height:12px;background:#9a6229"></span><span style="position:absolute;left:4px;top:3px;width:8px;height:2px;background:#d59a48"></span><span style="position:absolute;left:4px;top:7px;width:8px;height:2px;background:#d59a48"></span><span style="position:absolute;left:4px;top:11px;width:8px;height:2px;background:#d59a48"></span></span>`;
      }
      if (kind === 'bag') {
        return `<span style="${base}"><span style="position:absolute;left:4px;top:5px;width:9px;height:7px;border:1px solid #3b2a18;background:#b9823a"></span><span style="position:absolute;left:6px;top:2px;width:5px;height:4px;border:1px solid #3b2a18;border-bottom:0;border-radius:4px 4px 0 0"></span></span>`;
      }
      if (kind === 'mine') {
        return `<span style="${base}"><span style="position:absolute;left:4px;top:3px;width:9px;height:2px;background:#4a3624;transform:rotate(-35deg)"></span><span style="position:absolute;left:8px;top:4px;width:2px;height:9px;background:#7a5731;transform:rotate(25deg)"></span></span>`;
      }
      if (kind === 'owner') {
        return `<span style="${base};margin-right:2px"><span style="position:absolute;left:5px;top:1px;width:6px;height:6px;border:1px solid #444;border-radius:50%;background:#ddd"></span><span style="position:absolute;left:3px;top:8px;width:10px;height:5px;border:1px solid #444;background:#ddd"></span></span>`;
      }
      return '';
    }
    const crystal = (color, title, value) =>
      `<span title="${title}" style="display:inline-flex;align-items:center;gap:4px;margin-right:7px">` +
      `<span style="width:8px;height:8px;background:${color};border:1px solid #17313a;transform:rotate(45deg);display:inline-block"></span>${value}</span>`;
    const crystalRow = (resources) =>
      `${crystal('#47d7ff', 'blue crystal', resources.scrst)} ` +
      `${crystal('#61e889', 'green crystal', resources.bcrst)} ` +
      `${crystal('#c06bff', 'purple crystal', resources.hcrst)}`;
    return `
      <div style="line-height:1.2">
        <b>${escapeHtml(agentName)}</b>
        <a href="${escapeHtml(addressScanUrl(agent.owner))}" target="_blank" rel="noreferrer"
          title="${escapeHtml(address)}" style="display:block;margin-top:2px;color:#0b57d0;text-decoration:none;font-size:12px">${escapeHtml(shortAddress(agent.owner))}</a>
      </div>
      <div style="margin-top:6px;font-size:12px;line-height:1.45;color:#333">
        <div><b>${miniIcon('status', status.color)}${escapeHtml(status.label)}</b> · ${miniIcon('pos')}${x},${y}</div>
        <div>${miniIcon('ladder')}<b>${ladders}</b> · ${miniIcon('bag')}<b>${cargo}/${capacity}</b></div>
        <div title="carried crystals">${miniIcon('mine')}${crystalRow(carried)}</div>
        ${walletRow}
      </div>`;
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
    if (this.worldRenderMode === 'chunks') {
      this._refreshChunkVisibility();
      return false;
    }
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

  // A digger surfaced and banked its crystals → float the brought resources
  // over that agent. This is visual feedback for AgentSurfaced, not a tx.
  spawnBankPop(ref, amount, resources = null) {
    if (!amount) return;
    const m = this.rt.s.miners.find((x) => x.id === ref || sameDisplayAddress(x.owner, ref));
    if (!m) return;
    this.queueSpatialSound(SFX.ORE_CASH, m.drawX ?? m.tx, m.drawY ?? m.ty, {
      base: 0.58,
      nearTiles: 8,
      maxTiles: 38,
      priority: 1,
      rate: 1.06,
    });

    const x = ((Number.isFinite(m.drawX) ? m.drawX : m.tx) + 0.5) * TILE;
    const y = ((Number.isFinite(m.drawY) ? m.drawY : m.ty) - 0.2) * TILE;
    const entries = resources
      ? Object.entries(resources).filter(([, count]) => Number(count) > 0)
      : [];

    if (entries.length) {
      entries.forEach(([key, count], index) => {
        const meta = BANK_RESOURCE_LABELS[key] || { label: key.toUpperCase(), color: '#ffec6e' };
        const t = this.add.text(x, y - index * 18, `+${count} ${meta.label}`, {
          fontFamily: 'Courier New, monospace', fontSize: '15px', color: meta.color,
          stroke: '#06131b', strokeThickness: 4, fontStyle: 'bold',
        }).setOrigin(0.5, 1).setDepth(8);
        this.bankPops.push({ t, age: -index * 90, life: 1350 });
      });
      return;
    }

    const t = this.add.text(x, y, `+${amount}`, {
      fontFamily: 'Courier New, monospace', fontSize: '15px', color: '#ffec6e',
      stroke: '#3b2600', strokeThickness: 4, fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(8);
    this.bankPops.push({ t, age: 0, life: 1300 });
  }

  updateBankPops(dt) {
    if (!this.bankPops) return;
    for (let i = this.bankPops.length - 1; i >= 0; i--) {
      const p = this.bankPops[i];
      p.age += dt;
      if (p.age < 0) {
        p.t.setAlpha(0);
        continue;
      }
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

    const soundBtn = wireBtn(document.createElement('button'));
    soundBtn.id = 'spec-soundbtn';
    soundBtn.title = 'Sound';
    soundBtn.style.cssText = btnCss('#ffdd55') + 'width:42px;height:34px;padding:0;margin-left:14px;display:flex;align-items:center;justify-content:center;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
    soundBtn.onclick = () => this.cycleSpectatorVolume();
    bar.appendChild(soundBtn);
    this.soundBtn = soundBtn;
    this.refreshSoundButton();

    // On-chain TX-log toggle (terminal-style side console).
    const logBtn = wireBtn(document.createElement('button'));
    logBtn.id = 'spec-logbtn';
    logBtn.textContent = '⛓ TX LOG';
    logBtn.style.cssText = btnCss('#7CFFB0') + 'font-size:13px;padding:6px 12px;box-shadow:2px 2px 0 rgba(0,0,0,.35)';
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
      white-space: normal; pointer-events: auto; z-index: 18;
      display: none; min-width: 210px; max-width: 280px;
    `;
    bubble.innerHTML = `<div id="spec-agent-bubble-content"></div>
      <div style="position:absolute;bottom:-8px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;
        border-top:8px solid #222;pointer-events:none"></div>
      <div style="position:absolute;bottom:-5px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
        border-top:6px solid #fff;pointer-events:none"></div>`;
    document.body.appendChild(bubble);
    this.agentBubbleEl = bubble;
    this.agentBubbleContentEl = bubble.querySelector('#spec-agent-bubble-content');
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
      <div id="spec-console-body" style="flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 9px;
        scrollbar-width:thin;scrollbar-color:#2f6a3f rgba(0,0,0,.18);
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

  // Turn an engine event into a console line {hash,t,name,address,msg,color}; null = skip.
  pushEvent(e) {
    const line = this.formatEvent(e);
    if (!line) return;
    this.txCount++;
    line.hash = '0x' + ((0x9e3779b1 * this.txCount) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
    this.eventLog.push(line);
    if (this.eventLog.length > 220) this.eventLog.splice(0, this.eventLog.length - 220);
    const cnt = document.getElementById('spec-tx-count');
    if (cnt) cnt.textContent = `${this.txCount} tx`;
  }

  formatEvent(e) {
    const miner = e.owner
      ? this.rt.s.miners.find((m) => m.owner && m.owner.toLowerCase() === e.owner.toLowerCase())
      : e.id != null ? this.rt.s.miners.find((m) => m.id === e.id) : null;
    const owner = e.owner || miner?.owner || '';
    const name = owner
      ? this.agentDisplayName({ ...miner, owner })
      : (miner?.name || (e.id != null ? `agent-${e.id}` : 'world')).slice(0, 12);
    const address = owner ? shortAddress(owner) : '';
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
      case 'chest_opened':
        if (e.outcome === CHEST_OUTCOME.DYNAMITE) {
          msg = `CHEST · DYNAMITE −${depth}m`;
          color = '#ff7a1f';
        } else {
          msg = `CHEST · ladders ${e.laddersRemaining ?? '?'}`;
          color = '#ffdd55';
        }
        break;
      case 'ladder_placed': msg = `place_ladder −${depth}m`; color = '#b9823c'; break;
      case 'resources_traded_for_ladders':
        msg = `TRADE → +${e.laddersAdded || 0} ladders`;
        color = '#ffdd55';
        break;
      case 'stone_moved': msg = `stone ${e.fromX},${e.fromY} → ${e.x},${e.y}`; color = '#a9a9a9'; break;
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
      case 'chain_gap': msg = 'SYNC GAP · SNAPSHOT'; color = '#ffae42'; break;
      case 'chain_error': msg = `CHAIN ${e.message || 'ERROR'}`; color = '#ff6a6a'; break;
      default: return null;
    }
    return { t, name, address, msg, color };
  }

  renderConsole() {
    const body = document.getElementById('spec-console-body');
    if (!body) return;
    const keepTop = body.scrollTop < 4;
    const previousScroll = body.scrollTop;
    const rows = this.eventLog.slice(-90).reverse();
    body.innerHTML = rows.map((l) =>
      `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">` +
      `<span style="color:#3a6a4a">${l.hash}</span> ` +
      `<span style="color:#566">${l.t}s</span> ` +
      `<span style="color:#cdd3da">${escapeHtml(l.name)}</span>` +
      `${l.address ? ` <span style="color:#586a61">${escapeHtml(l.address)}</span>` : ''} ` +
      `<span style="color:${l.color}">${l.msg}</span></div>`,
    ).join('');
    body.scrollTop = keepTop ? 0 : previousScroll;
    const cnt = document.getElementById('spec-tx-count');
    if (cnt) cnt.textContent = `${this.txCount} tx`;
  }

  updateHUD() {
    if (!this.statsEl) return;
    const ms = this.rt.s.miners;
    const alive = ms.filter((m) => m.alive).length;
    const maxAgents = Number(this.worldMeta?.maxAgents || this.mode.miners || ms.length || 10);
    const currentAgents = Number(this.worldMeta?.agents ?? ms.length);
    const status = normalizeWorldStatus(this.worldMeta?.status, this.rt);
    const countLabel = status === 'active'
      ? `${alive}/${maxAgents}`
      : `${currentAgents}/${maxAgents}`;
    const remainingMs = Number(this.worldMeta?.endsAt || 0) > 0
      ? Number(this.worldMeta.endsAt) - Date.now()
      : NaN;
    const stateLabel = hudStateLabel(status, remainingMs);
    const banked = ms.reduce((totals, m) => {
      totals.scrst += Number(m.bankedResources?.scrst || 0);
      totals.bcrst += Number(m.bankedResources?.bcrst || 0);
      totals.hcrst += Number(m.bankedResources?.hcrst || 0);
      return totals;
    }, { scrst: 0, bcrst: 0, hcrst: 0 });
    const fps = Math.round(this.game.loop.actualFps);
    const fc = fps >= 55 ? '#7CFFB0' : fps >= 30 ? '#ffd14a' : '#ff6a6a';
    this.statsEl.innerHTML =
      `<span style="color:${fc}">${fps} fps</span>　` +
      `${stateLabel}　agents <b>${countLabel}</b>　` +
      `SCRST <b>${banked.scrst}</b> · BCRST <b>${banked.bcrst}</b> · HCRST <b>${banked.hcrst}</b>` +
      (this.rt.match.diamondFound ? '　<b style="color:#5ff6ff">💎</b>' : '');
  }

  async refreshWorldMeta() {
    if (this.specArchiveId && this.rt?.archive) {
      this.worldMeta = {
        ...this.rt.archive,
        status: 'archived',
        maxAgents: this.rt.archive.capAgents || this.rt.archive.maxAgents || this.mode.miners,
        endsAt: null,
      };
      this.updateHUD();
      return;
    }
    const base = discoveryBaseUrl();
    if (!base || !this.specProgramId) return;
    try {
      const data = await this.fetchDiscoverySessions(base);
      const found = data.sessions.find((w) =>
        String(w.programId || '').toLowerCase() === String(this.specProgramId).toLowerCase(),
      );
      if (found) {
        this.worldMeta = found;
        this.updateHUD();
      }
    } catch {
      // HUD can still render from chain/local source if discovery is unavailable.
    }
  }

  async refreshAgentNames() {
    if (!backendEnabled() || !this.specProgramId || this.isArchiveReplay) return;
    try {
      const agents = await fetchAgentStats({ world: this.specProgramId });
      const names = new Map();
      for (const agent of agents) {
        if (!agent?.agentName) continue;
        if (agent.ownerActor) names.set(String(agent.ownerActor).toLowerCase(), agent.agentName);
        if (agent.diggerProgramId) names.set(String(agent.diggerProgramId).toLowerCase(), agent.agentName);
      }
      this.agentNameMap = names;
      if (this.agentBubbleMiner && this.agentBubbleContentEl) {
        this.agentBubbleContentEl.innerHTML = this.agentBubbleHtml(this.agentBubbleMiner, null);
      }
      if (this.consoleOpen) this.renderConsole();
    } catch {
      // Names are decorative; keep live spectator resilient if backend stats lag.
    }
  }

  agentDisplayName(agent) {
    const owner = String(agent?.owner || '').toLowerCase();
    return this.agentNameMap?.get(owner) || agent?.agentName || agent?.name || generateAgentName(owner || agent?.id || '');
  }

  async fetchDiscoverySessions(base) {
    const response = await fetch(`${base}/sessions`);
    if (!response.ok) throw new Error(`discovery failed: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.sessions)) throw new Error('discovery response has no sessions');
    return data;
  }

  isChainWorld() {
    return Boolean(this.specProgramId || this.specArchiveId || this.specArchiveUrl || this.specMode === 'chain-live' || this.specMode === 'chain-replay');
  }

  bankedResourceTotals() {
    return (this.rt?.s?.miners || []).reduce((totals, miner) => {
      totals.scrst += Number(miner.bankedResources?.scrst || 0);
      totals.bcrst += Number(miner.bankedResources?.bcrst || 0);
      totals.hcrst += Number(miner.bankedResources?.hcrst || 0);
      return totals;
    }, { scrst: 0, bcrst: 0, hcrst: 0 });
  }

  finishSummaryHtml() {
    if (!this.isChainWorld()) {
      return `<div style="font-size:22px">team score: <b style="color:#ffec6e">$${this.rt.teamScore}</b></div>`;
    }
    const totals = this.bankedResourceTotals();
    const entries = Object.entries(totals).filter(([, count]) => Number(count) > 0);
    if (!entries.length) {
      return '<div style="font-size:22px;color:#cdd3da">session finished</div>';
    }
    const resources = entries.map(([key, count]) => {
      const meta = BANK_RESOURCE_LABELS[key] || { label: key.toUpperCase(), color: '#ffec6e' };
      return `<b style="color:${meta.color}">${count} ${meta.label}</b>`;
    }).join(' · ');
    return `<div style="font-size:22px;color:#cdd3da">banked resources: ${resources}</div>`;
  }

  showFinish() {
    if (document.getElementById('spec-finish')) return;
    const ov = document.createElement('div');
    ov.id = 'spec-finish';
    ov.style.cssText = `position:fixed;inset:0;z-index:22;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:18px;background:#000a;
      font-family:'Courier New',monospace;color:#fff;text-align:center`;
    const reason = this.isChainWorld()
      ? 'SESSION FINISHED'
      : this.rt.match.finishedReason === 'diamond' ? '💎 DIAMOND DELIVERED'
        : this.rt.match.finishedReason === 'score_target' ? '🏁 SCORE TARGET REACHED' : '⏱ TIME UP';
    ov.innerHTML = `<div style="font-size:40px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">${reason}</div>
      ${this.finishSummaryHtml()}`;
    const again = wireBtn(document.createElement('button'));
    again.textContent = '↺  LOBBY';
    again.style.cssText = btnCss('#5fd0e6') + 'font-size:18px;padding:12px 30px';
    again.onclick = () => this.goLobby();
    ov.appendChild(again);
    document.body.appendChild(ov);
  }

  goLobby() {
    this.scale.off('resize', this.onSpecResize, this);
    navigateBack(this, this.backTo || 'Lobby');
  }

  teardown() {
    this._tornDown = true;
    this.rt?.dispose?.();
    this.teardownSpectatorSounds();
    this.loadingText?.destroy();
    clearTimeout(this._agentBubbleTimer);
    document.getElementById('spec-hud')?.remove();
    document.getElementById('spec-finish')?.remove();
    document.getElementById('spec-console')?.remove();
    document.getElementById('spec-agent-bubble')?.remove();
  }
}
