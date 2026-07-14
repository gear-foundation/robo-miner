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
    root.style.cssText = `position:fixed;inset:0;z-index:20;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;
      background:radial-gradient(circle at 50% -10%, #4a3420, #1c1109 70%);
      font-family:'Courier New',monospace;color:#fff;padding:24px 28px 24px;box-sizing:border-box;
      scrollbar-width:thin;scrollbar-color:#c9a06a #1c1109`;

    const scrollStyle = document.createElement('style');
    scrollStyle.textContent = `
      #leaderboard-page::-webkit-scrollbar { width:10px }
      #leaderboard-page::-webkit-scrollbar-track { background:#1c1109 }
      #leaderboard-page::-webkit-scrollbar-thumb {
        background:#c9a06a;border:2px solid #1c1109;border-radius:8px
      }
      #leaderboard-page::-webkit-scrollbar-thumb:hover { background:#ffdd55 }
      #leaderboard-page .leaderboard-grid {
        grid-template-columns:64px minmax(180px,1fr) minmax(90px,130px) minmax(110px,160px) minmax(72px,110px)
      }
      @media (max-width:720px) {
        #leaderboard-page { padding:76px 12px 20px !important }
        #leaderboard-page > div:first-of-type { margin-bottom:12px !important }
        #leaderboard-page .leaderboard-grid {
          grid-template-columns:42px minmax(0,1fr) minmax(82px,105px) minmax(58px,76px);
          font-size:13px !important
        }
        #leaderboard-page .leaderboard-col-score { display:none }
        #leaderboard-page .leaderboard-cell { padding:8px 6px !important }
      }
    `;
    root.appendChild(scrollStyle);

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
      style: 'width:min(1320px,100%);margin:0 auto 24px;flex:0 0 auto',
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
