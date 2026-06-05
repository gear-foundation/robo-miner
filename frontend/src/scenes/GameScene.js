import Phaser from 'phaser';
import { TILE, WORLD_W, WORLD_H, SURFACE_Y, BLOCK, BLOCK_DATA, ITEMS, FUEL_PRICE, UPGRADES, MIN_DIG_DURATION } from '../config.js';
import { generateWorld, getBlock, setBlock, isSolid, isClimbable } from '../world.js';
import { createRobot, applyUpgrade, addToCargo } from '../robot.js';
import { drawRobot as drawSharedRobot } from '../render/robot.js';
import { CHEST_TIERS, rollLoot } from '../config/chests.js';

// Mapping from block type → texture key (files live in public/assets/tiles/).
// Missing files fall through to the procedural Graphics renderer.
const TILE_TEXTURE = {
  [BLOCK.DIRT]:    'dirt',
  [BLOCK.COAL]:    'coal',
  [BLOCK.IRON]:    'iron',
  [BLOCK.COPPER]:  'copper',
  [BLOCK.SILVER]:  'silver',
  [BLOCK.GOLD]:    'gold',
  [BLOCK.EMERALD]: 'emerald',
  [BLOCK.RUBY]:    'ruby',
  [BLOCK.DIAMOND]: 'diamond',
  [BLOCK.STONE]:   'stone',
  [BLOCK.LADDER]:  'ladder',
  [BLOCK.PILLAR]:  'pillar',
};

// Depth-driven dirt tint. Used as a multiplicative Sprite.setTint so each
// depth band reads as a distinct "biome" without needing separate art.
// Values are subtle — close to white (= no tint) near the surface, then
// drift cooler/darker as depth grows.
function dirtTintForDepth(depth) {
  if (depth < 15)  return 0xffffff;  // starter: natural tone
  if (depth < 45)  return 0xe8d9b8;  // hay/clay
  if (depth < 90)  return 0xd4b48a;  // rust/copper zone
  if (depth < 150) return 0xb29070;  // ash/silver zone
  if (depth < 210) return 0x8c7a6a;  // cool rock
  return 0x7b5a6e;                   // deep volcanic
}

// Per-block palette: base fill, top/left bevel highlight, bottom/right
// shadow. The procedural drawTile uses these so every block has a
// chiseled/pixel-voxel look instead of a flat color.
const TILE_PALETTE = {
  [BLOCK.DIRT]:    { base: 0x8b5a2b, light: 0xb37644, dark: 0x5a3818 },
  [BLOCK.STONE]:   { base: 0x8a8a8a, light: 0xbababa, dark: 0x4a4a4a },
  [BLOCK.COAL]:    { base: 0x4a3322, light: 0x6a4d34, dark: 0x281a0e },
  [BLOCK.IRON]:    { base: 0x6e5b4d, light: 0x927564, dark: 0x3f3026 },
  [BLOCK.COPPER]:  { base: 0x8a4a30, light: 0xb56a44, dark: 0x4a2510 },
  [BLOCK.SILVER]:  { base: 0x8d92a0, light: 0xc8cfdb, dark: 0x4f5360 },
  [BLOCK.GOLD]:    { base: 0xa07a2a, light: 0xe6c14a, dark: 0x5a4214 },
  [BLOCK.EMERALD]: { base: 0x267a4f, light: 0x4ec07a, dark: 0x103a25 },
  [BLOCK.RUBY]:    { base: 0xa01828, light: 0xe54058, dark: 0x4a0813 },
  [BLOCK.DIAMOND]: { base: 0x2c92b8, light: 0x7fe6f8, dark: 0x123a52 },
  [BLOCK.LADDER]:  { base: 0x6a3e15, light: 0x8d5d2a, dark: 0x3a200a },
  [BLOCK.PILLAR]:  { base: 0x9a9a9a, light: 0xc0c0c0, dark: 0x5a5a5a },
  // Digger crystals (agent arena) — embedded in dirt, drawn as gem facets.
  [BLOCK.SCRST]:   { base: 0x2a8fb0, light: 0x7fe6f8, dark: 0x123a52 },
  [BLOCK.BCRST]:   { base: 0x2e9a52, light: 0x6effa0, dark: 0x103a25 },
  [BLOCK.HCRST]:   { base: 0xb02a82, light: 0xff8fdc, dark: 0x4a0d35 },
};

