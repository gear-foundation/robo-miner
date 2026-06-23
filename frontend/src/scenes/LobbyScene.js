import Phaser from 'phaser';
import { GAME_MODES } from '../engine/index.js';
import { generateWorld } from '../world.js';
import { roomThumbnail } from '../engine/preview.js';
import { btnCss, wireBtn, paintThumb, hashStr } from './arenaUI.js';
import { CHAIN, chainReady, discoveryBaseUrl } from '../chain/config.js';
import { navigateBack, navigateTo } from '../router.js';

// Agent Arena lobby: a gallery of agent game modes. Each card shows a live
// preview of that mode's generated map and a WATCH button that drops into the
// spectator. Single-player ('solo') is intentionally NOT here — that's the
// normal START GAME flow; this screen is the machine-vs-map modes.
//
// In chain mode it lists worlds through the operator discovery API (/sessions):
// current worlds, past snapshots, statuses, and agent counts. Configured env
// program ids are only a fallback when discovery is unavailable.
const ARENA_MODES = ['coop-gem', 'coop-race', 'coop-timed', 'arena'];

function isPastStatus(status) {
  return ['finished', 'retired', 'archived'].includes(String(status || '').toLowerCase());
}

function normalizeWorldRecord(world) {
  const maxAgents = world.maxAgents ?? world.targetAgents ?? world.capAgents ?? world.cap;
  const minAgents = world.minAgents ?? world.min ?? world.admission?.minAgents;
  return {
    id: world.id,
    programId: world.programId,
    status: world.status,
    phase: world.phase,
    joinable: world.joinable,
    canRegister: world.canRegister,
    canPlay: world.canPlay,
    agents: world.agents,
    minAgents,
    maxAgents,
    archiveId: world.archiveId,
    archiveUrl: world.archiveUrl,
    seed: world.seed,
    sessionId: world.sessionId ?? world.session,
    endsAt: world.endsAt,
  };
}

