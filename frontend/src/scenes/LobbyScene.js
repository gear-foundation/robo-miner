import Phaser from 'phaser';
import { GAME_MODES } from '../engine/index.js';
import { generateWorld } from '../world.js';
import { roomThumbnail } from '../engine/preview.js';
import { btnCss, wireBtn, paintThumb, hashStr } from './arenaUI.js';

// Agent Arena lobby: a gallery of agent game modes. Each card shows a live
// preview of that mode's generated map and a WATCH button that drops into the
// spectator. Single-player ('solo') is intentionally NOT here — that's the
// normal START GAME flow; this screen is the machine-vs-map modes.
const ARENA_MODES = ['coop-gem', 'coop-race', 'coop-timed', 'arena'];

export default class LobbyScene extends Phaser.Scene {
  constructor() { super('Lobby'); }

  create() {
    this.cleanupDOM();
    const W = this.scale.width, H = this.scale.height;
    this.add.graphics().fillStyle(0x20140a, 1).fillRect(0, 0, W, H);
    this.buildDOM();
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart(); }

  buildDOM() {
    const root = document.createElement('div');
    root.id = 'arena-lobby';
    root.style.cssText = `position:fixed; inset:0; z-index:20; overflow:auto;
      background:radial-gradient(circle at 50% -10%, #4a3420, #1c1109 70%);
      font-family:'Courier New',monospace; color:#fff; padding:30px 20px 60px;`;
    root.innerHTML = `<div style="text-align:center">
      <div style="font-size:40px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000">🤖 AGENT ARENA</div>
      <div style="opacity:.8;margin-top:6px">pick a mode — watch the bots dig, search and race on a shared map</div>
    </div>`;

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'position:fixed;left:18px;top:18px;min-width:120px;font-size:16px;padding:10px 18px;z-index:21';
    back.onclick = () => this.goMenu();
    root.appendChild(back);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:22px;justify-content:center;max-width:1120px;margin:26px auto 0';
    for (const key of ARENA_MODES) grid.appendChild(this.makeCard(key));
    root.appendChild(grid);

    document.body.appendChild(root);
    this.lobbyEl = root;
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

  watch(mode, seed) {
    this.scale.off('resize', this.onResize, this);
    this.scene.start('Spectator', { mode, seed });
  }

  goMenu() {
    this.scale.off('resize', this.onResize, this);
    this.scene.start('Menu');
  }

  cleanupDOM() { document.getElementById('arena-lobby')?.remove(); }
  destroyDOM() { this.cleanupDOM(); }
}