// Inline SVG icon for each ore type, used in the inventory cargo grid.
// Drawn in a 32×32 box with a consistent visual language: dark stroke
// outlines + flat fill + small white highlight, so they read like
// little SVG cargo icons that match the world tiles.
const ORE_SVG = {
  coal: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M5,18 L11,8 L18,12 L15,22 Z" fill="#0d0d0d" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M14,14 L22,10 L26,18 L20,24 L13,21 Z" fill="#1a1a1a" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M5,22 L12,20 L14,27 L7,27 Z" fill="#1a1a1a" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
      <rect x="9"  y="11" width="2" height="1" fill="#fff" opacity="0.55"/>
      <rect x="19" y="13" width="2" height="1" fill="#fff" opacity="0.55"/>
      <rect x="9"  y="23" width="1" height="1" fill="#fff" opacity="0.45"/>
    </svg>`,
  iron: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M5,20 L10,9 L18,11 L15,22 Z" fill="#7e5b48" stroke="#2a1a10" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M14,15 L22,8  L27,16 L21,24 L13,22 Z" fill="#a87a5c" stroke="#2a1a10" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M6,22  L13,21 L15,27 L8,27 Z"  fill="#7e5b48" stroke="#2a1a10" stroke-width="1.2" stroke-linejoin="round"/>
      <rect x="11" y="12" width="2" height="1" fill="#ffe0c0" opacity="0.85"/>
      <rect x="20" y="11" width="2" height="1" fill="#ffe0c0" opacity="0.85"/>
    </svg>`,
  copper: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M5,21 L9,9   L18,12 L16,23 Z" fill="#a04a26" stroke="#2a0e04" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M14,14 L22,7 L28,17 L22,25 L13,22 Z" fill="#e6753a" stroke="#2a0e04" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M6,23  L13,22 L16,28 L8,28 Z"  fill="#a04a26" stroke="#2a0e04" stroke-width="1.2" stroke-linejoin="round"/>
      <rect x="20" y="11" width="2" height="2" fill="#ffd1a8" opacity="0.95"/>
      <rect x="10" y="13" width="2" height="1" fill="#ffd1a8" opacity="0.85"/>
    </svg>`,
  silver: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M16,4  L26,16 L16,28 L6,16 Z" fill="#4f5360" stroke="#1a1a22" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M16,7  L23,16 L16,25 L9,16 Z" fill="#c8cfdb" stroke="#1a1a22" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="M16,7  L20,16 L16,25 L12,16 Z" fill="#eaedf5"/>
      <rect x="13" y="11" width="3" height="2" fill="#fff"/>
      <rect x="11" y="14" width="2" height="1" fill="#fff" opacity="0.85"/>
    </svg>`,
  gold: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M5,18 L11,7 L19,11 L17,22 Z" fill="#b58820" stroke="#3a2806" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M14,12 L24,8 L28,18 L20,26 L13,22 Z" fill="#ffd84a" stroke="#3a2806" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M6,22 L14,21 L17,28 L8,28 Z" fill="#b58820" stroke="#3a2806" stroke-width="1.3" stroke-linejoin="round"/>
      <ellipse cx="20" cy="13" rx="3" ry="1.4" fill="#fff5b0"/>
      <rect x="10" y="20" width="2" height="1" fill="#fff5b0"/>
    </svg>`,
  emerald: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M16,3  L26,11 L23,25 L9,25 L6,11 Z" fill="#0d3a22" stroke="#04190d" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M16,6  L23,12 L21,23 L11,23 L9,12  Z" fill="#46c97e" stroke="#0d3a22" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="M16,6  L21,23 L11,23 Z"            fill="#7ce0a0" opacity="0.85"/>
      <rect x="14" y="10" width="3" height="3" fill="#fff" opacity="0.95"/>
      <rect x="13" y="13" width="6" height="1" fill="#fff" opacity="0.55"/>
    </svg>`,
  ruby: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M16,3  L27,12 L23,27 L9,27 L5,12 Z" fill="#4a0813" stroke="#1a0306" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M16,6  L24,13 L21,24 L11,24 L8,13  Z" fill="#e23a4f" stroke="#4a0813" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="M16,6  L21,24 L11,24 Z"             fill="#ff7a8c" opacity="0.85"/>
      <rect x="14" y="10" width="3" height="3" fill="#fff" opacity="0.95"/>
      <rect x="13" y="13" width="6" height="1" fill="#fff" opacity="0.55"/>
    </svg>`,
  diamond: `
    <svg viewBox="0 0 32 32" width="78%" height="78%" style="display:block">
      <path d="M16,3 L29,13 L16,29 L3,13 Z" fill="#103e58" stroke="#04101a" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M16,6 L26,13 L16,26 L6,13 Z"  fill="#6fdbf6" stroke="#103e58" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="M16,6 L22,13 L16,22 L10,13 Z" fill="#d6f7ff"/>
      <rect x="15" y="9"  width="2" height="6" fill="#fff"/>
      <rect x="12" y="12" width="8" height="2" fill="#fff"/>
    </svg>`,
};

function oreSvg(name) {
  return ORE_SVG[name] || `<div style="font-size:10px;color:#fff;opacity:.7">${name.slice(0, 3).toUpperCase()}</div>`;
}

// 8-bit-per-channel multiply. Used to apply the depth dirt tint to the
// dirt palette so the chiseled bevel still works in deeper biomes.
function multiplyHex(a, b) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(ar * br / 255) << 16)
       | (Math.round(ag * bg / 255) << 8)
       | Math.round(ab * bb / 255);
}

export default class GameScene extends Phaser.Scene {
  constructor(key = 'Game') {
    super(key);
    // Situational one-liners for the robot's speech bubble.
    this.PHRASES = {
      ore:       ['Mine!', 'Shiny!', 'Gotcha!', 'Nom nom', 'Score!'],
      coal:      ['Coal, baby!', 'Sooty…', 'Fuel for later'],
      iron:      ['Iron!', 'Solid!', 'Rusty but mine'],
      copper:    ['Copper!', 'Shiny penny', 'Pretty!'],
      silver:    ['Silver!', 'Moonstone!', 'Quite the haul'],
      gold:      ['GOLD!', 'Cha-ching!', '💰💰💰'],
      emerald:   ['EMERALD!', 'So green!', 'Rare find!'],
      ruby:      ['RUBY!', 'Bloody beautiful!', 'Worth the trip!'],
      diamond:   ['💎 DIAMOND!!!', 'JACKPOT!', "I'm rich!!!"],
      bone:      ['Bone!', 'Sold to a museum!', 'Old, very old.'],
      coin:      ['Treasure!', 'Cha-ching!', 'Tiny payday'],
      ring:      ['Pretty ring!', 'Someone lost this'],
      skull:     ['Rest in pieces.', 'Brave miner!', 'Ouch.'],
      skullClue: [
        'Note: emerald 30m east — beware the rocks',
        'Note: big chest behind a stone wall, depth 110',
        'Note: ruby vein near depth 215, mind the lava',
        'Note: silver in the next pocket — bring dynamite',
        'Note: gold cluster at the bottom of the right shaft',
      ],
      cargoFull: ['Hold is full!', "Can't carry more", 'Time to head up'],
      noLadder:  ['Out of ladders!', 'Need stairs…', 'No ladders left'],
      noPillar:  ['No pillars left', 'Need supports'],
      lowFuel:   ['Battery dying…', 'Charge me!', 'Fuel low!'],
      tough:     ['Tough one…', 'Hrrrng!', 'Rock-hard'],
      stuck:     ['Dead end!', 'Hmm?', "Can't go that way"],
      surface:   ['Home sweet home', 'Fresh air!', 'Daylight!', "I'm back!"],
      shake:     ['⚠️ Rock above!', 'Look out!', 'Incoming!'],
      pillar:    ['Locked and loaded', 'Support placed'],
      ladderPlaced: ['Ladder set'],
      chestMoney: ['Cha-ching!', 'Loaded!', 'Sweet!'],
      chestItems: ['Nice stash!', 'Useful!', 'Score!'],
      chestEmpty: ['Nothing?!', 'Bah…', 'Empty!'],
      chestTrap:  ['Uh oh…', 'Not good', "That's a trap!"],
    };
  }

  preload() {
    // Silently ignore missing files so the game still runs with procedural tiles.
    this.load.on('loaderror', () => {});
    const keys = ['dirt', 'coal', 'iron', 'copper', 'silver', 'gold', 'emerald', 'ruby', 'diamond', 'stone', 'grass', 'ladder', 'pillar'];
    for (const k of keys) {
      this.load.image(k, `assets/tiles/${k}.png`);
    }
    this.load.audio('rock-drill', 'assets/sfx/rock-drill-generated.wav');
    this.load.audio('rock-break', 'assets/sfx/rock-break.wav');
    this.load.audio('drill-fail', 'assets/sfx/drill-fail.wav');
    this.load.audio('ore-cash', 'assets/sfx/ore-cash.wav');
    this.load.audio('robot-chirp', 'assets/sfx/robot-chirp.wav');
    this.load.audio('robot-question', 'assets/sfx/robot-question.wav');
    this.load.audio('robot-sad', 'assets/sfx/robot-sad.wav');
    this.load.audio('ladder-place', 'assets/sfx/ladder-place.wav');
    this.load.audio('dynamite-fuse', 'assets/sfx/dynamite-fuse.wav');
    this.load.audio('dynamite-boom', 'assets/sfx/dynamite-boom.wav');
    this.load.audio('rock-shake',    'assets/sfx/rock-shake.wav');
    this.load.audio('rock-impact',   'assets/sfx/rock-impact.wav');
  }

  create() {
    this.cleanupSceneDOM();
    // Restore the master volume the player picked on the menu (or any
    // earlier session). Without this, reloading straight into the game
    // would default to full volume even if the saved setting is mute.
    try {
      const v = parseFloat(localStorage.getItem('robo.volume'));
      if (!Number.isNaN(v)) {
        this.game.sound.volume = v;
        this.game.sound.mute = (v === 0);
      }
    } catch { /* noop */ }
    this.world = generateWorld();
    this.robot = createRobot(Math.floor(WORLD_W / 2), SURFACE_Y - 1);
    // Cosmetics chosen on the menu screen, persisted in localStorage so
    // they survive reloads. Falling back to a sensible miner look if
    // localStorage is missing or empty (first-time visitor).
    try { this.robotHat = localStorage.getItem('robo.hat') || 'hardhat'; }
    catch { this.robotHat = 'hardhat'; }
    try { this.robotColor = localStorage.getItem('robo.color') || 'classic'; }
    catch { this.robotColor = 'classic'; }

    this.worldGfx = this.add.graphics();
    this.cloudGfx = this.add.graphics();       // parallax clouds, redrawn every frame
    this.digOverlayGfx = this.add.graphics();  // cracks on block being dug
    this.debrisGfx = this.add.graphics();      // flying cube chunks from broken blocks
    this.robotGfx = this.add.graphics();
    this.cloudGfx.setDepth(2);
    // Clouds live in screen space, not world space — they drift on their
    // own and stay put when the player walks left/right. Without this the
    // camera parallax would carry the sky along with the robot.
    this.cloudGfx.setScrollFactor(0, 0);
    this.digOverlayGfx.setDepth(3);
    this.debrisGfx.setDepth(4);
    this.robotGfx.setDepth(5);
    // Debris particles: array of { x, y, vx, vy, size, color, life, maxLife }.
    // Updated each frame; spawned when a block breaks (dig, chest, dynamite).
    this.debris = [];

    // Fog is a DOM overlay (radial-gradient). The camera keeps the robot
    // at the centre of the screen, so a screen-centred vignette works cleanly.
    this.createFogOverlay();

    // Sprite pool for textured tiles (reused each frame to avoid GC churn).
    this.tilePool = [];
    this.tilePoolCursor = 0;

    // Parallax clouds on the sky layer. Positions are in a scrolling buffer
    // coordinate system; drawWorld() maps them into view with a parallax
    // factor so they drift slower than the camera and convey motion.
    // baseX/baseY are now SCREEN coordinates (cloudGfx has scrollFactor 0).
    // baseY is fixed at scene start in the upper sky band.
    this.clouds = [];
    for (let i = 0; i < 8; i++) {
      this.clouds.push({
        baseX: Math.random() * 2400,
        baseY: 18 + Math.random() * 130,
        w: 70 + Math.random() * 80,
        h: 22 + Math.random() * 14,
        drift: 0.008 + Math.random() * 0.012,
      });
    }

    // Dig-in-progress state: { tx, ty, type, startedAt, duration, progress }
    this.digging = null;
    this.failedDig = null;
    // Falling stones: [{ x, y, state: 'shake'|'fall', startedAt, nextFallAt }]
    this.fallingStones = [];
    // Falling pillars: [{ x, y, nextFallAt }] — pillars with empty tile below.
    this.fallingPillars = [];
    this.drillLoop = this.sound.add('rock-drill', { loop: true, volume: 0.55 });
    this.breakSound = this.sound.add('rock-break', { volume: 0.75 });
    this.fuseLoop = this.sound.add('dynamite-fuse', { loop: true, volume: 0.55 });
    this.boomSound = this.sound.add('dynamite-boom', { volume: 0.85 });
    this.shakeLoop = this.sound.add('rock-shake', { loop: true, volume: 0.55 });
    this.impactSound = this.sound.add('rock-impact', { volume: 0.75 });
    this.drillFailSound = this.sound.add('drill-fail', { volume: 0.72 });
    this.oreCashSound = this.sound.add('ore-cash', { volume: 0.5 });
    this.robotChirpSound = this.sound.add('robot-chirp', { volume: 0.42 });
    this.robotQuestionSound = this.sound.add('robot-question', { volume: 0.42 });
    this.robotSadSound = this.sound.add('robot-sad', { volume: 0.42 });
    this.robotTouchSounds = [this.robotChirpSound, this.robotQuestionSound];
    this.ladderPlaceSound = this.sound.add('ladder-place', { volume: 0.55 });
    this.robotTouchLines = [
      "Don't touch me.",
      'Beep. Personal space.',
      'Hey!',
      'Systems nominal.',
      'Careful, partner.',
    ];
    this.input.on('pointerdown', this.handleRobotPointerDown, this);
    this.events.once('shutdown', () => this.destroySceneDOM());
    this.events.once('destroy', () => this.destroySceneDOM());

    this.cameras.main.setBounds(0, 0, WORLD_W * TILE, WORLD_H * TILE);
    // Sky-blue fallback so any sub-pixel uncovered strip on the canvas edge
    // reads as sky, not a black flicker, during smooth-camera movement.
    this.cameras.main.setBackgroundColor('#4a7bbf');
    // Pixel-snap the camera: prevents 1px subpixel artifacts on fillRect edges
    // when the robot is mid-tween and scrollX/Y are fractional.
    this.cameras.main.setRoundPixels(true);

    this.keys = this.input.keyboard.addKeys({
      up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT',
      w: 'W', a: 'A', s: 'S', d: 'D',
      ladder: 'ONE',
      pillar: 'TWO',
      dyn: 'THREE',
      bigDyn: 'FOUR',
      shop: 'ENTER',
      inv: 'I',
      teleport: 'T',
    });
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.inventoryOpen) this.closeInventory();
      if (this.shopOpen) this.closeShop();
    });

    // Camera zoom is fixed at 1 — pinch / wheel / hotkey zoom are
    // disabled so trackpad gestures don't accidentally rescale the
    // viewport mid-game and break HUD alignment.
    this.cameras.main.setZoom(1);

    this.actionCooldown = 0;
    this.shopOpen = false;
    this.inventoryOpen = false;

    this.createShopDOM();
    this.createHudDOM();

    // Handle resize
    this.scale.on('resize', (size) => {
      this.cameras.main.setSize(size.width, size.height);
      this.followCamera();
      this.redraw();
    });

    // Centre the camera on the robot before the first render so the fog
    // overlay and world draw with the correct scroll on frame 0.
    this.followCamera();
    this.redraw();
  }

  update(time, dt) {
    if (this.shopOpen) {
      this.updateHud();
      return;
    }
    // Inventory modal also pauses the world. Avatar inside it animates
    // (eye blinks etc) by re-rendering on each frame here.
    if (this.inventoryOpen) {
      this.updateHud();
      this.renderInventoryAvatar(time);
      // Allow toggling/closing while inventory is open without auto-walk.
      if (Phaser.Input.Keyboard.JustDown(this.keys.inv)) this.closeInventory();
      return;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.inv)) {
      this.openInventory();
      return;
    }

    // Visual smoothing: tween the robot's draw position (px/py) toward its
    // logical tile (tx/ty). Logic stays fully tile-based; only rendering is
    // interpolated. Speed chosen so a one-tile move completes in ~120ms
    // (matches the movement cooldown).
    this.tweenRobotDrawPosition(dt);
    this.drawClouds();

    // Passive fuel-out death. Without this the robot can sit at 0 fuel
    // forever — drill won't work, but no respawn ever fires. Catch the
    // condition here before any movement/dig logic runs.
    if (this.robot.fuel <= 0 && !this.isDying && !this.awaitingRespawn) {
      this.handleDeath('out of fuel');
    }
    this.updateDrillBuff(time);

    // Always simulate falling stones + pillars; redraw world while any are active
    const hadPhysics = this.fallingStones.length > 0 || this.fallingPillars.length > 0;
    this.updateFallingStones(time);
    this.updateFallingPillars(time);
    const lavaMoved = this.updateLavaFlow(time);
    if (hadPhysics || lavaMoved) this.drawWorld();

    // Debris physics + live bombs share the same Graphics layer so they
    // can render in the same pass. Bombs tick first so detonations can
    // spawn debris in the same frame they go off.
    this.updateBombs(time);
    const hasBombs = (this.bombs && this.bombs.length > 0);
    if (this.debris.length > 0 || hasBombs) {
      if (this.debris.length > 0) this.updateDebris(dt);
      this.debrisGfx.clear();
      if (this.debris.length > 0) this.drawDebris();
      if (hasBombs) this.drawBombs();
    } else if (this.debrisGfx) {
      this.debrisGfx.clear();
    }

    // If a dig is in progress, advance it instead of processing movement
    if (this.digging) {
      const elapsed = time - this.digging.startedAt;
      this.digging.progress = Math.min(1, elapsed / this.digging.duration);
      this.drawDigOverlay();
      if (this.digging.progress >= 1) {
        this.completeDig();
      }
      this.followCamera();
      this.drawRobot(time);
      this.drawFog();
      this.positionBubble();
      this.updateHud();
      return;
    }

    if (this.failedDig && time - this.failedDig.startedAt >= this.failedDig.duration) {
      this.failedDig = null;
    }
    this.actionCooldown -= dt;
    const shopCol = Math.floor(WORLD_W / 2);
    const nearShopDoor = this.robot.ty === SURFACE_Y - 1
      && Math.abs(this.robot.tx - shopCol) <= 1;

    if (nearShopDoor && Phaser.Input.Keyboard.JustDown(this.keys.shop)) {
      this.openShop();
      return;
    }

    // Key "2" → place pillar. Mirrors clicking the 🧱 inventory slot.
    if (Phaser.Input.Keyboard.JustDown(this.keys.pillar)) {
      this.placePillar();
    }

    // T → consume one Teleporter and beam back to the surface spawn.
    // No-op (with a tip) if the player has none. This is the late-game
    // panic button — drains a $300 item but saves a long ladder climb.
    if (Phaser.Input.Keyboard.JustDown(this.keys.teleport)) {
      this.useTeleporter();
    }

    // 3 → small dynamite (3×3), 4 → big dynamite (5×5). Both detonate at
    // the tile in front of the robot's facing direction, breaking any
    // soft block AND stone in radius. Ore inside the blast still drops
    // into cargo so explosives can be used aggressively.
    if (Phaser.Input.Keyboard.JustDown(this.keys.dyn))    this.useDynamite(1);
    if (Phaser.Input.Keyboard.JustDown(this.keys.bigDyn)) this.useDynamite(2);

    // While the death animation plays (squashed sprite, 900ms), freeze
    // all input + gravity. Otherwise the corpse keeps falling/moving and
    // can land somewhere wild before the respawn callback fires.
    if (this.actionCooldown <= 0 && !this.isDying && !this.awaitingRespawn) {
      this.tryMove();
    }

    this.followCamera();
    this.drawRobot(time);
    this.drawFog();
    this.positionBubble();
    this.updateHud();
  }

  tryMove() {
    const r = this.robot;
    // Gravity ALWAYS runs first, regardless of held input. Without
    // this, holding LEFT/RIGHT after stepping off a ladder lets the
    // player walk through mid-air — the previous code only called
    // applyGravity() when no direction was held.
    const beforeFallY = r.ty;
    this.applyGravity();
    if (r.ty !== beforeFallY) {
      // We just dropped a tile — burn this turn instead of also
      // honouring the horizontal input. Player needs to land.
      return;
    }

    const left  = this.keys.left.isDown  || this.keys.a.isDown;
    const right = this.keys.right.isDown || this.keys.d.isDown;
    const down  = this.keys.down.isDown  || this.keys.s.isDown;
    const up    = this.keys.up.isDown    || this.keys.w.isDown;

    let dx = 0, dy = 0;
    if (left)  { dx = -1; r.facing = 'left'; }
    else if (right) { dx = 1; r.facing = 'right'; }
    else if (down)  { dy = 1; r.facing = 'down'; }
    else if (up)    { dy = -1; }

    // Click/tap-to-move: a queued pointer direction is consumed once if
    // no key is held this frame. Mobile-friendly tap-on-tile movement;
    // on desktop it lets the player click an adjacent tile to drill it.
    if (dx === 0 && dy === 0 && this.pointerMove) {
      dx = this.pointerMove.dx;
      dy = this.pointerMove.dy;
      if (dx < 0) r.facing = 'left';
      else if (dx > 0) r.facing = 'right';
      else if (dy > 0) r.facing = 'down';
      this.pointerMove = null;
    }

    if (dx === 0 && dy === 0) {
      // Gravity already ran at the top; nothing else to do this tick.
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.keys.ladder)) {
      this.placeLadder();
      return;
    }

    const targetX = r.tx + dx;
    const targetY = r.ty + dy;
    const tile = getBlock(this.world, targetX, targetY);

    // CHEST: walking into it opens the loot and clears the tile. No drilling.
    // Handled before the up/solid branches so chests never start a dig cycle.
    if (tile === BLOCK.CHEST) {
      if (dy < 0) r.facing = 'up';
      this.applyChestLoot(targetX, targetY);
      this.spawnDebris(targetX, targetY, BLOCK.CHEST, 14);
      setBlock(this.world, targetX, targetY, BLOCK.SKY);
      this.playBreakSound();
      // Anything resting on the chest (a stone that landed above) is now
      // unsupported. Same cascade as completeDig — without this the rock
      // just floats after the chest disappears.
      this.scanUnsupportedAt(targetX, targetY - 1);
      this.scanUnsupportedPillarAt(targetX, targetY - 1);
      this.awakenLavaAround(targetX, targetY);
      this.moveTo(targetX, targetY);
      return;
    }

    if (dy < 0) {
      r.facing = 'up';
      // Can't fly above the surface row.
      if (targetY < SURFACE_Y - 1) return;
      // Digging UP into a solid block: just break it. The robot stays put
      // — climbing up is a separate press which auto-places a ladder in
      // the current tile (see below). This keeps us from burning a ladder
      // on every drill-up when the player only wants the ore.
      if (isSolid(tile)) {
        this.digBlock(targetX, targetY);
        return;
      }
      const hereTile = getBlock(this.world, r.tx, r.ty);
      // Auto-place a ladder at the current tile on the way up (unless already a ladder,
      // or we're still on the surface row where we don't need one).
      const needsLadder = hereTile !== BLOCK.LADDER && r.ty > SURFACE_Y - 1;
      if (needsLadder) {
        if (r.items.ladder <= 0) {
          this.warnOnce('noLadderClimb', 'No ladders! Return to surface to restock.', this.pick(this.PHRASES.noLadder), 1200);
          return;
        }
        setBlock(this.world, r.tx, r.ty, BLOCK.LADDER);
        r.items.ladder--;
        this.playLadderPlaceSound();
      }
      this.moveTo(targetX, targetY);
      return;
    }

    if (isSolid(tile)) {
      this.digBlock(targetX, targetY);
    } else {
      this.moveTo(targetX, targetY);
    }
  }

  applyGravity() {
    const r = this.robot;
    // Surface row is always "ground" — even if the player dug a trench into
    // the SURFACE_Y row, walking across it (at SURFACE_Y - 1) doesn't drop
    // the robot. You only descend by deliberately pressing down. This also
    // prevents respawn-loop deaths when a hole is dug under the spawn point.
    if (r.ty === SURFACE_Y - 1) return;
    const below = getBlock(this.world, r.tx, r.ty + 1);
    const here = getBlock(this.world, r.tx, r.ty);
    const canFall = !isSolid(below) && !isClimbable(here) && !isClimbable(below) && r.ty < WORLD_H - 1;
    if (canFall) {
      if (r.fallStartY == null) r.fallStartY = r.ty;
      this.moveTo(r.tx, r.ty + 1);
      return;
    }
    if (r.fallStartY != null) {
      const distance = r.ty - r.fallStartY;
      r.fallStartY = null;
      this.resolveFallLanding(distance);
    }
  }

  // Landing check. 3 tiles is the cutoff — feels like a safe hop-down but
  // anything taller is dangerous without the parachute. Parachute one-shot:
  // consumed automatically, saves the fall regardless of height.
  resolveFallLanding(distance) {
    const SAFE_FALL = 3;
    if (distance <= SAFE_FALL) return;
    const r = this.robot;
    if (r.items.parachute > 0) {
      r.items.parachute--;
      this.flashMessage('🪂 Parachute deployed!');
      this.sayBubble('safe landing');
      return;
    }
    this.handleDeath(`fell ${distance} tiles without a parachute`);
  }

  moveTo(tx, ty) {
    const r = this.robot;
    r.tx = tx;
    r.ty = ty;
    // Walking does not consume energy. Energy is only spent on successful
    // drilling — see completeDig. Failed drills (undrillable stone) cost 0.
    this.actionCooldown = 120;
    // Surface auto-refill: ladders AND pillars top up every time we land on
    // the surface row. Also auto-sell anything in cargo — shop turns ore
    // into cash without needing to open the UI. Show a tiny bubble so the
    // player sees it.
    if (ty === SURFACE_Y - 1) {
      let refilled = false;
      if (r.items.ladder < r.maxLadders)  { r.items.ladder = r.maxLadders; refilled = true; }
      if (r.items.pillar < r.maxPillars)  { r.items.pillar = r.maxPillars; refilled = true; }
      const sold = this.autoSellCargo();
      if (sold > 0) this.spawnMoneyFloat(r.tx, r.ty, sold);
      if (refilled || sold > 0) this.sayBubble(this.pick(this.PHRASES.surface));
    }
    this.applyHazardDamage(tx, ty);
    this.redraw();
    this.checkLowFuel();
    if (r.fuel <= 0) this.handleDeath('out of fuel');
    if (r.hp <= 0) this.handleDeath('crushed by the depths');
  }

  // Floating "+$N" that rises from a world-space tile and fades — same
  // feedback style arcade cash registers use. Used for auto-sell on the
  // surface and any other moment we want the player to feel a payout.
  spawnMoneyFloat(tx, ty, amount) {
    const txt = this.add.text(
      tx * TILE + TILE / 2,
      ty * TILE + TILE / 2,
      `+$${amount}`,
      {
        fontFamily: 'Courier New, monospace',
        fontSize: '28px',
        fontStyle: 'bold',
        color: '#ffec6e',
        stroke: '#1c1000',
        strokeThickness: 5,
      },
    );
    txt.setOrigin(0.5, 0.5);
    txt.setDepth(50);
    this.tweens.add({
      targets: txt,
      y: txt.y - TILE * 2.2,
      alpha: { from: 1, to: 0 },
      scale: { from: 0.6, to: 1.15 },
      duration: 1400,
      ease: 'Cubic.easeOut',
      onComplete: () => txt.destroy(),
    });
  }

  // Auto-sell all ore in cargo using BLOCK_DATA prices. Returns total $.
  autoSellCargo() {
    const r = this.robot;
    let total = 0;
    for (const [name, count] of Object.entries(r.cargo)) {
      const type = Object.values(BLOCK).find(t => BLOCK_DATA[t]?.name === name);
      total += count * (BLOCK_DATA[type]?.price || 0);
    }
    if (total > 0) {
      r.money += total;
      r.cargo = {};
      r.cargoCount = 0;
      this.playOreCashSound?.();
    }
    return total;
  }

  // Per-step hazard contact. Energy is reserved for drilling (see completeDig)
  // so hazards only damage HP — lava is a near-one-shot, water is a slow drip.
  applyHazardDamage(tx, ty) {
    const r = this.robot;
    const type = getBlock(this.world, tx, ty);
    if (type === BLOCK.LAVA) {
      r.hp = Math.max(0, r.hp - (BLOCK_DATA[BLOCK.LAVA].damage ?? 30));
      this.sayBubble('hot-hot-HOT');
    } else if (type === BLOCK.WATER) {
      r.hp = Math.max(0, r.hp - (BLOCK_DATA[BLOCK.WATER].damage ?? 2));
    }
  }

  digBlock(tx, ty) {
    const r = this.robot;
    const type = getBlock(this.world, tx, ty);
    const data = BLOCK_DATA[type];
    this.faceTarget(tx, ty);
    if (!data) return;
    if (data.hardness >= 999) {
      this.failDigBlock(tx, ty);
      return;
    }
    this.failedDig = null;

    // Start a timed dig; actual break happens when progress reaches 1.
    // Clamp to MIN_DIG_DURATION so a maxed Diamond Drill on coal still
    // shows a visible crack/debris animation rather than insta-popping.
    const duration = Math.max(MIN_DIG_DURATION, 420 * data.hardness * r.drillSpeed);
    this.digging = {
      tx, ty, type,
      startedAt: this.time.now,
      duration,
      progress: 0,
    };
    // Face the block being dug (drill points that way).
    this.faceTarget(tx, ty);

    // Flavour on tough blocks.
    if (data.hardness >= 3) this.sayBubble(this.pick(this.PHRASES.tough));
    this.startDrillSound();
  }

  faceTarget(tx, ty) {
    const r = this.robot;
    if (tx < r.tx) r.facing = 'left';
    else if (tx > r.tx) r.facing = 'right';
    else if (ty > r.ty) r.facing = 'down';
    else if (ty < r.ty) r.facing = 'up';
  }

  failDigBlock(tx, ty) {
    this.failedDig = {
      tx,
      ty,
      startedAt: this.time.now,
      duration: 360,
    };
    this.actionCooldown = 240;
    this.playDrillFailSound();
    this.sayBubble(this.pick(this.PHRASES.tough), 900);
  }

  completeDig() {
    const { tx, ty, type } = this.digging;
    const data = BLOCK_DATA[type];
    const r = this.robot;
    // Energy cost = block hardness. Dirt = 1, coal/iron = 2, diamond = 4, etc.
    // Failed drills on undrillable STONE never reach completeDig, so they
    // cost nothing — matches "the drill spins but the rock doesn't break".
    r.fuel = Math.max(0, r.fuel - data.hardness);

    // Chest: resolve loot before the tile turns back to sky.
    if (type === BLOCK.CHEST) {
      this.applyChestLoot(tx, ty);
    }

    if (data.price > 0) {
      const added = addToCargo(r, data.name);
      if (!added) {
        // Cargo full: abort dig, leave block intact
        this.flashMessage('Cargo full!');
        this.sayBubble(this.pick(this.PHRASES.cargoFull));
        this.digging = null;
        this.digOverlayGfx.clear();
        this.stopDrillSound();
        return;
      }
      if (type === BLOCK.DIAMOND) {
        r.hasDiamond = true;
        this.flashMessage('💎 DIAMOND FOUND! Return to the shop to WIN!');
        this.sayBubble(this.pick(this.PHRASES.diamond), 3200);
      } else if (type === BLOCK.RUBY) {
        this.sayBubble(this.pick(this.PHRASES.ruby));
      } else if (type === BLOCK.EMERALD) {
        this.sayBubble(this.pick(this.PHRASES.emerald));
      } else if (type === BLOCK.GOLD) {
        this.sayBubble(this.pick(this.PHRASES.gold));
      } else if (type === BLOCK.SILVER) {
        this.sayBubble(this.pick(this.PHRASES.silver));
      } else if (type === BLOCK.COPPER) {
        this.sayBubble(this.pick(this.PHRASES.copper));
      } else if (type === BLOCK.IRON) {
        this.sayBubble(this.pick(this.PHRASES.iron));
      } else if (type === BLOCK.COAL) {
        this.sayBubble(this.pick(this.PHRASES.coal));
      } else if (type === BLOCK.BONE) {
        this.flashMessage('🦴 Dinosaur bone — collector will pay');
        this.sayBubble(this.pick(this.PHRASES.bone));
      } else if (type === BLOCK.COIN) {
        this.flashMessage('🪙 Ancient coin');
        this.sayBubble(this.pick(this.PHRASES.coin));
      } else if (type === BLOCK.RING) {
        this.flashMessage('💍 Lost ring — looks expensive');
        this.sayBubble(this.pick(this.PHRASES.ring));
      } else if (type === BLOCK.SKULL) {
        // Miner grave — small cash plus a randomly chosen clue.
        this.flashMessage(`💀 ${this.pick(this.PHRASES.skullClue)}`);
        this.sayBubble(this.pick(this.PHRASES.skull));
      } else {
        this.sayBubble(this.pick(this.PHRASES.ore));
      }
      this.playOreCashSound();
    }
    // Shrine: sacrifices a random ore from cargo for one of: blueprint /
    // drill buff / +teleporter / cash. Resolved AFTER the dig has gone
    // through (the shrine tile itself drops nothing into cargo because
    // its data.price is 0 and BLOCK_DATA.shrine.name has no match).
    if (type === BLOCK.SHRINE) this.activateShrine();
    // Drill relic should NOT be reachable here (hardness 999), but if it
    // somehow is, treat it like dynamite-broken and grant the buff.
    if (type === BLOCK.DRILL_RELIC) this.applyDrillBuff();

    const fromX = r.tx, fromY = r.ty;
    // Cube-chunk debris burst. Spawn BEFORE writing SKY so the block type
    // is still accurate (used for color selection).
    this.spawnDebris(tx, ty, type, 9);
    setBlock(this.world, tx, ty, BLOCK.SKY);
    // Upward digs leave the robot on its original tile — the next "up" press
    // is the one that actually climbs (and places the ladder). Sideways and
    // downward digs step into the newly opened tile immediately.
    const diggingUp = ty < fromY;
    if (!diggingUp) {
      r.tx = tx;
      r.ty = ty;
    }
    this.digging = null;
    this.digOverlayGfx.clear();
    this.stopDrillSound();
    this.playBreakSound();

    // Any stone or pillar directly above the freed tile may now be unsupported → may fall.
    this.scanUnsupportedAt(tx, ty - 1);
    this.scanUnsupportedPillarAt(tx, ty - 1);
    // If we just exposed a lava neighbour, kick off the slow flow.
    this.awakenLavaAround(tx, ty);

    this.redraw();
    this.checkLowFuel();
    if (r.fuel <= 0) this.handleDeath('out of fuel');
  }

  // Chest opening. Resolves a loot outcome and applies it to the robot.
  // Called from completeDig(); the CHEST tile is replaced with SKY right after,
  // like any other drilled block.
  applyChestLoot(tx, ty) {
    const chest = this.world.chestsAt?.get(ty * WORLD_W + tx);
    if (!chest || chest.opened) return;
    chest.opened = true;
    // Re-roll up to 4 times if the outcome would land on the player as a
    // no-op (e.g. all rolled items are already capped). Avoids the "+0 🪜"
    // result that reads like a broken chest.
    let outcome = rollLoot(chest.tier, Math.random);
    for (let i = 0; i < 4 && this.outcomeIsNoOp(outcome); i++) {
      outcome = rollLoot(chest.tier, Math.random);
    }
    // Forward the chest position so trap outcomes can plant a real
    // bomb at the chest's tile (rather than a placeholder toast).
    this.resolveLootOutcome(outcome, tx, ty);
  }

  // True if applying the outcome would change nothing about the robot —
  // 'empty' chests, or item rolls where every line is already at cap.
  outcomeIsNoOp(outcome) {
    if (outcome.kind !== 'items') return false;
    const r = this.robot;
    for (const [name, n] of Object.entries(outcome.give)) {
      if (n <= 0) continue;
      if (name === 'ladder' && r.items.ladder < r.maxLadders) return false;
      if (name === 'pillar' && r.items.pillar < r.maxPillars) return false;
      if (name !== 'ladder' && name !== 'pillar') return false; // uncapped items
    }
    return true;
  }

  resolveLootOutcome(outcome, chestX = null, chestY = null) {
    const r = this.robot;
    if (outcome.kind === 'money') {
      r.money += outcome.amount;
      this.flashMessage(`+$${outcome.amount}`);
      this.sayBubble(this.pick(this.PHRASES.chestMoney));
      this.playOreCashSound();
      return;
    }
    if (outcome.kind === 'items') {
      const parts = [];
      for (const [name, n] of Object.entries(outcome.give)) {
        if (n <= 0) continue;
        if (name === 'ladder') {
          const add = Math.min(n, r.maxLadders - r.items.ladder);
          if (add <= 0) continue;
          r.items.ladder += add;
          parts.push(`+${add} 🪜`);
        } else if (name === 'pillar') {
          const add = Math.min(n, r.maxPillars - r.items.pillar);
          if (add <= 0) continue;
          r.items.pillar += add;
          parts.push(`+${add} 🧱`);
        } else {
          r.items[name] = (r.items[name] || 0) + n;
          const icon = name === 'dynamite' ? '💣' : name === 'bigDynamite' ? '🧨' : name;
          parts.push(`+${n} ${icon}`);
        }
      }
      // Net-zero fallback: every line was capped. Convert to a small
      // consolation cash drop so the chest never feels broken.
      if (parts.length === 0) {
        const consolation = 5 + Math.floor(Math.random() * 10);
        r.money += consolation;
        this.flashMessage(`+$${consolation} (bag full)`);
        this.sayBubble(this.pick(this.PHRASES.chestMoney));
        this.playOreCashSound();
        return;
      }
      this.flashMessage(parts.join('  '));
      this.sayBubble(this.pick(this.PHRASES.chestItems));
      return;
    }
    if (outcome.kind === 'trap') {
      // TRAP! Plant a real bomb at the chest tile — same entity the
      // dynamite system uses, so the player gets a visible fuse and
      // the same blast logic. fuseMs is the warning window.
      const isBig = outcome.size === 'big';
      const radius = isBig ? 2 : 1;
      const bx = chestX != null ? chestX : r.tx;
      const by = chestY != null ? chestY : r.ty;
      this.bombs = this.bombs || [];
      this.bombs.push({
        tx: bx, ty: by,
        radius, isBig,
        placedAt: this.time.now,
        fuse: outcome.fuseMs ?? 2500,
      });
      if (this.fuseLoop && !this.fuseLoop.isPlaying) this.fuseLoop.play();
      this.flashMessage(`⚠️ TRAP! ${isBig ? 'Big ' : ''}fuse — RUN!`);
      this.sayBubble(this.pick(this.PHRASES.chestTrap));
      return;
    }
    if (outcome.kind === 'fuel') {
      // Partial battery refill. pct is a fraction of maxFuel; cap to the
      // current max so a 100%-pct on a topped-off bar doesn't flash an
      // empty "+0 charge".
      const pct = outcome.pct ?? 30;
      const before = r.fuel;
      const refill = Math.round(r.maxFuel * (pct / 100));
      r.fuel = Math.min(r.maxFuel, r.fuel + refill);
      const actual = r.fuel - before;
      if (actual <= 0) {
        // Already full — small consolation cash so the chest still feels
        // worth opening even if it's a fuel-can on a full tank.
        const consolation = 5 + Math.floor(Math.random() * 15);
        r.money += consolation;
        this.flashMessage(`🔋 Battery already full (+$${consolation})`);
      } else {
        this.flashMessage(`🔋 +${actual} charge (${pct}%)`);
      }
      this.sayBubble('Power up!');
      this.playOreCashSound?.();
      return;
    }
    if (outcome.kind === 'blueprint') {
      // Pick a random NOT-yet-maxed upgrade and bump it one tier for free.
      const candidates = ['drill', 'fuel', 'cargo', 'pack', 'radar']
        .filter(k => r.upgrades[k] < UPGRADES[k].length);
      if (candidates.length === 0) {
        // All maxed — convert to a fat money drop instead.
        const fallback = 1500 + Math.floor(Math.random() * 1500);
        r.money += fallback;
        this.flashMessage(`📜 Blueprint (all maxed): +$${fallback}`);
        this.sayBubble('Already perfect.');
        this.playOreCashSound();
        return;
      }
      const key = candidates[Math.floor(Math.random() * candidates.length)];
      const cur = r.upgrades[key];
      const next = UPGRADES[key][cur];
      // Apply the upgrade for free — duplicate the relevant branches of
      // applyUpgrade so we don't deduct money.
      r.upgrades[key] = next.lvl;
      if (key === 'fuel')  { r.maxFuel = next.val; r.fuel = r.maxFuel; }
      if (key === 'cargo') { r.maxCargo = next.val; }
      if (key === 'drill') { r.drillSpeed = next.val; }
      if (key === 'pack')  {
        const [maxL, maxP, maxH] = next.val;
        r.maxLadders = maxL; r.maxPillars = maxP; r.maxHp = maxH;
        r.items.ladder = maxL; r.items.pillar = maxP; r.hp = maxH;
      }
      if (key === 'radar') { r.radar = next.val; }
      const labels = { drill: 'Drill', fuel: 'Battery', cargo: 'Cargo', pack: 'Pack', radar: 'Radar' };
      this.flashMessage(`📜 Blueprint! ${labels[key]} → ${next.name}`);
      this.sayBubble('Free upgrade!');
      this.playOreCashSound();
      if (key === 'cargo') {
        // Mirror shop-cargo highlight: pulse new slots in inventory.
        this.cargoSlotsAddedFrom = r.maxCargo - (next.val - (UPGRADES.cargo[cur - 1].val));
        this.cargoHighlightUntil = (this.time?.now || 0) + 6000;
      }
      return;
    }
    this.flashMessage('Empty chest');
    this.sayBubble(this.pick(this.PHRASES.chestEmpty));
  }

  // shakeMs: how long the stone wobbles before it actually falls. The
  // PLAYER‑triggered case (dig / explosion) wants a full 1.5 s warning
  // so the player can react. The CASCADE case (one stone uncovers the
  // next as it falls) passes a short 250 ms so the lava feels like one
  // continuous slide instead of one stone per beat.
  scanUnsupportedAt(x, y, shakeMs = 1500) {
    if (y < 0 || y >= WORLD_H) return;
    if (getBlock(this.world, x, y) !== BLOCK.STONE) return;
    const below = getBlock(this.world, x, y + 1);
    if (below === BLOCK.SKY || below === BLOCK.LADDER) {
      if (!this.fallingStones.some(s => s.x === x && s.y === y)) {
        this.fallingStones.push({ x, y, state: 'shake', startedAt: this.time.now, shakeMs });
        // Only warn if the shaking stone is right above the robot's column.
        if (x === this.robot.tx && y < this.robot.ty) {
          this.sayBubble(this.pick(this.PHRASES.shake));
        }
      }
    }
  }

  scanUnsupportedPillarAt(x, y) {
    if (y < 0 || y >= WORLD_H) return;
    if (getBlock(this.world, x, y) !== BLOCK.PILLAR) return;
    const below = getBlock(this.world, x, y + 1);
    if (below === BLOCK.SKY || below === BLOCK.LADDER) {
      if (!this.fallingPillars.some(p => p.x === x && p.y === y)) {
        // Short grace period before a pillar drops — lets the player see
        // what happened before it moves.
        this.fallingPillars.push({ x, y, nextFallAt: this.time.now + 250 });
      }
    }
  }

  updateFallingPillars(time) {
    for (let i = this.fallingPillars.length - 1; i >= 0; i--) {
      const p = this.fallingPillars[i];
      if (time < p.nextFallAt) continue;
      const below = getBlock(this.world, p.x, p.y + 1);
      if (below === BLOCK.SKY || below === BLOCK.LADDER) {
        // Pillar is passive — passes THROUGH the robot (doesn't crush it).
        setBlock(this.world, p.x, p.y, BLOCK.SKY);
        p.y += 1;
        setBlock(this.world, p.x, p.y, BLOCK.PILLAR);
        p.nextFallAt = time + 90;
        this.redraw();
      } else {
        // Landed. Bottom of world or solid block below.
        this.fallingPillars.splice(i, 1);
      }
    }
  }

  // ---- Lava flow ----
  // Lava behaves like a slow puddle: every 280ms each "active" lava tile
  // tries to crawl one step (down first, then sideways). A per-source
  // budget caps total spread so a single broken tile can't drown the
  // map. Active sources are kept in `this.activeLava` — when a tile is
  // exposed (any of its 4 neighbours becomes SKY), we register it.
  registerLavaFlow(x, y) {
    if (getBlock(this.world, x, y) !== BLOCK.LAVA) return;
    this.activeLava = this.activeLava || new Map();
    // Hard cap on simultaneously active flows. Without this, every
    // tile a flow lands on can spawn a fresh source with full budget,
    // and the spread becomes exponential after a few seconds.
    if (this.activeLava.size >= 8) return;
    const key = y * WORLD_W + x;
    if (this.activeLava.has(key)) return;
    // 18-tile budget per opened source. Big enough to fill a small pit
    // but not enough to drown a full chamber.
    this.activeLava.set(key, { x, y, budget: 18, nextStep: this.time.now + 350 });
  }

  // Wake up any lava neighbours of a freshly opened tile. Called from
  // completeDig / explosion / chest cascade so the player sees lava
  // start to drip the moment they breach a wall containing it.
  awakenLavaAround(x, y) {
    this.registerLavaFlow(x - 1, y);
    this.registerLavaFlow(x + 1, y);
    this.registerLavaFlow(x,     y - 1);
    this.registerLavaFlow(x,     y + 1);
  }

  // Per-tick lava spreader. Returns true if the world changed so the
  // caller can trigger a redraw.
  updateLavaFlow(time) {
    if (!this.activeLava || this.activeLava.size === 0) return false;
    let changed = false;
    for (const [key, src] of this.activeLava) {
      if (time < src.nextStep) continue;
      src.nextStep = time + 280;
      if (src.budget <= 0) { this.activeLava.delete(key); continue; }
      // Confirm the source tile is still lava — could have been
      // destroyed by dynamite or turned into stone by a falling rock.
      if (getBlock(this.world, src.x, src.y) !== BLOCK.LAVA) {
        this.activeLava.delete(key);
        continue;
      }
      // Try to flow down first.
      const candidates = [
        { dx: 0,  dy: 1 },   // down
        { dx: -1, dy: 0 },   // left
        { dx: 1,  dy: 0 },   // right
      ];
      let flowed = false;
      for (const c of candidates) {
        const nx = src.x + c.dx;
        const ny = src.y + c.dy;
        if (nx <= 0 || nx >= WORLD_W - 1 || ny >= WORLD_H - 1) continue;
        const t = getBlock(this.world, nx, ny);
        if (t !== BLOCK.SKY && t !== BLOCK.LADDER) continue;
        // Lava destroys ladders / fills empty space. We do NOT
        // re-register the flowed-into tile as a new source — the
        // original source keeps streaming next tick and tries the
        // remaining open neighbours. Without this rule, every newly
        // converted tile would get its own full budget and the spread
        // grew exponentially.
        setBlock(this.world, nx, ny, BLOCK.LAVA);
        src.budget--;
        flowed = true;
        changed = true;
        // Catch the robot if it stood there.
        if (this.robot.tx === nx && this.robot.ty === ny && !this.isDying) {
          this.handleDeath('engulfed by lava');
        }
        break;
      }
      if (!flowed) {
        // Source is fully blocked — retire it. Remaining budget can be
        // re-awakened later if a neighbour opens up again.
        this.activeLava.delete(key);
      }
    }
    return changed;
  }

  updateFallingStones(time) {
    // Iterate backwards so we can splice safely
    for (let i = this.fallingStones.length - 1; i >= 0; i--) {
      const s = this.fallingStones[i];
      if (s.state === 'shake') {
        // If the player slipped a pillar / supports the tile while
        // we were wobbling, settle immediately. Robot stops being in
        // danger and the shake animation/sound cuts out.
        const belowShake = getBlock(this.world, s.x, s.y + 1);
        const stillAtRisk = belowShake === BLOCK.SKY || belowShake === BLOCK.LADDER;
        if (!stillAtRisk) {
          this.fallingStones.splice(i, 1);
          continue;
        }
        const dur = s.shakeMs ?? 1500;
        if (time - s.startedAt > dur) {
          s.state = 'fall';
          s.nextFallAt = time;
        }
      } else if (s.state === 'fall') {
        if (time >= (s.nextFallAt || 0)) {
          // Check what's below FIRST. If something solid (pillar, dirt,
          // stone, ore, ...) is now under the rock, it lands here and
          // can no longer crush the robot. The earlier version did the
          // robot-crush check before this — so a pillar placed during
          // the shake didn't actually save the player.
          const below = getBlock(this.world, s.x, s.y + 1);
          const willFall = below === BLOCK.SKY || below === BLOCK.LADDER;
          // Robot in the path AND nothing supports the rock?
          if (willFall && this.robot.tx === s.x && this.robot.ty === s.y + 1) {
            // Crush the robot — counts as a hard impact too.
            this.playRockImpact();
            setBlock(this.world, s.x, s.y, BLOCK.SKY);
            setBlock(this.world, s.x, s.y + 1, BLOCK.STONE);
            this.fallingStones.splice(i, 1);
            this.handleDeath('crushed by a falling rock');
            // Check what's above old position — cascade (short shake)
            this.scanUnsupportedAt(s.x, s.y - 1, 250);
            this.scanUnsupportedPillarAt(s.x, s.y - 1);
            this.redraw();
            continue;
          }
          if (willFall) {
            // Fall one tile (destroys any ladder in the way)
            setBlock(this.world, s.x, s.y, BLOCK.SKY);
            s.y += 1;
            setBlock(this.world, s.x, s.y, BLOCK.STONE);
            s.nextFallAt = time + 90;
            // Cascade: the tile we just vacated (s.y - 1) now sits with
            // sky underneath whatever was above it. Trigger a scan with
            // a SHORT shake — once a slide is in motion, follow-up
            // rocks should drop almost immediately, not pause for 1.5 s
            // each.
            this.scanUnsupportedAt(s.x, s.y - 2, 250);
            this.scanUnsupportedPillarAt(s.x, s.y - 2);
            this.redraw();
          } else {
            // Landed — stop shaking; cascade above old pos. Play a
            // chunky thud so the player hears the rock settle.
            this.playRockImpact();
            this.fallingStones.splice(i, 1);
            this.scanUnsupportedAt(s.x, s.y - 1, 250);
            this.scanUnsupportedPillarAt(s.x, s.y - 1);
            this.redraw();
          }
        }
      }
    }
    // Drive the shared shake-loop sound: play whenever there's at least
    // one stone wobbling, stop the moment all of them have either fallen
    // or settled.
    const hasShaker = this.fallingStones.some(s => s.state === 'shake');
    if (this.shakeLoop) {
      if (hasShaker && !this.shakeLoop.isPlaying) this.shakeLoop.play();
      else if (!hasShaker && this.shakeLoop.isPlaying) this.shakeLoop.stop();
    }
  }

  // Pitch-randomized rock-impact one-shot so consecutive stones don't
  // sound identical when a cascade happens.
  playRockImpact() {
    if (!this.impactSound) return;
    this.impactSound.stop();
    this.impactSound.play({
      volume: 0.7 + Math.random() * 0.15,
      rate:   0.92 + Math.random() * 0.16, // 0.92..1.08
    });
  }

  drawDigOverlay() {
    const g = this.digOverlayGfx;
    g.clear();
    if (!this.digging) return;
    const { tx, ty, progress } = this.digging;
    const px = tx * TILE, py = ty * TILE;

    // Cracks appear in stages (25/50/75/100)
    // Use black semi-transparent lines
    g.lineStyle(3, 0x000000, 0.85);

    if (progress >= 0.25) {
      // First crack — diagonal
      g.strokeLineShape(new Phaser.Geom.Line(px + 8, py + 10, px + TILE / 2, py + TILE / 2));
      g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + TILE / 2, px + TILE - 14, py + TILE - 8));
    }
    if (progress >= 0.5) {
      g.strokeLineShape(new Phaser.Geom.Line(px + TILE - 8, py + 6, px + TILE / 2 + 4, py + TILE / 2));
      g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2 - 2, py + TILE / 2 + 2, px + 10, py + TILE - 4));
    }
    if (progress >= 0.75) {
      g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + 4, px + TILE / 2 + 3, py + TILE / 2));
      g.strokeLineShape(new Phaser.Geom.Line(px + TILE / 2, py + TILE / 2, px + TILE / 2 - 2, py + TILE - 4));
      // Chips falling off
      g.fillStyle(0x000000, 0.5);
      g.fillRect(px + 4, py + TILE - 10, 4, 3);
      g.fillRect(px + TILE - 10, py + TILE - 14, 3, 3);
    }

    // Progress bar under the tile
    const barW = TILE - 8;
    const barH = 4;
    const barX = px + 4;
    const barY = py - 8;
    g.fillStyle(0x000000, 0.6);
    g.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
    g.fillStyle(0xffdd55, 1);
    g.fillRect(barX, barY, barW * progress, barH);
  }

  // Debris palette. Returns [main, accent] so each chunk randomly picks one of
  // the two — simulates color variance inside a broken block (e.g. coal has
  // dark chunks + slightly-brown fragments of its dirt matrix).
  debrisPalette(type) {
    switch (type) {
      case BLOCK.DIRT:    return [0x8b5a2b, 0x5c3b1c];
      case BLOCK.COAL:    return [0x2a2a2a, 0x5c3b1c];
      case BLOCK.IRON:    return [0x8b5a4d, 0x5f3a30];
      case BLOCK.COPPER:  return [0xc06844, 0x8b4a2e];
      case BLOCK.SILVER:  return [0xd8d8e0, 0xa0a0a8];
      case BLOCK.GOLD:    return [0xffd700, 0xffaa00];
      case BLOCK.EMERALD: return [0x50c878, 0x2e8d50];
      case BLOCK.RUBY:    return [0xe23a4f, 0xa01828];
      case BLOCK.DIAMOND: return [0x9effff, 0x5ff6ff];
      case BLOCK.STONE:   return [0x8a8a8a, 0x555555];
      case BLOCK.CHEST:   return [0x8a5a2a, 0xffd964];
      case BLOCK.PILLAR:  return [0xaaaaaa, 0x7a7a7a];
      case BLOCK.LADDER:  return [0xc28840, 0x7a5428];
      case BLOCK.SCRST:   return [0x5fd6ff, 0x2a8fb0];
      case BLOCK.BCRST:   return [0x66e06a, 0x2e9a52];
      case BLOCK.HCRST:   return [0xff5fc8, 0xb02a82];
      default:            return [0x9a9a9a, 0x555555];
    }
  }

  // Spawn a burst of square debris from a tile's centre. Velocities bias
  // outward + slightly upward so chunks "jump" before gravity pulls them
  // down, giving a satisfying pop. Life is ms; gravity is px/s² in update.
  spawnDebris(tx, ty, type, count = 8) {
    const [main, accent] = this.debrisPalette(type);
    const cx = tx * TILE + TILE / 2;
    const cy = ty * TILE + TILE / 2;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 90 + Math.random() * 140;
      const upwardBias = 60 + Math.random() * 90;
      this.debris.push({
        x: cx + (Math.random() - 0.5) * TILE * 0.35,
        y: cy + (Math.random() - 0.5) * TILE * 0.35,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.5 - upwardBias,
        size: 3 + Math.floor(Math.random() * 4),
        color: Math.random() < 0.65 ? main : accent,
        life: 520 + Math.random() * 320,
      });
    }
  }

  // Physics tick for debris. Simple Euler integration with gravity. No
  // per-tile collision — chunks fly over the world, fade out, and vanish.
  updateDebris(dt) {
    const s = dt / 1000;
    const g = 680;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.vy += g * s;
      d.x += d.vx * s;
      d.y += d.vy * s;
      d.life -= dt;
      if (d.life <= 0) this.debris.splice(i, 1);
    }
  }

  drawDebris() {
    const g = this.debrisGfx;
    g.clear();
    for (const d of this.debris) {
      const a = Math.max(0, Math.min(1, d.life / 300));
      g.fillStyle(d.color, a);
      g.fillRect(Math.round(d.x - d.size / 2), Math.round(d.y - d.size / 2), d.size, d.size);
    }
  }

  placeLadder() {
    const r = this.robot;
    if (r.items.ladder <= 0) {
      this.warnOnce('noLadderPlace', 'No ladders', this.pick(this.PHRASES.noLadder), 1200);
      return;
    }
    const here = getBlock(this.world, r.tx, r.ty);
    if (here !== BLOCK.SKY) { this.flashMessage("Can't place here"); return; }
    setBlock(this.world, r.tx, r.ty, BLOCK.LADDER);
    r.items.ladder--;
    this.playLadderPlaceSound();
    this.redraw();
    this.actionCooldown = 200;
  }

  placePillar() {
    const r = this.robot;
    if (r.items.pillar <= 0) {
      this.flashMessage('No pillars');
      this.sayBubble(this.pick(this.PHRASES.noPillar));
      return;
    }

    // Pillar is placed in the SAME tile the robot stands in — think of it as
    // a support column dropped right where you are, with the robot rendered
    // in front of it. When the robot moves off, the pillar stays and can
    // catch a stone falling from above.
    const here = getBlock(this.world, r.tx, r.ty);
    if (here !== BLOCK.SKY && here !== BLOCK.LADDER) {
      this.flashMessage("Can't place here");
      return;
    }
    setBlock(this.world, r.tx, r.ty, BLOCK.PILLAR);
    r.items.pillar--;
    this.sayBubble(this.pick(this.PHRASES.pillar));
    // If placed in midair, pillar starts falling immediately.
    this.scanUnsupportedPillarAt(r.tx, r.ty);
    this.redraw();
    this.actionCooldown = 200;
  }

  // Activates a shrine: drops one random ore from cargo and rolls a
  // reward. If cargo is empty the shrine still gives a small cash
  // payout so it never feels broken.
  activateShrine() {
    const r = this.robot;
    let sacrifice = null;
    const oreNames = Object.keys(r.cargo).filter(n => r.cargo[n] > 0);
    if (oreNames.length > 0) {
      sacrifice = oreNames[Math.floor(Math.random() * oreNames.length)];
      r.cargo[sacrifice]--;
      r.cargoCount = Math.max(0, r.cargoCount - 1);
      if (r.cargo[sacrifice] <= 0) delete r.cargo[sacrifice];
    }
    const roll = Math.random();
    if (roll < 0.30) {
      this.resolveLootOutcome({ kind: 'blueprint' });
    } else if (roll < 0.55) {
      this.applyDrillBuff();
    } else if (roll < 0.75) {
      r.items.teleporter = (r.items.teleporter || 0) + 1;
      this.flashMessage('🛐 Shrine grants a Teleporter');
      this.sayBubble('Sacred tech!');
      this.playOreCashSound?.();
    } else {
      const reward = 250 + Math.floor(Math.random() * 750);
      r.money += reward;
      this.flashMessage(`🛐 Shrine offering: +$${reward}`);
      this.sayBubble('Blessed!');
      this.playOreCashSound?.();
    }
    if (!sacrifice) {
      this.flashMessage('🛐 Shrine accepted… nothing? (no cargo to offer)');
    }
  }

  // 60-second drill speed buff. Multiplies r.drillSpeed by 0.8 for the
  // duration; chaining two relics back-to-back stacks (0.64× etc).
  // On expiry we restore from the CURRENT upgrade level, NOT a stale
  // pre-buff snapshot — that way buying a drill upgrade DURING the
  // buff doesn't get clobbered when the buff ends.
  applyDrillBuff() {
    const r = this.robot;
    r.drillSpeed = (r.drillSpeed || 1) * 0.8;
    this.drillBuffUntil = (this.time?.now || 0) + 60_000;
    this.flashMessage('⚙️ Drill speed boost (60s)');
    this.sayBubble('Drill goes brrrrr!');
    this.playOreCashSound?.();
  }

  // Tick the drill buff timer; restore the baseline drill speed when it
  // elapses by reading the player's current drill UPGRADE level. This
  // survives both stacking (multiple buffs) and any drill upgrade the
  // player bought while a buff was active.
  updateDrillBuff(time) {
    if (!this.drillBuffUntil) return;
    if (time < this.drillBuffUntil) return;
    const lvl = this.robot.upgrades?.drill || 1;
    const tier = UPGRADES.drill?.[lvl - 1];
    if (tier) this.robot.drillSpeed = tier.val;
    this.drillBuffUntil = 0;
    this.flashMessage('⚙️ Drill boost expired');
  }

  // Consumes one dynamite and PLANTS a bomb at the robot's current tile.
  // The fuse burns for ~2.6s (small) / 3.4s (big) — the player has to
  // step out of the blast radius before it goes off, otherwise damage
  // catches them too. radius=1 → 3×3, radius=2 → 5×5.
  useDynamite(radius) {
    // Same dying/menu-open guard as the teleporter — keypress while
    // the respawn dialog is up shouldn't burn a dynamite stick.
    if (this.isDying || this.awaitingRespawn || this.shopOpen || this.inventoryOpen) return;
    const r = this.robot;
    const isBig = radius >= 2;
    const itemKey = isBig ? 'bigDynamite' : 'dynamite';
    const label = isBig ? 'Big Dynamite' : 'Dynamite';
    if ((r.items[itemKey] || 0) <= 0) {
      this.flashMessage(`No ${label}`);
      return;
    }
    r.items[itemKey]--;
    this.bombs = this.bombs || [];
    this.bombs.push({
      tx: r.tx,
      ty: r.ty,
      radius,
      isBig,
      placedAt: this.time.now,
      // Same fuse for both — 4s gives the player one tile of travel + a
      // beat to ladder out vertically before the blast goes off.
      fuse: 4000,
    });
    // Start the looping fuse hiss if not already playing. Multiple bombs
    // share the same loop so the hiss doesn't multiply with each plant.
    if (this.fuseLoop && !this.fuseLoop.isPlaying) this.fuseLoop.play();
    this.flashMessage(`💣 ${label} planted — RUN!`);
    this.sayBubble('Fuse is lit!', 1100);
  }

  // Tick all live bombs each frame; once a bomb's fuse elapses, fire
  // detonateBomb and remove it from the list. Stop the shared hissing
  // loop the moment the last bomb is gone.
  updateBombs(time) {
    if (!this.bombs || this.bombs.length === 0) return;
    const remaining = [];
    for (const b of this.bombs) {
      if (time - b.placedAt >= b.fuse) {
        this.detonateBomb(b);
      } else {
        remaining.push(b);
      }
    }
    this.bombs = remaining;
    if (this.bombs.length === 0 && this.fuseLoop && this.fuseLoop.isPlaying) {
      this.fuseLoop.stop();
    }
  }

  // Actual explosion. Walks every tile in the radius, breaking solids
  // (including STONE) and scooping ore into cargo. Damages the robot
  // if it's still within the blast box. Diamond is protected so a
  // careless blast can't soft-lock the run.
  detonateBomb(bomb) {
    const r = this.robot;
    const { tx: cx, ty: cy, radius, isBig } = bomb;

    let oresCollected = 0;
    let cargoFullSkipped = 0;
    let relicsBroken = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx <= 0 || tx >= WORLD_W - 1) continue;
        if (ty <= SURFACE_Y - 1 || ty >= WORLD_H - 1) continue;
        const t = getBlock(this.world, tx, ty);
        if (t === BLOCK.SKY) continue;
        if (t === BLOCK.DIAMOND) continue; // win-condition tile is fire-proof
        const data = BLOCK_DATA[t];
        if (data && data.price > 0 && data.name !== 'chest') {
          if (addToCargo(r, data.name)) oresCollected++;
          else cargoFullSkipped++;
        }
        if (t === BLOCK.DRILL_RELIC) relicsBroken++;
        // Chests caught in the blast still resolve their loot table
        // before the tile clears — otherwise dynamite-mining a chest
        // silently eats the contents.
        if (t === BLOCK.CHEST) this.applyChestLoot(tx, ty);
        // Shrine destroyed by the blast still triggers its sacrifice
        // roll (consolation cash if cargo empty).
        if (t === BLOCK.SHRINE) this.activateShrine();
        this.spawnDebris(tx, ty, t === BLOCK.CHEST ? BLOCK.CHEST : t, 8);
        setBlock(this.world, tx, ty, BLOCK.SKY);
      }
    }
    // Each freed relic grants the drill buff (stacks if multiple).
    for (let i = 0; i < relicsBroken; i++) this.applyDrillBuff();
    // Falling-tile scan one row above the cleared area.
    for (let dx = -radius; dx <= radius; dx++) {
      this.scanUnsupportedAt(cx + dx, cy - radius - 1);
      this.scanUnsupportedPillarAt(cx + dx, cy - radius - 1);
    }
    // Lava neighbours of every cleared tile may now flow into the void.
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        this.awakenLavaAround(cx + dx, cy + dy);
      }
    }

    // Damage check: if the robot is inside the blast box, take a big hit.
    const dxR = Math.abs(r.tx - cx);
    const dyR = Math.abs(r.ty - cy);
    const caught = dxR <= radius && dyR <= radius;
    if (caught && !this.isDying) {
      const damage = isBig ? 200 : 120;
      r.hp = Math.max(0, r.hp - damage);
      this.flashMessage('💥 Caught in the blast!');
      this.cameras.main.shake(420, 0.025);
      if (r.hp <= 0) this.handleDeath('caught in own dynamite blast');
    } else {
      this.cameras.main.shake(260, 0.014);
    }

    // Boom! Big dyn plays the same boom but a hair louder for impact.
    if (this.boomSound) {
      this.boomSound.stop();
      this.boomSound.play({ volume: isBig ? 1.0 : 0.85 });
    } else {
      this.playBreakSound();
    }
    if (oresCollected > 0) this.playOreCashSound();
    if (cargoFullSkipped > 0) {
      this.flashMessage(`💥 Boom! (${cargoFullSkipped} ore lost: cargo full)`);
    }
    this.redraw();
  }

  // Renders every live bomb. A single tilted dynamite stick (or a tied
  // bundle of three for big dyn) with a sparking fuse that visibly
  // shortens. Tilt sells "tossed onto the ground" rather than "neatly
  // standing"; a translateCanvas / rotateCanvas pair handles the lean.
  drawBombs() {
    const g = this.debrisGfx;
    if (!this.bombs || this.bombs.length === 0) return;
    const now = this.time.now;
    for (const b of this.bombs) {
      const t = Math.min(1, (now - b.placedAt) / b.fuse);
      const cx = b.tx * TILE + TILE / 2;
      const baseY = b.ty * TILE + TILE * 0.92;
      // Lean ~22° to the right so it reads as "thrown".
      const angle = -Math.PI / 8;
      g.save();
      g.translateCanvas(cx, baseY);
      g.rotateCanvas(angle);
      if (b.isBig) this._drawBombBundle(g, t, now);
      else         this._drawBombStick(g, t, now);
      g.restore();
      g.lineStyle(0, 0, 0);
    }
  }

  // Single dynamite stick. Drawn around (0,0) with the bottom of the
  // stick at y=0; the caller has already translated + rotated.
  _drawBombStick(g, t, now) {
    const w = TILE * 0.30;
    const h = TILE * 0.62;
    // Body
    g.fillStyle(0xc62828, 1);
    g.fillRect(-w / 2, -h, w, h);
    // Top cap (darker red)
    g.fillStyle(0xa01a1a, 1);
    g.fillRect(-w / 2, -h, w, h * 0.18);
    // White bands
    g.fillStyle(0xffffff, 1);
    g.fillRect(-w / 2, -h * 0.62, w, Math.max(2, h * 0.08));
    g.fillRect(-w / 2, -h * 0.28, w, Math.max(2, h * 0.08));
    // Outline
    g.lineStyle(2, 0x0a0a0a, 1);
    g.strokeRect(-w / 2, -h, w, h);
    g.lineStyle(0, 0, 0);
    // Fuse — short curved-ish line growing UP from top of stick.
    this._drawFuse(g, 0, -h, TILE * 0.55, t, now, true);
  }

  // Big dynamite — three sticks lashed with a rope band, center one
  // taller. Center fuse is the visible burning one.
  _drawBombBundle(g, t, now) {
    const stickW = TILE * 0.20;
    const sideH  = TILE * 0.58;
    const midH   = TILE * 0.74;
    const gap    = stickW + 2;

    const stick = (ox, hh) => {
      g.fillStyle(0xc62828, 1);
      g.fillRect(ox - stickW / 2, -hh, stickW, hh);
      g.fillStyle(0xa01a1a, 1);
      g.fillRect(ox - stickW / 2, -hh, stickW, hh * 0.18);
      g.fillStyle(0xffffff, 1);
      g.fillRect(ox - stickW / 2, -hh * 0.62, stickW, Math.max(1, hh * 0.07));
      g.fillRect(ox - stickW / 2, -hh * 0.28, stickW, Math.max(1, hh * 0.07));
      g.lineStyle(2, 0x0a0a0a, 1);
      g.strokeRect(ox - stickW / 2, -hh, stickW, hh);
    };
    stick(-gap, sideH);
    stick(0,    midH);
    stick( gap, sideH);

    // Rope band across the bundle at mid-height.
    const ropeY = -sideH * 0.5;
    const ropeW = gap * 2 + stickW + 6;
    g.fillStyle(0x5a3a14, 1);
    g.fillRect(-ropeW / 2, ropeY - 3, ropeW, 6);
    g.lineStyle(2, 0x0a0a0a, 1);
    g.strokeRect(-ropeW / 2, ropeY - 3, ropeW, 6);
    g.lineStyle(0, 0, 0);

    // Three fuses; the center one is the live, sparking fuse.
    this._drawFuse(g, -gap, -sideH, TILE * 0.40, t, now, false);
    this._drawFuse(g,  gap, -sideH, TILE * 0.40, t, now, false);
    this._drawFuse(g,  0,   -midH,  TILE * 0.60, t, now, true);
  }

  // Common fuse renderer. Cord stays at full length the whole time;
  // tip carries a flickering spark + a halo of tiny particles.
  // `withSparks` adds the particle cloud (only the "main" fuse needs
  // it to keep it readable).
  _drawFuse(g, baseX, baseY, fullLen, t, now, withSparks) {
    const len = fullLen;
    const tipX = baseX + Math.sin(now / 70 + baseX) * 3;
    const tipY = baseY - len;
    g.lineStyle(3, 0x5a3a14, 1);
    g.beginPath();
    g.moveTo(baseX, baseY);
    // Slight curl in the middle so it reads as a fuse cord, not a stick.
    const midX = baseX + Math.sin(now / 90 + baseY) * 2;
    const midY = (baseY + tipY) / 2;
    g.lineTo(midX, midY);
    g.lineTo(tipX, tipY);
    g.strokePath();
    // Spark dot.
    const sparkOn = Math.floor(now / 70) % 2 === 0;
    g.fillStyle(sparkOn ? 0xffd84a : 0xffaa00, 1);
    const sparkSz = withSparks ? 7 : 4;
    g.fillRect(tipX - sparkSz / 2, tipY - sparkSz / 2, sparkSz, sparkSz);
    if (!withSparks) { g.lineStyle(0, 0, 0); return; }
    // Particle halo for the live fuse.
    for (let i = 0; i < 5; i++) {
      const a = (now / 60 + i * 1.6) % (Math.PI * 2);
      const rr = 5 + ((now / 30 + i * 7) % 9);
      g.fillStyle(i % 2 === 0 ? 0xffd84a : 0xff7a3a, 0.7);
      g.fillRect(tipX + Math.cos(a) * rr, tipY + Math.sin(a) * rr, 2, 2);
    }
    g.lineStyle(0, 0, 0);
  }

  // Consumes one Teleporter and warps the robot to the shop column at
  // the surface row. Triggers the same auto-sell / ladder + pillar
  // refill as walking onto the surface, so a player rich in cargo can
  // cash out instantly. Refuses (no-op + tip) when out of teleporters
  // or already on the surface.
  useTeleporter() {
    // Ignore the keypress if the player is dead/respawning. Without
    // this guard the item is consumed even though the action is frozen.
    if (this.isDying || this.awaitingRespawn || this.shopOpen || this.inventoryOpen) return;
    const r = this.robot;
    if (r.items.teleporter <= 0) {
      this.flashMessage('No teleporter');
      return;
    }
    if (r.ty <= SURFACE_Y - 1) {
      this.flashMessage('Already on the surface');
      return;
    }
    r.items.teleporter--;
    r.tx = Math.floor(WORLD_W / 2);
    r.ty = SURFACE_Y - 1;
    r.px = r.tx;
    r.py = r.ty;
    r.fallStartY = null;
    // Mirror the surface arrival logic from tryMove: refill + auto-sell.
    let refilled = false;
    if (r.items.ladder < r.maxLadders) { r.items.ladder = r.maxLadders; refilled = true; }
    if (r.items.pillar < r.maxPillars) { r.items.pillar = r.maxPillars; refilled = true; }
    const sold = this.autoSellCargo();
    if (sold > 0) this.spawnMoneyFloat(r.tx, r.ty, sold);
    if (refilled || sold > 0) this.sayBubble(this.pick(this.PHRASES.surface));
    this.flashMessage('📡 Teleported!');
    this.playOreCashSound?.();
    this.followCamera();
    this.redraw();
  }

  handleDeath(reason) {
    if (this.isDying || this.awaitingRespawn) return; // guard
    this.isDying = true;
    this.stopDrillSound();
    if (this.fuseLoop && this.fuseLoop.isPlaying) this.fuseLoop.stop();
    if (this.shakeLoop && this.shakeLoop.isPlaying) this.shakeLoop.stop();
    this.bombs = []; // any planted bombs vaporize with the player
    this.failedDig = null;
    this.digging = null;
    this.playRobotSadSound();
    const r = this.robot;
    // Freeze squashed-visual on current tile until the player taps respawn.
    this.squashedUntil = Number.POSITIVE_INFINITY;
    this.redraw();
    // After ~900ms (long enough for the squashed silhouette to land),
    // open the respawn dialog and HAND OVER control to the player.
    this.time.delayedCall(900, () => {
      // Order matters — set `awaitingRespawn` BEFORE clearing
      // `isDying` so any concurrent input handler that might fire in
      // this tick still sees AT LEAST ONE death-state flag set and
      // bails. Otherwise there's a one-statement window where neither
      // is true and a stray cascade / lava trigger could fire a
      // second handleDeath.
      this.awaitingRespawn = true;
      this.deathReason = reason;
      this.isDying = false;          // squashed sprite stays on screen
      this.openRespawnDialog(reason);
    });
  }

  // Performs the actual respawn: fuel/hp top-up, teleport to shop, drop
  // cargo + diamond. Called either by the dialog button or the ENTER /
  // SPACE key while the dialog is open.
  doRespawn() {
    if (!this.awaitingRespawn) return;
    const r = this.robot;
    r.fuel = Math.max(r.fuel, r.maxFuel * 0.3);
    r.hp = r.maxHp;
    r.cargo = {};
    r.cargoCount = 0;
    r.tx = Math.floor(WORLD_W / 2);
    r.ty = SURFACE_Y - 1;
    r.px = r.tx;
    r.py = r.ty;
    // Wipe fall-tracker so the next fall measures from the new spawn,
    // not from wherever we died.
    r.fallStartY = null;
    if (r.hasDiamond) {
      r.hasDiamond = false;
      this.flashMessage('Lost the diamond!');
    }
    this.awaitingRespawn = false;
    this.deathReason = null;
    this.squashedUntil = 0;
    this.closeRespawnDialog();
    this.followCamera();
    this.redraw();
  }

  openRespawnDialog(reason) {
    let d = document.getElementById('respawn-dialog');
    if (!d) {
      d = document.createElement('div');
      d.id = 'respawn-dialog';
      d.style.cssText = `
        position: fixed; inset: 0; z-index: 25; display: flex;
        align-items: center; justify-content: center;
        background: rgba(0,0,0,0.55);
        font-family: 'Courier New', monospace; color: #f1e6cf;
      `;
      // Two-choice modal: free local Continue (cargo lost) or End Run.
      // Score = current bank money; diamond bonus only applies on
      // actual diamond turn-in (which goes through the win dialog).
      d.innerHTML = `
        <div style="background:#1d140b; border:4px solid #4b2e15;
          border-radius:14px; padding:24px 28px; min-width:340px;
          max-width:92vw; text-align:center;
          box-shadow:0 8px 30px rgba(0,0,0,0.6);">
          <div style="font-size:48px; line-height:1; margin-bottom:6px">💀</div>
          <div style="font-size:20px; font-weight:bold; letter-spacing:1px;
            margin-bottom:6px">YOU DIED</div>
          <div id="respawn-reason" style="font-size:13px; opacity:.8;
            margin-bottom:14px"></div>
          <div id="respawn-score" style="font-size:13px; opacity:.95;
            margin-bottom:16px;background:#241608;border:2px solid #4b2e15;
            border-radius:10px;padding:10px"></div>
          <div style="display:flex;gap:10px;flex-direction:column">
            <button id="respawn-continue-btn" style="
              font-family:inherit; background:#7fc99c; color:#0e2e1e;
              border:3px solid #0e2e1e; border-radius:10px;
              padding:12px 24px; font-weight:bold; font-size:15px;
              letter-spacing:1px; cursor:pointer;">
              🔄 Continue (free) — lose cargo, keep money
            </button>
            <button id="respawn-end-btn" style="
              font-family:inherit; background:#c9a06a; color:#241608;
              border:3px solid #4b2e15; border-radius:10px;
              padding:12px 24px; font-weight:bold; font-size:15px;
              letter-spacing:1px; cursor:pointer;">
              🚪 End Run
            </button>
          </div>
          <div id="respawn-status" style="margin-top:10px; font-size:11px;
            opacity:.65;min-height:14px"></div>
        </div>
      `;
      document.body.appendChild(d);
      d.querySelector('#respawn-continue-btn').onclick = () => this.doRespawn();
      d.querySelector('#respawn-end-btn').onclick = () => this.endRunFromDeath();
      // Keyboard: SPACE = Continue, ENTER = End Run.
      this._respawnKeyHandler = (ev) => {
        if (!this.awaitingRespawn) return;
        if (ev.code === 'Space') {
          ev.preventDefault();
          this.doRespawn();
        } else if (ev.code === 'Enter') {
          ev.preventDefault();
          this.endRunFromDeath();
        }
      };
      window.addEventListener('keydown', this._respawnKeyHandler);
    }
    d.querySelector('#respawn-reason').textContent = reason || '';
    const r = this.robot;
    const depth = Math.max(0, r.ty - SURFACE_Y + 1);
    d.querySelector('#respawn-score').innerHTML = `
      <div style="font-size:11px;opacity:.7;letter-spacing:1.5px;margin-bottom:4px">
        CURRENT RUN
      </div>
      <div>💰 <strong>$${r.money}</strong> banked &nbsp;·&nbsp; ⛏ depth <strong>${depth}</strong> m</div>
    `;
    d.querySelector('#respawn-status').textContent = '';
    d.style.display = 'flex';
  }

  closeRespawnDialog() {
    const d = document.getElementById('respawn-dialog');
    if (d) d.style.display = 'none';
  }

  // Player chose "End Run" from the death modal: transition to the
  // "Run Ended" view (reusing the win dialog with a different title).
  endRunFromDeath() {
    const score = this.robot.money;
    this.closeRespawnDialog();
    this.openRunEndedDialog(score);
  }

  // Modal shown after a death-end-run: same shape as the win dialog
  // but with a tombstone icon. Single "🔄 New Run" CTA restarts the scene.
  openRunEndedDialog(score) {
    this.awaitingRespawn = true;
    let d = document.getElementById('win-dialog');
    if (!d) {
      d = this._createWinShellDialog();
    }
    d.querySelector('#win-icon').textContent = '🪦';
    d.querySelector('#win-title').textContent = 'RUN ENDED';
    d.querySelector('#win-title').style.color = '#c9a06a';
    d.querySelector('#win-card').style.borderColor = '#4b2e15';
    d.querySelector('#win-detail').innerHTML = `Final score: <strong>$${score}</strong>`;
    d.style.display = 'flex';
  }

  // Reusable end-of-run shell — the win modal AND the run-ended modal
  // share the same DOM structure. Only the icon, title color and
  // detail text differ. The "New Run" CTA restarts the Phaser scene.
  _createWinShellDialog() {
    const d = document.createElement('div');
    d.id = 'win-dialog';
    d.style.cssText = `
      position: fixed; inset: 0; z-index: 26; display: flex;
      align-items: center; justify-content: center;
      background: rgba(0,0,0,0.6);
      font-family: 'Courier New', monospace; color: #f1e6cf;
    `;
    d.innerHTML = `
      <div id="win-card" style="background:#1d140b; border:4px solid #ffd66b;
        border-radius:14px; padding:28px 32px; min-width:360px;
        max-width:92vw; text-align:center;
        box-shadow:0 8px 30px rgba(0,0,0,0.6);">
        <div id="win-icon" style="font-size:64px; line-height:1; margin-bottom:6px">🏆</div>
        <div id="win-title" style="font-size:24px; font-weight:bold; letter-spacing:2px;
          color:#ffd66b; margin-bottom:6px">YOU WIN!</div>
        <div id="win-detail" style="font-size:13px; opacity:.85;
          margin-bottom:18px"></div>
        <button id="win-btn" style="
          font-family:inherit; background:#7fc99c; color:#0e2e1e;
          border:3px solid #0e2e1e; border-radius:10px;
          padding:14px 32px; font-weight:bold; font-size:17px;
          letter-spacing:1px; cursor:pointer;">
          🔄 NEW RUN
        </button>
        <div style="margin-top:10px; font-size:11px; opacity:.6">
          (or press SPACE / ENTER)
        </div>
      </div>
    `;
    document.body.appendChild(d);
    d.querySelector('#win-btn').onclick = () => this.startNewRun();
    this._winKeyHandler = (ev) => {
      const cur = document.getElementById('win-dialog');
      if (!cur || cur.style.display === 'none') return;
      if (ev.code === 'Space' || ev.code === 'Enter') {
        ev.preventDefault();
        this.startNewRun();
      }
    };
    window.addEventListener('keydown', this._winKeyHandler);
    return d;
  }

  // Win modal — fired when the player turns in the diamond at the shop.
  openWinDialog(bonus) {
    this.awaitingRespawn = true; // reuse same input-block flag
    let d = document.getElementById('win-dialog');
    if (!d) {
      d = this._createWinShellDialog();
    }
    d.querySelector('#win-icon').textContent = '🏆';
    d.querySelector('#win-title').textContent = 'YOU WIN!';
    d.querySelector('#win-title').style.color = '#ffd66b';
    d.querySelector('#win-card').style.borderColor = '#ffd66b';
    const score = (this.robot.money || 0) + 50000;
    d.querySelector('#win-detail').innerHTML =
      `Diamond delivered. +$${bonus} bonus.<br>Final score: <strong>$${score}</strong>`;
    d.style.display = 'flex';
  }

  // Regenerate the world and reset the run. Called from the win
  // dialog. Uses Phaser's scene.restart() — that re-runs preload +
  // create, which builds a fresh world via generateWorld() and a
  // fresh robot via createRobot().
  startNewRun() {
    const d = document.getElementById('win-dialog');
    if (d) d.style.display = 'none';
    if (this._winKeyHandler) {
      window.removeEventListener('keydown', this._winKeyHandler);
      this._winKeyHandler = null;
    }
    this.awaitingRespawn = false;
    this.scene.restart();
  }

  handleRobotPointerDown(pointer) {
    if (this.shopOpen || this.inventoryOpen || this.digging || this.isDying || this.awaitingRespawn) return;
    const r = this.robot;
    const cx = r.px * TILE + TILE / 2;
    const cy = r.py * TILE + TILE / 2;
    const halfW = TILE * 0.38;
    const halfH = TILE * 0.44;
    // Tap on the robot itself — emit a chirp, no movement.
    if (
      pointer.worldX >= cx - halfW &&
      pointer.worldX <= cx + halfW &&
      pointer.worldY >= cy - halfH &&
      pointer.worldY <= cy + halfH
    ) {
      this.reactRobot(true);
      return;
    }
    // Tap on a neighbouring tile — request a move/dig in that direction.
    // We pick the dominant axis (vertical wins on ties) so a sloppy tap
    // still resolves to one of the four cardinal moves the engine knows.
    const tx = Math.floor(pointer.worldX / TILE);
    const ty = Math.floor(pointer.worldY / TILE);
    const dx = tx - r.tx;
    const dy = ty - r.ty;
    if (dx === 0 && dy === 0) return;
    let mdx = 0, mdy = 0;
    if (Math.abs(dy) >= Math.abs(dx)) mdy = dy > 0 ? 1 : -1;
    else                              mdx = dx > 0 ? 1 : -1;
    // Only allow taps within a generous radius — anywhere on screen is
    // OK as long as it picks a single direction. The tile-based engine
    // will only step ONE tile per request; holding doesn't auto-repeat,
    // so spamming the same tap is the way to traverse longer distances.
    this.pointerMove = { dx: mdx, dy: mdy };
  }

  reactRobot(fromTouch = false) {
    this.playRobotChirp();
    if (fromTouch || Math.random() < 0.3) {
      this.sayBubble(this.pick(this.robotTouchLines), 1400);
    }
  }

  warnOnce(key, flashText, bubbleText, cooldown = 1000) {
    const now = this.time.now;
    this._warnedAt ||= {};
    if (now - (this._warnedAt[key] || 0) < cooldown) return;
    this._warnedAt[key] = now;
    if (flashText) this.flashMessage(flashText);
    if (bubbleText) this.sayBubble(bubbleText);
  }

  startDrillSound() {
    if (!this.drillLoop || this.drillLoop.isPlaying) return;
    this.drillLoop.play();
  }

  stopDrillSound() {
    if (!this.drillLoop || !this.drillLoop.isPlaying) return;
    this.drillLoop.stop();
  }

  playBreakSound() {
    if (!this.breakSound) return;
    this.breakSound.play();
  }

  playDrillFailSound() {
    if (!this.drillFailSound) return;
    this.drillFailSound.stop();
    this.drillFailSound.play();
  }

  playOreCashSound() {
    if (!this.oreCashSound) return;
    this.oreCashSound.stop();
    this.oreCashSound.play();
  }

  playRobotChirp() {
    const sounds = this.robotTouchSounds?.filter(Boolean) || [];
    if (sounds.length === 0) return;
    for (const sound of sounds) sound.stop();
    this.pick(sounds).play();
  }

  playRobotSadSound() {
    if (!this.robotSadSound) return;
    this.robotSadSound.stop();
    this.robotSadSound.play();
  }

  playLadderPlaceSound() {
    if (!this.ladderPlaceSound) return;
    this.ladderPlaceSound.stop();
    this.ladderPlaceSound.play();
  }

  followCamera() {
    const r = this.robot;
    this.cameras.main.centerOn(r.px * TILE + TILE / 2, r.py * TILE + TILE / 2);
  }

  adjustZoom(delta) {
    const cam = this.cameras.main;
    const next = Math.max(0.08, Math.min(2.5, (cam.zoom || 1) + delta));
    cam.setZoom(next);
    this.followCamera();
    this.redraw();
  }

  tweenRobotDrawPosition(dt) {
    const r = this.robot;
    const speed = 8.3; // tiles per second (~120ms per tile)
    const step = speed * (dt / 1000);
    const dx = r.tx - r.px;
    const dy = r.ty - r.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      r.px = r.tx;
      r.py = r.ty;
    } else {
      r.px += (dx / dist) * step;
      r.py += (dy / dist) * step;
    }
  }

  redraw() {
    this.drawWorld();
    this.drawRobot();
    this.drawFog();
  }

  createFogOverlay() {
    document.getElementById('fog-overlay')?.remove();
    const d = document.createElement('div');
    d.id = 'fog-overlay';
    d.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 6;
      display: none; background: transparent;
    `;
    document.body.appendChild(d);
    this.fogOverlay = d;
  }

  cleanupSceneDOM() {
    for (const id of ['fog-overlay', 'hud', 'inv', 'hud-hint', 'inventory', 'bubble', 'flash', 'shop', 'respawn-dialog', 'win-dialog', 'menu-bubble', 'menu-start', 'menu-generate', 'menu-customizer', 'menu-customizer-modal', 'menu-tunnel-overlay']) {
      document.getElementById(id)?.remove();
    }
  }

  destroySceneDOM() {
    this.stopDrillSound();
    if (this.fuseLoop && this.fuseLoop.isPlaying) this.fuseLoop.stop();
    if (this.shakeLoop && this.shakeLoop.isPlaying) this.shakeLoop.stop();
    if (this._respawnKeyHandler) {
      window.removeEventListener('keydown', this._respawnKeyHandler);
      this._respawnKeyHandler = null;
    }
    if (this._winKeyHandler) {
      window.removeEventListener('keydown', this._winKeyHandler);
      this._winKeyHandler = null;
    }
    this.input?.off('pointerdown', this.handleRobotPointerDown, this);
    this.cleanupSceneDOM();
    this.fogOverlay = null;
    this.shopEl = null;
    this.invEl = null;
    this.bubbleEl = null;
    this.bubbleTextEl = null;
    this.flashEl = null;
  }

  drawWorld() {
    const g = this.worldGfx;
    g.clear();
    this.tilePoolCursor = 0;

    const cam = this.cameras.main;
    // Floor scroll to integer pixels: worldGfx is in world space and fillRect
    // on fractional coords leaves 1px gaps on the canvas edges when the camera
    // smoothly tweens. Pad each fill by a few px past the viewport to hide it.
    const camX = Math.floor(cam.scrollX) - 2;
    const camY = Math.floor(cam.scrollY) - 2;
    const camW = Math.ceil(cam.width) + 4;
    const camH = Math.ceil(cam.height) + 4;

    const left = Math.max(0, Math.floor(cam.scrollX / TILE) - 1);
    const right = Math.min(this.world.W, Math.ceil((cam.scrollX + cam.width) / TILE) + 1);
    const top = Math.max(0, Math.floor(cam.scrollY / TILE) - 1);
    const bot = Math.min(this.world.H, Math.ceil((cam.scrollY + cam.height) / TILE) + 1);

    // Sky background (above surface) — painted everywhere above first dirt row.
    const skyBottom = SURFACE_Y * TILE;
    const skyFillBottom = Math.min(camY + camH, skyBottom);
    if (skyFillBottom > camY) {
      g.fillStyle(0x4a7bbf, 1);
      g.fillRect(camX, camY, camW, skyFillBottom - camY);
    }

    // Dug-out backdrop: visible through any empty tile below the surface.
    // A dark brown base with subtle darker speckles — reads as "excavated
    // tunnel wall" instead of the void-black default.
    const ugTop = Math.max(camY, SURFACE_Y * TILE);
    const ugBottom = Math.min(camY + camH, this.world.H * TILE);
    if (ugBottom > ugTop) {
      g.fillStyle(0x3a2412, 1);
      g.fillRect(camX, ugTop, camW, ugBottom - ugTop);
      // Ribbed/pitted texture — procedurally placed dark spots on a 24px grid.
      g.fillStyle(0x1f130a, 0.55);
      const step = 24;
      const startX = Math.floor(camX / step) * step;
      const startY = Math.floor(ugTop / step) * step;
      for (let yy = startY; yy < ugBottom; yy += step) {
        for (let xx = startX; xx < camX + camW; xx += step) {
          const s = (xx * 73856093 ^ yy * 19349663) >>> 0;
          const ox = (s % 10);
          const oy = ((s >>> 8) % 10);
          const sz = 3 + ((s >>> 16) % 3);
          g.fillRect(xx + ox, yy + oy, sz, sz);
        }
      }
    }

    for (let y = top; y < bot; y++) {
      for (let x = left; x < right; x++) {
        const type = getBlock(this.world, x, y);
        if (type === BLOCK.SKY) continue;
        const data = BLOCK_DATA[type];
        this.drawTile(g, x, y, type, data);
      }
    }

    // Hide any leftover pool sprites from last frame.
    for (let i = this.tilePoolCursor; i < this.tilePool.length; i++) {
      this.tilePool[i].setVisible(false);
    }

    // Surface structures. Single-player has a central shop building; the
    // digger arena gives each agent its own surface spot, marked by a totem
    // (no central shop → no extra walking to bank/refuel/upgrade).
    if (this.world.model === 'digger') this.drawTotems(g);
    else this.drawShop(g);
  }

  // Per-spot "sell totem": a short wooden post with a glowing orb on top,
  // planted on the surface at each digger's home column. `this.totemSpots`
  // is a list of surface x-columns (set by the spectator from the miners).
  drawTotems(g) {
    const spots = this.totemSpots;
    if (!spots || !spots.length) return;
    const groundY = SURFACE_Y * TILE;
    for (const sx of spots) {
      const cx = sx * TILE + TILE / 2;
      const top = groundY - TILE + 2;
      // post
      g.fillStyle(0x5a3410, 1);
      g.fillRect(cx - 3, top + 8, 6, TILE - 8);
      g.fillStyle(0x8d5d2a, 1);
      g.fillRect(cx - 3, top + 8, 2, TILE - 8); // light edge
      // little cross-bar / banner arm
      g.fillStyle(0x6a3e15, 1);
      g.fillRect(cx - 7, top + 12, 14, 3);
      // glowing orb beacon (the "shop" marker)
      g.fillStyle(0x103a52, 1);
      g.fillCircle(cx, top + 4, 7);
      g.fillStyle(0x5fd6ff, 1);
      g.fillCircle(cx, top + 4, 5);
      g.fillStyle(0xd6f7ff, 0.9);
      g.fillCircle(cx - 1.5, top + 2.5, 2);
    }
  }

  drawClouds() {
    const g = this.cloudGfx;
    g.clear();
    const cam = this.cameras.main;
    // Hide clouds entirely when the sky band isn't on screen (player is
    // deep underground). Otherwise a fixed-screen cloud would float in
    // front of the dirt.
    const zoom = cam.zoom || 1;
    const skyBottomScreen = (SURFACE_Y * TILE - cam.scrollY) * zoom;
    if (skyBottomScreen <= 0) return;

    const W = cam.width;
    const t = this.time.now;
    // Wrap region — wider than the screen so clouds drift in/out cleanly.
    const bufW = W + 400;
    for (const c of this.clouds) {
      // Position is purely autonomous: time * drift, NOT camera-driven.
      // Walking left/right no longer moves the clouds.
      const localX = ((c.baseX + t * c.drift) % bufW + bufW) % bufW - 200;
      const x = Math.floor(localX);
      const y = Math.floor(c.baseY);
      if (y + c.h > skyBottomScreen) continue;
      // Soft puff: three overlapping ellipses, white with slight transparency.
      g.fillStyle(0xffffff, 0.85);
      g.fillEllipse(x + c.w * 0.3, y + c.h * 0.55, c.w * 0.55, c.h);
      g.fillEllipse(x + c.w * 0.6, y + c.h * 0.45, c.w * 0.6, c.h * 1.05);
      g.fillEllipse(x + c.w * 0.85, y + c.h * 0.6, c.w * 0.4, c.h * 0.85);
      // Subtle shadow on underside
      g.fillStyle(0xbfd3e8, 0.55);
      g.fillEllipse(x + c.w * 0.55, y + c.h * 0.85, c.w * 0.7, c.h * 0.4);
    }
  }

  acquireTileSprite() {
    let s = this.tilePool[this.tilePoolCursor];
    if (!s) {
      s = this.add.image(0, 0, '__MISSING__');
      s.setOrigin(0, 0);
      s.setDepth(1);
      this.tilePool.push(s);
    }
    this.tilePoolCursor++;
    return s;
  }

  drawTile(g, x, y, type, data) {
    // Shaking stones wobble
    let jitterX = 0, jitterY = 0;
    if (type === BLOCK.STONE) {
      const shaking = this.fallingStones?.find(s => s.x === x && s.y === y && s.state === 'shake');
      if (shaking) {
        jitterX = Math.sin(this.time.now / 40 + x) * 2;
        jitterY = Math.cos(this.time.now / 35 + y) * 1.5;
      }
    }
    const px = x * TILE + jitterX, py = y * TILE + jitterY;

    // Chests get a bespoke procedural draw based on their tier metadata.
    if (type === BLOCK.CHEST) {
      this.drawChestTile(g, x, y, px, py);
      return;
    }

    if (type === BLOCK.LAVA) {
      this.drawLavaTile(g, x, y, px, py);
      return;
    }

    if (type === BLOCK.WATER) {
      this.drawWaterTile(g, x, y, px, py);
      return;
    }

    // If a texture exists for this tile, use the sprite pool and skip procedural drawing.
    let texKey = TILE_TEXTURE[type];
    // Dirt on the surface row gets a grass-capped sprite if available.
    if (type === BLOCK.DIRT && y === SURFACE_Y && this.textures.exists('grass')) {
      texKey = 'grass';
    }
    if (texKey && this.textures.exists(texKey)) {
      const s = this.acquireTileSprite();
      s.setTexture(texKey);
      s.setDisplaySize(TILE, TILE);
      s.setPosition(px, py);
      s.setVisible(true);
      // Biome tint: dirt darkens / cools with depth so each ~20m band reads
      // visually different without adding new assets. Multiplier via setTint.
      if (type === BLOCK.DIRT) s.setTint(dirtTintForDepth(y - SURFACE_Y));
      else s.clearTint();
      return;
    }

    // Ladder / pillar are drawn directly against the dug-out backdrop —
    // NO base fill, NO bevel, NO outline. Otherwise each tile gets its
    // own framed rectangle and the rails of stacked ladders end up with
    // a visible seam at every tile boundary (looks like the ladder is
    // chopped into pieces).
    if (type === BLOCK.LADDER || type === BLOCK.PILLAR || type === BLOCK.TORCH) {
      // Torch / ladder / pillar render directly on the dug-out backdrop —
      // no base square, no bevel, no outline. Otherwise stacked tiles
      // get a visible seam at every boundary.
      this.drawTileDetail(g, x, y, type, px, py, (x * 31 ^ y * 17) >>> 0);
      return;
    }

    // Procedural fallback below — chiseled / pixel-voxel look.
    // Every block: base fill, top+left highlight bevel, bottom+right
    // shadow bevel, black outline, type-specific detail painted on top.
    //
    // "Embedded ore" tiles (copper/silver/gold/emerald/ruby/diamond)
    // share the dirt base so the world reads as ONE biome with veins
    // and crystals showing through, not a disco of solid-color blocks.
    // Coal/iron keep their own warm-brown palette because their detail
    // already implies dirt context.
    const EMBEDDED_ORES = (
      type === BLOCK.COPPER || type === BLOCK.SILVER ||
      type === BLOCK.GOLD   || type === BLOCK.EMERALD ||
      type === BLOCK.RUBY   || type === BLOCK.DIAMOND ||
      type === BLOCK.BONE   || type === BLOCK.COIN   ||
      type === BLOCK.RING   || type === BLOCK.SKULL  ||
      type === BLOCK.SHRINE || type === BLOCK.DRILL_RELIC ||
      type === BLOCK.SCRST  || type === BLOCK.BCRST  || type === BLOCK.HCRST
    );
    let palette = TILE_PALETTE[type] || { base: data.color, light: 0xffffff, dark: 0x000000 };
    if (type === BLOCK.DIRT || EMBEDDED_ORES) {
      const dirtPal = TILE_PALETTE[BLOCK.DIRT];
      const tint = dirtTintForDepth(y - SURFACE_Y);
      palette = {
        base:  multiplyHex(dirtPal.base,  tint),
        light: multiplyHex(dirtPal.light, tint),
        dark:  multiplyHex(dirtPal.dark,  tint),
      };
    }

    const seed = (x * 73856093 ^ y * 19349663) >>> 0;

    // Base fill
    g.fillStyle(palette.base, 1);
    g.fillRect(px, py, TILE, TILE);

    // Subtle scatter of darker pixels for texture (deterministic per tile).
    g.fillStyle(palette.dark, 0.35);
    for (let i = 0; i < 5; i++) {
      const sx = (seed >>> (i * 3)) % (TILE - 4);
      const sy = (seed >>> (i * 3 + 13)) % (TILE - 4);
      g.fillRect(px + sx, py + sy, 2, 2);
    }

    // Chiseled bevel
    g.fillStyle(palette.light, 1);
    g.fillRect(px, py, TILE, 3);
    g.fillRect(px, py, 3, TILE);
    g.fillStyle(palette.dark, 1);
    g.fillRect(px, py + TILE - 3, TILE, 3);
    g.fillRect(px + TILE - 3, py, 3, TILE);
    // Bright corner pip
    g.fillStyle(0xffffff, 0.22);
    g.fillRect(px + 3, py + 3, 4, 1);
    g.fillRect(px + 3, py + 3, 1, 4);

    // Black outline (slightly inset for crispness)
    g.lineStyle(1, 0x000000, 0.5);
    g.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);

    // Cartoon grass cap on the top-most ground row. Paints over the top
    // bevel + outline so blades and the green band read as one continuous
    // strip across adjacent tiles. Blades extend up into the sky row,
    // which is fine because tiles draw after the sky fill.
    if (y === SURFACE_Y && (type === BLOCK.DIRT || type === BLOCK.COAL)) {
      this.drawGrassCap(g, x, px, py, seed);
    }

    // Per-type detail (coal shards, ore streaks, gem facets, etc).
    this.drawTileDetail(g, x, y, type, px, py, seed);
  }

  // Cartoon SVG-style grass cap, drawn over a surface tile. Uses
  // triangles to fake the rounded blade shapes from the reference image:
  // a darker green silhouette behind a brighter green core, plus a
  // wavy darker band marking the soil/grass border.
  drawGrassCap(g, x, px, py, seed) {
    const GREEN_HI   = 0x86dd58;  // bright top stripe
    const GREEN_MID  = 0x53b545;  // main green band
    const GREEN_DARK = 0x2c7a2e;  // outline / shadow
    const GREEN_DEEP = 0x1f5a23;  // bottom outline accent

    // ---- Soil-side wavy border. Bumps point down into the dirt so the
    // grass appears to "drape" over the soil. Drawn first so tile detail
    // / blades paint on top.
    g.fillStyle(GREEN_DEEP, 1);
    for (let i = 0; i < 5; i++) {
      const sx = px + i * 12;
      g.fillTriangle(sx, py + 14, sx + 6, py + 19, sx + 12, py + 14);
    }
    // ---- Main green band
    g.fillStyle(GREEN_MID, 1);
    g.fillRect(px, py, TILE, 14);
    // Lighter top stripe for the SVG-style highlight
    g.fillStyle(GREEN_HI, 1);
    g.fillRect(px, py, TILE, 6);
    // Wavy soil-side band one row above the deep wave (creates the
    // double-bumped silhouette from the reference)
    g.fillStyle(GREEN_DARK, 1);
    for (let i = 0; i < 5; i++) {
      const sx = px + i * 12 - 4;
      g.fillTriangle(sx, py + 12, sx + 6, py + 17, sx + 12, py + 12);
    }
    g.fillRect(px, py, TILE, 1); // crisp top edge

    // ---- Tufts of tall grass sticking up. 1-2 per tile, position based
    // on a seed so neighbouring tiles look varied but stable across
    // redraws. Each tuft is a fan of 5 blades: dark outline behind a
    // brighter inner fan.
    const tuftCount = ((seed >>> 4) & 1) ? 1 : 2;
    for (let i = 0; i < tuftCount; i++) {
      const slot = ((seed >>> (i * 5)) & 0x1f) % (TILE - 18);
      const cx = px + 9 + slot;
      this.drawGrassTuft(g, cx, py, GREEN_DARK, GREEN_MID, GREEN_HI, (seed >>> (i * 7)) & 0xff);
    }
  }

  // One bushel of grass blades. cx = horizontal centre, py = top of the
  // surface tile. Blades grow upward (negative dy) into the sky.
  drawGrassTuft(g, cx, py, dark, mid, hi, jitter) {
    const j = (jitter % 5) - 2;       // -2..+2
    const tall  = 22 + (jitter & 3);  // 22..25 px
    const med   = 16 + ((jitter >>> 2) & 3);
    const short = 12 + ((jitter >>> 4) & 3);
    const baseY = py + 2;             // sit slightly inside the tile

    // Dark green silhouette (stroke-equivalent).
    g.fillStyle(dark, 1);
    g.fillTriangle(cx - 9, baseY, cx - 4, baseY - short - 1, cx + 1, baseY);
    g.fillTriangle(cx - 5, baseY, cx,     baseY - tall  - 1, cx + 5, baseY);
    g.fillTriangle(cx - 1, baseY, cx + 4, baseY - med   - 1, cx + 9, baseY);
    g.fillTriangle(cx + 4, baseY, cx + 8, baseY - short - 1, cx + 12, baseY);
    g.fillTriangle(cx - 12, baseY, cx - 8, baseY - short - 1, cx - 4, baseY);

    // Inner brighter blades (fill-equivalent).
    g.fillStyle(mid, 1);
    g.fillTriangle(cx - 8 + j, baseY - 1, cx - 4, baseY - short, cx + 0, baseY - 1);
    g.fillTriangle(cx - 4 + j, baseY - 1, cx,     baseY - tall,  cx + 4, baseY - 1);
    g.fillTriangle(cx + 0 + j, baseY - 1, cx + 4, baseY - med,   cx + 8, baseY - 1);
    g.fillTriangle(cx + 5 + j, baseY - 1, cx + 8, baseY - short, cx + 11, baseY - 1);
    g.fillTriangle(cx - 11 + j, baseY - 1, cx - 8, baseY - short, cx - 5, baseY - 1);

    // Bright highlight strip down the centre blade.
    g.fillStyle(hi, 1);
    g.fillTriangle(cx - 1, baseY - 4, cx, baseY - tall + 2, cx + 1, baseY - 4);
  }

  // Type-specific overlay painted on top of the beveled base. Kept
  // separate so the base drawTile loop stays readable.
  drawTileDetail(g, x, y, type, px, py, seed) {
    if (type === BLOCK.STONE) {
      // Two zigzag fracture lines + a few darker chips. Reads as
      // "hard rock you can't drill" without needing color cues.
      g.lineStyle(2, 0x2a2a2a, 0.7);
      g.beginPath();
      g.moveTo(px + 6,  py + 12);
      g.lineTo(px + 18, py + 20);
      g.lineTo(px + 14, py + 30);
      g.lineTo(px + 28, py + 38);
      g.strokePath();
      g.lineStyle(1, 0x2a2a2a, 0.55);
      g.beginPath();
      g.moveTo(px + 30, py + 8);
      g.lineTo(px + 38, py + 18);
      g.strokePath();
      g.fillStyle(0x2a2a2a, 0.6);
      g.fillRect(px + 12, py + 22, 3, 3);
      g.fillRect(px + 32, py + 32, 3, 2);
      // Tiny bright fleck
      g.fillStyle(0xffffff, 0.25);
      g.fillRect(px + 20, py + 14, 2, 2);
      return;
    }

    if (type === BLOCK.COAL) {
      // Three big chunky black shards positioned with seeded jitter.
      // Each shard is two overlapping triangles so it reads as a
      // jagged piece of coal rather than a circle.
      const j1x = (seed       & 7);
      const j1y = ((seed>>>3) & 7);
      const j2x = ((seed>>>6) & 7);
      const j2y = ((seed>>>9) & 7);
      g.fillStyle(0x080808, 1);
      // shard A — top-left
      g.fillTriangle(px+6+j1x, py+10+j1y, px+18, py+8, px+22, py+20);
      g.fillTriangle(px+6+j1x, py+10+j1y, px+22, py+20, px+10, py+22);
      // shard B — bottom-right
      g.fillTriangle(px+22, py+24, px+38-j2x, py+22+j2y, px+34, py+38);
      g.fillTriangle(px+22, py+24, px+34, py+38, px+20, py+34);
      // shard C — bottom-left small
      g.fillTriangle(px+8, py+30, px+18, py+28, px+12, py+40);
      // Glints — coal catches the headlamp
      g.fillStyle(0xffffff, 0.4);
      g.fillRect(px + 14, py + 12, 2, 1);
      g.fillRect(px + 28, py + 28, 2, 1);
      g.fillRect(px + 11, py + 33, 1, 1);
      return;
    }

    if (type === BLOCK.IRON) {
      // Two diagonal rusty ore streaks on the dirt.
      g.fillStyle(0x6a4630, 1);
      g.fillTriangle(px+6, py+14, px+22, py+8, px+24, py+22);
      g.fillTriangle(px+22, py+24, px+38, py+30, px+30, py+40);
      g.fillStyle(0xb47e58, 1);
      g.fillTriangle(px+9, py+16, px+20, py+12, px+22, py+22);
      g.fillTriangle(px+24, py+26, px+34, py+30, px+30, py+36);
      g.fillStyle(0xffffff, 0.55);
      g.fillRect(px + 14, py + 14, 2, 1);
      g.fillRect(px + 28, py + 30, 2, 1);
      return;
    }

    if (type === BLOCK.COPPER) {
      // Thin copper veins running diagonally through the dirt — bright
      // orange streak with a darker shadow line just below it.
      const offX = (seed       & 3);
      const offY = ((seed>>>4) & 3);
      g.lineStyle(2, 0x4a1a04, 0.85);
      g.beginPath();
      g.moveTo(px + 4,  py + 14 + offY);
      g.lineTo(px + 20, py + 18);
      g.lineTo(px + 30, py + 12 + offY);
      g.lineTo(px + 44, py + 16);
      g.strokePath();
      g.lineStyle(2, 0xe6753a, 1);
      g.beginPath();
      g.moveTo(px + 4,  py + 12 + offY);
      g.lineTo(px + 20, py + 16);
      g.lineTo(px + 30, py + 10 + offY);
      g.lineTo(px + 44, py + 14);
      g.strokePath();
      // A second smaller streak lower-right.
      g.lineStyle(2, 0xb55326, 1);
      g.beginPath();
      g.moveTo(px + 14 + offX, py + 30);
      g.lineTo(px + 26, py + 36);
      g.lineTo(px + 38, py + 32);
      g.strokePath();
      g.lineStyle(0, 0, 0);
      // A few orange flecks for sparkle.
      g.fillStyle(0xffae6b, 1);
      g.fillRect(px + 22, py + 14, 2, 2);
      g.fillRect(px + 30, py + 34, 2, 2);
      return;
    }

    if (type === BLOCK.SILVER) {
      // Wavy silver vein — bright zigzag stroke with a darker outline.
      const wob = (seed & 7) - 3;
      g.lineStyle(4, 0x36404e, 1);   // shadow under the vein
      g.beginPath();
      g.moveTo(px + 4,  py + 18 + wob);
      g.lineTo(px + 16, py + 28 + wob);
      g.lineTo(px + 28, py + 16 + wob);
      g.lineTo(px + 44, py + 26 + wob);
      g.strokePath();
      g.lineStyle(2, 0xeaedf5, 1);   // bright silver core
      g.beginPath();
      g.moveTo(px + 4,  py + 18 + wob);
      g.lineTo(px + 16, py + 28 + wob);
      g.lineTo(px + 28, py + 16 + wob);
      g.lineTo(px + 44, py + 26 + wob);
      g.strokePath();
      g.lineStyle(0, 0, 0);
      // 3 silver beads scattered on the dirt.
      g.fillStyle(0xeaedf5, 1);
      g.fillRect(px + 12, py + 36, 3, 3);
      g.fillRect(px + 32, py + 8,  3, 3);
      g.fillStyle(0xffffff, 0.9);
      g.fillRect(px + 13, py + 36, 1, 1);
      g.fillRect(px + 33, py + 8,  1, 1);
      return;
    }

    if (type === BLOCK.GOLD) {
      // Golden vein + nuggets. Same wavy stroke as silver but yellow,
      // plus three rounded nuggets sitting on top of the dirt.
      const wob = ((seed >>> 2) & 7) - 3;
      g.lineStyle(4, 0x6a4a14, 1);
      g.beginPath();
      g.moveTo(px + 4,  py + 16 + wob);
      g.lineTo(px + 18, py + 26 + wob);
      g.lineTo(px + 30, py + 14 + wob);
      g.lineTo(px + 44, py + 24 + wob);
      g.strokePath();
      g.lineStyle(2, 0xffd84a, 1);
      g.beginPath();
      g.moveTo(px + 4,  py + 16 + wob);
      g.lineTo(px + 18, py + 26 + wob);
      g.lineTo(px + 30, py + 14 + wob);
      g.lineTo(px + 44, py + 24 + wob);
      g.strokePath();
      g.lineStyle(0, 0, 0);
      // Nuggets — small filled blobs (triangle pairs).
      const drawNugget = (cx, cy, r) => {
        g.fillStyle(0x6a4a14, 1);
        g.fillTriangle(cx - r, cy, cx, cy - r, cx + r, cy);
        g.fillTriangle(cx - r, cy, cx + r, cy, cx, cy + r);
        g.fillStyle(0xffd84a, 1);
        g.fillTriangle(cx - r + 1, cy, cx, cy - r + 1, cx + r - 1, cy);
        g.fillTriangle(cx - r + 1, cy, cx + r - 1, cy, cx, cy + r - 1);
        g.fillStyle(0xfff5b0, 1);
        g.fillRect(cx - 1, cy - 2, 2, 1);
      };
      drawNugget(px + 12, py + 36, 4);
      drawNugget(px + 30, py + 38, 3);
      drawNugget(px + 36, py + 8,  3);
      return;
    }

    if (type === BLOCK.EMERALD) {
      // Three short emerald crystals jutting out of the dirt at slight
      // angles. Each crystal is a tall hexagon (6 triangles) with a
      // darker outline + bright facet streak. Positioned by seed so
      // tiles vary visually.
      const drawCrystal = (cx, cy, h, w, tilt) => {
        const tx = cx + tilt;
        // outline
        g.fillStyle(0x0d3a22, 1);
        g.fillTriangle(cx - w, cy, cx, cy - h, cx + w, cy);
        g.fillTriangle(cx - w, cy, cx, cy + 2, cx + w, cy);
        g.fillTriangle(cx - w, cy, cx, cy + 4, cx, cy - h);
        // body
        g.fillStyle(0x46c97e, 1);
        g.fillTriangle(cx - w + 1, cy, tx, cy - h + 2, cx + w - 1, cy);
        g.fillStyle(0x7ce0a0, 1);
        g.fillTriangle(cx - w + 2, cy - 1, tx, cy - h + 3, cx, cy);
        // glint
        g.fillStyle(0xffffff, 0.95);
        g.fillRect(tx - 1, cy - h + 4, 1, Math.max(2, h - 6));
      };
      const ox = (seed & 3) - 1;
      drawCrystal(px + 14, py + 38 + ox, 18, 5, -1);
      drawCrystal(px + 26, py + 40, 14, 4, 1);
      drawCrystal(px + 36, py + 36 - ox, 16, 4, 0);
      return;
    }

    if (type === BLOCK.RUBY) {
      // Same crystal layout as emerald but red — three short ruby
      // shards embedded in deep-biome dirt.
      const drawCrystal = (cx, cy, h, w, tilt) => {
        const tx = cx + tilt;
        g.fillStyle(0x4a0813, 1);
        g.fillTriangle(cx - w, cy, cx, cy - h, cx + w, cy);
        g.fillTriangle(cx - w, cy, cx, cy + 2, cx + w, cy);
        g.fillTriangle(cx - w, cy, cx, cy + 4, cx, cy - h);
        g.fillStyle(0xe23a4f, 1);
        g.fillTriangle(cx - w + 1, cy, tx, cy - h + 2, cx + w - 1, cy);
        g.fillStyle(0xff7a8c, 1);
        g.fillTriangle(cx - w + 2, cy - 1, tx, cy - h + 3, cx, cy);
        g.fillStyle(0xffd0d8, 0.95);
        g.fillRect(tx - 1, cy - h + 4, 1, Math.max(2, h - 6));
      };
      const ox = (seed & 3) - 1;
      drawCrystal(px + 14, py + 38, 16, 4, 1);
      drawCrystal(px + 26, py + 40 + ox, 18, 5, -1);
      drawCrystal(px + 36, py + 36, 14, 4, 0);
      return;
    }

    if (type === BLOCK.DIAMOND) {
      // ONE big blue crystal with bright facets + sparkle, plus two
      // tiny shards beside it. Reads as the "treasure" tile of the
      // game — big enough to be unmistakable on a regular dirt tile.
      g.fillStyle(0x103e58, 1);
      g.fillTriangle(px+10, py+30, px+22, py+8,  px+34, py+30);
      g.fillTriangle(px+10, py+30, px+22, py+44, px+34, py+30);
      g.fillStyle(0x6fdbf6, 1);
      g.fillTriangle(px+14, py+30, px+22, py+12, px+30, py+30);
      g.fillTriangle(px+14, py+30, px+22, py+40, px+30, py+30);
      g.fillStyle(0xd6f7ff, 1);
      g.fillTriangle(px+18, py+30, px+22, py+16, px+26, py+30);
      // Big bright star sparkle on top of the crystal.
      g.fillStyle(0xffffff, 1);
      g.fillRect(px + 21, py + 14, 2, 10);
      g.fillRect(px + 16, py + 21, 12, 2);
      // Two tiny shards in the corners
      g.fillStyle(0x6fdbf6, 1);
      g.fillTriangle(px + 4,  py + 38, px + 8,  py + 32, px + 12, py + 40);
      g.fillTriangle(px + 36, py + 40, px + 40, py + 34, px + 44, py + 42);
      g.fillStyle(0xd6f7ff, 1);
      g.fillRect(px + 7,  py + 36, 1, 1);
      g.fillRect(px + 39, py + 38, 1, 1);
      return;
    }

    // Digger crystals: small (cyan) + big (green) read as a cluster of shards;
    // huge (magenta) is a single treasure gem like the diamond.
    if (type === BLOCK.SCRST || type === BLOCK.BCRST) {
      const C = type === BLOCK.SCRST
        ? { out: 0x0d3a4a, body: 0x2fb6df, hi: 0x8fe9ff, h: 13, w: 4 }
        : { out: 0x0d3a22, body: 0x35c46a, hi: 0x9bffbf, h: 17, w: 5 };
      const drawShard = (cx, cy, h, w, tilt) => {
        const tx = cx + tilt;
        g.fillStyle(C.out, 1);
        g.fillTriangle(cx - w, cy, cx, cy - h, cx + w, cy);
        g.fillTriangle(cx - w, cy, cx, cy + 4, cx, cy - h);
        g.fillStyle(C.body, 1);
        g.fillTriangle(cx - w + 1, cy, tx, cy - h + 2, cx + w - 1, cy);
        g.fillStyle(C.hi, 0.95);
        g.fillRect(tx - 1, cy - h + 4, 1, Math.max(2, h - 6));
      };
      const ox = (seed & 3) - 1;
      drawShard(px + 14, py + 38 + ox, C.h + 3, C.w, -1);
      drawShard(px + 26, py + 40, C.h, C.w - 1, 1);
      drawShard(px + 36, py + 36 - ox, C.h + 1, C.w - 1, 0);
      return;
    }

    if (type === BLOCK.HCRST) {
      g.fillStyle(0x4a0d35, 1);
      g.fillTriangle(px+10, py+30, px+22, py+8,  px+34, py+30);
      g.fillTriangle(px+10, py+30, px+22, py+44, px+34, py+30);
      g.fillStyle(0xe85cc0, 1);
      g.fillTriangle(px+14, py+30, px+22, py+12, px+30, py+30);
      g.fillTriangle(px+14, py+30, px+22, py+40, px+30, py+30);
      g.fillStyle(0xffc6ef, 1);
      g.fillTriangle(px+18, py+30, px+22, py+16, px+26, py+30);
      g.fillStyle(0xffffff, 1);
      g.fillRect(px + 21, py + 14, 2, 10);
      g.fillRect(px + 16, py + 21, 12, 2);
      return;
    }

    if (type === BLOCK.BONE) {
      // Dinosaur fossil — a stylised femur lying diagonally, plus two
      // ribs poking out. Bone-white on dirt.
      g.fillStyle(0x8a7a52, 1);
      // shadow
      g.fillTriangle(px+8, py+34, px+38, py+12, px+38, py+18);
      g.fillTriangle(px+8, py+34, px+38, py+18, px+10, py+38);
      g.fillStyle(0xefe4c2, 1);
      // shaft
      g.fillTriangle(px+10, py+32, px+38, py+12, px+38, py+16);
      g.fillTriangle(px+10, py+32, px+38, py+16, px+12, py+36);
      // knobs at the ends
      g.fillStyle(0xefe4c2, 1);
      g.fillRect(px + 6,  py + 30, 8, 8);
      g.fillRect(px + 34, py + 8,  8, 8);
      g.lineStyle(1, 0x6a5a32, 1);
      g.strokeRect(px + 6,  py + 30, 8, 8);
      g.strokeRect(px + 34, py + 8,  8, 8);
      g.lineStyle(0, 0, 0);
      // Tiny rib chips
      g.fillStyle(0xefe4c2, 1);
      g.fillRect(px + 14, py + 12, 6, 2);
      g.fillRect(px + 28, py + 28, 6, 2);
      return;
    }

    if (type === BLOCK.COIN) {
      // Pile of three gold coins with a rim and a stamp.
      const drawCoin = (cx, cy) => {
        g.fillStyle(0x6a4a14, 1);
        g.fillTriangle(cx - 7, cy, cx, cy - 7, cx + 7, cy);
        g.fillTriangle(cx - 7, cy, cx + 7, cy, cx, cy + 7);
        g.fillStyle(0xffd84a, 1);
        g.fillTriangle(cx - 6, cy, cx, cy - 6, cx + 6, cy);
        g.fillTriangle(cx - 6, cy, cx + 6, cy, cx, cy + 6);
        g.fillStyle(0x6a4a14, 1);
        g.fillRect(cx - 1, cy - 2, 2, 4); // stamp
        g.fillStyle(0xfff5b0, 1);
        g.fillRect(cx - 4, cy - 4, 2, 1);
      };
      drawCoin(px + 16, py + 32);
      drawCoin(px + 28, py + 30);
      drawCoin(px + 22, py + 22);
      return;
    }

    if (type === BLOCK.RING) {
      // Gold ring with a sky-blue gem on top.
      g.lineStyle(4, 0x6a4a14, 1);
      g.strokeRect(px + 14, py + 18, 18, 18);
      g.lineStyle(2, 0xffd84a, 1);
      g.strokeRect(px + 14, py + 18, 18, 18);
      g.lineStyle(0, 0, 0);
      // gem
      g.fillStyle(0x103e58, 1);
      g.fillTriangle(px + 18, py + 18, px + 23, py + 10, px + 28, py + 18);
      g.fillStyle(0x6fdbf6, 1);
      g.fillTriangle(px + 20, py + 18, px + 23, py + 12, px + 26, py + 18);
      g.fillStyle(0xffffff, 0.9);
      g.fillRect(px + 22, py + 14, 1, 2);
      return;
    }

    if (type === BLOCK.SKULL) {
      // A weathered miner skull. Cream-colored cranium + dark eye sockets.
      g.fillStyle(0x6a5a3a, 1);
      g.fillRect(px + 12, py + 14, 24, 22);
      g.fillStyle(0xeae0c4, 1);
      g.fillRect(px + 13, py + 14, 22, 18);
      // jaw
      g.fillRect(px + 16, py + 32, 16, 5);
      g.fillStyle(0x6a5a3a, 1);
      g.fillRect(px + 19, py + 36, 2, 2);
      g.fillRect(px + 23, py + 36, 2, 2);
      g.fillRect(px + 27, py + 36, 2, 2);
      // eye sockets
      g.fillStyle(0x1a1a1a, 1);
      g.fillRect(px + 16, py + 20, 5, 5);
      g.fillRect(px + 27, py + 20, 5, 5);
      // nose
      g.fillStyle(0x6a5a3a, 1);
      g.fillTriangle(px + 22, py + 26, px + 26, py + 26, px + 24, py + 30);
      // crack
      g.lineStyle(1, 0x6a5a3a, 0.9);
      g.beginPath();
      g.moveTo(px + 14, py + 16);
      g.lineTo(px + 18, py + 18);
      g.lineTo(px + 16, py + 20);
      g.strokePath();
      g.lineStyle(0, 0, 0);
      return;
    }

    if (type === BLOCK.SHRINE) {
      // Stone altar with a glowing offering bowl + faint sigils on the
      // base. The flame on top pulses softly to advertise interaction.
      const t = (this.time?.now || 0);
      const pulse = 0.55 + 0.35 * Math.abs(Math.sin(t / 320));
      // base
      g.fillStyle(0x6a5a3a, 1);
      g.fillRect(px + 8,  py + 30, 32, 12);
      g.fillStyle(0x8a7a52, 1);
      g.fillRect(px + 10, py + 30, 28, 4);
      g.fillStyle(0x4a3e22, 1);
      g.fillRect(px + 10, py + 38, 28, 2);
      // pillar
      g.fillStyle(0x9a8a62, 1);
      g.fillRect(px + 14, py + 14, 20, 16);
      g.fillStyle(0x6a5a3a, 1);
      g.fillRect(px + 14, py + 14, 20, 2);
      g.fillRect(px + 14, py + 28, 20, 2);
      // offering bowl + glow
      g.fillStyle(0x3a2a14, 1);
      g.fillRect(px + 18, py + 12, 12, 4);
      g.fillStyle(0xffd84a, pulse);
      g.fillRect(px + 20, py + 8,  8, 6);
      g.fillStyle(0xffae40, 1);
      g.fillRect(px + 22, py + 6,  4, 4);
      // sigil dots on base
      g.fillStyle(0xffc870, 0.85);
      g.fillRect(px + 14, py + 34, 1, 1);
      g.fillRect(px + 22, py + 34, 1, 1);
      g.fillRect(px + 30, py + 34, 1, 1);
      return;
    }

    if (type === BLOCK.DRILL_RELIC) {
      // Embedded broken drill — angled steel cone wedged into the dirt
      // with a chunky housing on top. Reads as "abandoned miner gear".
      g.fillStyle(0x3a3a3a, 1);
      g.fillRect(px + 8,  py + 18, 18, 8);    // motor housing shadow
      g.fillStyle(0x6a6a6a, 1);
      g.fillRect(px + 9,  py + 18, 16, 6);    // housing body
      g.fillStyle(0x8a8a8a, 1);
      g.fillRect(px + 9,  py + 18, 16, 2);    // housing top hi-light
      g.fillStyle(0xffaa00, 1);
      g.fillRect(px + 11, py + 21, 2, 2);     // power LED (off-tone)
      // cone bit pointing down-right
      g.fillStyle(0x2a2a2a, 1);
      g.fillTriangle(px + 22, py + 24, px + 30, py + 24, px + 38, py + 40);
      g.fillStyle(0xb8b8b8, 1);
      g.fillTriangle(px + 23, py + 24, px + 29, py + 24, px + 36, py + 38);
      g.fillStyle(0x6a6a6a, 1);
      g.fillTriangle(px + 27, py + 26, px + 29, py + 24, px + 36, py + 38);
      // notches
      g.fillStyle(0x1a1a1a, 1);
      g.fillRect(px + 26, py + 28, 2, 2);
      g.fillRect(px + 30, py + 32, 2, 2);
      g.fillRect(px + 33, py + 36, 2, 2);
      // cracks in the dirt around it (anchor it to the tile)
      g.lineStyle(1, 0x2a1a08, 0.7);
      g.beginPath();
      g.moveTo(px + 4, py + 26);
      g.lineTo(px + 8, py + 28);
      g.moveTo(px + 36, py + 12);
      g.lineTo(px + 42, py + 10);
      g.strokePath();
      g.lineStyle(0, 0, 0);
      // "DYNAMITE ONLY" hint — tiny red exclamation
      g.fillStyle(0xff3030, 1);
      g.fillRect(px + 6, py + 10, 2, 5);
      g.fillRect(px + 6, py + 16, 2, 2);
      return;
    }

    if (type === BLOCK.TORCH) {
      // Wall sconce with a flickering flame. The flame shape jitters
      // every ~80ms via a deterministic seed so adjacent torches look
      // out-of-sync (more lively).
      const t = (this.time?.now || 0);
      const flick = Math.floor((t + (seed & 7) * 30) / 80) % 3;
      // bracket — small grey wedge attaching to a wall.
      g.fillStyle(0x3a2a14, 1);
      g.fillRect(px + 18, py + 22, 12, 4);
      g.fillStyle(0x6a4a14, 1);
      g.fillRect(px + 20, py + 22, 8,  4);
      // shaft
      g.fillStyle(0x4a2a08, 1);
      g.fillRect(px + 22, py + 14, 4, 14);
      g.fillStyle(0x6a4a14, 1);
      g.fillRect(px + 23, py + 14, 2, 14);
      // flame
      const tipY = py + 4 + flick;
      const baseY = py + 14;
      g.fillStyle(0xc62828, 1);
      g.fillTriangle(px + 19, baseY, px + 24, tipY, px + 29, baseY);
      g.fillStyle(0xffaa20, 1);
      g.fillTriangle(px + 21, baseY, px + 24, tipY + 2, px + 27, baseY);
      g.fillStyle(0xffe07a, 1);
      g.fillTriangle(px + 22, baseY, px + 24, tipY + 5, px + 26, baseY);
      // sparks
      g.fillStyle(0xffd84a, 0.85);
      g.fillRect(px + 20 + (seed & 3), py + 6 + flick, 1, 1);
      g.fillRect(px + 26 - ((seed >>> 4) & 3), py + 8 + flick, 1, 1);
      // soft halo (semi-transparent rect under the flame)
      g.fillStyle(0xffaa20, 0.18);
      g.fillRect(px + 14, py + 0, 20, 18);
      return;
    }

    if (type === BLOCK.LADDER) {
      // Wood ladder: two side rails + rungs with end caps.
      g.fillStyle(0x4f2c0c, 1);
      g.fillRect(px + 6, py, 4, TILE);
      g.fillRect(px + TILE - 10, py, 4, TILE);
      g.fillStyle(0x8b5a2b, 1);
      g.fillRect(px + 7, py, 2, TILE);
      g.fillRect(px + TILE - 9, py, 2, TILE);
      g.fillStyle(0x4f2c0c, 1);
      for (let r = 6; r < TILE; r += 10) {
        g.fillRect(px + 6, py + r, TILE - 12, 3);
        g.fillStyle(0x8b5a2b, 1);
        g.fillRect(px + 6, py + r, TILE - 12, 1);
        g.fillStyle(0x4f2c0c, 1);
      }
      return;
    }

    if (type === BLOCK.PILLAR) {
      // Concrete support: chunky shaft + caps on top + bottom.
      g.fillStyle(0x6a6a6a, 1);
      g.fillRect(px + 6, py, TILE - 12, TILE);
      g.fillStyle(0x8c8c8c, 1);
      g.fillRect(px + 8, py, 2, TILE);
      g.fillStyle(0x3a3a3a, 1);
      g.fillRect(px + TILE - 10, py, 2, TILE);
      // Caps
      g.fillStyle(0x9a9a9a, 1);
      g.fillRect(px + 4, py, TILE - 8, 4);
      g.fillRect(px + 4, py + TILE - 4, TILE - 8, 4);
      return;
    }
  }

  // Pixel-art chest. Tier picks the body/band/lock palette; everything else
  // is drawn procedurally so no sprite asset is required.
  drawChestTile(g, x, y, px, py) {
    const chest = this.world.chestsAt?.get(y * this.world.W + x);
    const tier = CHEST_TIERS[chest?.tier] || CHEST_TIERS.shallow;
    const body = tier.color;
    const band = tier.bandColor;
    const lock = tier.lockColor;

    // Dark cave-floor backing so the chest reads as "sitting in a pocket".
    g.fillStyle(0x1a120a, 1);
    g.fillRect(px, py, TILE, TILE);

    // Chest footprint (inset). Lid is a shorter box sitting on top.
    const bx = px + 4;
    const bw = TILE - 8;
    const bodyTop = py + 18;
    const bodyH = TILE - 18 - 3;
    const lidTop = py + 8;
    const lidH = 12;

    // Body.
    g.fillStyle(body, 1);
    g.fillRect(bx, bodyTop, bw, bodyH);
    // Subtle vertical wood lines.
    g.fillStyle(0x000000, 0.18);
    for (let i = bx + 8; i < bx + bw - 2; i += 10) {
      g.fillRect(i, bodyTop + 2, 1, bodyH - 4);
    }

    // Lid.
    g.fillStyle(body, 1);
    g.fillRect(bx, lidTop, bw, lidH);
    g.fillStyle(0xffffff, 0.08);
    g.fillRect(bx + 2, lidTop + 2, bw - 4, 2); // lid highlight

    // Metal bands (horizontal + vertical corners).
    g.fillStyle(band, 1);
    g.fillRect(bx, lidTop + lidH, bw, 2);            // under-lid band
    g.fillRect(bx, bodyTop + Math.floor(bodyH / 2), bw, 2);
    g.fillRect(bx, lidTop, 2, lidH + bodyH);         // left corner
    g.fillRect(bx + bw - 2, lidTop, 2, lidH + bodyH); // right corner

    // Lock at the front, centered on the lid seam.
    const lkW = 10, lkH = 10;
    const lkX = px + TILE / 2 - lkW / 2;
    const lkY = lidTop + lidH - 2;
    g.fillStyle(lock, 1);
    g.fillRect(lkX, lkY, lkW, lkH);
    g.fillStyle(0x201100, 1);
    g.fillRect(lkX + lkW / 2 - 1, lkY + 3, 2, 4); // keyhole

    // Tight outline.
    g.lineStyle(1, 0x000000, 0.7);
    g.strokeRect(bx + 0.5, lidTop + 0.5, bw - 1, lidH + bodyH - 1);
  }

  drawLavaTile(g, x, y, px, py) {
    // Dark volcanic backing so the bands pop.
    g.fillStyle(0x2a0a00, 1);
    g.fillRect(px, py, TILE, TILE);

    // Animated wavy bands — phase uses world position so neighboring tiles
    // read as one continuous lava surface, not per-tile loops.
    const t = this.time.now / 280;
    const bandH = 6;
    for (let row = 0; row < TILE; row += bandH) {
      const phase = t + (x * 0.9) + (y * 0.35) + row * 0.08;
      const offset = Math.sin(phase) * 3;
      const shade = (row / TILE) * 0.4;
      const color = row < TILE / 2 ? 0xff8a1f : 0xff3a0a;
      g.fillStyle(color, 1 - shade);
      g.fillRect(px, py + row + offset, TILE, bandH + 1);
    }
    // Highlight ripples on top.
    g.fillStyle(0xfff0a0, 0.35);
    for (let i = 0; i < 3; i++) {
      const rx = px + ((x * 7 + i * 11 + Math.floor(t * 6)) % TILE);
      g.fillRect(rx, py + 2 + i * 4, 4, 1);
    }
  }

  drawWaterTile(g, x, y, px, py) {
    // Deep background so transparent layers read as depth.
    g.fillStyle(0x0a2a55, 1);
    g.fillRect(px, py, TILE, TILE);

    const t = this.time.now / 420;
    const bandH = 5;
    for (let row = 0; row < TILE; row += bandH) {
      const phase = t + (x * 0.7) + (y * 0.3) + row * 0.09;
      const offset = Math.sin(phase) * 2;
      const shade = 0.15 + (row / TILE) * 0.35;
      const color = row < TILE / 2 ? 0x3a9ee0 : 0x246dc0;
      g.fillStyle(color, 1 - shade);
      g.fillRect(px, py + row + offset, TILE, bandH + 1);
    }
    // Foam/highlight specks.
    g.fillStyle(0xd0eaff, 0.5);
    for (let i = 0; i < 2; i++) {
      const rx = px + ((x * 5 + i * 13 + Math.floor(t * 8)) % TILE);
      g.fillRect(rx, py + 3 + i * 6, 3, 1);
    }
  }

  drawShop(g) {
    const sx = Math.floor(this.world.W / 2) * TILE; // spawn-column left edge
    const top = (SURFACE_Y - 1) * TILE;        // shop sits one row above ground
    const W = TILE * 3;                        // 3-tile wide facade
    const H = TILE;
    const left = sx - TILE;                    // shop wraps around the spawn col
    const right = left + W;
    const ridgeX = left + W / 2;
    const roofTop = top - TILE * 0.62;
    const t = this.time?.now || 0;

    // ---- Plank wall body (warm wood + horizontal plank seams)
    g.fillStyle(0x7e4a22, 1);
    g.fillRect(left, top, W, H);
    g.fillStyle(0x9a5e2a, 1);
    g.fillRect(left, top, W, 5);                  // top board highlight
    g.fillStyle(0x4a2810, 1);
    for (let i = 1; i < 5; i++) {
      g.fillRect(left, top + Math.floor(i * H / 5), W, 1);
    }
    // Vertical plank-end darker stripes (corner posts)
    g.fillStyle(0x2e1808, 1);
    g.fillRect(left,           top, 3, H);
    g.fillRect(right - 3,      top, 3, H);
    g.fillStyle(0x4a2810, 1);
    g.fillRect(left + W / 3,   top, 1, H);
    g.fillRect(left + W * 2/3, top, 1, H);

    // ---- Stone foundation
    g.fillStyle(0x5a4634, 1);
    g.fillRect(left - 4, top + H - 7, W + 8, 7);
    g.fillStyle(0x2a1f12, 1);
    for (let i = 0; i < 8; i++) g.fillRect(left - 4 + i * 18, top + H - 7, 1, 7);
    g.fillStyle(0x7a6448, 1);
    g.fillRect(left - 4, top + H - 7, W + 8, 1);

    // ---- Pitched roof: shadow layer first, then top, then beam ridge.
    const roofL = left - 8;
    const roofR = right + 8;
    g.fillStyle(0x4a1010, 1);
    g.fillTriangle(roofL, top + 4, roofR, top + 4, ridgeX, roofTop + 6);
    g.fillStyle(0xa83434, 1);
    g.fillTriangle(roofL, top, roofR, top, ridgeX, roofTop);
    // Shingle bands (lines parallel to the eaves)
    g.lineStyle(1, 0x6a1414, 0.85);
    for (let i = 1; i <= 3; i++) {
      const f = i / 4;
      const lx = roofL + (ridgeX - roofL) * f;
      const rx = roofR - (roofR - ridgeX) * f;
      const ly = top + (roofTop - top) * f;
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(rx, ly);
      g.strokePath();
    }
    g.lineStyle(0, 0, 0);
    // Ridge cap
    g.fillStyle(0x3a0808, 1);
    g.fillRect(ridgeX - 2, roofTop - 2, 4, 5);

    // ---- Chimney with a wisp of smoke (purely cosmetic).
    const chX = right - 16;
    const chY = roofTop + (top - roofTop) * 0.45;
    g.fillStyle(0x4a2810, 1);
    g.fillRect(chX, chY, 8, 14);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(chX, chY, 8, 2);
    g.fillStyle(0xdcdcdc, 0.7);
    const puff = (Math.sin(t / 600) + 1) * 0.5;
    g.fillRect(chX - 1, chY - 6 - puff * 4, 4, 4);
    g.fillRect(chX + 2, chY - 12 - puff * 6, 5, 4);

    // ---- Door (centered on the spawn column so the entry reads clearly).
    const doorW = Math.floor(TILE * 0.6);
    const doorH = Math.floor(H * 0.78);
    const doorX = sx + Math.floor((TILE - doorW) / 2);
    const doorY = top + H - doorH - 6;
    g.fillStyle(0x2b1606, 1);
    g.fillRect(doorX, doorY, doorW, doorH);
    g.fillStyle(0x4a2810, 1);
    g.fillRect(doorX + Math.floor(doorW / 3),     doorY + 2, 1, doorH - 4);
    g.fillRect(doorX + Math.floor(doorW * 2 / 3), doorY + 2, 1, doorH - 4);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(doorX, doorY, doorW, 2);
    g.fillRect(doorX, doorY + doorH - 2, doorW, 2);
    // Hinges + knob
    g.fillStyle(0xb0b0b0, 1);
    g.fillRect(doorX + 2, doorY + 5, 5, 2);
    g.fillRect(doorX + 2, doorY + doorH - 7, 5, 2);
    g.fillStyle(0xffd54a, 1);
    g.fillRect(doorX + doorW - 6, doorY + Math.floor(doorH / 2), 3, 3);
    // Tiny window in the upper third of the door
    g.fillStyle(0xffe8a8, 1);
    g.fillRect(doorX + doorW / 2 - 4, doorY + 6, 8, 6);
    g.fillStyle(0x4a2810, 1);
    g.fillRect(doorX + doorW / 2 - 1, doorY + 6, 1, 6);
    g.fillRect(doorX + doorW / 2 - 4, doorY + 9, 8, 1);

    // ---- Welcome mat
    g.fillStyle(0x8b2e2e, 1);
    g.fillRect(doorX - 4, top + H - 5, doorW + 8, 4);
    g.fillStyle(0xc44a4a, 1);
    g.fillRect(doorX - 4, top + H - 5, doorW + 8, 1);

    // ---- Big white SHOP sign hung on chains under the roof eave. White
    // panel with a thick dark frame and bold black pixel letters so it
    // reads cleanly from far away even on the busy plank wall.
    const signW = 96, signH = 24;
    const signX = ridgeX - signW / 2;
    const signY = top + 6;
    // Suspension chains
    g.fillStyle(0x7a7a7a, 1);
    g.fillRect(signX + 8,         top, 2, 8);
    g.fillRect(signX + signW - 10, top, 2, 8);
    g.fillStyle(0xb0b0b0, 1);
    g.fillRect(signX + 8,         top + 2, 1, 1);
    g.fillRect(signX + 8,         top + 5, 1, 1);
    g.fillRect(signX + signW - 10, top + 2, 1, 1);
    g.fillRect(signX + signW - 10, top + 5, 1, 1);
    // Outer dark frame (the "shadow")
    g.fillStyle(0x1c0d04, 1);
    g.fillRect(signX, signY, signW, signH);
    // Inner thick brown bezel
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(signX + 1, signY + 1, signW - 2, signH - 2);
    // White / cream sign face
    g.fillStyle(0xf6ecd1, 1);
    g.fillRect(signX + 4, signY + 4, signW - 8, signH - 8);
    // Subtle warm shadow inside the panel
    g.fillStyle(0xd9c694, 1);
    g.fillRect(signX + 4, signY + signH - 6, signW - 8, 2);
    // Decorative iron studs at the corners
    g.fillStyle(0x2a1606, 1);
    g.fillRect(signX + 4,           signY + 4,           2, 2);
    g.fillRect(signX + signW - 6,   signY + 4,           2, 2);
    g.fillRect(signX + 4,           signY + signH - 6,   2, 2);
    g.fillRect(signX + signW - 6,   signY + signH - 6,   2, 2);
    // SHOP letters — chunky 2-px-wide strokes, 9 tall.
    const letterY = signY + 7;
    const lx = signX + 12;
    const stroke = 2;
    g.fillStyle(0x18120a, 1);
    // helpers (tiny inline so we don't sprout new methods)
    const hbar = (x, y, w) => g.fillRect(x, y, w, stroke);
    const vbar = (x, y, h) => g.fillRect(x, y, stroke, h);
    // S
    hbar(lx,     letterY,         9);
    vbar(lx,     letterY,         5);
    hbar(lx,     letterY + 4,     9);
    vbar(lx + 7, letterY + 4,     5);
    hbar(lx,     letterY + 8,     9);
    // H
    const hX = lx + 14;
    vbar(hX,     letterY,         10);
    vbar(hX + 7, letterY,         10);
    hbar(hX,     letterY + 4,     9);
    // O
    const oX = lx + 28;
    hbar(oX,     letterY,         9);
    hbar(oX,     letterY + 8,     9);
    vbar(oX,     letterY,         10);
    vbar(oX + 7, letterY,         10);
    // P
    const pX = lx + 42;
    vbar(pX,     letterY,         10);
    hbar(pX,     letterY,         9);
    hbar(pX,     letterY + 4,     9);
    vbar(pX + 7, letterY,         6);

    // ---- Wall lantern with a soft flickering glow.
    const lanX = left + W - 14;
    const lanTop = doorY - 4;
    g.fillStyle(0x2a1606, 1);
    g.fillRect(lanX + 3, lanTop - 6, 1, 8);    // bracket arm
    g.fillRect(lanX,     lanTop,    8, 2);
    // Cage
    g.fillStyle(0x222222, 1);
    g.fillRect(lanX, lanTop + 2, 8, 12);
    // Glow inside
    const flicker = 0.7 + (Math.sin(t / 90) + Math.sin(t / 250)) * 0.15;
    g.fillStyle(0xffe49a, Math.min(1, flicker));
    g.fillRect(lanX + 1, lanTop + 4, 6, 8);
    // Outer halo
    g.fillStyle(0xffc94a, 0.18);
    g.fillRect(lanX - 6, lanTop - 2, 20, 22);

    // ---- Roadside SHOP-arrow signpost stuck in the dirt next to the shop,
    // pointing at the door so it still reads as "the shop" from far away.
    const postX = left - 16;
    const postBaseY = top + H + 4;          // dug into the dirt
    const postTopY = top + H - 30;
    g.fillStyle(0x4a2810, 1);
    g.fillRect(postX, postTopY, 4, postBaseY - postTopY);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(postX, postTopY, 1, postBaseY - postTopY);
    // Arrow board pointing right (toward the door)
    g.fillStyle(0xb98a4d, 1);
    g.fillRect(postX - 14, postTopY - 4, 22, 14);
    g.fillTriangle(postX + 8, postTopY - 6, postX + 8, postTopY + 12, postX + 18, postTopY + 3);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(postX - 14, postTopY - 4, 22, 1);
    g.fillRect(postX - 14, postTopY + 9, 22, 1);
    g.fillRect(postX - 14, postTopY - 4, 1, 14);
    // Mini "→ E" hint on the arrow board
    g.fillStyle(0x2a1606, 1);
    // arrow dash
    g.fillRect(postX - 10, postTopY + 2, 6, 2);
    g.fillTriangle(postX - 4, postTopY,   postX - 4, postTopY + 6, postX - 1, postTopY + 3);
    // letter E
    const ex = postX + 1, ey = postTopY + 1;
    g.fillRect(ex,     ey,     4, 1);
    g.fillRect(ex,     ey,     1, 5);
    g.fillRect(ex,     ey + 2, 3, 1);
    g.fillRect(ex,     ey + 4, 4, 1);

    // ---- Tiny pickaxe leaning on the foundation (mining flavour).
    g.fillStyle(0x6a3e15, 1);
    g.fillTriangle(left - 6, top + H - 22, left - 4, top + H - 22, left + 6, top + H - 4);
    g.fillStyle(0xc0c0c0, 1);
    g.fillTriangle(left - 12, top + H - 24, left + 4, top + H - 22, left - 4, top + H - 16);
    g.fillStyle(0x6a6a6a, 1);
    g.fillRect(left - 10, top + H - 22, 12, 2);
    // ---- Shovel propped right next to the pickaxe.
    g.fillStyle(0x6a3e15, 1);
    g.fillTriangle(left + 4, top + H - 26, left + 6, top + H - 26, left + 12, top + H - 4);
    g.fillStyle(0x9a9a9a, 1);
    g.fillTriangle(left + 8,  top + H - 30, left + 16, top + H - 24, left + 10, top + H - 18);
    g.fillStyle(0x4a4a4a, 1);
    g.fillRect(left + 10, top + H - 28, 6, 2);

    // ---- Mine-cart rails on the right side leading toward the cave.
    // Sleepers first (under), then the two parallel iron rails on top.
    const railsY  = top + H - 4;
    const railsL  = right + 6;
    const railsR  = railsL + TILE * 4;
    g.fillStyle(0x4a2810, 1);
    for (let i = 0; i <= 8; i++) {
      g.fillRect(railsL + i * 18, railsY - 2, 4, 8);
    }
    g.fillStyle(0x6a3e15, 1);
    for (let i = 0; i <= 8; i++) {
      g.fillRect(railsL + i * 18, railsY - 2, 1, 8);
    }
    g.fillStyle(0x9a9a9a, 1);
    g.fillRect(railsL, railsY - 2, railsR - railsL, 2);
    g.fillRect(railsL, railsY + 4, railsR - railsL, 2);
    g.fillStyle(0xd0d0d0, 1);
    g.fillRect(railsL, railsY - 2, railsR - railsL, 1);
    g.fillRect(railsL, railsY + 4, railsR - railsL, 1);

    // ---- Mine cart sitting on the rails between shop and cave.
    const cartX = right + TILE + 4;
    const cartY = railsY - 24;
    const cartW = 36, cartH = 18;
    // Body frame (dark iron)
    g.fillStyle(0x2a2a2a, 1);
    g.fillRect(cartX - 1, cartY - 1, cartW + 2, cartH + 2);
    g.fillStyle(0x6a4422, 1);
    g.fillRect(cartX, cartY, cartW, cartH);
    // Plank seams
    g.fillStyle(0x4a2810, 1);
    g.fillRect(cartX + cartW / 3, cartY + 2, 1, cartH - 4);
    g.fillRect(cartX + cartW * 2 / 3, cartY + 2, 1, cartH - 4);
    // Iron bands
    g.fillStyle(0x3a3a3a, 1);
    g.fillRect(cartX, cartY,           cartW, 3);
    g.fillRect(cartX, cartY + cartH - 3, cartW, 3);
    // Ore peeking out the top — small clusters
    g.fillStyle(0x0a0a0a, 1);
    g.fillTriangle(cartX + 4,  cartY,     cartX + 9,  cartY - 4, cartX + 13, cartY);
    g.fillStyle(0xffd84a, 1);
    g.fillTriangle(cartX + 13, cartY,     cartX + 18, cartY - 5, cartX + 23, cartY);
    g.fillStyle(0x6fdbf6, 1);
    g.fillTriangle(cartX + 22, cartY,     cartX + 26, cartY - 3, cartX + 30, cartY);
    g.fillStyle(0xb47e58, 1);
    g.fillRect(cartX + 30, cartY - 2, 4, 2);
    // Wheels
    g.fillStyle(0x111111, 1);
    g.fillRect(cartX + 3,           cartY + cartH,     8, 7);
    g.fillRect(cartX + cartW - 11,  cartY + cartH,     8, 7);
    g.fillStyle(0x6a6a6a, 1);
    g.fillRect(cartX + 5,           cartY + cartH + 2, 4, 3);
    g.fillRect(cartX + cartW - 9,   cartY + cartH + 2, 4, 3);
    g.fillStyle(0x222222, 1);
    g.fillRect(cartX + 6,           cartY + cartH + 3, 2, 1);
    g.fillRect(cartX + cartW - 8,   cartY + cartH + 3, 2, 1);

    // ---- Cave entrance (the "shaft" the rails lead into) on the far right.
    const cvBase = top + H;            // sits on the surface
    const cvX = railsR + 8;            // a bit past the end of the rails
    const cvW = TILE * 1.6;
    const cvH = TILE * 1.1;
    // Mountain silhouette (two-tone)
    g.fillStyle(0x4f4538, 1);
    g.fillTriangle(cvX - 18, cvBase, cvX + cvW * 0.55, cvBase - cvH, cvX + cvW + 22, cvBase);
    g.fillStyle(0x6a5a48, 1);
    g.fillTriangle(cvX - 4,  cvBase, cvX + cvW * 0.5,  cvBase - cvH * 0.8, cvX + cvW + 6,  cvBase);
    g.fillStyle(0x836b50, 1);
    g.fillTriangle(cvX + 12, cvBase, cvX + cvW * 0.5,  cvBase - cvH * 0.55, cvX + cvW - 6,  cvBase);
    // A few rocky speckles for texture
    g.fillStyle(0x36281c, 0.8);
    g.fillRect(cvX + 6,   cvBase - 18, 3, 3);
    g.fillRect(cvX + 28,  cvBase - 30, 3, 3);
    g.fillRect(cvX + cvW - 18, cvBase - 22, 3, 3);
    // Cave opening — black archway centred at the foot of the mountain.
    const openW = 22, openH = 26;
    const openX = cvX + (cvW - openW) / 2;
    const openY = cvBase - openH;
    g.fillStyle(0x080808, 1);
    g.fillRect(openX, openY + 4, openW, openH - 4);
    g.fillTriangle(openX - 1, openY + 4, openX + openW / 2, openY - 4, openX + openW + 1, openY + 4);
    // Wooden door frame around the entrance
    g.fillStyle(0x4a2810, 1);
    g.fillRect(openX - 3, openY + 4, 3, openH - 4);
    g.fillRect(openX + openW, openY + 4, 3, openH - 4);
    g.fillRect(openX - 3, openY + 4, openW + 6, 3);
    g.fillStyle(0x6a3e15, 1);
    g.fillRect(openX - 3, openY + 4, 1, openH - 4);
    g.fillRect(openX - 3, openY + 4, openW + 6, 1);
    // Small lantern hanging in the entrance for warmth
    const lan2X = openX + openW / 2 - 2;
    const lan2Y = openY + 4;
    g.fillStyle(0xffd24a, 0.85);
    g.fillRect(lan2X, lan2Y + 2, 4, 4);
    g.fillStyle(0xffe49a, 0.45);
    g.fillRect(lan2X - 4, lan2Y - 2, 12, 12);

    // Rail stub running into the cave so the cart's path reads as
    // shop ↔ mine.
    g.fillStyle(0x9a9a9a, 1);
    g.fillRect(railsR, railsY - 2, openX - railsR + 4, 2);
    g.fillRect(railsR, railsY + 4, openX - railsR + 4, 2);
  }

  // Visual tier 1..6 derived from the robot's upgrade levels. Average
  // across the four stats that have meaningful "look" implications (pack,
  // drill, fuel, cargo) and round, so a player who pours into one stat
  // still gets a glow-up rather than waiting on full diagonal progress.
  robotTier() {
    const u = this.robot.upgrades || {};
    const sum = (u.pack || 1) + (u.drill || 1) + (u.fuel || 1) + (u.cargo || 1);
    return Math.max(1, Math.min(6, Math.round(sum / 4)));
  }

  drawRobot(time = 0) {
    const g = this.robotGfx;
    g.clear();
    const r = this.robot;
    const px = r.px * TILE;
    const py = r.py * TILE;
    const drillTarget = this.digging || this.failedDig;

    // Integer-pixel shake while digging (no sub-pixel sin wiggle — keeps
    // the pixel-art style clean).
    const shake = drillTarget ? {
      x: ((Math.floor(time / 55)) % 2) === 0 ? 1 : -1,
      y: ((Math.floor(time / 80)) % 2) === 0 ? 1 : 0,
    } : { x: 0, y: 0 };

    const squashed = this.squashedUntil && this.time.now < this.squashedUntil;
    // Single shared pixel-art robot — same one MenuScene uses.
    // tier = average upgrade level across the 5 stats (rounded), so the
    // chassis palette levels up as the player invests in any direction.
    drawSharedRobot(g, px + TILE / 2, py + TILE / 2, TILE, {
      facing: r.facing,
      digging: !!drillTarget && !squashed,
      time,
      hasDiamond: !!r.hasDiamond,
      shake,
      squashed,
      hat: this.robotHat,
      bodyColor: this.robotColor,
      tier: this.robotTier(),
    });

    // Dust puffs around the dig target tile (scene-specific FX, not the robot)
    if (drillTarget) {
      g.fillStyle(this.failedDig ? 0xb8b8b8 : 0x8b5a2b, this.failedDig ? 0.85 : 0.7);
      const dx = drillTarget.tx * TILE + TILE / 2;
      const dy = drillTarget.ty * TILE + TILE / 2;
      for (let i = 0; i < 3; i++) {
        const a = (time / 100 + i * 2) % 6.28;
        const rr = 6 + (time / 50 + i * 7) % 14;
        g.fillRect(Math.round(dx + Math.cos(a) * rr), Math.round(dy + Math.sin(a) * rr), 3, 3);
      }
      if (this.failedDig) {
        g.fillStyle(0xffffff, 0.9);
        g.fillRect(Math.round(dx - 3), Math.round(dy - 3), 3, 3);
        g.fillRect(Math.round(dx + 7), Math.round(dy + 5), 2, 2);
      }
    }
  }

  drawFog() {
    if (!this.fogOverlay) return;
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;

    const r = this.robot;
    // On the surface: keep the shop, sky and first ground rows visible, but
    // hide the deeper mine so the player does not see the whole map at once.
    if (r.ty <= SURFACE_Y) {
      const surfaceScreenY = ((SURFACE_Y + 1) * TILE - cam.scrollY) * zoom;
      const clipTop = Math.max(0, surfaceScreenY);
      this.fogOverlay.style.display = 'block';
      this.fogOverlay.style.clipPath = `inset(${clipTop}px 0 0 0)`;
      this.fogOverlay.style.background = '#000';
      return;
    }

    this.fogOverlay.style.display = 'block';
    // Robot's centre in screen space.
    const rx = (r.px * TILE + TILE / 2 - cam.scrollX) * zoom;
    const ry = (r.py * TILE + TILE / 2 - cam.scrollY) * zoom;

    // Underground: the fog covers the ENTIRE screen (including the sky above
    // the mine shaft) to sell the "you're buried in a tunnel" feeling. The
    // radar hole opens at the robot so you can see the surrounding tiles.
    this.fogOverlay.style.clipPath = 'none';

    const inner = Math.max(0, (r.radar - 0.3) * TILE * zoom);
    const outer = (r.radar + 1.2) * TILE * zoom;
    const mid = (inner + outer) / 2;

    this.fogOverlay.style.background =
      `radial-gradient(circle at ${rx}px ${ry}px, ` +
      `rgba(0,0,0,0) 0, ` +
      `rgba(0,0,0,0) ${inner}px, ` +
      `rgba(0,0,0,0.85) ${mid}px, ` +
      `rgba(0,0,0,1) ${outer}px)`;
  }

  // ---- HUD ----
  createHudDOM() {
    const top = document.createElement('div');
    top.id = 'hud';
    top.style.cssText = `
      position: fixed; top: 10px; left: 10px; right: 10px;
      font-family: 'Courier New', monospace; color: #fff;
      display: flex; justify-content: flex-start; align-items: flex-start;
      pointer-events: none; z-index: 10;
      text-shadow: 1px 1px 2px #000; font-size: 14px;
    `;
    top.innerHTML = `
      <div id="hud-left" style="background:rgba(0,0,0,.55);padding:10px 14px;border-radius:10px;line-height:1.55;min-width:240px"></div>
    `;
    document.body.appendChild(top);

    // Bottom-left: a single hipster/canvas-tan backpack button. Click (or
    // press I) opens the full inventory modal — there's no inline drawer
    // any more. Quick-keys still work for items (2 brace, etc).
    const inv = document.createElement('div');
    inv.id = 'inv';
    inv.style.cssText = `
      position: fixed; bottom: 30px; left: 16px;
      display: flex; flex-direction: row; align-items: center;
      gap: 14px; z-index: 10;
      font-family: 'Courier New', monospace; color: #fff;
      text-shadow: 1px 1px 2px #000;
      pointer-events: auto;
    `;
    document.body.appendChild(inv);
    this.invEl = inv;

    // Backpack icon — drawn from scratch as an inline SVG: tan canvas body,
    // top flap with leather buckle, front pocket with stitching, side
    // pocket bump and a tiny carabiner. Minimalist, походный, never red.
    const bag = document.createElement('div');
    bag.id = 'inv-bag';
    // No frame, no card — just the silhouette of the backpack standing on
    // the play area. The SVG provides its own outline so it reads cleanly
    // on any background. Drop-shadow filter gives a soft lift without a
    // hard rectangular border.
    bag.style.cssText = `
      width:72px;height:80px;
      display:flex;align-items:center;justify-content:center;
      position:relative;cursor:pointer;user-select:none;
      filter:drop-shadow(2px 3px 0 rgba(0,0,0,0.55));
    `;
    bag.innerHTML = `
      <svg viewBox="0 0 64 64" width="100%" height="100%"
        style="display:block;shape-rendering:geometricPrecision">
        <!-- top loop (handle) — sits on top of the body, fully enclosed
             so it never blends into the surrounding area -->
        <path d="M27,12 L27,8 Q27,4 32,4 Q37,4 37,8 L37,12 Z"
          fill="#7a5028" stroke="#2a1606" stroke-width="1.5" stroke-linejoin="round"/>
        <!-- main body — single rounded silhouette, slightly tapered -->
        <path d="M14,16 Q14,12 18,12 L46,12 Q50,12 50,16 L52,58 Q52,62 48,62 L16,62 Q12,62 12,58 Z"
          fill="#c9a06a" stroke="#2a1606" stroke-width="2" stroke-linejoin="round"/>
        <!-- side pocket bump on the right edge, integrated into silhouette -->
        <path d="M50,30 Q58,32 58,42 Q58,52 50,54"
          fill="#a37745" stroke="#2a1606" stroke-width="1.5" stroke-linejoin="round"/>
        <!-- top flap -->
        <path d="M14,16 L14,30 Q14,34 18,34 L46,34 Q50,34 50,30 L50,16 Z"
          fill="#a37745" stroke="#2a1606" stroke-width="2" stroke-linejoin="round"/>
        <!-- flap stitch -->
        <path d="M18,30 L46,30" stroke="#5a3818" stroke-width="0.7"
          stroke-dasharray="2 1.5" fill="none"/>
        <!-- buckle strap -->
        <rect x="28" y="22" width="8" height="14"
          fill="#5a3818" stroke="#2a1606" stroke-width="1.2"/>
        <!-- buckle metal -->
        <rect x="29" y="26" width="6" height="5"
          fill="#e0cf8a" stroke="#5e4c1a" stroke-width="0.8"/>
        <rect x="31.5" y="27" width="1" height="3" fill="#5e4c1a"/>
        <!-- front pocket -->
        <rect x="20" y="42" width="24" height="14" rx="2"
          fill="#b48a55" stroke="#2a1606" stroke-width="1.5"/>
        <!-- pocket stitch -->
        <path d="M22,44 L42,44" stroke="#5a3818" stroke-width="0.6"
          stroke-dasharray="2 1.5" fill="none"/>
        <!-- carabiner (hipster touch) -->
        <circle cx="44" cy="38" r="2.2" fill="none" stroke="#cfcfcf" stroke-width="1"/>
        <line x1="44" y1="36" x2="44" y2="40" stroke="#cfcfcf" stroke-width="0.8"/>
      </svg>
      <div id="inv-bag-count" style="position:absolute;bottom:-2px;right:-4px;background:#1a1a1a;color:#fff;
        border:2px solid #ffffff;border-radius:50%;
        width:26px;height:26px;padding:0;
        display:flex;align-items:center;justify-content:center;
        font-size:12px;font-weight:bold;line-height:1;
        box-shadow:1px 2px 0 rgba(0,0,0,0.6);
        pointer-events:none;">0</div>
    `;
    bag.addEventListener('pointerdown', (e) => {
      if (this.shopOpen) return;
      e.preventDefault();
      this.toggleInventory();
    });
    inv.appendChild(bag);
    this.bagCountEl = bag.querySelector('#inv-bag-count');

    // Ladder + Pillar chips — same visual language as the backpack: a
    // big SVG silhouette with drop-shadow and a small dark count badge
    // in the bottom-right corner. No "X / max" — just the remaining
    // count (auto-refill on surface makes the cap feel implicit).
    const chipBoxCss = `
      width:72px;height:80px;
      display:flex;align-items:center;justify-content:center;
      position:relative;user-select:none;
      filter:drop-shadow(2px 3px 0 rgba(0,0,0,0.55));
    `;
    const badgeCss = `
      position:absolute;bottom:-2px;right:-4px;background:#1a1a1a;color:#fff;
      border:2px solid #ffffff;border-radius:50%;
      width:26px;height:26px;padding:0;
      display:flex;align-items:center;justify-content:center;
      font-size:12px;font-weight:bold;line-height:1;
      box-shadow:1px 2px 0 rgba(0,0,0,0.6);
      pointer-events:none;
    `;

    const ladderChip = document.createElement('div');
    ladderChip.id = 'chip-ladder';
    ladderChip.style.cssText = chipBoxCss;
    ladderChip.innerHTML = `
      <svg viewBox="0 0 64 64" width="100%" height="100%"
        style="display:block;shape-rendering:geometricPrecision">
        <!-- left rail -->
        <rect x="14" y="6" width="8" height="52" rx="2"
          fill="#a06a2c" stroke="#2a1606" stroke-width="2"/>
        <!-- right rail -->
        <rect x="42" y="6" width="8" height="52" rx="2"
          fill="#a06a2c" stroke="#2a1606" stroke-width="2"/>
        <!-- rungs -->
        <rect x="14" y="14" width="36" height="6" fill="#c98a48" stroke="#2a1606" stroke-width="1.5"/>
        <rect x="14" y="26" width="36" height="6" fill="#c98a48" stroke="#2a1606" stroke-width="1.5"/>
        <rect x="14" y="38" width="36" height="6" fill="#c98a48" stroke="#2a1606" stroke-width="1.5"/>
        <rect x="14" y="50" width="36" height="6" fill="#c98a48" stroke="#2a1606" stroke-width="1.5"/>
        <!-- highlights -->
        <rect x="16" y="8" width="2" height="48" fill="#e8b878" opacity="0.55"/>
        <rect x="44" y="8" width="2" height="48" fill="#e8b878" opacity="0.55"/>
      </svg>
      <div id="chip-ladder-count" style="${badgeCss}">0</div>
    `;
    inv.appendChild(ladderChip);

    const pillarChip = document.createElement('div');
    pillarChip.id = 'chip-pillar';
    pillarChip.style.cssText = chipBoxCss;
    pillarChip.innerHTML = `
      <svg viewBox="0 0 64 64" width="100%" height="100%"
        style="display:block;shape-rendering:geometricPrecision">
        <!-- top capital -->
        <rect x="10" y="6" width="44" height="8" rx="1"
          fill="#e0dccb" stroke="#2a2a2a" stroke-width="2"/>
        <rect x="14" y="14" width="36" height="4"
          fill="#bdb6a2" stroke="#2a2a2a" stroke-width="1.5"/>
        <!-- shaft -->
        <rect x="18" y="18" width="28" height="32"
          fill="#cfc9b3" stroke="#2a2a2a" stroke-width="2"/>
        <!-- flutes -->
        <rect x="22" y="22" width="3" height="24" fill="#7d7868"/>
        <rect x="30" y="22" width="3" height="24" fill="#7d7868"/>
        <rect x="38" y="22" width="3" height="24" fill="#7d7868"/>
        <!-- base -->
        <rect x="14" y="50" width="36" height="4"
          fill="#bdb6a2" stroke="#2a2a2a" stroke-width="1.5"/>
        <rect x="10" y="54" width="44" height="8" rx="1"
          fill="#e0dccb" stroke="#2a2a2a" stroke-width="2"/>
      </svg>
      <div id="chip-pillar-count" style="${badgeCss}">0</div>
    `;
    inv.appendChild(pillarChip);

    this.chipLadderCount = ladderChip.querySelector('#chip-ladder-count');
    this.chipPillarCount = pillarChip.querySelector('#chip-pillar-count');

    // Hint strip — anchored separately at the very bottom-left so the
    // inv row (bag + chips) stays clean.
    const hintBox = document.createElement('div');
    hintBox.id = 'hud-hint';
    hintBox.style.cssText = `
      position: fixed; bottom: 4px; left: 16px;
      font-family: 'Courier New', monospace; color: #fff;
      font-size: 11px; opacity: .55; text-shadow: 1px 1px 2px #000;
      pointer-events: none; z-index: 10;
    `;
    hintBox.innerHTML = `WASD/Arrows · Enter shop · 2 pillar · 1 ladder · I/🎒 inventory · T teleport`;
    document.body.appendChild(hintBox);

    // Inventory modal — built once, toggled later. Defined here so the
    // backpack click already has a target.
    this.createInventoryDOM();

    // Speech bubble that floats above the robot.
    const bubble = document.createElement('div');
    bubble.id = 'bubble';
    bubble.style.cssText = `
      position: fixed; transform: translate(-50%, -100%);
      background: #fff; color: #222; font-family: 'Courier New', monospace;
      font-size: 14px; padding: 6px 10px; border-radius: 10px;
      border: 2px solid #222; box-shadow: 2px 2px 0 rgba(0,0,0,0.3);
      white-space: nowrap; pointer-events: none; z-index: 8;
      display: none; max-width: 260px;
    `;
    // Small tail triangle under the bubble.
    bubble.innerHTML = `<span id="bubble-text"></span>
      <div style="position:absolute;bottom:-8px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;
        border-top:8px solid #222;"></div>
      <div style="position:absolute;bottom:-5px;left:var(--tail-x, 42%);transform:translateX(-50%);
        width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
        border-top:6px solid #fff;"></div>`;
    document.body.appendChild(bubble);
    this.bubbleEl = bubble;
    this.bubbleTextEl = bubble.querySelector('#bubble-text');

    const msg = document.createElement('div');
    msg.id = 'flash';
    msg.style.cssText = `
      position: fixed; top: 20%; left: 50%; transform: translateX(-50%);
      padding: 12px 24px; background: rgba(0,0,0,0.9); color: #ffdd55;
      font-family: 'Courier New', monospace; font-size: 18px; border-radius: 4px;
      z-index: 20; display: none; text-align: center; border: 1px solid #555;
    `;
    document.body.appendChild(msg);
    this.flashEl = msg;
  }

  // ---- Inventory modal ----
  // Two-pane layout: cargo grid + consumables on the left, big animated
  // robot + upgrade stats on the right. Game pauses while it's open.
  createInventoryDOM() {
    const d = document.createElement('div');
    d.id = 'inventory';
    d.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 760px; max-width: 95vw; max-height: 90vh; overflow-y: auto;
      padding: 0; background: #1d140b; color: #f1e6cf;
      font-family: 'Courier New', monospace;
      border: 4px solid #4b2e15; border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.6);
      z-index: 30; display: none;
    `;
    d.innerHTML = `
      <div style="padding:14px 20px;background:linear-gradient(180deg,#3a2614,#241608);
        border-bottom:3px solid #4b2e15;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:20px;font-weight:bold;letter-spacing:1px">🎒  Backpack</div>
        <button id="inv-close" style="font-family:inherit;background:#c9a06a;color:#241608;
          border:2px solid #4b2e15;border-radius:8px;padding:6px 14px;font-weight:bold;cursor:pointer">
          Close (I / Esc)
        </button>
      </div>
      <div style="display:flex;gap:18px;padding:18px 20px">
        <div style="flex:1.4;min-width:0">
          <div style="font-size:13px;opacity:.75;margin-bottom:6px">Cargo
            <span id="inv-cargo-meta" style="float:right"></span>
          </div>
          <div id="inv-cargo-grid" style="display:grid;gap:6px;
            background:#3a2614;padding:8px;border-radius:8px;border:2px solid #4b2e15;
            max-height:340px;overflow-y:auto;
            scrollbar-width:thin;scrollbar-color:#c9a06a #3a2614"></div>

          <div style="font-size:13px;opacity:.75;margin:14px 0 6px">Tools</div>
          <div id="inv-tools" style="display:flex;gap:10px;flex-wrap:wrap"></div>
        </div>

        <div style="flex:1;min-width:240px;display:flex;flex-direction:column;align-items:center;
          background:#241608;border-radius:10px;border:2px solid #4b2e15;padding:14px">
          <canvas id="inv-avatar" width="180" height="180"
            style="background:#3a2614;border:2px solid #4b2e15;border-radius:8px;image-rendering:pixelated"></canvas>
          <div id="inv-stats" style="margin-top:12px;width:100%;font-size:13px;line-height:1.6"></div>
        </div>
      </div>
    `;
    document.body.appendChild(d);
    this.inventoryEl = d;
    d.querySelector('#inv-close').addEventListener('click', () => this.closeInventory());
    this.invCargoGrid = d.querySelector('#inv-cargo-grid');
    this.invCargoMeta = d.querySelector('#inv-cargo-meta');
    this.invToolsEl = d.querySelector('#inv-tools');
    this.invStatsEl = d.querySelector('#inv-stats');
    this.invAvatarCanvas = d.querySelector('#inv-avatar');
  }

  toggleInventory() {
    if (this.inventoryOpen) this.closeInventory();
    else this.openInventory();
  }

  openInventory() {
    if (this.shopOpen) return;
    this.inventoryOpen = true;
    this.inventoryEl.style.display = 'block';
    this.renderInventory();
  }

  closeInventory() {
    this.inventoryOpen = false;
    this.inventoryEl.style.display = 'none';
  }

  renderInventory() {
    const r = this.robot;
    // ---- Cargo grid: maxCargo cells, each cell = 1 unit. Aggregate the
    // r.cargo dict into a flat list (e.g. 3 coal + 2 iron → CCCII····).
    const flat = [];
    for (const [name, count] of Object.entries(r.cargo)) {
      for (let i = 0; i < count; i++) flat.push(name);
    }
    const cells = r.maxCargo;
    const cols = Math.min(10, Math.max(5, Math.ceil(Math.sqrt(cells))));
    this.invCargoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this.invCargoMeta.textContent = `${r.cargoCount}/${r.maxCargo}`;
    let html = '';
    // After a cargo upgrade, slots in [cargoSlotsAddedFrom, maxCargo) are
    // brand-new and pulse gold until cargoHighlightUntil elapses. We
    // can't use CSS keyframes directly because the grid HTML is rebuilt
    // every frame (the modal repaints in update()) — so we drive the
    // pulse in JS off this.time.now and burn it into the inline style.
    const now = this.time?.now || 0;
    const highlightActive = this.cargoHighlightUntil && now < this.cargoHighlightUntil;
    const newFrom = this.cargoSlotsAddedFrom ?? -1;
    const pulse = highlightActive
      ? 0.55 + 0.45 * Math.abs(Math.sin(now / 220))
      : 0;
    for (let i = 0; i < cells; i++) {
      const ore = flat[i];
      const isNew = highlightActive && i >= newFrom && newFrom >= 0;
      const ring = isNew
        ? `border:2px solid rgba(255,214,107,${pulse.toFixed(2)});
           box-shadow:0 0 ${(8 + 8 * pulse).toFixed(0)}px rgba(255,214,107,${(0.3 + 0.5 * pulse).toFixed(2)}),
                      inset 0 0 6px rgba(255,214,107,${(0.25 * pulse).toFixed(2)});`
        : '';
      if (ore) {
        const svg = oreSvg(ore);
        html += `<div style="aspect-ratio:1;background:#3a2614;border:2px solid #4b2e15;
          border-radius:6px;display:flex;align-items:center;justify-content:center;
          box-shadow:inset 0 0 6px rgba(0,0,0,0.5);overflow:hidden;${ring}">${svg}</div>`;
      } else {
        html += `<div style="aspect-ratio:1;background:${isNew ? '#7a5a2e' : '#5a3e22'};border:2px solid #4b2e15;
          border-radius:6px;box-shadow:inset 0 0 8px rgba(0,0,0,0.45);${ring}"></div>`;
      }
    }
    this.invCargoGrid.innerHTML = html;

    // ---- Tools row: consumables. Same SVG language as shop + HUD chips,
    // so the dynamite stick in the inventory is the dynamite stick the
    // shop sells — no emoji mismatches.
    const tools = [
      { key: 'ladder',      label: 'Ladders' },
      { key: 'pillar',      label: 'Pillars' },
      { key: 'dynamite',    label: 'Dynamite' },
      { key: 'bigDynamite', label: 'Big Dyn' },
      { key: 'parachute',   label: 'Parachute' },
      { key: 'teleporter',  label: 'Teleport' },
    ];
    this.invToolsEl.innerHTML = tools.map(t => {
      const c = r.items[t.key] || 0;
      const dim = c <= 0 ? 'opacity:.4' : '';
      return `<div style="width:68px;text-align:center;${dim}">
        <div style="width:58px;height:58px;background:#3a2614;border:2px solid #4b2e15;
          border-radius:8px;display:flex;align-items:center;justify-content:center;
          position:relative;margin:0 auto">
          ${this.shopItemIcon(t.key, 40)}
          <span style="position:absolute;bottom:-4px;right:-4px;background:#222;color:#fff;
            border:2px solid #c9a06a;border-radius:10px;min-width:22px;height:20px;padding:0 4px;
            display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold">${c}</span>
        </div>
        <div style="font-size:11px;margin-top:6px;opacity:.85">${t.label}</div>
      </div>`;
    }).join('');

    // ---- Stats: upgrade levels with current → max indication.
    const lvl = r.upgrades || {};
    const max = (key) => UPGRADES[key]?.length || 0;
    const row = (icon, label, key, value) => {
      const cur = lvl[key] || 1;
      const mx = max(key);
      const dots = Array.from({ length: mx }, (_, i) =>
        `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;
          margin-right:3px;background:${i < cur ? '#c9a06a' : '#4b2e15'};border:1px solid #2a1a0a"></span>`
      ).join('');
      return `<div style="display:flex;align-items:center;justify-content:space-between;
        padding:6px 8px;border-bottom:1px solid #3a2614">
        <span>${icon} <strong>${label}</strong></span>
        <span style="display:flex;align-items:center;gap:8px">
          <span style="opacity:.8;font-size:12px">${value}</span>
          <span>${dots}</span>
        </span>
      </div>`;
    };
    const depth = Math.max(0, r.ty - SURFACE_Y + 1);
    this.invStatsEl.innerHTML = `
      ${row('⛏️', 'Drill',   'drill', `×${(1 / r.drillSpeed).toFixed(2)}`)}
      ${row('📦', 'Cargo',   'cargo', `${r.maxCargo}`)}
      ${row('🔋', 'Battery', 'fuel',  `${r.maxFuel}`)}
      ${row('👁️', 'Radar',   'radar', `${r.radar}`)}
      <div style="display:flex;justify-content:space-between;padding:8px;font-size:13px;opacity:.85">
        <span>🏔️ Depth</span><strong>-${depth}m</strong>
      </div>
    `;

    // First avatar paint (subsequent frames are pumped from update()).
    this.renderInventoryAvatar(this.time?.now || 0);
  }

  // Re-renders the procedural robot into the modal's <canvas> using a tiny
  // 2D-context shim that mimics the Phaser Graphics API used by drawRobot.
  // We don't import the existing Phaser graphics renderer here because it
  // belongs to the world scene and the modal is plain DOM.
  renderInventoryAvatar(time) {
    const cv = this.invAvatarCanvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const adapter = makeCanvasGraphicsAdapter(ctx);
    drawSharedRobot(adapter, cv.width / 2, cv.height / 2 + 8, 130, {
      facing: 'right',
      time,
      hasDiamond: this.robot.hasDiamond,
      shadow: true,
      hat: this.robotHat,
      bodyColor: this.robotColor,
      tier: this.robotTier(),
    });
  }

  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  checkLowFuel() {
    const r = this.robot;
    if (r.fuel / r.maxFuel < 0.2) {
      if (!this._lowFuelWarned) {
        this._lowFuelWarned = true;
        this.sayBubble(this.pick(this.PHRASES.lowFuel));
      }
    } else if (r.fuel / r.maxFuel > 0.5) {
      this._lowFuelWarned = false;
    }
  }

  sayBubble(text, ms = 2200) {
    if (!this.bubbleEl || !text) return;
    this.bubbleTextEl.textContent = text;
    this.bubbleEl.style.display = 'block';
    clearTimeout(this._bubbleTimer);
    this._bubbleTimer = setTimeout(() => {
      this.bubbleEl.style.display = 'none';
    }, ms);
  }

  positionBubble() {
    if (!this.bubbleEl || this.bubbleEl.style.display === 'none') return;
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    const r = this.robot;
    const sx = (r.px * TILE + TILE / 2 - cam.scrollX) * zoom;
    const sy = (r.py * TILE - 6 - cam.scrollY) * zoom;
    const side = r.facing === 'left' ? -1 : 1;
    this.bubbleEl.style.left = `${sx + side * 36}px`;
    this.bubbleEl.style.top = `${sy}px`;
    this.bubbleEl.style.setProperty('--tail-x', side > 0 ? '38%' : '62%');
  }

  flashMessage(text) {
    this.flashEl.textContent = text;
    this.flashEl.style.display = 'block';
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this.flashEl.style.display = 'none'; }, 2200);
  }

  updateHud() {
    const r = this.robot;
    const l = document.getElementById('hud-left');
    if (!l) return;
    const pct = Math.max(0, Math.min(100, (r.fuel / r.maxFuel) * 100));
    // Battery indicator with a smooth GREEN → YELLOW → RED transition.
    // Single hue lerps continuously with fuel — at 100% it's lush green,
    // around 50% it slides into amber, near zero it pulses red. Gives
    // the bar a subtle "draining" personality without adding steps.
    const fuelP = Math.max(0, Math.min(1, r.fuel / r.maxFuel));
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    let cr, cg, cb;
    if (fuelP > 0.5) {
      // Green → yellow as fuel goes from 100% to 50%.
      const t = (1 - fuelP) * 2; // 0 at full, 1 at 50%
      cr = lerp(76,  255, t);  cg = lerp(175, 184, t);  cb = lerp(80, 28, t);
    } else {
      // Yellow → red as fuel goes from 50% to 0%.
      const t = (0.5 - fuelP) * 2;
      cr = lerp(255, 220, t);  cg = lerp(184, 40, t);   cb = lerp(28, 40, t);
    }
    // Slight vertical gradient (lighter top, darker bottom) keeps the
    // bar from looking flat without breaking the smooth hue shift.
    const baseRgb = `rgb(${cr},${cg},${cb})`;
    const lightRgb = `rgb(${Math.min(255, cr + 40)},${Math.min(255, cg + 40)},${Math.min(255, cb + 30)})`;
    const fillColor = `linear-gradient(180deg, ${lightRgb}, ${baseRgb})`;
    const barWidth = Math.min(220, 90 + r.maxFuel * 0.6);
    const battery = `
      <div style="display:inline-block;position:relative;width:${barWidth}px;height:14px;
        border:2px solid #fff;border-radius:10px;background:rgba(255,255,255,0.08);
        box-shadow:0 0 0 1px rgba(0,0,0,0.6),1px 2px 0 rgba(0,0,0,0.4);overflow:hidden;vertical-align:middle">
        <div style="height:100%;width:${pct.toFixed(1)}%;background:${fillColor};
          border-radius:8px 0 0 8px;transition:width .12s linear,background .15s linear"></div>
      </div>
    `;
    // Top HUD: money, battery, and a big depth readout. One-shot life model
    // so HP isn't shown — death just respawns. Cargo / radar / consumables
    // live inside the inventory modal.
    const depth = Math.max(0, r.ty - SURFACE_Y + 1);
    l.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;font-size:15px">
        💰 <strong>$${r.money}</strong>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
        🔋 ${battery}
        <span style="font-family:'Courier New',monospace;font-weight:bold;font-size:22px;
          color:#fff;letter-spacing:1px;line-height:1;
          text-shadow:2px 2px 0 #000;">−${depth}m</span>
      </div>
      ${r.hasDiamond ? '<div style="margin-top:4px;color:#5ff6ff">💎 DIAMOND!</div>' : ''}
    `;
    // Bag badge now shows cargo fill (current/max) so the player sees at
    // a glance how full the hold is. Turn red when at the cap so it
    // reads like a "stop and head up" hint.
    if (this.bagCountEl) {
      this.bagCountEl.textContent = r.cargoCount;
      const full = r.cargoCount >= r.maxCargo;
      // Red pill when the hold is at the cap.
      this.bagCountEl.style.background = full ? '#a02020' : '#1a1a1a';
    }
    // Ladder + pillar HUD chips. Auto-refill on the surface so these
    // mostly drain mid-dive; they're a "how much placement room do I
    // have left?" indicator, not a buy-back currency.
    if (this.chipLadderCount) {
      const c = r.items.ladder || 0;
      this.chipLadderCount.textContent = c;
      this.chipLadderCount.style.background = c === 0 ? '#a02020' : '#1a1a1a';
    }
    if (this.chipPillarCount) {
      const c = r.items.pillar || 0;
      this.chipPillarCount.textContent = c;
      this.chipPillarCount.style.background = c === 0 ? '#a02020' : '#1a1a1a';
    }
    // If the inventory modal is open, keep its contents fresh (cargo / stats
    // change as the robot moves, sells, takes hits etc).
    if (this.inventoryOpen) this.renderInventory();
  }

  // ---- Shop ----
  // Tabbed brown-earthy modal. Top of the modal is a fixed header (cash,
  // close). Below sits a row of category tabs (Drill / Tank / Cargo / Hull
  // / Radar / Items). Only the active category's body is rendered. Each
  // upgrade tab shows the full 6-step ladder with a big buy button for
  // the next tier; the items tab shows consumables + the diamond turn-in
  // + battery recharge.
  createShopDOM() {
    const d = document.createElement('div');
    d.id = 'shop';
    d.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 760px; max-width: 95vw; max-height: 90vh; overflow: hidden;
      padding: 0; background: #1d140b; color: #f1e6cf;
      font-family: 'Courier New', monospace;
      border: 4px solid #4b2e15; border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.6);
      z-index: 30; display: none; flex-direction: column;
    `;
    document.body.appendChild(d);
    this.shopEl = d;
    this.shopTab = 'drill'; // initial tab
  }

  openShop() {
    this.shopOpen = true;
    this.renderShop();
    this.shopEl.style.display = 'flex';
  }

  closeShop() {
    this.shopOpen = false;
    this.shopEl.style.display = 'none';
  }

  // Returns the list of tabs in display order with their icons + labels.
  // The five upgrade categories use their key from UPGRADES so the body
  // renderer can look up levels generically.
  shopTabs() {
    return [
      { key: 'drill', label: 'Drill' },
      { key: 'fuel',  label: 'Battery' },
      { key: 'cargo', label: 'Cargo' },
      { key: 'pack',  label: 'Pack' },
      { key: 'radar', label: 'Radar' },
      { key: 'items', label: 'Items' },
    ];
  }

  // SVG icon for a shop tab. Drawn from scratch so each shape literally
  // depicts what the upgrade does (drill bit for Drill, satellite dish
  // for Radar, etc.) — no more emoji mismatches.
  shopTabIcon(key, size = 32) {
    const wh = `width="${size}" height="${size}"`;
    if (key === 'drill') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- grip / motor housing -->
        <rect x="5" y="4" width="14" height="7" rx="1" fill="#3a3a3a" stroke="#0a0a0a" stroke-width="1.4"/>
        <rect x="5" y="4" width="14" height="2" fill="#7a7a7a"/>
        <rect x="6" y="6" width="2" height="2" fill="#ffb000"/>
        <!-- collar -->
        <rect x="8" y="11" width="9" height="3" fill="#9a9a9a" stroke="#0a0a0a" stroke-width="1.2"/>
        <!-- conical bit -->
        <polygon points="9,14 16,14 19,22 14,30 11,30 6,22"
          fill="#cfcfcf" stroke="#0a0a0a" stroke-width="1.4" stroke-linejoin="round"/>
        <polygon points="13,14 16,14 19,22 14,30" fill="#7a7a7a"/>
        <!-- spiral notches -->
        <line x1="8"  y1="18" x2="17" y2="18" stroke="#0a0a0a" stroke-width="1.1"/>
        <line x1="9"  y1="22" x2="16" y2="22" stroke="#0a0a0a" stroke-width="1.1"/>
        <line x1="10" y1="26" x2="15" y2="26" stroke="#0a0a0a" stroke-width="1.1"/>
      </svg>`;

    if (key === 'fuel') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <rect x="12" y="3"  width="8"  height="3" fill="#1a1a1a"/>
        <rect x="6"  y="6"  width="20" height="23" rx="3"
          fill="#1f1f1f" stroke="#000" stroke-width="1.6"/>
        <rect x="9"  y="9"  width="14" height="5" fill="#7fdf7f"/>
        <rect x="9"  y="15" width="14" height="5" fill="#7fdf7f"/>
        <rect x="9"  y="21" width="14" height="5" fill="#ffd84a"/>
        <line x1="9" y1="14" x2="23" y2="14" stroke="#0a0a0a" stroke-width="0.8"/>
        <line x1="9" y1="20" x2="23" y2="20" stroke="#0a0a0a" stroke-width="0.8"/>
      </svg>`;

    if (key === 'cargo') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- stacked crates -->
        <rect x="4"  y="14" width="13" height="14" fill="#a06a2c" stroke="#2a1606" stroke-width="1.5"/>
        <rect x="15" y="10" width="13" height="18" fill="#c98a48" stroke="#2a1606" stroke-width="1.5"/>
        <rect x="4"  y="20" width="13" height="2"  fill="#7a4a1a"/>
        <rect x="15" y="18" width="13" height="2"  fill="#7a4a1a"/>
        <line x1="10.5" y1="14" x2="10.5" y2="28" stroke="#7a4a1a" stroke-width="1"/>
        <line x1="21.5" y1="10" x2="21.5" y2="28" stroke="#7a4a1a" stroke-width="1"/>
      </svg>`;

    if (key === 'pack') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- top loop / handle -->
        <path d="M13,5 L13,3.5 Q13,2 16,2 Q19,2 19,3.5 L19,5 Z"
          fill="#7a5028" stroke="#2a1606" stroke-width="1.2"/>
        <!-- body -->
        <path d="M7,8 Q7,6 9,6 L23,6 Q25,6 25,8 L26,28 Q26,30 24,30 L8,30 Q6,30 6,28 Z"
          fill="#c9a06a" stroke="#2a1606" stroke-width="1.5"/>
        <!-- top flap -->
        <path d="M7,8 L7,15 Q7,17 9,17 L23,17 Q25,17 25,15 L25,8 Z"
          fill="#a37745" stroke="#2a1606" stroke-width="1.5"/>
        <!-- buckle strap + metal -->
        <rect x="14" y="11" width="4" height="7"  fill="#5a3818" stroke="#2a1606" stroke-width="1"/>
        <rect x="14.5" y="13" width="3" height="2.5" fill="#e0cf8a" stroke="#5e4c1a" stroke-width="0.6"/>
        <!-- front pocket -->
        <rect x="10" y="20" width="12" height="7" rx="1" fill="#b48a55" stroke="#2a1606" stroke-width="1"/>
      </svg>`;

    if (key === 'radar') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- dish bowl -->
        <path d="M4,21 Q16,12 28,21 L24,24 Q16,18 8,24 Z"
          fill="#d4d4dc" stroke="#0a0a0a" stroke-width="1.5" stroke-linejoin="round"/>
        <!-- center receiver -->
        <circle cx="16" cy="20" r="2" fill="#7a3030" stroke="#0a0a0a" stroke-width="1"/>
        <!-- mast + base -->
        <rect x="15" y="22" width="2" height="6" fill="#5a5a5a" stroke="#0a0a0a" stroke-width="0.8"/>
        <rect x="11" y="27" width="10" height="3" fill="#3a3a3a" stroke="#0a0a0a" stroke-width="1"/>
        <!-- signal arcs -->
        <path d="M22,8  Q26,11 26,15" stroke="#5fc7f5" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        <path d="M19,4  Q26.5,8 28.5,15.5" stroke="#5fc7f5" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>`;

    if (key === 'items') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- treasure chest body -->
        <rect x="4" y="15" width="24" height="13" fill="#7a4a1a" stroke="#1a0a04" stroke-width="1.5"/>
        <!-- arched lid -->
        <path d="M4,15 Q4,5 16,5 Q28,5 28,15 Z" fill="#a06a2c" stroke="#1a0a04" stroke-width="1.5"/>
        <!-- bands -->
        <rect x="4" y="14" width="24" height="1.6" fill="#3a1a04"/>
        <!-- lock -->
        <rect x="13" y="16" width="6" height="6" fill="#ffd84a" stroke="#1a0a04" stroke-width="1"/>
        <rect x="15" y="18" width="2" height="2" fill="#1a0a04"/>
      </svg>`;
    return '';
  }

  renderShop() {
    const r = this.robot;
    const tabs = this.shopTabs();
    const active = this.shopTab;

    const tabsRow = tabs.map(t => {
      const on = t.key === active;
      return `<button data-tab="${t.key}"
        style="flex:1;min-width:0;padding:12px 8px;border:none;cursor:pointer;
          font-family:inherit;font-size:13px;font-weight:bold;
          background:${on ? '#c9a06a' : 'transparent'};
          color:${on ? '#241608' : '#f1e6cf'};
          border-bottom:3px solid ${on ? '#ffd66b' : 'transparent'};
          transition:background .12s linear">
          <div style="display:flex;justify-content:center;line-height:1">${this.shopTabIcon(t.key, 28)}</div>
          <div style="margin-top:6px;letter-spacing:1px">${t.label}</div>
        </button>`;
    }).join('');

    let body = '';
    if (active === 'items') body = this.renderShopItemsTab();
    else body = this.renderShopUpgradeTab(active);

    this.shopEl.innerHTML = `
      <div style="padding:14px 20px;background:linear-gradient(180deg,#3a2614,#241608);
        border-bottom:3px solid #4b2e15;display:flex;justify-content:space-between;align-items:center;
        flex-shrink:0">
        <div style="font-size:20px;font-weight:bold;letter-spacing:1px">🏪  Miner's Shop</div>
        <div style="display:flex;align-items:center;gap:14px">
          <div style="background:#241608;border:2px solid #4b2e15;border-radius:8px;
            padding:6px 14px;font-weight:bold;font-size:15px">
            💰 <span style="color:#ffd66b">$${r.money}</span>
          </div>
          <button data-act="close" style="font-family:inherit;background:#c9a06a;color:#241608;
            border:2px solid #4b2e15;border-radius:8px;padding:6px 14px;font-weight:bold;cursor:pointer">
            Close (Esc)
          </button>
        </div>
      </div>

      <div style="display:flex;background:#241608;border-bottom:3px solid #4b2e15;flex-shrink:0">
        ${tabsRow}
      </div>

      ${r.hasDiamond ? `
        <div style="margin:14px 18px 0;padding:12px;background:#0f3a3e;border:2px solid #5ff6ff;
          border-radius:10px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
          <div style="color:#5ff6ff;font-weight:bold">💎  You hold the Diamond!</div>
          <button data-act="win" style="font-family:inherit;background:#5ff6ff;color:#0a1c1e;
            border:2px solid #4b2e15;border-radius:8px;padding:8px 16px;font-weight:bold;cursor:pointer">
            Turn in → WIN
          </button>
        </div>` : ''}

      <div style="padding:18px 20px;overflow-y:auto;flex:1">${body}</div>
    `;

    this.shopEl.querySelectorAll('button[data-tab]').forEach(btn => {
      btn.onclick = () => { this.shopTab = btn.dataset.tab; this.renderShop(); };
    });
    this.shopEl.querySelectorAll('button:not([data-tab])').forEach(btn => {
      btn.onclick = () => this.handleShopClick(btn);
    });
  }

  // ----- Upgrade tab body -----
  // Full 6-step ladder for one category. Each tier shows level name,
  // stat value, price, and a status pill (OWNED / NEXT / locked). The
  // single "+ Upgrade" button at the bottom buys the very next tier.
  renderShopUpgradeTab(key) {
    const r = this.robot;
    const cur = r.upgrades[key];
    const tiers = UPGRADES[key];
    const next = tiers[cur]; // next-level def (cur is 1-indexed)
    const tabMeta = this.shopTabs().find(t => t.key === key);

    const ladder = tiers.map((t, i) => {
      const lvl = i + 1;
      const owned = lvl <= cur;
      const isNext = lvl === cur + 1;
      const statusBg = owned ? '#3a5a2e' : (isNext ? '#5a4a1e' : '#2a1a0a');
      const statusBorder = owned ? '#7fdf7f' : (isNext ? '#ffd66b' : '#4b2e15');
      const statusLabel = owned ? '✓ OWNED' : (isNext ? '→ NEXT' : `L${lvl}`);
      const dim = owned ? '' : (isNext ? '' : 'opacity:.55');
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;
          background:#3a2614;border-radius:8px;border:2px solid ${statusBorder};${dim}">
          <div style="background:${statusBg};color:#fff;border-radius:6px;
            padding:3px 8px;font-size:10px;font-weight:bold;min-width:64px;text-align:center">
            ${statusLabel}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:bold;font-size:14px">${t.name}</div>
            <div style="font-size:11px;opacity:.75;margin-top:2px">${t.desc}</div>
          </div>
          <div style="font-size:11px;color:#ffd66b;text-align:right;min-width:90px">
            <div style="font-weight:bold">${this.formatStatVal(key, t.val)}</div>
            <div style="opacity:.85">${i === 0 ? 'starter' : '$' + t.price}</div>
          </div>
        </div>`;
    }).join('');

    const buyBtn = next
      ? (() => {
          const canBuy = r.money >= next.price;
          const bg = canBuy ? '#c9a06a' : '#5a3e22';
          const fg = canBuy ? '#241608' : '#8a6a44';
          return `<button data-up="${key}" ${canBuy ? '' : 'disabled'}
            style="width:100%;font-family:inherit;background:${bg};color:${fg};
              border:3px solid #4b2e15;border-radius:10px;padding:14px;
              font-weight:bold;font-size:16px;cursor:${canBuy ? 'pointer' : 'not-allowed'};
              letter-spacing:1px;margin-top:14px">
              + UPGRADE → ${next.name}  ·  $${next.price}
            </button>`;
        })()
      : `<div style="margin-top:14px;padding:14px;background:#3a5a2e;color:#dfffdf;
          border:3px solid #7fdf7f;border-radius:10px;text-align:center;font-weight:bold;
          letter-spacing:2px">⭐  MAXED OUT  ⭐</div>`;

    return `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div>${this.shopTabIcon(key, 40)}</div>
        <div>
          <div style="font-size:18px;font-weight:bold">${tabMeta.label}</div>
          <div style="font-size:12px;opacity:.75">Current: ${tiers[cur - 1].name}
            (L${cur}/${tiers.length}) · ${this.formatStatVal(key, tiers[cur - 1].val)}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">${ladder}</div>
      ${buyBtn}
    `;
  }

  // Stat values mean different things per category — translate into a
  // human-readable label so the ladder rows speak game terms instead of
  // raw numbers.
  formatStatVal(key, val) {
    // Note: the upgrade key is `fuel` for legacy reasons but the player-
    // visible category is "Battery" — translate accordingly so the tab,
    // header and ladder rows speak the same language.
    if (key === 'fuel')  return `${val} charge`;
    if (key === 'cargo') return `${val} slots`;
    if (key === 'drill') return `×${(1 / val).toFixed(2)} speed`;
    if (key === 'pack') {
      // Pack stat values are tuples [ladders, pillars, hp].
      const [l, p, hp] = Array.isArray(val) ? val : [0, 0, 0];
      return `${l} 🪜 · ${p} 🧱 · ${hp} HP`;
    }
    if (key === 'radar') return `${val} tile vision`;
    return String(val);
  }

  // SVG icon for a consumable / recharge row. Drawn from scratch so it
  // visually matches the chunky pixel-art the rest of the UI uses; no
  // emoji guesswork. `key` mirrors ITEMS keys + 'fuel' for the recharge.
  shopItemIcon(key, size = 32) {
    const wh = `width="${size}" height="${size}"`;
    if (key === 'fuel') return this.shopTabIcon('fuel', size);

    if (key === 'pillar') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <rect x="6"  y="3" width="20" height="3" fill="#e0dccb" stroke="#2a2a2a" stroke-width="1.2"/>
        <rect x="9"  y="6" width="14" height="20" fill="#cfc9b3" stroke="#2a2a2a" stroke-width="1.2"/>
        <rect x="11" y="9"  width="2" height="14" fill="#7d7868"/>
        <rect x="15" y="9"  width="2" height="14" fill="#7d7868"/>
        <rect x="19" y="9"  width="2" height="14" fill="#7d7868"/>
        <rect x="6"  y="26" width="20" height="3" fill="#e0dccb" stroke="#2a2a2a" stroke-width="1.2"/>
      </svg>`;

    if (key === 'dynamite') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <path d="M14,4 Q12,2 14,1" stroke="#5a3a14" stroke-width="1.4" fill="none"/>
        <circle cx="14" cy="1.5" r="1.4" fill="#ffaa00"/>
        <rect x="9" y="6" width="14" height="22" fill="#c62828" stroke="#0a0a0a" stroke-width="1.4"/>
        <rect x="9" y="6" width="14" height="3"  fill="#a01a1a"/>
        <rect x="9" y="14" width="14" height="2" fill="#ffffff"/>
        <rect x="9" y="20" width="14" height="2" fill="#ffffff"/>
      </svg>`;

    if (key === 'bigDynamite') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- left stick -->
        <rect x="3"  y="9"  width="8" height="19" fill="#c62828" stroke="#0a0a0a" stroke-width="1"/>
        <!-- center stick (taller) -->
        <rect x="12" y="6"  width="8" height="22" fill="#c62828" stroke="#0a0a0a" stroke-width="1"/>
        <!-- right stick -->
        <rect x="21" y="9"  width="8" height="19" fill="#c62828" stroke="#0a0a0a" stroke-width="1"/>
        <!-- rope binding -->
        <rect x="2"  y="17" width="28" height="3" fill="#5a3a14" stroke="#0a0a0a" stroke-width="1"/>
        <!-- fuses + sparks -->
        <line x1="7"  y1="9" x2="7"  y2="3" stroke="#5a3a14" stroke-width="1.4"/>
        <circle cx="7"  cy="2" r="1.2" fill="#ffaa00"/>
        <line x1="16" y1="6" x2="16" y2="0" stroke="#5a3a14" stroke-width="1.4"/>
        <circle cx="16" cy="0.5" r="1.2" fill="#ffaa00"/>
        <line x1="25" y1="9" x2="25" y2="3" stroke="#5a3a14" stroke-width="1.4"/>
        <circle cx="25" cy="2" r="1.2" fill="#ffaa00"/>
        <!-- white bands -->
        <rect x="3"  y="23" width="8" height="1.6" fill="#ffffff"/>
        <rect x="12" y="23" width="8" height="1.6" fill="#ffffff"/>
        <rect x="21" y="23" width="8" height="1.6" fill="#ffffff"/>
      </svg>`;

    if (key === 'parachute') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- canopy -->
        <path d="M3,15 Q16,3 29,15 Z" fill="#e6402a" stroke="#0a0a0a" stroke-width="1.4"/>
        <path d="M9,12 Q12,10 15,11 L15,15 L9,15 Z" fill="#ffffff"/>
        <path d="M17,11 Q20,10 23,12 L23,15 L17,15 Z" fill="#ffffff"/>
        <line x1="9"  y1="13" x2="9"  y2="15" stroke="#0a0a0a" stroke-width="0.8"/>
        <line x1="16" y1="9"  x2="16" y2="15" stroke="#0a0a0a" stroke-width="0.8"/>
        <line x1="23" y1="13" x2="23" y2="15" stroke="#0a0a0a" stroke-width="0.8"/>
        <!-- strings -->
        <line x1="3"  y1="15" x2="14" y2="26" stroke="#3a3a3a" stroke-width="1"/>
        <line x1="11" y1="13" x2="14" y2="26" stroke="#3a3a3a" stroke-width="1"/>
        <line x1="21" y1="13" x2="18" y2="26" stroke="#3a3a3a" stroke-width="1"/>
        <line x1="29" y1="15" x2="18" y2="26" stroke="#3a3a3a" stroke-width="1"/>
        <!-- box -->
        <rect x="13" y="25" width="6" height="5" fill="#a06a2c" stroke="#0a0a0a" stroke-width="1.2"/>
      </svg>`;

    if (key === 'teleporter') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <!-- portal disc -->
        <circle cx="16" cy="16" r="11" fill="#1a3a5e" stroke="#0a0a0a" stroke-width="1.6"/>
        <circle cx="16" cy="16" r="8"  fill="none" stroke="#5fc7f5" stroke-width="1.4"/>
        <circle cx="16" cy="16" r="5"  fill="none" stroke="#9be4ff" stroke-width="1.4"/>
        <circle cx="16" cy="16" r="2"  fill="#ffffff"/>
        <!-- up arrow (returns to surface) -->
        <polygon points="16,7 21,13 11,13" fill="#ffd84a" stroke="#0a0a0a" stroke-width="1"/>
      </svg>`;

    if (key === 'ladder') return `
      <svg viewBox="0 0 32 32" ${wh} style="display:block">
        <rect x="7"   y="3" width="3.5" height="26" fill="#a06a2c" stroke="#3a1f08" stroke-width="1.2"/>
        <rect x="21.5" y="3" width="3.5" height="26" fill="#a06a2c" stroke="#3a1f08" stroke-width="1.2"/>
        <rect x="7" y="8"  width="18" height="2.6" fill="#c98a48" stroke="#3a1f08" stroke-width="0.8"/>
        <rect x="7" y="14" width="18" height="2.6" fill="#c98a48" stroke="#3a1f08" stroke-width="0.8"/>
        <rect x="7" y="20" width="18" height="2.6" fill="#c98a48" stroke="#3a1f08" stroke-width="0.8"/>
      </svg>`;
    return '';
  }

  // ----- Items tab body -----
  // Battery recharge + consumable purchases. Same row layout as before
  // but contained to its own tab so the upgrade ladders aren't cluttered.
  renderShopItemsTab() {
    const r = this.robot;
    const fuelFull = r.fuel >= r.maxFuel;
    const RECHARGE_PRICE = 5;

    const recharge = this.shopRow(
      this.shopItemIcon('fuel', 30), 'Recharge battery (full)',
      `${Math.round(r.fuel)} / ${r.maxFuel}`,
      fuelFull ? '—' : `$${RECHARGE_PRICE}`,
      'fuel', !fuelFull && r.money >= RECHARGE_PRICE,
      fuelFull ? 'Full' : (r.money >= RECHARGE_PRICE ? '+ Buy' : 'Need $'),
    );

    const items = Object.entries(ITEMS).map(([k, v]) => {
      const have = r.items[k] || 0;
      const canBuy = r.money >= v.price;
      return this.shopRow(this.shopItemIcon(k, 30), v.name,
        `${v.desc} · Have: ${have}`,
        `$${v.price}`, null, canBuy,
        canBuy ? '+ Buy' : 'Need $', `data-buy="${k}"`);
    }).join('');

    return `
      ${this.shopSection('Recharge', recharge)}
      ${this.shopSection('Consumables', items)}
    `;
  }

  shopSection(title, body) {
    return `
      <div style="margin-bottom:16px">
        <div style="font-size:12px;opacity:.7;letter-spacing:1.5px;
          text-transform:uppercase;margin-bottom:6px">${title}</div>
        <div style="background:#241608;border:2px solid #4b2e15;border-radius:10px;
          padding:6px;display:flex;flex-direction:column;gap:4px">${body}</div>
      </div>`;
  }

  // One row inside a section: [icon] [label + meta] [price] [button].
  shopRow(icon, label, meta, price, act, enabled, btnLabel, extraAttr = '') {
    const dim = enabled ? '' : 'opacity:.45';
    const btnBg = enabled ? '#c9a06a' : '#5a3e22';
    const btnColor = enabled ? '#241608' : '#8a6a44';
    const dataAttr = act ? `data-act="${act}"` : extraAttr;
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:8px 10px;
        background:#3a2614;border-radius:8px;${dim}">
        <div style="width:36px;display:flex;justify-content:center;align-items:center;flex-shrink:0">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:bold;font-size:14px">${label}</div>
          <div style="font-size:11px;opacity:.75;margin-top:2px">${meta}</div>
        </div>
        <div style="font-size:13px;color:#ffd66b;font-weight:bold;min-width:60px;text-align:right">${price}</div>
        <button ${dataAttr} ${enabled ? '' : 'disabled'}
          style="font-family:inherit;background:${btnBg};color:${btnColor};
            border:2px solid #4b2e15;border-radius:8px;padding:8px 14px;font-weight:bold;
            cursor:${enabled ? 'pointer' : 'not-allowed'};min-width:88px">${btnLabel}</button>
      </div>`;
  }

  handleShopClick(btn) {
    const r = this.robot;
    if (btn.dataset.act === 'close') { this.closeShop(); return; }
    if (btn.dataset.act === 'fuel') {
      const RECHARGE_PRICE = 5;
      if (r.fuel < r.maxFuel && r.money >= RECHARGE_PRICE) {
        r.money -= RECHARGE_PRICE;
        r.fuel = r.maxFuel;
        this.playOreCashSound?.();
      }
      this.renderShop();
      return;
    }
    if (btn.dataset.act === 'win') {
      // Real win flow: bonus payout, mark diamond consumed, open the
      // win modal. Player can hit "New Run" to regenerate the world.
      const bonus = 10000;
      r.money += bonus;
      r.hasDiamond = false;
      this.closeShop();
      this.openWinDialog(bonus);
      this.playOreCashSound?.();
      return;
    }
    if (btn.dataset.up) {
      const key = btn.dataset.up;
      const prevCargo = r.maxCargo;
      const res = applyUpgrade(r, key);
      if (res.ok) {
        this.playOreCashSound?.();
        // Cargo expansion: highlight the new slots in the inventory grid
        // for ~6s, plus a screen toast so the upgrade feels tangible. The
        // pulse is driven in JS by renderInventory each frame, so we just
        // need to record the start index and an expiry timestamp.
        if (key === 'cargo' && r.maxCargo > prevCargo) {
          this.cargoSlotsAddedFrom = prevCargo;
          this.cargoHighlightUntil = (this.time?.now || 0) + 6000;
          this.flashMessage(`+${r.maxCargo - prevCargo} cargo slots!`);
        }
      } else {
        this.flashMessage(res.reason);
      }
      this.renderShop();
      return;
    }
    if (btn.dataset.buy) {
      const key = btn.dataset.buy;
      const def = ITEMS[key];
      if (r.money >= def.price) {
        r.money -= def.price;
        r.items[key] = (r.items[key] || 0) + 1;
        this.playOreCashSound?.();
      } else {
        this.flashMessage('Not enough money');
      }
      this.renderShop();
      return;
    }
  }
}

// Minimal Phaser-Graphics-API → CanvasRenderingContext2D shim. The shared
// drawRobot() expects calls like g.fillStyle(0xff0000, 0.5), g.fillRect(...),
// g.fillTriangle(...), g.lineStyle(w, c, a), g.beginPath / moveTo / lineTo /
// strokePath. This adapter routes those onto a 2D canvas so the inventory
// avatar uses the SAME pixel-art robot as the world scene — no second copy.
function makeCanvasGraphicsAdapter(ctx) {
  const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
  return {
    fillStyle(color, alpha = 1) {
      ctx.fillStyle = hex(color);
      ctx.globalAlpha = alpha;
    },
    fillRect(x, y, w, h) { ctx.fillRect(x, y, w, h); },
    lineStyle(width, color, alpha = 1) {
      ctx.lineWidth = Math.max(1, width || 0);
      ctx.strokeStyle = hex(color);
      ctx.globalAlpha = alpha;
    },
    strokeRect(x, y, w, h) { ctx.strokeRect(x, y, w, h); },
    fillTriangle(x1, y1, x2, y2, x3, y3) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
    },
    beginPath() { ctx.beginPath(); },
    moveTo(x, y) { ctx.moveTo(x, y); },
    lineTo(x, y) { ctx.lineTo(x, y); },
    strokePath() { ctx.stroke(); },
  };
}