function uniqueWorlds(worlds) {
  const seen = new Set();
  return worlds.filter((world) => {
    const key = [
      String(world.programId || '').toLowerCase(),
      world.archiveId || world.sessionId || world.id || '',
      world.status || '',
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function configuredFallbackWorlds() {
  return CHAIN.worldProgramIds
    .filter((id) => chainReady(id))
    .map((programId) => ({ programId, status: 'configured' }));
}

function makeWorldBadge(label, bg, fg = '#1b1309') {
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText = `box-sizing:border-box;max-width:142px;padding:5px 7px;
    border:3px solid #000;border-radius:8px;background:${bg};color:${fg};
    box-shadow:3px 3px 0 rgba(0,0,0,.45);font-size:10px;font-weight:bold;
    line-height:1;letter-spacing:1px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
  return el;
}

function worldStatusMeta(info = {}) {
  const value = String(info.phase || info.status || '').toLowerCase();
  if (['open', 'waiting_agents', 'map_ready', 'deployed'].includes(value)) {
    return {
      label: 'REGISTRATION',
      bg: '#6ee7a8',
      fg: '#102318',
      description: 'Registration is open — agents can join this world.',
    };
  }
  if (value === 'configured') {
    return {
      label: 'DISCOVERY OFF',
      bg: '#5fd0e6',
      fg: '#10343d',
      description: 'Discovery is unavailable — showing configured fallback world.',
    };
  }
  if (value === 'active') {
    return {
      label: 'IN GAME',
      bg: '#ffdd55',
      fg: '#261a06',
      description: 'Session is running — agents are mining now. Late join is available while slots remain.',
    };
  }
  if (['finished', 'archived', 'retired'].includes(value)) {
    return {
      label: 'ARCHIVE',
      bg: '#cdd3da',
      fg: '#18202a',
      description: 'Finished world — open the final snapshot.',
    };
  }
  return {
    label: value ? value.toUpperCase().slice(0, 14) : 'UNKNOWN',
    bg: '#5fd0e6',
    fg: '#10343d',
    description: 'World status has not been reported by discovery yet.',
  };
}

function agentCountMeta(info) {
  const max = Number(info.maxAgents ?? info.targetAgents ?? 10);
  const agents = Number(info.agents);
  if (!Number.isFinite(agents)) {
    const maxLabel = Number.isFinite(max) ? max : 10;
    return { detail: `agents unknown · ${maxLabel} max` };
  }
  const cap = Number.isFinite(max) ? max : Math.max(agents, 10);
  return { detail: `${agents}/${cap} agents registered` };
}

export default class LobbyScene extends Phaser.Scene {
  constructor() { super('Lobby'); }

  init(data = {}) {
    this.backTo = data.backTo || 'Landing';
  }

  create() {
    this.cleanupDOM();
    this.tab = 'current'; // current | past
    this.loadingWorlds = CHAIN.enabled;
    this.worlds = { current: [], past: [] };
    const W = this.scale.width, H = this.scale.height;
    this.add.graphics().fillStyle(0x20140a, 1).fillRect(0, 0, W, H);
    this.buildDOM();
    this.refreshWorlds();
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart(); }

  buildDOM() {
    this.cleanupDOM();
    const root = document.createElement('div');
    root.id = 'arena-lobby';
    root.style.cssText = `position:fixed; inset:0; z-index:20; overflow:auto;
      background:radial-gradient(circle at 50% -10%, #4a3420, #1c1109 70%);
      font-family:'Courier New',monospace; color:#fff; padding:30px 20px 60px;`;
    root.innerHTML = `<div style="text-align:center">
      <div style="font-size:40px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">🤖 AGENT ARENA</div>
    </div>`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'position:fixed;left:18px;top:18px;min-width:120px;font-size:16px;padding:10px 18px;z-index:21';
    back.onclick = () => this.goMenu();
    root.appendChild(back);

    if (CHAIN.enabled) root.appendChild(this.makeToggle());

    const grid = document.createElement('div');
    grid.id = 'arena-grid';
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:22px;justify-content:center;max-width:1120px;margin:24px auto 0';
    root.appendChild(grid);
    this.gridEl = grid;

    document.body.appendChild(root);
    this.lobbyEl = root;
    this.renderGrid();
  }

  // CURRENT / PAST segmented toggle in the lobby's chunky retro style: thick
  // black border, hard offset shadow, Courier New, a cyan pill that slides.
  makeToggle() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:center;margin-top:18px';
    const seg = document.createElement('div');
    seg.style.cssText = `position:relative;display:flex;width:300px;padding:5px;
      border:3px solid #000;border-radius:12px;background:#1c1109`;
    const pill = document.createElement('div');
    pill.style.cssText = `position:absolute;top:5px;bottom:5px;left:5px;right:50%;box-sizing:border-box;
      border:2px solid #000;border-radius:8px;background:#5fd0e6;z-index:0;
      transition:left .2s ease,right .2s ease`;
    seg.appendChild(pill);
    const mk = (label, key) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `position:relative;z-index:1;flex:1;background:transparent;border:0;cursor:pointer;
        font-family:'Courier New',monospace;font-weight:bold;font-size:15px;letter-spacing:2px;padding:9px 0`;
      b.onclick = () => this.setTab(key);
      return b;
    };
    this.tabBtns = { current: mk('CURRENT', 'current'), past: mk('PAST', 'past') };
    seg.appendChild(this.tabBtns.current);
    seg.appendChild(this.tabBtns.past);
    this.tabPill = pill;
    wrap.appendChild(seg);
    this.syncToggle();
    return wrap;
  }

  setTab(key) {
    if (this.tab === key) return;
    this.tab = key;
    this.syncToggle();
    this.renderGrid();
  }

  syncToggle() {
    if (this.tabPill) {
      const past = this.tab === 'past';
      this.tabPill.style.left = past ? '50%' : '5px';
      this.tabPill.style.right = past ? '5px' : '50%';
    }
    for (const [key, btn] of Object.entries(this.tabBtns || {})) {
      btn.style.color = key === this.tab ? '#10343d' : '#cdd3da';
    }
  }

  // Pull worlds from operator discovery. This is only a lobby/catalog read; live
  // world movement is handled by the frontend chain subscription.
  async refreshWorlds() {
    if (!CHAIN.enabled) return;
    this.loadingWorlds = true;
    this.renderGrid();

    const base = discoveryBaseUrl();
    if (base) {
      try {
        const worlds = await this.fetchDiscoveryWorlds(base);
        this.applyWorlds(worlds);
        return;
      } catch (error) {
        console.warn('[discovery] failed to load worlds', error);
      }
    }

    this.applyWorlds({ current: configuredFallbackWorlds(), past: [] });
  }

  async fetchDiscoveryWorlds(base) {
    try {
      const sessions = await this.fetchJson(`${base}/sessions`);
      const sessionWorlds = Array.isArray(sessions) ? sessions : (sessions?.sessions || []);
      const worlds = sessionWorlds
        .filter((world) => world.programId)
        .map(normalizeWorldRecord);
      return {
        current: worlds.filter((world) => !isPastStatus(world.status)),
        past: worlds.filter((world) => isPastStatus(world.status)),
      };
    } catch (sessionsError) {
      const manifest = await this.fetchJson(`${base}/api/manifest`);
      const manifestWorlds = Array.isArray(manifest?.worlds)
        ? manifest.worlds
        : [...(manifest?.active || []), ...(manifest?.past || [])];
      const worlds = manifestWorlds
        .filter((world) => world.programId)
        .map(normalizeWorldRecord);
      return {
        current: worlds.filter((world) => !isPastStatus(world.status)),
        past: worlds.filter((world) => isPastStatus(world.status)),
      };
    }
  }

  async fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`discovery failed: ${response.status}`);
    return response.json();
  }

  applyWorlds(worlds) {
    if (!this.gridEl) return;
    this.loadingWorlds = false;
    this.worlds.current = uniqueWorlds((worlds.current || []).filter((world) => world.programId));
    this.worlds.past = uniqueWorlds((worlds.past || []).filter((world) => world.programId));
    this.renderGrid();
  }

  renderGrid() {
    if (!this.gridEl) return;
    this.gridEl.innerHTML = '';
    if (!CHAIN.enabled) {
      for (const key of ARENA_MODES) this.gridEl.appendChild(this.makeCard(key));
      return;
    }
    const list = this.worlds[this.tab] || [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:.55;font-size:14px;padding:48px;text-align:center;width:100%';
      empty.textContent = this.loadingWorlds
        ? 'loading worlds...'
        : this.tab === 'past' ? 'no archived worlds yet' : 'no open worlds right now';
      this.gridEl.appendChild(empty);
      return;
    }
    list.forEach((rec) => this.gridEl.appendChild(this.makeChainCard(rec)));
  }

  makeCard(key) {
    const mode = GAME_MODES[key];
    const seed = 1000 + hashStr(key);
    const world = generateWorld(seed, mode.spec);
    const thumb = roomThumbnail(world, { cols: 84, rows: 60 });

    const card = document.createElement('div');
    card.style.cssText = `width:300px;background:#3a2616;border:3px solid #000;border-radius:14px;
      box-shadow:5px 5px 0 rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column`;

    const cv = document.createElement('canvas');
    const scale = 3;
    cv.width = thumb.cols * scale; cv.height = thumb.rows * scale;
    cv.style.cssText = 'width:100%;height:190px;image-rendering:pixelated;display:block;background:#0c0c0c;border-bottom:3px solid #000';
    paintThumb(cv, thumb, scale);
    card.appendChild(cv);

    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:6px';
    body.innerHTML = `<div style="font-size:18px;font-weight:bold;color:#ffdd55">${mode.label}</div>
      <div style="font-size:12px;opacity:.85;flex:1;line-height:1.35">${mode.description}</div>
      <div style="font-size:11px;opacity:.65">map ${world.W}×${world.H} · ${mode.miners} agents · ${world.chests.length} chests</div>`;

    const watch = wireBtn(document.createElement('button'));
    watch.textContent = '▶  WATCH';
    watch.style.cssText = btnCss('#5fd0e6') + 'margin-top:8px;width:100%;font-size:16px;padding:10px';
    watch.onclick = () => this.watch(key, seed);
    body.appendChild(watch);

    card.appendChild(body);
    return card;
  }

  makeChainCard(rec) {
    // Accepts a world record { programId, status, agents, maxAgents } (or a bare
    // programId string for the env fallback). Same card as the local modes: a
    // scaled-down mine on top, program address as title + live counts below.
    const programId = typeof rec === 'string' ? rec : rec.programId;
    const info = (typeof rec === 'string' ? {} : rec) || {};
    const status = worldStatusMeta(info);
    const agents = agentCountMeta(info);
    const seed = hashStr(programId);
    const world = generateWorld(seed, 'agents');
    const thumb = roomThumbnail(world, { cols: 84, rows: 60 });

    const card = document.createElement('div');
    card.style.cssText = `width:300px;background:#3a2616;border:3px solid #000;border-radius:14px;
      box-shadow:5px 5px 0 rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column`;

    const media = document.createElement('div');
    media.style.cssText = 'position:relative;border-bottom:3px solid #000;background:#0c0c0c';
    const cv = document.createElement('canvas');
    const scale = 3;
    cv.width = thumb.cols * scale; cv.height = thumb.rows * scale;
    cv.style.cssText = 'width:100%;height:190px;image-rendering:pixelated;display:block;background:#0c0c0c';
    paintThumb(cv, thumb, scale);
    media.appendChild(cv);

    const badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'position:absolute;left:8px;right:8px;top:8px;display:flex;align-items:flex-start;pointer-events:none';
    badgeRow.appendChild(makeWorldBadge(status.label, status.bg, status.fg));
    media.appendChild(badgeRow);
    card.appendChild(media);

    const short = `${programId.slice(0, 10)}…${programId.slice(-8)}`;
    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:6px';
    const desc = status.description;
    body.innerHTML = `<div title="${programId}" style="font-size:16px;font-weight:bold;color:#ffdd55;word-break:break-all">${short}</div>
      <div style="font-size:12px;opacity:.85;flex:1;line-height:1.35">${desc}</div>
      <div style="font-size:11px;opacity:.72">map ${world.W}×${world.H} · ${agents.detail}</div>`;

    const watch = wireBtn(document.createElement('button'));
    watch.textContent = '▶  WATCH';
    watch.style.cssText = btnCss('#5fd0e6') + 'margin-top:8px;width:100%;font-size:16px;padding:10px';
    watch.onclick = () => {
      if (info.archiveId) this.watchArchive(info);
      else this.watchChain(programId);
    };
    body.appendChild(watch);

    card.appendChild(body);
    return card;
  }

  watch(mode, seed) {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Spectator', { mode, seed, backTo: 'Lobby' });
  }

  watchChain(programId) {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Spectator', { mode: 'chain-live', seed: 0, programId, backTo: 'Lobby' });
  }

  watchArchive(info) {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Spectator', {
      mode: 'chain-replay',
      seed: Number(info.seed || 0) || 0,
      programId: info.programId,
      archiveId: info.archiveId,
      archiveUrl: info.archiveUrl,
      backTo: 'Lobby',
    });
  }

  goMenu() {
    this.scale.off('resize', this.onResize, this);
    navigateBack(this, this.backTo || 'Landing');
  }

  cleanupDOM() { document.getElementById('arena-lobby')?.remove(); }
  destroyDOM() { this.cleanupDOM(); }
}
