import Phaser from 'phaser';
import { GAME_MODES } from '../engine/index.js';
import { generateWorld } from '../world.js';
import { roomThumbnail } from '../engine/preview.js';
import { btnCss, wireBtn, paintThumb, hashStr } from './arenaUI.js';
import { CHAIN, chainReady } from '../chain/config.js';
import { backendEnabled, fetchManifest } from '../backend/api.js';
import { setRoute } from '../routing.js';

// Agent Arena lobby: a gallery of agent game modes. Each card shows a live
// preview of that mode's generated map and a WATCH button that drops into the
// spectator. Single-player ('solo') is intentionally NOT here — that's the
// normal START GAME flow; this screen is the machine-vs-map modes.
//
// In chain mode it lists deployed worlds with a CURRENT / PAST toggle, sourced
// from the backend World Registry manifest (active vs finished), falling back to
// the configured program ids as "current" when no backend is wired.
const ARENA_MODES = ['coop-gem', 'coop-race', 'coop-timed', 'arena'];

export default class LobbyScene extends Phaser.Scene {
  constructor() { super('Lobby'); }

  create() {
    setRoute('Lobby', {}, { replace: true });
    this.cleanupDOM();
    this.tab = 'current'; // current | past
    this.worlds = {
      current: CHAIN.worldProgramIds.filter((id) => chainReady(id)).map((programId) => ({ programId })),
      past: [],
    };
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

  // Pull worlds (with statuses) from the backend World Registry manifest and
  // bucket into current (active/open) vs past (finished). No-op without a
  // backend — the chain-seeded current bucket stays.
  async refreshWorlds() {
    if (!CHAIN.enabled) return;
    // Prefer the operator discovery feed: live current/past + agent counts,
    // no colleague backend required.
    if (CHAIN.matchesUrl) {
      try {
        const base = String(CHAIN.matchesUrl).replace(/\/+$/, '');
        const data = await (await fetch(`${base}/worlds`)).json();
        const isPast = (s) => s === 'finished' || s === 'retired' || s === 'archived';
        const rec = (w) => ({ programId: w.programId, status: w.status, agents: w.agents, maxAgents: w.maxAgents });
        const ws = (data?.worlds || []).filter((w) => w.programId);
        this.worlds.current = ws.filter((w) => !isPast(w.status)).map(rec);
        this.worlds.past = ws.filter((w) => isPast(w.status)).map(rec);
        this.renderGrid();
        return;
      } catch (error) {
        console.warn('[matches] failed to load worlds', error);
      }
    }
    if (!backendEnabled()) return;
    try {
      const manifest = await fetchManifest();
      const rec = (w) => ({ programId: w.programId, status: w.status, agents: w.agents, maxAgents: w.targetAgents });
      const active = (manifest?.active || []).filter((w) => w.programId).map(rec);
      if (active.length) this.worlds.current = active;
      this.worlds.past = (manifest?.past || []).filter((w) => w.programId).map(rec);
      this.renderGrid();
    } catch (error) {
      console.warn('[backend] failed to load worlds', error);
    }
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
      empty.textContent = this.tab === 'past' ? 'no finished worlds yet' : 'no open worlds right now';
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
    const seed = hashStr(programId);
    const world = generateWorld(seed, 'agents');
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

    const short = `${programId.slice(0, 10)}…${programId.slice(-8)}`;
    const body = document.createElement('div');
    body.style.cssText = 'padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:6px';
    const countLine = Number.isFinite(info.agents)
      ? `${info.agents}/${info.maxAgents ?? 10} agents${info.status ? ` · ${info.status}` : ''}`
      : 'up to 10 agents';
    const desc = info.status === 'active'
      ? 'Session running — agents are mining.'
      : ['finished', 'archived', 'retired'].includes(info.status)
        ? 'Finished — explore the dug-out mine.'
        : 'Open lobby — agents register and dig.';
    body.innerHTML = `<div title="${programId}" style="font-size:16px;font-weight:bold;color:#ffdd55;word-break:break-all">${short}</div>
      <div style="font-size:12px;opacity:.85;flex:1;line-height:1.35">${desc}</div>
      <div style="font-size:11px;opacity:.65">map ${world.W}×${world.H} · ${countLine}</div>`;

    const watch = wireBtn(document.createElement('button'));
    watch.textContent = '▶  WATCH';
    watch.style.cssText = btnCss('#5fd0e6') + 'margin-top:8px;width:100%;font-size:16px;padding:10px';
    watch.onclick = () => this.watchChain(programId);
    body.appendChild(watch);

    card.appendChild(body);
    return card;
  }

  watch(mode, seed) {
    this.scale.off('resize', this.onResize, this);
    setRoute('Spectator', { mode, seed });
    this.scene.start('Spectator', { mode, seed });
  }

  watchChain(programId) {
    this.scale.off('resize', this.onResize, this);
    setRoute('Spectator', { mode: 'chain-live', seed: 0, programId });
    this.scene.start('Spectator', { mode: 'chain-live', seed: 0, programId });
  }

  goMenu() {
    this.scale.off('resize', this.onResize, this);
    setRoute('Menu');
    this.scene.start('Menu');
  }

  cleanupDOM() { document.getElementById('arena-lobby')?.remove(); }
  destroyDOM() { this.cleanupDOM(); }
}
