import Phaser from 'phaser';
import { createLeaderboardPanel } from '../backend/leaderboardPanel.js';
import { btnCss, wireBtn } from './arenaUI.js';
import { navigateBack } from '../router.js';

export default class LeaderboardScene extends Phaser.Scene {
  constructor() { super('Leaderboard'); }

  init(data = {}) {
    this.backTo = data.backTo || 'Landing';
  }

  create() {
    this.cleanupDOM();
    const W = this.scale.width;
    const H = this.scale.height;
    this.add.graphics().fillStyle(0x20140a, 1).fillRect(0, 0, W, H);
    this.buildDOM();
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart(); }

  buildDOM() {
    const root = document.createElement('div');
    root.id = 'leaderboard-page';
    root.style.cssText = `position:fixed;inset:0;z-index:20;overflow:hidden;display:flex;flex-direction:column;
      background:radial-gradient(circle at 50% -10%, #4a3420, #1c1109 70%);
      font-family:'Courier New',monospace;color:#fff;padding:24px 28px 24px;box-sizing:border-box`;

    const header = document.createElement('div');
    header.style.cssText = 'text-align:center;margin-bottom:14px;flex:0 0 auto';
    header.innerHTML = `<div style="font-size:36px;font-weight:bold;color:#ffdd55;text-shadow:3px 3px 0 #000;line-height:1">LEADERBOARD</div>`;
    root.appendChild(header);

    const back = wireBtn(document.createElement('button'));
    back.textContent = '← BACK';
    back.style.cssText = btnCss('#cdd3da') + 'position:fixed;left:18px;top:18px;min-width:120px;font-size:16px;padding:10px 18px;z-index:21';
    back.onclick = () => this.goMenu();
    root.appendChild(back);

    this.leaderboardPanel = createLeaderboardPanel({
      id: 'leaderboard-page-panel',
      style: 'width:min(1320px,calc(100vw - 96px));margin:0 auto;max-height:calc(100vh - 112px);flex:1 1 auto',
      pageSize: 8,
    });
    root.appendChild(this.leaderboardPanel.element);

    document.body.appendChild(root);
    this.rootEl = root;
  }

  goMenu() {
    this.scale.off('resize', this.onResize, this);
    navigateBack(this, this.backTo || 'Landing');
  }

  cleanupDOM() {
    document.getElementById('leaderboard-page')?.remove();
  }

  destroyDOM() {
    this.leaderboardPanel?.destroy();
    this.leaderboardPanel = null;
    this.cleanupDOM();
  }
}
