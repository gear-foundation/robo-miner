import Phaser from 'phaser';
import { TILE } from '../config.js';
import {
  drawRobot as drawSharedRobot,
  HAT_IDS, HAT_LABELS, pickRandomHat,
  BODY_COLOR_IDS, BODY_COLOR_LABELS, BODY_COLOR_SWATCH, pickRandomBodyColor,
  makeCanvasGraphicsAdapter,
} from '../render/robot.js';
import { connectWallet as connectBrowserWallet, getWalletState, shortAddress, startWalletDiscovery, subscribeWallet } from '../chain/wallet.js';
import { navigateTo } from '../router.js';
// Title / splash scene. Shows the game logo, the robot, and the
// "Start Digging" button. On start, the robot plays a little fall-
// through-the-ground animation before we hand off to the Game scene.
//
// Visual pieces (background, robot, logo) are drawn procedurally as
// placeholders — drop real sprites into public/assets/menu/ later and
// swap the graphics for this.add.image(...) calls.
export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  preload() {
    // Optional art drop-in: if these files exist, we'll use them. If not,
    // we fall back to procedural shapes. Silently swallow 404s.
    this.load.on('loaderror', () => {});
    this.load.image('menu-bg',    'assets/menu/bg.png');
    this.load.image('menu-logo',  'assets/menu/logo.png');
    this.load.image('menu-robot', 'assets/menu/robot.png');
    this.load.audio('menu-rock-drill', 'assets/sfx/rock-drill-generated.wav');
    this.load.audio('menu-music', 'assets/sfx/menu-music.wav');
    this.load.audio('robot-chirp', 'assets/sfx/robot-chirp.wav');
    this.load.audio('robot-question', 'assets/sfx/robot-question.wav');
    this.load.audio('robot-sad', 'assets/sfx/robot-sad.wav');
  }

  create() {
    this.cleanupMenuDOM();
    startWalletDiscovery();
    const W = this.scale.width, H = this.scale.height;

    // Horizon y: where grass meets sky. Robot feet land exactly on this line.
    this.groundY = Math.floor(H * 0.68);

    // --- Background: sky (above horizon) + dark ground (below).
    this.bgGfx = this.add.graphics();
    this.drawBg(W, H, this.groundY);
    // Separate layer for the animated torch flames flanking the mine
    // entrance — drawn every frame in update() so they flicker without
    // forcing the heavy bg redraw.
    this.torchGfx = this.add.graphics();
    this.torchGfx.setDepth(1);

    if (this.textures.exists('menu-bg')) {
      const bg = this.add.image(W / 2, H / 2, 'menu-bg');
      bg.setDisplaySize(W, H);
    }

    // --- Logo / tagline up top.
    if (this.textures.exists('menu-logo')) {
      this.logo = this.add.image(W / 2, H * 0.18, 'menu-logo');
    } else {
      this.logo = this.add.text(W / 2, H * 0.18, 'WEB3 MINER', {
        fontFamily: 'Courier New, monospace',
        fontSize: Math.min(96, Math.floor(W / 10)) + 'px',
        fontStyle: 'bold',
        color: '#ffdd55',
        stroke: '#000',
        strokeThickness: 8,
      }).setOrigin(0.5);
      this.tagline = this.add.text(W / 2, H * 0.18 + 60, 'dig deep. get rich.', {
        fontFamily: 'Courier New, monospace',
        fontSize: '18px',
        color: '#ffffff',
        stroke: '#000',
        strokeThickness: 3,
      }).setOrigin(0.5);
    }

    // --- Robot: feet rest on the grass strip. drawRobot draws from center
    // outwards at size T=2×TILE; track bottom sits at py + T*0.44.
    const T = TILE * 2;
    this.robotX = W / 2;
    this.robotY = this.groundY - T * 0.44 - 10; // lift the robot a few px off the grass
    this.robotGfx = this.add.graphics();
    this.drawRobot(this.robotGfx, this.robotX, this.robotY);
    this.menuDrillSound = this.sound.add('menu-rock-drill', { loop: false, volume: 0.55 });
    // Atmospheric loop for the menu — quiet so it doesn't drown the
    // bubble/click sfx. Auto-resumes if the browser blocked autoplay
    // (Phaser will start it on first user input).
    if (this.cache.audio.exists('menu-music')) {
      this.menuMusic = this.sound.add('menu-music', { loop: true, volume: 0.18 });
      try { this.menuMusic.play(); } catch { /* autoplay may be blocked */ }
      // Stop on shutdown to prevent overlap with future scenes.
      this.events.once('shutdown', () => this.menuMusic?.stop());
      this.events.once('destroy',  () => this.menuMusic?.stop());
    }
    this.robotChirpSound = this.sound.add('robot-chirp', { volume: 0.45 });
    this.robotQuestionSound = this.sound.add('robot-question', { volume: 0.45 });
    this.robotSadSound = this.sound.add('robot-sad', { volume: 0.45 });
    this.robotTouchSounds = [this.robotChirpSound, this.robotQuestionSound];
    this.robotTouchLines = [
      "Don't touch me.",
      'Beep. Personal space.',
      'Hey!',
      'I am calibrated.',
      'Careful, partner.',
    ];
    this.robotHitZone = this.add.zone(this.robotX, this.robotY + T * 0.06, T * 0.72, T * 0.84);
    this.robotHitZone.setInteractive({ cursor: 'pointer' });
    this.robotHitZone.on('pointerdown', () => this.reactRobot(true));

    // Grass strip — drawn AFTER the robot-y is known so they line up.
    this.groundGfx = this.add.graphics();
    this.drawGround(this.groundGfx, W, this.groundY);

    // Speech bubble — same DOM styling as the in-game sayBubble, positioned
    // above the robot's head. Cycles through greetings.
    this.createBubbleDOM();
    this.bubbleAnchor = { x: this.robotX, y: this.robotY - T * 0.58 };
    this.positionMenuBubble();
    this.cycleGreeting();

    // --- Cosmetics: hat + body color, both persisted in localStorage so
    // the player's look survives reloads. First-time visitors get a fresh
    // random combo so the menu feels alive.
    this.menuHat   = this.loadStored('robo.hat',   HAT_IDS)        || pickRandomHat();
    this.menuColor = this.loadStored('robo.color', BODY_COLOR_IDS) || pickRandomBodyColor();
    this.persist('robo.hat',   this.menuHat);
    this.persist('robo.color', this.menuColor);

    // --- Start button is a DOM element — clean typography, no
    // hand-drawn graphics artifacts.
    this.createStartDOM();
    this.createArenaDOM();
    this.createLeaderboardButtonDOM();
    this.createRedeemButtonDOM();
    this.createSocialFuelButtonDOM();
    this.createLandingButtonDOM();
    this.createWalletButtonDOM();
    this.createCustomizerDOM();
    this.createSoundButtonDOM();
    this.downKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);

    // Resize handler: rebuild layout.
    this.scale.on('resize', this.onResize, this);
    // Remove DOM nodes when leaving the menu.
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy',  () => this.destroyDOM());
  }

  update() {
    // Re-render the robot each frame so the LED blinks, antenna pulse and
    // pupil look-around animate. While a fall tween is running it already
    // drives drawRobot via onUpdate, so skip to avoid double draws.
    if (this._falling) return;
    if (Phaser.Input.Keyboard.JustDown(this.downKey)) {
      this.handleStartClick();
      return;
    }
    if (this.robotGfx) this.drawRobot(this.robotGfx, this.robotX, this.robotY);
    this.drawTorches();
    this.drawEyes();
  }

  createBubbleDOM() {
    if (this.menuBubbleEl) return;
    const b = document.createElement('div');
    b.id = 'menu-bubble';
    b.style.cssText = `
      position: fixed; transform: translate(-50%, -100%);
      background: #fff; color: #222; font-family: 'Courier New', monospace;
      font-size: 16px; padding: 8px 14px; border-radius: 12px;
      border: 2px solid #222; box-shadow: 3px 3px 0 rgba(0,0,0,0.3);
      white-space: nowrap; pointer-events: none; z-index: 11;
      display: none; max-width: 320px; font-weight: bold;
    `;
    b.innerHTML = `<span id="menu-bubble-text"></span>
      <div style="position:absolute;bottom:-10px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;
        border-top:10px solid #222;"></div>
      <div style="position:absolute;bottom:-6px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;
        border-top:7px solid #fff;"></div>`;
    document.body.appendChild(b);
    this.menuBubbleEl = b;
    this.menuBubbleText = b.querySelector('#menu-bubble-text');
  }

  positionMenuBubble() {
    if (!this.menuBubbleEl || !this.bubbleAnchor) return;
    // Center the bubble horizontally above the robot's head and lift it
    // a bit further so a tall hat (top hat / party cone / crown) doesn't
    // poke through the bubble's bottom edge. Tail sits at 50% so it
    // points straight down to the robot's head.
    this.menuBubbleEl.style.left = `${this.bubbleAnchor.x}px`;
    this.menuBubbleEl.style.top  = `${this.bubbleAnchor.y - 14}px`;
    this.menuBubbleEl.style.setProperty('--tail-x', '50%');
  }

  showMenuBubble(text, ms = 2800) {
    if (!this.menuBubbleEl) return;
    this.menuBubbleText.textContent = text;
    this.menuBubbleEl.style.display = 'block';
    clearTimeout(this._menuBubbleTimer);
    this._menuBubbleTimer = setTimeout(() => {
      this.menuBubbleEl.style.display = 'none';
    }, ms);
  }

  hideMenuBubble() {
    if (this.menuBubbleEl) this.menuBubbleEl.style.display = 'none';
    clearTimeout(this._menuBubbleTimer);
    clearInterval(this._greetCycle);
  }

  cycleGreeting() {
    const lines = [
      'Hi! Ready to deep-dive?',
      'Smell that? That is money.',
      'Let us dig, partner!',
      'I feel a big one down there…',
      'Come on, press START!',
    ];
    let i = 0;
    const show = () => {
      this.showMenuBubble(lines[i % lines.length], 2500);
      i++;
    };
    show();
    this._greetCycle = setInterval(show, 3200);
  }

  reactRobot(fromTouch = false) {
    if (this._falling) return;
    this.playRobotChirp();
    if (fromTouch || Math.random() < 0.35) {
      this.showMenuBubble(this.pick(this.robotTouchLines), 1500);
    }
  }

  pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  createStartDOM() {
    if (this.startEl) return;
    const el = document.createElement('button');
    el.id = 'menu-start';
    el.style.cssText = this.menuActionCss({ background: '#ffdd55', color: '#222', fontSize: 22, primary: true });
    this.placeMenuActionButton(el, 'start');
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.handleStartClick());
    document.body.appendChild(el);
    this.startEl = el;
    this.startEl.textContent = '⛏  START GAME';
  }

  // Click handler for the START button and the keyboard DOWN shortcut.
  handleStartClick() {
    this.startFall();
  }

  destroyDOM() {
    this.stopMenuDrillSound();
    this.unsubscribeWallet?.();
    this.unsubscribeWallet = null;
    this.destroyLandingButtonDOM();
    this.destroyStartDOM();
    this.destroyArenaDOM();
    this.destroyLeaderboardButtonDOM();
    this.destroyRedeemButtonDOM();
    this.destroySocialFuelButtonDOM();
    this.destroyWalletButtonDOM();
    this.destroyBubbleDOM();
    this.destroyCustomizerDOM();
    this.destroySoundButtonDOM();
    this.destroyTunnelOverlay();
  }

  cleanupMenuDOM() {
    for (const id of ['campaign-landing', 'menu-landing-btn', 'menu-wallet-btn', 'menu-bubble', 'menu-start', 'menu-arena', 'menu-leaderboard-btn', 'menu-redeem-btn', 'menu-social-btn', 'menu-generate', 'menu-customizer', 'menu-customizer-modal', 'menu-sound', 'menu-hatpicker', 'leaderboard-page', 'redeem-page', 'social-fuel-page', 'menu-tunnel-overlay', 'arena-lobby', 'spec-hud', 'spec-finish', 'fog-overlay', 'hud', 'inv', 'bubble', 'flash', 'shop']) {
      document.getElementById(id)?.remove();
    }
  }

  destroyBubbleDOM() {
    clearTimeout(this._menuBubbleTimer);
    clearInterval(this._greetCycle);
    if (this.menuBubbleEl) { this.menuBubbleEl.remove(); this.menuBubbleEl = null; }
  }

  destroyStartDOM() {
    if (this.startEl) { this.startEl.remove(); this.startEl = null; }
  }

  getMenuActionLayout() {
    const W = this.scale.width;
    const compact = W < 560;
    const width = compact ? Math.min(320, W - 28) : Math.min(420, W - 32);
    const gap = compact ? 9 : 10;
    const startH = compact ? 58 : 64;
    const secondaryH = compact ? 50 : 56;
    const top = this.groundY + 8;
    const colGap = 10;
    const colW = compact ? width : Math.floor((width - colGap) / 2);
    const left = (W - width) / 2;
    return { W, compact, width, gap, startH, secondaryH, top, colW, colGap, left };
  }

  placeMenuActionButton(el, slot) {
    const layout = this.getMenuActionLayout();
    if (slot === 'start') {
      el.style.left = `${layout.left}px`;
      el.style.top = `${layout.top}px`;
      el.style.width = `${layout.width}px`;
      el.style.height = `${layout.startH}px`;
      return;
    }
    const index = { arena: 0, leaderboard: 1, redeem: 2, social: 3 }[slot] ?? 0;
    const row = layout.compact ? index : Math.floor(index / 2);
    const col = layout.compact ? 0 : index % 2;
    const top = layout.top + layout.startH + layout.gap + row * (layout.secondaryH + layout.gap);
    const left = layout.left + col * (layout.colW + layout.colGap);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${layout.compact ? layout.width : layout.colW}px`;
    el.style.height = `${layout.secondaryH}px`;
  }

  menuActionCss({ background, color, fontSize = 18, primary = false }) {
    return `
      position: fixed; transform: none;
      z-index: 12; padding: ${primary ? '0 32px' : '0 14px'};
      font-family: 'Courier New', monospace; font-size: ${fontSize}px; font-weight: bold;
      color: ${color}; background: ${background}; border: 3px solid #000; border-radius: 12px;
      cursor: pointer; letter-spacing: 1px; transition: transform 0.08s ease, filter 0.08s ease;
      text-align: center; box-shadow: 3px 3px 0 rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    `;
  }

  bindMenuActionMotion(el) {
    el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.04)'; });
    el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });
    el.addEventListener('mousedown', () => { el.style.transform = 'scale(0.97)'; });
  }

  createLandingButtonDOM() {
    if (this.landingBtnEl) return;
    const el = document.createElement('button');
    el.id = 'menu-landing-btn';
    el.style.cssText = `
      position: fixed; left: 16px; top: 76px; z-index: 14;
      width: 112px; height: 38px; padding: 0 10px;
      font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold;
      color: #111; background: #ffdd55; border: 3px solid #000; border-radius: 8px;
      cursor: pointer; box-shadow: 2px 2px 0 rgba(0,0,0,0.35);
      display:flex;align-items:center;justify-content:center;
    `;
    el.textContent = 'Landing';
    el.addEventListener('click', () => this.openLanding());
    document.body.appendChild(el);
    this.landingBtnEl = el;
  }

  openLanding() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Landing');
  }

  destroyLandingButtonDOM() {
    if (this.landingBtnEl) { this.landingBtnEl.remove(); this.landingBtnEl = null; }
  }

  createWalletButtonDOM() {
    if (this.walletBtnEl) return;
    const compact = this.scale.width < 420;
    const el = document.createElement('button');
    el.id = 'menu-wallet-btn';
    el.style.cssText = `
      position: fixed; right: ${compact ? 12 : 18}px; top: ${compact ? 18 : 18}px; z-index: 14;
      min-width: ${compact ? 150 : 176}px; height: 48px; padding: 0 ${compact ? 12 : 16}px;
      font-family: 'Courier New', monospace; font-size: ${compact ? 12 : 14}px; font-weight: bold;
      color: #101821; background: #ffffff; border: 3px solid #000; border-radius: 10px;
      cursor: pointer; letter-spacing: 1px; box-shadow: 3px 3px 0 rgba(0,0,0,0.35);
      display:flex;align-items:center;justify-content:center;
      transition: transform 0.08s ease, filter 0.08s ease;
      white-space: nowrap;
    `;
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.changeWallet());
    document.body.appendChild(el);
    this.walletBtnEl = el;
    this.unsubscribeWallet = subscribeWallet((state) => {
      this.walletAccount = state.account;
      this.walletStatus = state.status;
      this.refreshWalletButton();
    });
    this.refreshWalletButton();
  }

  async changeWallet() {
    try {
      await connectBrowserWallet({ forceSelection: true });
    } catch (error) {
      this.walletStatus = explainWalletError(error?.message || String(error));
      this.refreshWalletButton();
    }
  }

  refreshWalletButton() {
    if (!this.walletBtnEl) return;
    const state = getWalletState();
    const account = this.walletAccount || state.account;
    const status = this.walletStatus || state.status;
    const label = account
      ? shortAddress(account)
      : (status || 'CONNECT WALLET');
    this.walletBtnEl.textContent = label;
    this.walletBtnEl.style.background = account ? '#7CFFB0' : '#ffffff';
  }

  destroyWalletButtonDOM() {
    if (this.walletBtnEl) { this.walletBtnEl.remove(); this.walletBtnEl = null; }
  }

  // Secondary button: jump to the Agent Arena lobby (watch bots play).
  createArenaDOM() {
    if (this.arenaEl) return;
    const el = document.createElement('button');
    el.id = 'menu-arena';
    el.style.cssText = this.menuActionCss({ background: '#5fd0e6', color: '#10343d', fontSize: 16 });
    this.placeMenuActionButton(el, 'arena');
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.openArena());
    document.body.appendChild(el);
    this.arenaEl = el;
    this.arenaEl.textContent = '🤖  AGENT ARENA';
  }

  openArena() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Lobby', { backTo: 'Menu' });
  }

  destroyArenaDOM() {
    if (this.arenaEl) { this.arenaEl.remove(); this.arenaEl = null; }
  }

  createLeaderboardButtonDOM() {
    if (this.leaderboardBtnEl) return;
    const el = document.createElement('button');
    el.id = 'menu-leaderboard-btn';
    el.style.cssText = this.menuActionCss({ background: '#7CFFB0', color: '#1d2610', fontSize: 16 });
    this.placeMenuActionButton(el, 'leaderboard');
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.openLeaderboard());
    document.body.appendChild(el);
    this.leaderboardBtnEl = el;
    this.leaderboardBtnEl.textContent = '🏆  LEADERBOARD';
  }

  openLeaderboard() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Leaderboard', { backTo: 'Menu' });
  }

  destroyLeaderboardButtonDOM() {
    if (this.leaderboardBtnEl) { this.leaderboardBtnEl.remove(); this.leaderboardBtnEl = null; }
  }

  createRedeemButtonDOM() {
    if (this.redeemBtnEl) return;
    const el = document.createElement('button');
    el.id = 'menu-redeem-btn';
    el.style.cssText = this.menuActionCss({ background: '#bff3ff', color: '#10252c', fontSize: 16 });
    this.placeMenuActionButton(el, 'redeem');
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.openRedeem());
    document.body.appendChild(el);
    this.redeemBtnEl = el;
    this.redeemBtnEl.textContent = '💎  REDEEM RES';
  }

  openRedeem() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Redeem', { backTo: 'Menu' });
  }

  destroyRedeemButtonDOM() {
    if (this.redeemBtnEl) { this.redeemBtnEl.remove(); this.redeemBtnEl = null; }
  }

  createSocialFuelButtonDOM() {
    if (this.socialFuelBtnEl) return;
    const el = document.createElement('button');
    el.id = 'menu-social-btn';
    el.style.cssText = this.menuActionCss({ background: '#76f6a5', color: '#102116', fontSize: 15 });
    this.placeMenuActionButton(el, 'social');
    this.bindMenuActionMotion(el);
    el.addEventListener('click', () => this.openSocialFuel());
    document.body.appendChild(el);
    this.socialFuelBtnEl = el;
    this.socialFuelBtnEl.textContent = 'FREE wVARA';
  }

  openSocialFuel() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'SocialFuel', { backTo: 'Menu' });
  }

  destroySocialFuelButtonDOM() {
    if (this.socialFuelBtnEl) { this.socialFuelBtnEl.remove(); this.socialFuelBtnEl = null; }
  }

  destroyTunnelOverlay() {
    if (this.tunnelOverlayEl) {
      this.tunnelOverlayEl.remove();
      this.tunnelOverlayEl = null;
    }
  }

  onResize(size) {
    // Easiest: restart the scene to re-lay everything out cleanly.
    this.scene.restart();
  }

  drawBg(W, H, groundY) {
    const g = this.bgGfx;
    g.clear();
    // === Sky — two-band gradient, deeper toward the horizon.
    g.fillStyle(0x6fa3d9, 1);
    g.fillRect(0, 0, W, groundY * 0.4);
    g.fillStyle(0x88b8e0, 1);
    g.fillRect(0, groundY * 0.4, W, groundY * 0.6);

    // === Underground (below horizon): dark brown with darker speckles.
    g.fillStyle(0x3a2412, 1);
    g.fillRect(0, groundY, W, H - groundY);
    g.fillStyle(0x1f130a, 0.55);
    for (let yy = groundY + 6; yy < H; yy += 14) {
      for (let xx = 4; xx < W; xx += 14) {
        const s = ((xx * 73856093) ^ (yy * 19349663)) >>> 0;
        const ox = (s % 8);
        const oy = ((s >>> 8) % 8);
        const sz = 2 + ((s >>> 16) % 3);
        g.fillRect(xx + ox, yy + oy, sz, sz);
      }
    }

    // === Clouds — layered, with a soft inner highlight.
    const clouds = [
      { x: W * 0.10, y: groundY * 0.20, w: 140, h: 32 },
      { x: W * 0.30, y: groundY * 0.10, w: 110, h: 28 },
      { x: W * 0.72, y: groundY * 0.18, w: 170, h: 36 },
      { x: W * 0.92, y: groundY * 0.30, w: 110, h: 28 },
    ];
    for (const c of clouds) {
      // shadow
      g.fillStyle(0xb6cde0, 0.85);
      g.fillEllipse(c.x + 4, c.y + 6, c.w + 8, c.h + 4);
      // body
      g.fillStyle(0xffffff, 1);
      g.fillEllipse(c.x, c.y, c.w, c.h);
      g.fillEllipse(c.x + c.w * 0.30, c.y - c.h * 0.30, c.w * 0.70, c.h);
      g.fillEllipse(c.x - c.w * 0.30, c.y + c.h * 0.10, c.w * 0.55, c.h * 0.85);
      // highlight
      g.fillStyle(0xffffff, 0.85);
      g.fillEllipse(c.x - c.w * 0.05, c.y - c.h * 0.20, c.w * 0.55, c.h * 0.55);
    }

    // === Mountain — central peak with a darker right-shadow + green
    // grassy slope sections, snow cap, and side ridges. Built from
    // triangles so it scales cleanly. Anchored to the horizon line.
    const peakX = W * 0.5;
    const peakY = groundY - H * 0.55;
    const baseLeftX  = W * 0.10;
    const baseRightX = W * 0.90;
    // Back ridges (lower, lighter for atmospheric depth)
    g.fillStyle(0x5a8c66, 1);
    g.fillTriangle(W * 0.02,  groundY, W * 0.20, groundY - H * 0.30, W * 0.38, groundY);
    g.fillTriangle(W * 0.62, groundY, W * 0.80, groundY - H * 0.32, W * 0.98, groundY);
    // Main mountain — brown rocky base
    g.fillStyle(0x6e4a28, 1);
    g.fillTriangle(baseLeftX, groundY, peakX, peakY, baseRightX, groundY);
    // Right-side shadow slope (darker brown)
    g.fillStyle(0x4a2e14, 1);
    g.fillTriangle(peakX, peakY, baseRightX, groundY, peakX + W * 0.08, groundY);
    // Green grass cover on the lower flanks (left + right)
    g.fillStyle(0x4a8c3a, 1);
    g.fillTriangle(baseLeftX,        groundY,
                   peakX - W * 0.10, peakY + H * 0.30,
                   peakX + W * 0.04, groundY);
    g.fillStyle(0x3a6e2a, 1);
    g.fillTriangle(peakX + W * 0.04, groundY,
                   peakX - W * 0.02, peakY + H * 0.32,
                   baseRightX - W * 0.05, groundY);
    // Snow cap — math-driven so the base sits exactly on the mountain
    // slope. The mountain runs from peak (peakX, peakY) to the base
    // corners (W*0.10, groundY) / (W*0.90, groundY); a snow band of
    // height `snowH` interpolates along that slope.
    const snowH = H * 0.10;
    const mountH = groundY - peakY;
    const mountHalfBase = peakX - baseLeftX;
    const t = snowH / mountH;
    const snowBaseY = peakY + snowH;
    const snowL = peakX - mountHalfBase * t;
    const snowR = peakX + mountHalfBase * t;
    g.fillStyle(0xf2f6ff, 1);
    g.fillTriangle(snowL, snowBaseY, peakX, peakY, snowR, snowBaseY);
    // Wavy snow drip line — three little tongues hanging below the
    // straight base, so the snow doesn't read as a sharp triangle slice.
    g.fillTriangle(snowL,                       snowBaseY,
                   peakX - mountHalfBase * t * 0.6, snowBaseY + 8,
                   peakX - mountHalfBase * t * 0.2, snowBaseY);
    g.fillTriangle(peakX + mountHalfBase * t * 0.2, snowBaseY,
                   peakX + mountHalfBase * t * 0.6, snowBaseY + 6,
                   snowR,                            snowBaseY);
    g.fillTriangle(peakX - mountHalfBase * t * 0.25, snowBaseY,
                   peakX,                            snowBaseY + 12,
                   peakX + mountHalfBase * t * 0.25, snowBaseY);
    // Soft shadow under the snow — darker grey strip on the right slope.
    g.fillStyle(0xc8d0e0, 0.85);
    g.fillTriangle(peakX,        peakY + 4,
                   snowR,        snowBaseY,
                   peakX,        snowBaseY);
    // Stone outcrops on the slope
    g.fillStyle(0x9a8a72, 1);
    g.fillTriangle(peakX - W * 0.10, peakY + H * 0.20, peakX - W * 0.06, peakY + H * 0.18, peakX - W * 0.07, peakY + H * 0.24);
    g.fillTriangle(peakX + W * 0.07, peakY + H * 0.22, peakX + W * 0.10, peakY + H * 0.20, peakX + W * 0.09, peakY + H * 0.26);

    // === Pine trees (silhouettes) — flanking the mine entrance.
    const drawPine = (cx, baseY, sz) => {
      g.fillStyle(0x274a1a, 1);
      g.fillTriangle(cx - sz, baseY,         cx, baseY - sz * 1.4, cx + sz, baseY);
      g.fillTriangle(cx - sz * 0.85, baseY - sz * 0.6, cx, baseY - sz * 1.9, cx + sz * 0.85, baseY - sz * 0.6);
      g.fillTriangle(cx - sz * 0.7,  baseY - sz * 1.1, cx, baseY - sz * 2.3, cx + sz * 0.7,  baseY - sz * 1.1);
      g.fillStyle(0x3a2210, 1);
      g.fillRect(cx - 3, baseY, 6, sz * 0.25);
    };
    drawPine(W * 0.18, groundY, 26);
    drawPine(W * 0.27, groundY, 18);
    drawPine(W * 0.74, groundY, 22);
    drawPine(W * 0.84, groundY, 28);

    // === Bushes / shrubs along the ground line.
    const drawBush = (cx, baseY, w, h) => {
      g.fillStyle(0x2f6a30, 1);
      g.fillEllipse(cx, baseY - h * 0.4, w, h);
      g.fillEllipse(cx + w * 0.35, baseY - h * 0.55, w * 0.7, h * 0.85);
      g.fillEllipse(cx - w * 0.30, baseY - h * 0.45, w * 0.65, h * 0.75);
      g.fillStyle(0x4ea846, 1);
      g.fillEllipse(cx - w * 0.15, baseY - h * 0.55, w * 0.5, h * 0.55);
    };
    drawBush(W * 0.08, groundY, 60, 26);
    drawBush(W * 0.36, groundY, 50, 22);
    drawBush(W * 0.62, groundY, 56, 24);
    drawBush(W * 0.92, groundY, 60, 28);

    // === Mine entrance — chunky wooden frame: thick posts + thick top
    // lintel. Torches mount directly onto the posts so they don't look
    // like they're floating in mid-air.
    const mineW = Math.min(240, W * 0.20);
    const mineH = mineW * 1.05;
    const mineX = peakX - mineW / 2;
    const mineY = groundY - mineH;
    const postW   = 32;
    const lintelH = 32;
    // Interior — deep black void inside the frame.
    g.fillStyle(0x080604, 1);
    g.fillRect(mineX + postW, mineY + lintelH, mineW - postW * 2, mineH - lintelH);
    // Left + right wooden posts (thicker, with hi-light strip + dark edge).
    g.fillStyle(0x4a2a08, 1);
    g.fillRect(mineX,                  mineY, postW, mineH);
    g.fillRect(mineX + mineW - postW,  mineY, postW, mineH);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(mineX + 4,                  mineY + 4, postW - 8, mineH - 8);
    g.fillRect(mineX + mineW - postW + 4,  mineY + 4, postW - 8, mineH - 8);
    g.fillStyle(0x8d5d2a, 1);
    g.fillRect(mineX + 8,                  mineY + 6, 4, mineH - 12);
    g.fillRect(mineX + mineW - postW + 8,  mineY + 6, 4, mineH - 12);
    // Wood grain — vertical streaks down each post.
    g.fillStyle(0x3a1f08, 0.65);
    g.fillRect(mineX + postW - 8, mineY + 4, 1, mineH - 8);
    g.fillRect(mineX + mineW - 8, mineY + 4, 1, mineH - 8);
    // Iron bolts at the post tops + bottoms.
    g.fillStyle(0x1a1a1a, 1);
    g.fillRect(mineX + 6,                  mineY + 6,         5, 5);
    g.fillRect(mineX + 6,                  mineY + mineH - 12, 5, 5);
    g.fillRect(mineX + mineW - 12,         mineY + 6,         5, 5);
    g.fillRect(mineX + mineW - 12,         mineY + mineH - 12, 5, 5);
    g.fillStyle(0x6a6a6a, 1);
    g.fillRect(mineX + 7,                  mineY + 7,         2, 2);
    g.fillRect(mineX + mineW - 11,         mineY + 7,         2, 2);
    // Top lintel beam — thicker, sits across the top of both posts.
    g.fillStyle(0x4a2a08, 1);
    g.fillRect(mineX - 6, mineY, mineW + 12, lintelH);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(mineX - 4, mineY + 4, mineW + 8, lintelH - 8);
    g.fillStyle(0x8d5d2a, 1);
    g.fillRect(mineX - 4, mineY + 6, mineW + 8, 6);
    // Plank seams on the lintel
    g.fillStyle(0x3a1f08, 1);
    for (let bx = mineX; bx < mineX + mineW; bx += 22) {
      g.fillRect(bx, mineY + 4, 1, lintelH - 8);
    }
    // Bolts on the lintel corners + center
    g.fillStyle(0x1a1a1a, 1);
    g.fillRect(mineX + 4,                  mineY + 6, 5, 5);
    g.fillRect(mineX + mineW - 9,          mineY + 6, 5, 5);
    g.fillRect(mineX + mineW * 0.5 - 2,    mineY + 6, 5, 5);

    // === Torch anchors — mounted on the FRONT of each post, mid-height,
    // so they sit visually attached to the wood. Drawn upright (no tilt)
    // by drawTorches() each frame.
    this._torchAnchors = [
      { x: mineX + postW / 2,              y: mineY + 80 },
      { x: mineX + mineW - postW / 2,      y: mineY + 80 },
    ];

    // Bounds of the dark cave interior — used by drawEyes() to place
    // glowing creature eyes that fade in and out from the shadows.
    this._mineBounds = {
      x: mineX + postW,
      y: mineY + lintelH,
      w: mineW - postW * 2,
      h: mineH - lintelH,
    };

    // 3 creatures with different colours, positions and rhythms. x/y
    // are fractions of the cave interior; phase shifts each pair so
    // they wink in and out at different beats.
    this._eyes = [
      { x: 0.25, y: 0.30, period: 5400, phase:    0, color: 0xffd84a },
      { x: 0.72, y: 0.45, period: 6200, phase: 2200, color: 0xff5a50 },
      { x: 0.50, y: 0.78, period: 7000, phase: 4400, color: 0x9effff },
    ];

    // === Treasure pile on the grass — visible to the LEFT of the mine
    // entrance (outside the dark interior so it actually reads). Mirrors
    // the reference image: an open chest spilling gold, with chunky
    // gems sitting next to it.
    const treasureX = mineX - 90;
    const treasureY = groundY - 4;
    // Chest base — much bigger than the previous "tucked inside" version.
    const ch = 38;
    const cw = 60;
    g.fillStyle(0x4a2a08, 1);
    g.fillRect(treasureX,        treasureY - ch,     cw, ch);    // shadow
    g.fillStyle(0x7a4a1a, 1);
    g.fillRect(treasureX + 2,    treasureY - ch + 2, cw - 4, ch - 4);
    g.fillStyle(0xa06a2c, 1);
    g.fillRect(treasureX + 4,    treasureY - ch + 4, cw - 8, 10);
    // arched lid (open, leaning back)
    g.fillStyle(0x4a2a08, 1);
    g.fillTriangle(treasureX,        treasureY - ch + 4,
                   treasureX + cw / 2, treasureY - ch - 16,
                   treasureX + cw,    treasureY - ch + 4);
    g.fillStyle(0xa06a2c, 1);
    g.fillTriangle(treasureX + 4,    treasureY - ch + 4,
                   treasureX + cw / 2, treasureY - ch - 12,
                   treasureX + cw - 4, treasureY - ch + 4);
    // Iron bands across the chest body
    g.fillStyle(0x3a2a14, 1);
    g.fillRect(treasureX + 4, treasureY - ch + 16, cw - 8, 2);
    g.fillRect(treasureX + 4, treasureY - 8,        cw - 8, 2);
    // Gold lock
    g.fillStyle(0xffd84a, 1);
    g.fillRect(treasureX + cw / 2 - 6, treasureY - ch + 6, 12, 12);
    g.fillStyle(0x3a2a14, 1);
    g.fillRect(treasureX + cw / 2 - 1, treasureY - ch + 10, 2, 4);
    // Gold coin pile spilling from / next to the chest
    const drawCoinStack = (cx, cy, n) => {
      for (let i = 0; i < n; i++) {
        g.fillStyle(0x6a4a14, 1);
        g.fillEllipse(cx, cy - i * 4, 18, 6);
        g.fillStyle(0xffd84a, 1);
        g.fillEllipse(cx, cy - i * 4 - 1, 16, 4);
        g.fillStyle(0xfff5b0, 1);
        g.fillRect(cx - 4, cy - i * 4 - 2, 4, 1);
      }
    };
    drawCoinStack(treasureX - 22, treasureY - 6, 4);
    drawCoinStack(treasureX + cw + 22, treasureY - 6, 3);
    // Loose coins scattered
    g.fillStyle(0xffd84a, 1);
    g.fillEllipse(treasureX - 8,         treasureY - 4, 14, 5);
    g.fillEllipse(treasureX + cw + 6,    treasureY - 5, 12, 5);
    g.fillEllipse(treasureX + 12,        treasureY - 2, 10, 4);

    // (Crystals removed — the chest + coins read better on their own.)

    // === Subtle interior glow inside the mine — just a pair of distant
    // sparkles to suggest "more treasure hidden deeper" without
    // competing with the chest pile out front.
    g.fillStyle(0xffd84a, 0.85);
    g.fillRect(mineX + mineW * 0.30, mineY + 50, 3, 3);
    g.fillRect(mineX + mineW * 0.65, mineY + 70, 3, 3);
    g.fillStyle(0x6fdbf6, 0.85);
    g.fillRect(mineX + mineW * 0.45, mineY + 90, 3, 3);

    // === Decorative flowers on the foreground grass.
    const flowers = [
      { x: W * 0.04, c: 0xff5fa0 },
      { x: W * 0.13, c: 0xffd84a },
      { x: W * 0.45, c: 0xffd84a },
      { x: W * 0.55, c: 0xff5fa0 },
      { x: W * 0.92, c: 0xff5fa0 },
      { x: W * 0.96, c: 0xffd84a },
    ];
    for (const f of flowers) {
      g.fillStyle(0x274a1a, 1);
      g.fillRect(f.x - 1, groundY - 8, 2, 6);
      g.fillStyle(f.c, 1);
      g.fillRect(f.x - 3, groundY - 12, 6, 4);
      g.fillStyle(0xffffff, 1);
      g.fillRect(f.x,     groundY - 11, 1, 1);
    }

    // === Stones / pebbles along the dirt edge.
    g.fillStyle(0x6a5a4a, 1);
    g.fillEllipse(W * 0.22, groundY + 4, 30, 14);
    g.fillEllipse(W * 0.78, groundY + 4, 28, 12);
    g.fillStyle(0x9a8a72, 1);
    g.fillEllipse(W * 0.22 - 4, groundY + 1, 14, 6);
    g.fillEllipse(W * 0.78 - 4, groundY + 1, 12, 5);
  }

  // Animated torch flames at the mine entrance. Anchors are stamped by
  // drawBg(); each torch is bigger now and tilts outward from the mine
  // (left torch leans LEFT, right torch leans RIGHT) so they read like
  // wall sconces emerging from the rock.
  drawTorches() {
    const g = this.torchGfx;
    if (!g || !this._torchAnchors) return;
    g.clear();
    const t = this.time?.now || 0;
    for (let i = 0; i < this._torchAnchors.length; i++) {
      const a = this._torchAnchors[i];
      const flick = Math.floor((t + a.x * 7) / 80) % 3;
      // Straight upright — torches are bolted to a flat post face.
      g.save();
      g.translateCanvas(a.x, a.y);
      // === Draw torch around (0,0) with shaft going UP from origin.
      // Bracket / wall mount
      g.fillStyle(0x3a2a14, 1);
      g.fillRect(-12, 6, 24, 7);
      g.fillStyle(0x6a4a14, 1);
      g.fillRect(-10, 6, 20, 7);
      g.fillStyle(0xa07a4a, 1);
      g.fillRect(-10, 6, 20, 2); // top hi-light on bracket
      // Shaft (longer + wider than before)
      g.fillStyle(0x3a1f08, 1);
      g.fillRect(-5, -10, 10, 18);
      g.fillStyle(0x6a3e15, 1);
      g.fillRect(-4, -10,  8, 18);
      g.fillStyle(0x8d5d2a, 1);
      g.fillRect(-2, -10,  3, 18); // hi-light streak
      // Bowl at the top of the shaft
      g.fillStyle(0x2a1a08, 1);
      g.fillRect(-9, -14, 18, 6);
      g.fillStyle(0x6a4a14, 1);
      g.fillRect(-8, -13, 16, 4);
      // Flame — 3 stacked triangles, larger than before
      const tipY = -34 - flick;
      g.fillStyle(0xc62828, 1);
      g.fillTriangle(-13, -10, 0, tipY,        13, -10);
      g.fillStyle(0xff7a20, 1);
      g.fillTriangle(-9,  -10, 0, tipY + 6,     9, -10);
      g.fillStyle(0xffd84a, 1);
      g.fillTriangle(-5,  -10, 0, tipY + 12,    5, -10);
      g.fillStyle(0xfff5b0, 0.95);
      g.fillTriangle(-2,  -10, 0, tipY + 18,    2, -10);
      // Floating sparks above the flame
      g.fillStyle(0xffd84a, 0.85);
      g.fillRect(-5 + flick, -28 + flick, 2, 2);
      g.fillRect( 5 - flick, -25 - flick, 2, 2);
      g.fillRect(  flick - 1, -32 - flick, 1, 1);
      // Soft warm halo around the flame
      g.fillStyle(0xffaa20, 0.18);
      g.fillEllipse(0, -16, 90, 70);
      g.restore();
    }
  }

  // Glowing creature eyes peeking out of the dark mine. Each "creature"
  // cycles through fade-in → blink → hold → fade-out → hidden, with a
  // staggered phase so they don't all appear at once. Hints at future
  // cave mobs without committing to any specific gameplay.
  drawEyes() {
    const g = this.torchGfx;
    if (!g || !this._eyes || !this._mineBounds) return;
    const t = this.time?.now || 0;
    const mb = this._mineBounds;
    const FADE_IN  = 900;
    const HOLD     = 1700;
    const FADE_OUT = 900;
    const cycle = FADE_IN + HOLD + FADE_OUT; // active duration; rest of period = hidden
    for (const e of this._eyes) {
      const phase = ((t + e.phase) % e.period + e.period) % e.period;
      let alpha = 0;
      if (phase < FADE_IN) {
        alpha = phase / FADE_IN;
      } else if (phase < FADE_IN + HOLD) {
        alpha = 1;
        // Brief 90ms blink in the middle of the hold.
        const blinkAt = FADE_IN + HOLD * 0.5;
        if (phase >= blinkAt && phase < blinkAt + 90) alpha *= 0.15;
      } else if (phase < cycle) {
        alpha = 1 - (phase - FADE_IN - HOLD) / FADE_OUT;
      } else {
        alpha = 0;
      }
      if (alpha <= 0.02) continue;
      // Subtle floating drift — eyes slowly bob up and down.
      const drift = Math.sin((t + e.phase) / 380) * 1.6;
      const cx = mb.x + mb.w * e.x;
      const cy = mb.y + mb.h * e.y + drift;
      // Soft halo so the eyes feel like they're glowing through fog.
      g.fillStyle(e.color, 0.18 * alpha);
      g.fillEllipse(cx, cy, 32, 16);
      g.fillStyle(e.color, 0.10 * alpha);
      g.fillEllipse(cx, cy, 56, 28);
      // Two tiny eye dots side by side.
      g.fillStyle(e.color, alpha);
      g.fillRect(cx - 6, cy - 1, 4, 4);
      g.fillRect(cx + 2, cy - 1, 4, 4);
      // Bright pupil pip.
      g.fillStyle(0xffffff, alpha * 0.95);
      g.fillRect(cx - 5, cy,     1, 1);
      g.fillRect(cx + 3, cy,     1, 1);
    }
  }

  drawGround(g, W, y) {
    g.clear();
    // Thin grass strip
    g.fillStyle(0x3dbb54, 1);
    g.fillRect(0, y - 6, W, 6);
    g.fillStyle(0x2a8c3d, 1);
    g.fillRect(0, y - 2, W, 2);
  }

  drawTunnelHole(progress = 1) {
    const W = this.scale.width;
    const H = this.scale.height;
    const g = this.groundGfx;
    g.clear();

    const p = Phaser.Math.Clamp(progress, 0, 1);
    const holeW = TILE * (1.1 + 1.5 * p);
    const holeX = this.robotX - holeW / 2;
    const shaftBottom = Phaser.Math.Linear(this.groundY + 28, H + TILE * 1.5, p);

    // Grass strip with a clean opening in the middle.
    g.fillStyle(0x3dbb54, 1);
    g.fillRect(0, this.groundY - 6, holeX, 6);
    g.fillRect(holeX + holeW, this.groundY - 6, W - (holeX + holeW), 6);
    g.fillStyle(0x2a8c3d, 1);
    g.fillRect(0, this.groundY - 2, holeX, 2);
    g.fillRect(holeX + holeW, this.groundY - 2, W - (holeX + holeW), 2);

    // Black void plus darker earth lips so the hole reads as depth, not a cutout.
    g.fillStyle(0x070401, 1);
    g.fillRect(holeX + TILE * 0.18, this.groundY - 2, holeW - TILE * 0.36, shaftBottom - this.groundY + 2);
    g.fillStyle(0x1b0f07, 1);
    g.fillRect(holeX, this.groundY, TILE * 0.22, shaftBottom - this.groundY);
    g.fillRect(holeX + holeW - TILE * 0.22, this.groundY, TILE * 0.22, shaftBottom - this.groundY);
    g.fillStyle(0x000000, 0.7);
    g.fillEllipse(this.robotX, this.groundY + 4, holeW * 0.9, 18 + 10 * p);

    // Dust and broken dirt around the rim.
    g.fillStyle(0x8b5a2b, 0.65);
    g.fillEllipse(this.robotX, this.groundY - 2, holeW + 26, 14 + 8 * p);
    g.fillStyle(0x5a351c, 0.9);
    for (let i = 0; i < 9; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const ox = side * (holeW * 0.28 + (i % 3) * 8);
      const oy = -4 + (i % 4) * 4;
      g.fillRect(Math.round(this.robotX + ox), Math.round(this.groundY + oy), 5 + (i % 3), 3);
    }
  }

  drawRobot(g, px, py, opts = {}) {
    // Menu robot uses the same grey chassis as gameplay, but without the
    // drill. In-game drawRobot passes digging=true only while a block is
    // actively being drilled, so the tool feels like it is being pulled out.
    g.clear();
    const T = TILE * 2;
    const time = (this.time && this.time.now) || 0;
    const digging = opts.digging ?? this.menuRobotDigging ?? false;
    const facing = opts.facing ?? (digging ? 'down' : 'right');

    // Softer menu-only shadow. The shared robot stays crisp in gameplay.
    g.fillStyle(0x000000, 0.12);
    g.fillEllipse(px, py + T * 0.46, T * 0.86, 18);
    g.fillStyle(0x000000, 0.18);
    g.fillEllipse(px, py + T * 0.47, T * 0.62, 9);

    drawSharedRobot(g, px, py, T, {
      facing,
      digging,
      time,
      shadow: false,
      hat: this.menuHat,
      bodyColor: this.menuColor,
      tier: 1,
    });
  }

  // Generic localStorage helpers — used for both hat and body color so we
  // don't duplicate identical try/catch blocks per cosmetic.
  loadStored(key, validIds) {
    try {
      const v = localStorage.getItem(key);
      if (v && validIds.includes(v)) return v;
    } catch { /* localStorage unavailable */ }
    return null;
  }
  persist(key, value) {
    try { localStorage.setItem(key, value); } catch { /* noop */ }
  }

  // Tiny ✏️ icon pinned to the top-left. Default state is a 44×44
  // square button. Tapping it pops a
  // small floating panel anchored under the icon — same HAT + COLOR
  // controls + 🎲 surprise. Click outside collapses. Doesn't shift the
  // menu layout, doesn't crowd the centre between robot and START, and
  // stays inside the viewport on mobile (left edge is universally safe).
  createCustomizerDOM() {
    if (this.customizerEl) return;

    const wrap = document.createElement('div');
    wrap.id = 'menu-customizer';
    wrap.style.cssText = `
      position: fixed; top: 16px; left: 16px; z-index: 16;
      font-family: 'Courier New', monospace;
      display: flex; flex-direction: column; align-items: flex-start; gap: 0;
    `;
    wrap.innerHTML = `
      <button id="cstm-toggle" title="Customize robot" style="
        background:#ffffff;color:#222;
        border:3px solid #000;border-radius:12px;
        width:52px;height:52px;padding:0;
        font-family:inherit;font-size:24px;cursor:pointer;
        display:flex;align-items:center;justify-content:center">✏️</button>
      <div id="cstm-panel" style="
        margin-top:8px; max-height:0; overflow:hidden;
        transition:max-height .25s ease, opacity .18s ease, padding .25s ease;
        opacity:0;
        background:#1d140b; color:#f1e6cf;
        border:3px solid #4b2e15; border-radius:14px;
        width:280px;">
        <div style="padding:0 14px;display:flex;flex-direction:column;gap:8px">
          ${this.cstmRowHTML('hat',   'HAT')}
          ${this.cstmRowHTML('color', 'COLOR')}
          <button data-act="surprise" style="font-family:inherit;cursor:pointer;
            background:#7fc99c;color:#0e2e1e;border:2px solid #0e2e1e;
            border-radius:10px;padding:8px;font-weight:bold;font-size:13px;
            letter-spacing:1px;margin-bottom:4px">🎲 SURPRISE ME</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    this.customizerEl   = wrap;
    this.cstmToggleBtn  = wrap.querySelector('#cstm-toggle');
    this.cstmPanelEl    = wrap.querySelector('#cstm-panel');
    this.cstmHatLabel   = wrap.querySelector('#cstm-hat-label');
    this.cstmColorLabel = wrap.querySelector('#cstm-color-label');
    this.cstmColorDot   = wrap.querySelector('#cstm-color-dot');
    this.cstmExpanded   = false;

    this.cstmToggleBtn.onclick = () => this.toggleCustomizer();
    wrap.querySelectorAll('button[data-kind]').forEach(b => {
      b.onclick = () => this.handleCstmClick(b.dataset.kind, b.dataset.act);
    });
    wrap.querySelector('button[data-act="surprise"]').onclick = () => this.handleCstmClick('all', 'random');

    // Click-outside collapses the panel.
    this.cstmOutsideHandler = (ev) => {
      if (!this.cstmExpanded) return;
      if (!wrap.contains(ev.target)) this.toggleCustomizer(false);
    };
    document.addEventListener('mousedown', this.cstmOutsideHandler);
    document.addEventListener('touchstart', this.cstmOutsideHandler);

    this.refreshCustomizerLabels();
  }

  cstmRowHTML(kind, label) {
    const arrowCss = `font-family:inherit;cursor:pointer;background:#3a2614;color:#f1e6cf;
      border:2px solid #4b2e15;border-radius:8px;padding:6px 12px;font-size:15px;font-weight:bold`;
    const valueCell = kind === 'hat'
      ? `<span id="cstm-hat-label" style="font-size:14px;font-weight:bold"></span>`
      : `<span id="cstm-color-dot" style="display:inline-block;width:16px;height:16px;
           border-radius:50%;border:2px solid #000"></span>
         <span id="cstm-color-label" style="font-size:14px;font-weight:bold"></span>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;
        padding:8px 0;border-bottom:1px solid #3a2614">
        <div style="font-size:11px;letter-spacing:1.5px;opacity:.7;width:46px">${label}</div>
        <button data-kind="${kind}" data-act="prev" style="${arrowCss}">◀</button>
        <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px;
          min-width:0;text-align:center">${valueCell}</div>
        <button data-kind="${kind}" data-act="next" style="${arrowCss}">▶</button>
      </div>`;
  }

  toggleCustomizer(force) {
    const next = force == null ? !this.cstmExpanded : !!force;
    this.cstmExpanded = next;
    if (next) {
      this.cstmPanelEl.style.maxHeight = '260px';
      this.cstmPanelEl.style.opacity   = '1';
      this.cstmPanelEl.style.padding   = '8px 0';
      this.cstmToggleBtn.style.background = '#f7f3e8';
    } else {
      this.cstmPanelEl.style.maxHeight = '0';
      this.cstmPanelEl.style.opacity   = '0';
      this.cstmPanelEl.style.padding   = '0';
      this.cstmToggleBtn.style.background = '#ffffff';
    }
  }

  handleCstmClick(kind, act) {
    if (kind === 'all' && act === 'random') {
      this.menuHat   = pickRandomHat();
      this.menuColor = pickRandomBodyColor();
    } else if (kind === 'hat') {
      this.menuHat = this.cycle(HAT_IDS, this.menuHat, act, pickRandomHat);
    } else if (kind === 'color') {
      this.menuColor = this.cycle(BODY_COLOR_IDS, this.menuColor, act, pickRandomBodyColor);
    }
    this.persist('robo.hat',   this.menuHat);
    this.persist('robo.color', this.menuColor);
    this.refreshCustomizerLabels();
    this.playRobotChirp();
  }

  cycle(ids, current, act, randomFn) {
    if (act === 'random') return randomFn();
    const i = ids.indexOf(current);
    const len = ids.length;
    return ids[act === 'next' ? (i + 1) % len : (i - 1 + len) % len];
  }

  refreshCustomizerLabels() {
    if (this.cstmHatLabel)   this.cstmHatLabel.textContent   = HAT_LABELS[this.menuHat]         || this.menuHat;
    if (this.cstmColorLabel) this.cstmColorLabel.textContent = BODY_COLOR_LABELS[this.menuColor] || this.menuColor;
    if (this.cstmColorDot)   this.cstmColorDot.style.background = BODY_COLOR_SWATCH[this.menuColor] || '#888';
  }

  destroyCustomizerDOM() {
    if (this.cstmOutsideHandler) {
      document.removeEventListener('mousedown', this.cstmOutsideHandler);
      document.removeEventListener('touchstart', this.cstmOutsideHandler);
      this.cstmOutsideHandler = null;
    }
    if (this.customizerEl) { this.customizerEl.remove(); this.customizerEl = null; }
  }

  // Sound button mirroring the ✏️ customize button — sits to its right
  // and cycles through 3 states (full → half → mute → full). Volume is
  // applied globally via Phaser's master sound manager so it survives
  // scene transitions, and persisted in localStorage so reloads
  // remember the choice.
  createSoundButtonDOM() {
    if (this.soundBtnEl) return;
    // Restore stored volume.
    let stored = 1;
    try {
      const v = localStorage.getItem('robo.volume');
      if (v != null) stored = Math.max(0, Math.min(1, parseFloat(v)));
    } catch { /* noop */ }
    this.applyVolume(stored);

    const btn = document.createElement('button');
    btn.id = 'menu-sound';
    btn.title = 'Sound (toggles full / half / mute)';
    btn.style.cssText = `
      position: fixed; top: 16px; left: 76px; z-index: 12;
      background:#ffffff; color:#222;
      border:3px solid #000; border-radius:12px;
      width:52px; height:52px; padding:0;
      font-family:'Courier New', monospace; font-size:24px; cursor:pointer;
      display:flex; align-items:center; justify-content:center;
    `;
    btn.onclick = () => this.cycleVolume();
    document.body.appendChild(btn);
    this.soundBtnEl = btn;
    this.refreshSoundButton();
  }

  cycleVolume() {
    // 4-state cycle: 1.0 (3 bars) → 0.66 (2) → 0.33 (1) → 0 (mute) → 1.0
    // Read from our own tracked field — Phaser's `sound.volume` can
    // return the pre-mute value while muted, which would scramble the
    // cycle (a single click wouldn't change state).
    const cur = this._volume ?? 1;
    let next;
    if (cur > 0.85)      next = 0.66;
    else if (cur > 0.5)  next = 0.33;
    else if (cur > 0)    next = 0;
    else                  next = 1;
    this.applyVolume(next);
    this.refreshSoundButton();
    if (next > 0) this.playRobotChirp();
  }

  applyVolume(v) {
    // Master volume on the Phaser sound manager affects every sound
    // (sfx + the menu music loop). Mute also short-circuits playback.
    this._volume = v;
    this.game.sound.volume = v;
    this.game.sound.mute = (v === 0);
    try { localStorage.setItem('robo.volume', String(v)); } catch { /* noop */ }
  }

  refreshSoundButton() {
    if (!this.soundBtnEl) return;
    const v = this._volume ?? this.game.sound.volume ?? 1;
    // Pick how many sound-wave bars to draw: 0 → muted (red slash),
    // 1 / 2 / 3 → escalating volume. The speaker body stays identical
    // so the only visual change is the bar count and the strike-line.
    const bars = v === 0 ? 0 : (v <= 0.4 ? 1 : v <= 0.75 ? 2 : 3);
    const muted = v === 0;
    // Inline SVG so the icon looks crisp at any DPI and the slash can
    // sit precisely over the speaker.
    this.soundBtnEl.innerHTML = `
      <svg viewBox="0 0 32 32" width="30" height="30" style="display:block">
        <!-- speaker body -->
        <path d="M5,12 L11,12 L18,7 L18,25 L11,20 L5,20 Z"
          fill="#222" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
        <!-- 3 sound-wave arcs, hidden one-by-one as volume drops -->
        ${bars >= 1 ? '<path d="M21,13 Q23,16 21,19" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        ${bars >= 2 ? '<path d="M24,11 Q27,16 24,21" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        ${bars >= 3 ? '<path d="M27,9  Q31,16 27,23" fill="none" stroke="#222" stroke-width="2" stroke-linecap="round"/>' : ''}
        <!-- mute slash -->
        ${muted ? '<line x1="6" y1="26" x2="28" y2="6" stroke="#e23a4f" stroke-width="3" stroke-linecap="round"/>' : ''}
      </svg>
    `;
  }

  destroySoundButtonDOM() {
    if (this.soundBtnEl) { this.soundBtnEl.remove(); this.soundBtnEl = null; }
  }

  // Called when the fall animation starts so the panel doesn't sit
  // visibly during the dive into the ground.
  hideGenerateButton() {
    if (!this.customizerEl) return;
    this.customizerEl.style.transition = 'opacity 0.2s';
    this.customizerEl.style.opacity = '0';
    this.customizerEl.style.pointerEvents = 'none';
  }

  hideMenuActionButtons() {
    for (const el of [this.startEl, this.arenaEl, this.leaderboardBtnEl, this.redeemBtnEl, this.socialFuelBtnEl, this.landingBtnEl, this.walletBtnEl, this.soundBtnEl]) {
      if (!el) continue;
      el.style.transition = 'opacity 0.24s ease, transform 0.08s ease';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
  }

  createTunnelOverlay() {
    if (this.tunnelOverlayEl) return;
    const d = document.createElement('div');
    d.id = 'menu-tunnel-overlay';
    d.style.cssText = `
      position: fixed; inset: 0; z-index: 13; pointer-events: none;
      opacity: 0; background: transparent;
    `;
    document.body.appendChild(d);
    this.tunnelOverlayEl = d;
  }

  updateTunnelOverlay(progress) {
    this.createTunnelOverlay();
    const p = Phaser.Math.Clamp(progress, 0, 1);
    const radius = Phaser.Math.Linear(320, 58, p);
    const soft = Phaser.Math.Linear(190, 52, p);
    const sx = this.robotX;
    const sy = Math.min(this.scale.height - 24, this.robotY);
    this.tunnelOverlayEl.style.opacity = String(Phaser.Math.Linear(0, 1, p));
    this.tunnelOverlayEl.style.background =
      `radial-gradient(circle at ${sx}px ${sy}px, ` +
      `rgba(0,0,0,0) 0, ` +
      `rgba(0,0,0,0) ${radius}px, ` +
      `rgba(0,0,0,0.72) ${radius + soft * 0.55}px, ` +
      `rgba(0,0,0,1) ${radius + soft}px)`;
  }

  startFall() {
    if (this._falling) return;
    this._falling = true;
    this.menuRobotDigging = true;
    this.playMenuDrillSound();

    // Fade out DOM buttons (CSS transition) and Phaser text. The Generate
    // button hides immediately so the dig animation isn't visually crowded.
    this.hideMenuActionButtons();
    this.hideGenerateButton();

    this.hideMenuBubble();
    const fadeTargets = [this.logo, this.tagline].filter(Boolean);
    if (fadeTargets.length) {
      this.tweens.add({ targets: fadeTargets, alpha: 0, duration: 280 });
    }

    this.drawTunnelHole(0.08);

    // Tiny lift, drill points down, then it bores through the ground line.
    this.tweens.add({
      targets: this,
      robotY: this.robotY - 26,
      duration: 180,
      ease: 'Sine.easeOut',
      onUpdate: () => this.drawRobot(this.robotGfx, this.robotX, this.robotY, { digging: true, facing: 'down' }),
      onComplete: () => this.fallDown(),
    });
  }

  fallDown() {
    const W = this.scale.width;
    this.createTunnelOverlay();

    const startY = this.robotY;
    const endY = this.scale.height + TILE * 2.5;
    this.tweens.add({
      targets: this,
      robotY: endY,
      duration: 980,
      ease: 'Cubic.easeInOut',
      onUpdate: () => {
        const p = Phaser.Math.Clamp((this.robotY - startY) / (endY - startY), 0, 1);
        this.drawTunnelHole(Math.max(0.18, p));
        this.drawRobot(this.robotGfx, this.robotX, this.robotY, { digging: true, facing: 'down' });
        this.updateTunnelOverlay(Math.min(1, p * 1.15));
      },
      onComplete: () => this.handoff(),
    });

    // Final black cover behind the radial tunnel focus.
    this.fader = this.add.rectangle(W / 2, this.scale.height / 2, W, this.scale.height, 0x000000, 0);
    this.fader.setDepth(100);
    this.tweens.add({
      targets: this.fader,
      alpha: 1,
      delay: 760,
      duration: 260,
    });
  }

  handoff() {
    this.stopMenuDrillSound();
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Game');
  }

  playMenuDrillSound() {
    if (!this.menuDrillSound) return;
    this.menuDrillSound.stop();
    this.menuDrillSound.play();
  }

  stopMenuDrillSound() {
    if (!this.menuDrillSound || !this.menuDrillSound.isPlaying) return;
    this.menuDrillSound.stop();
  }

  playRobotChirp() {
    const sounds = this.robotTouchSounds?.filter(Boolean) || [];
    if (sounds.length === 0) return;
    for (const sound of sounds) sound.stop();
    this.pick(sounds).play();
  }
}

function explainWalletError(message) {
  const known = {
    wallet_request_rejected: 'REJECTED',
    wallet_request_already_pending: 'OPEN WALLET',
  };
  if (message === 'Wallet was not selected.') return getWalletState().account ? '' : 'CONNECT WALLET';
  return known[message] || 'TRY AGAIN';
}
