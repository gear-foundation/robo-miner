// Flat pixel-art robot. ONE implementation, used by MenuScene and GameScene
// so there is a single source of truth for the hero's look. No curves, no
// alpha fades, no sub-pixel interpolation — just rectangles on discrete
// on/off timers.
//
// Call:
//   drawRobot(graphics, centerX, centerY, size, opts)
//
// `size` is the width of the full robot box. Everything inside is expressed
// relative to a reference size of 48 px, so the same drawing scales cleanly
// from a 48-px game tile to a 96-px menu splash.
//
// opts:
//   facing     'left' | 'right' | 'up' | 'down'     (default 'right')
//   digging    bool — shows the drill in the facing direction
//   time       ms, for simple on/off LED blinking and drill pulse
//   hasDiamond bool — little cyan flag on top of the head
//   shake      { x, y } — integer offset applied while digging
//   shadow     bool — draw a flat ground shadow (default true)
//   hat        cosmetic id from HATS — null/undefined = no hat
//   tier       1..6 — visually upgrades the chassis palette (gray → bronze
//              → silver → gold → plasma → diamond) so a maxed-out robot
//              looks earned at a glance

// --- Body color palettes (cosmetic, chosen on the menu). Each is a
// [light, mid, dark] triplet that fills the chassis. 'classic' is the
// stock gray which also serves as the no-color default.
const BODY_COLORS = {
  classic:  { light: 0xcccccc, mid: 0x9a9a9a, dark: 0x555555 },
  mint:     { light: 0x9be6c0, mid: 0x4fbf90, dark: 0x1f5f4a },
  sky:      { light: 0x9ed0ff, mid: 0x4f9be6, dark: 0x1c4f8a },
  pink:     { light: 0xffb0d4, mid: 0xff5a9e, dark: 0x8a224a },
  sunset:   { light: 0xffc87a, mid: 0xff7a3a, dark: 0x8a3a14 },
  royal:    { light: 0xc8a8ff, mid: 0x8c5fe6, dark: 0x3e1f7a },
  sunshine: { light: 0xfff0a0, mid: 0xffd84a, dark: 0xa07a14 },
  racer:    { light: 0xff5a5a, mid: 0xb02020, dark: 0x320a0a },
  carbon:   { light: 0x4a4a4a, mid: 0x2a2a2a, dark: 0x080808 },
};

// CSS hex form, used by the menu picker swatches.
export const BODY_COLOR_SWATCH = Object.fromEntries(
  Object.entries(BODY_COLORS).map(([k, v]) => [k, '#' + v.mid.toString(16).padStart(6, '0')]),
);

export const BODY_COLOR_IDS = Object.keys(BODY_COLORS);
export const BODY_COLOR_LABELS = {
  classic:  'Classic Gray',
  mint:     'Mint',
  sky:      'Sky Blue',
  pink:     'Hot Pink',
  sunset:   'Sunset',
  royal:    'Royal Purple',
  sunshine: 'Sunshine',
  racer:    'Racer Red',
  carbon:   'Carbon',
};

export function pickRandomBodyColor() {
  return BODY_COLOR_IDS[Math.floor(Math.random() * BODY_COLOR_IDS.length)];
}

// Tiny adapter that lets `drawRobot` (built around Phaser's Graphics
// API) render onto a regular HTML `<canvas>` 2D context. Used by menu
// previews and inventory avatars where we don't have a Phaser scene.
export function makeCanvasGraphicsAdapter(ctx) {
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
    fillEllipse(cx, cy, w, h) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    beginPath() { ctx.beginPath(); },
    moveTo(x, y) { ctx.moveTo(x, y); },
    lineTo(x, y) { ctx.lineTo(x, y); },
    strokePath() { ctx.stroke(); },
  };
}

// --- Tier accents. Tier no longer recolors the whole body — that is
// the player's cosmetic choice (BODY_COLORS). Tier instead drives the
// metal trim: track + stud color and a rim highlight that grows brighter
// with each upgrade. Index 0 = L1, index 5 = L6.
const TIER_ACCENTS = [
  { track: 0x2a2a2a, stud: 0x666666, accent: null },        // L1 — stock
  { track: 0x282c30, stud: 0x808890, accent: null },        // L2 — slight chrome
  { track: 0x2c1c10, stud: 0xa07a4a, accent: 0xffc784 },    // L3 — bronze trim
  { track: 0x232634, stud: 0xa8b0c0, accent: 0xa0d6ff },    // L4 — steel chrome
  { track: 0x2c1c00, stud: 0xffe86b, accent: 0xfff19a },    // L5 — golden rim
  { track: 0x18394c, stud: 0xeaffff, accent: 0xffffff },    // L6 — diamond plate
];

const PANEL       = 0x141414;
const WHITE       = 0xffffff;
const BLACK       = 0x111111;
const RED_ON      = 0xff3b3b;
const RED_OFF     = 0x7a1c1c;
const LED_GREEN_ON  = 0x2ec552, LED_GREEN_OFF = 0x184f24;
const LED_RED_ON    = 0xff3b3b, LED_RED_OFF   = 0x7a1c1c;
const LED_WHITE_ON  = 0xffffff, LED_WHITE_OFF = 0x6e6e6e;
const LED_CYAN_ON   = 0x5ff6ff;
const DRILL_STEEL = 0xb8b8c2;
const DRILL_DARK  = 0x6a6a74;
const DRILL_NOTCH = 0x2e2e36;

// Hat ids list — exported so menu/inventory can render the picker. The
// drawing function `drawHat` switches on this id.
export const HAT_IDS = ['none', 'hardhat', 'pirate', 'party', 'top', 'cap', 'crown', 'beanie', 'horns'];

// Player-facing labels for the menu randomizer.
export const HAT_LABELS = {
  none:    'No Hat',
  hardhat: 'Hard Hat',
  pirate:  'Pirate',
  party:   'Party Cone',
  top:     'Top Hat',
  cap:     'Cap',
  crown:   'Crown',
  beanie:  'Propeller',
  horns:   'Viking',
};

export function pickRandomHat() {
  // 'none' is included but weighted lower so most rolls give an actual hat.
  const weighted = ['hardhat','hardhat', 'pirate','pirate', 'party',
    'top', 'cap', 'crown', 'beanie','beanie', 'horns', 'none'];
  return weighted[Math.floor(Math.random() * weighted.length)];
}

export function drawRobot(g, cx, cy, size, opts = {}) {
  const {
    facing = 'right',
    digging = false,
    time = 0,
    hasDiamond = false,
    shake = { x: 0, y: 0 },
    shadow = true,
    squashed = false,
    hat = null,
    tier = 1,
    bodyColor = 'classic',
  } = opts;

  if (squashed) {
    drawSquashedRobot(g, cx, cy, size, bodyColor);
    return;
  }

  const s = size / 48; // scale factor from the reference 48-px layout
  const P = (v) => Math.max(1, Math.round(v * s)); // size in pixels, min 1
  const x = Math.round(cx - size / 2 + (shake.x || 0));
  const y = Math.round(cy - size / 2 + (shake.y || 0));

  // Body color = player's cosmetic choice. Tier never overrides this so
  // the robot stays "yours" even at L6 — only the trim escalates.
  const BODY = BODY_COLORS[bodyColor] || BODY_COLORS.classic;
  const GRAY_LIGHT = BODY.light;
  const GRAY_MID   = BODY.mid;
  const GRAY_DARK  = BODY.dark;
  // Tier accent (track + stud + rim glow). Higher tier = shinier metal.
  const tIdx = Math.max(0, Math.min(TIER_ACCENTS.length - 1, (tier | 0) - 1));
  const PAL = TIER_ACCENTS[tIdx];

  // --- Flat ground shadow (rectangle, no ellipse)
  if (shadow) {
    g.fillStyle(0x000000, 0.3);
    g.fillRect(
      Math.round(cx - size * 0.34),
      Math.round(cy + size * 0.46),
      Math.round(size * 0.68),
      P(2),
    );
  }

  // --- Antenna: 1-2 px stick + square blinking tip, slightly left of center.
  // The antenna IS the "no-hat" head ornament — it would clip ugly through
  // any hat brim, so it only renders when no hat is active.
  if (!hat || hat === 'none') {
    const antX = x + P(19);
    g.fillStyle(GRAY_DARK, 1);
    g.fillRect(antX, y + P(4), P(1), P(6));
    const antOn = Math.floor(time / 350) % 2 === 0;
    g.fillStyle(antOn ? RED_ON : RED_OFF, 1);
    g.fillRect(antX - P(1), y + P(2), P(3), P(3));
  }

  // --- Body chassis (gray with darker side band for a bit of volume)
  g.fillStyle(GRAY_LIGHT, 1);
  g.fillRect(x + P(8), y + P(10), P(32), P(30));
  g.fillStyle(GRAY_MID, 1);
  g.fillRect(x + P(34), y + P(10), P(6), P(30));

  // --- Eye panel (flat dark rectangle)
  const epX = x + P(11);
  const epY = y + P(14);
  const epW = P(26);
  const epH = P(9);
  g.fillStyle(PANEL, 1);
  g.fillRect(epX, epY, epW, epH);

  // --- Eyes: white squares + black square pupils, pupils shift by facing.
  // Blink = thin white bar.
  const eyeSize = P(5);
  const eyeY = epY + Math.floor((epH - eyeSize) / 2);
  const eyeLX = epX + P(3);
  const eyeRX = epX + epW - P(3) - eyeSize;
  const blinking = ((time / 1000) % 4.2) > 4.05;
  if (blinking) {
    g.fillStyle(WHITE, 1);
    g.fillRect(eyeLX, eyeY + Math.floor(eyeSize / 2), eyeSize, P(1));
    g.fillRect(eyeRX, eyeY + Math.floor(eyeSize / 2), eyeSize, P(1));
  } else {
    g.fillStyle(WHITE, 1);
    g.fillRect(eyeLX, eyeY, eyeSize, eyeSize);
    g.fillRect(eyeRX, eyeY, eyeSize, eyeSize);
    let pdx = 0, pdy = 0;
    if (facing === 'left')  pdx = -P(1);
    if (facing === 'right') pdx =  P(1);
    if (facing === 'up')    pdy = -P(1);
    if (facing === 'down')  pdy =  P(1);
    const pup = Math.max(2, Math.round(2 * s));
    const pin = Math.floor((eyeSize - pup) / 2);
    g.fillStyle(BLACK, 1);
    g.fillRect(eyeLX + pin + pdx, eyeY + pin + pdy, pup, pup);
    g.fillRect(eyeRX + pin + pdx, eyeY + pin + pdy, pup, pup);
  }

  // --- Left control panel: three tiny blinking lamps on the chassis.
  const panelX = x + P(11);
  const panelY = y + P(30);
  const ledS = Math.max(2, Math.round(3 * s));

  const greenOn = Math.floor(time / 520) % 2 === 0;
  const redOn = Math.floor((time + 170) / 390) % 2 === 0;
  const whiteOn = Math.floor((time + 80) / 710) % 2 === 0;
  g.fillStyle(greenOn ? LED_GREEN_ON : LED_GREEN_OFF, 1);
  g.fillRect(panelX + P(2), panelY + P(1), ledS, ledS);
  g.fillStyle(redOn ? LED_RED_ON : LED_RED_OFF, 1);
  g.fillRect(panelX + P(7), panelY + P(1), ledS, ledS);
  g.fillStyle(whiteOn ? LED_WHITE_ON : LED_WHITE_OFF, 1);
  g.fillRect(panelX + P(12), panelY + P(1), ledS, ledS);

  // --- Tracks (solid dark base + simple square studs)
  g.fillStyle(PAL.track, 1);
  g.fillRect(x + P(4), y + P(40), P(40), P(6));
  g.fillStyle(PAL.stud, 1);
  const stud = Math.max(2, Math.round(2 * s));
  for (let i = 0; i < 4; i++) {
    const sx = x + P(9) + i * P(10);
    g.fillRect(sx, y + P(42), stud, stud);
  }

  // --- Tier accent rim (T4+): a 1-px highlight along the chassis top
  // and side band so the robot reads as "premium plating".
  if (PAL.accent) {
    g.fillStyle(PAL.accent, 1);
    g.fillRect(x + P(8), y + P(10), P(32), P(1));
    g.fillRect(x + P(40 - 1), y + P(10), P(1), P(30));
  }

  // --- Drill: ONLY when actively digging. Drawn after tracks so the
  // downward drill visibly comes out from underneath the robot.
  if (digging) drawDrill(g, x, y, s, facing, time);

  // --- Hat: drawn on top of the chassis but UNDER the diamond marker.
  // Each hat occupies the strip y..y+P(10) above the eye panel.
  if (hat && hat !== 'none') drawHat(g, x, y, s, P, hat, time);

  // --- Diamond flag on the head (game only sets this)
  if (hasDiamond) {
    g.fillStyle(LED_CYAN_ON, 1);
    g.fillRect(x + P(22), y + P(2), P(4), P(4));
  }
}

// --- Hats. Each is a tiny rectangle composition that sits in the
// strip above the chassis. The ones with chinstraps / brims wrap a bit
// onto the head sides. They are deliberately oversized so they read at
// 48-px tile resolution.
function drawHat(g, x, y, s, P, hat, time) {
  const cx = x + P(24);

  if (hat === 'hardhat') {
    // Bright yellow construction helmet with a wide brim and central ridge.
    g.fillStyle(0xffc107, 1);
    g.fillRect(x + P(11), y + P(3), P(26), P(7));   // dome
    g.fillStyle(0xffd84a, 1);
    g.fillRect(x + P(13), y + P(3), P(22), P(2));   // top hi-light
    g.fillStyle(0xb8860b, 1);
    g.fillRect(x + P(8), y + P(8), P(32), P(2));    // brim
    g.fillStyle(0x3a2a00, 1);
    g.fillRect(x + P(23), y + P(3), P(2), P(7));    // central ridge
    return;
  }

  if (hat === 'pirate') {
    // Tricorn-ish silhouette: a wide black trapezoid with a white skull dot.
    g.fillStyle(0x111111, 1);
    g.fillRect(x + P(7), y + P(7), P(34), P(3));    // brim
    g.fillTriangle(x + P(11), y + P(7), x + P(24), y + P(0), x + P(37), y + P(7)); // crown peak
    g.fillStyle(0x2a2a2a, 1);
    g.fillRect(x + P(13), y + P(5), P(22), P(3));   // band
    // Skull crossbones (tiny white dot pair)
    g.fillStyle(0xffffff, 1);
    g.fillRect(x + P(22), y + P(5), P(4), P(2));
    g.fillRect(x + P(22), y + P(7) - P(1), P(2), P(1));
    g.fillRect(x + P(25), y + P(7) - P(1), P(1), P(1));
    return;
  }

  if (hat === 'party') {
    // Striped party cone with a pom-pom.
    g.fillStyle(0xff3366, 1);
    g.fillTriangle(x + P(16), y + P(10), x + P(32), y + P(10), x + P(24), y - P(2));
    g.fillStyle(0xffd84a, 1);
    g.fillTriangle(x + P(19), y + P(7),  x + P(29), y + P(7),  x + P(24), y + P(1));
    g.fillStyle(0x35c8ff, 1);
    g.fillTriangle(x + P(21), y + P(4),  x + P(27), y + P(4),  x + P(24), y);
    // Pom-pom — a 3×3 white cluster on the tip.
    g.fillStyle(0xffffff, 1);
    g.fillRect(cx - P(2), y - P(4), P(4), P(3));
    return;
  }

  if (hat === 'top') {
    // Classic black top hat: tall block + brim + red band.
    g.fillStyle(0x111111, 1);
    g.fillRect(x + P(15), y - P(2), P(18), P(11));  // crown
    g.fillRect(x + P(9),  y + P(8), P(30), P(3));   // brim
    g.fillStyle(0xc62828, 1);
    g.fillRect(x + P(15), y + P(5), P(18), P(3));   // band
    g.fillStyle(0x2a2a2a, 1);
    g.fillRect(x + P(15), y - P(2), P(18), P(1));   // top hi-light
    return;
  }

  if (hat === 'cap') {
    // Backwards baseball cap.
    g.fillStyle(0x1565c0, 1);
    g.fillRect(x + P(12), y + P(4), P(24), P(6));   // crown
    g.fillStyle(0x0d47a1, 1);
    g.fillRect(x + P(12), y + P(8), P(24), P(2));   // band
    g.fillStyle(0x1565c0, 1);
    g.fillRect(x + P(8),  y + P(8), P(4),  P(2));   // bill (left)
    g.fillStyle(0xffffff, 1);
    g.fillRect(x + P(22), y + P(6), P(4),  P(2));   // logo patch
    return;
  }

  if (hat === 'crown') {
    // Spiky gold crown with red gem in the middle. Twinkle on the gem.
    g.fillStyle(0xffd84a, 1);
    g.fillRect(x + P(11), y + P(5), P(26), P(5));    // band
    g.fillRect(x + P(12), y + P(2), P(3),  P(5));    // spike L
    g.fillRect(x + P(22), y,        P(3),  P(7));    // spike center
    g.fillRect(x + P(33), y + P(2), P(3),  P(5));    // spike R
    g.fillRect(x + P(17), y + P(3), P(3),  P(4));    // spike mid-L
    g.fillRect(x + P(28), y + P(3), P(3),  P(4));    // spike mid-R
    g.fillStyle(0xffffff, 1);
    for (let i = 0; i < 3; i++) g.fillRect(x + P(13 + i * 8), y + P(2), P(1), P(1));
    g.fillStyle(0xe6224a, 1);
    g.fillRect(x + P(22), y + P(6), P(4), P(3));
    if (Math.floor(time / 280) % 2 === 0) {
      g.fillStyle(0xffe6ed, 1);
      g.fillRect(x + P(22), y + P(6), P(2), P(1));
    }
    return;
  }

  if (hat === 'beanie') {
    // Propeller beanie: striped beanie + spinning prop on top.
    g.fillStyle(0xc62828, 1);
    g.fillRect(x + P(13), y + P(5), P(22), P(5));
    g.fillStyle(0x1565c0, 1);
    g.fillRect(x + P(13), y + P(7), P(22), P(2));
    g.fillStyle(0x6e6e6e, 1);
    g.fillRect(x + P(23), y + P(2), P(2), P(3));      // shaft
    // Propeller swap orientation each ~120ms so it "spins".
    const phase = Math.floor(time / 120) % 2 === 0;
    g.fillStyle(0xeeeeee, 1);
    if (phase) {
      g.fillRect(x + P(18), y + P(1), P(12), P(1));
    } else {
      g.fillRect(cx - P(1), y - P(1), P(2), P(4));
    }
    return;
  }

  if (hat === 'horns') {
    // Viking helmet: a gray dome + two outward horns + rivets.
    g.fillStyle(0x9a9a9a, 1);
    g.fillRect(x + P(13), y + P(4), P(22), P(6));
    g.fillStyle(0xc8c8c8, 1);
    g.fillRect(x + P(15), y + P(4), P(18), P(2));
    g.fillStyle(0x4a4a4a, 1);
    g.fillRect(x + P(13), y + P(8), P(22), P(2));
    // Rivets
    g.fillStyle(0xffffff, 1);
    g.fillRect(x + P(16), y + P(7), P(1), P(1));
    g.fillRect(x + P(31), y + P(7), P(1), P(1));
    // Horns sweep outward
    g.fillStyle(0xfff4d4, 1);
    g.fillTriangle(x + P(13), y + P(6), x + P(7),  y + P(2), x + P(11), y + P(7));
    g.fillTriangle(x + P(35), y + P(6), x + P(41), y + P(2), x + P(37), y + P(7));
    g.fillStyle(0x6e5a32, 1);
    g.fillRect(x + P(7),  y + P(2), P(1), P(1));
    g.fillRect(x + P(41), y + P(2), P(1), P(1));
    return;
  }
}

// Flat, pressed-down silhouette with X eyes. Drawn when the robot just
// got crushed / died — keeps the visual language of the normal sprite
// (player's chosen body color, dark panel) so it reads clearly as
// "same robot, squashed".
function drawSquashedRobot(g, cx, cy, size, bodyColor = 'classic') {
  const s = size / 48;
  const P = (v) => Math.max(1, Math.round(v * s));
  const x = Math.round(cx - size / 2);
  const y = Math.round(cy - size / 2);

  const BODY = BODY_COLORS[bodyColor] || BODY_COLORS.classic;
  const GRAY_LIGHT = BODY.light;
  const GRAY_MID   = BODY.mid;

  // Shadow is wider and flatter — something heavy landed here.
  g.fillStyle(0x000000, 0.45);
  g.fillRect(Math.round(cx - size * 0.42), Math.round(cy + size * 0.42), Math.round(size * 0.84), P(3));

  // Flattened chassis: half height, splayed wider.
  const bodyTop = y + P(28);
  const bodyH = P(14);
  g.fillStyle(GRAY_LIGHT, 1);
  g.fillRect(x + P(4), bodyTop, P(40), bodyH);
  g.fillStyle(GRAY_MID, 1);
  g.fillRect(x + P(36), bodyTop, P(8), bodyH);

  // Cracked eye panel
  g.fillStyle(PANEL, 1);
  g.fillRect(x + P(8), bodyTop + P(2), P(32), P(8));

  // X eyes: two crossing diagonals per eye.
  const exY = bodyTop + P(3);
  const exH = P(6);
  const exL = x + P(11);
  const exR = x + P(28);
  const exW = P(8);
  g.lineStyle(P(1), 0xffffff, 1);
  g.beginPath();
  g.moveTo(exL, exY); g.lineTo(exL + exW, exY + exH);
  g.moveTo(exL + exW, exY); g.lineTo(exL, exY + exH);
  g.moveTo(exR, exY); g.lineTo(exR + exW, exY + exH);
  g.moveTo(exR + exW, exY); g.lineTo(exR, exY + exH);
  g.strokePath();

  // Stumpy tracks sticking out the sides.
  g.fillStyle(0x2a2a2a, 1);
  g.fillRect(x + P(2), y + P(42), P(44), P(4));
}

function drawDrill(g, x, y, s, facing, time) {
  const P = (v) => Math.max(1, Math.round(v * s));
  const pulse = Math.abs(Math.sin(time / 40));
  const ext = P(4) + Math.round(pulse * P(3));
  const half = P(7);
  const inset = P(8);

  const cxB = x + P(24);
  const cyB = y + P(24);
  const bodyL = x + P(8);
  const bodyR = x + P(40);
  const bodyT = y + P(10);
  const bodyB = y + P(40);
  const robotL = x + P(4);
  const robotR = x + P(44);
  const robotT = y + P(2);
  const robotB = y + P(46);

  let ax, ay, bx2, by2, tx, ty;
  if (facing === 'up') {
    ax = cxB - half; ay = robotT - P(1);
    bx2 = cxB + half; by2 = robotT - P(1);
    tx = cxB; ty = robotT - P(9) - ext;
  } else if (facing === 'down') {
    ax = cxB - half; ay = robotB + P(1);
    bx2 = cxB + half; by2 = robotB + P(1);
    tx = cxB; ty = robotB + P(9) + ext;
  } else if (facing === 'left') {
    ax = robotL - P(1); ay = cyB - half;
    bx2 = robotL - P(1); by2 = cyB + half;
    tx = robotL - P(9) - ext; ty = cyB;
  } else { // right
    ax = robotR + P(1); ay = cyB - half;
    bx2 = robotR + P(1); by2 = cyB + half;
    tx = robotR + P(9) + ext; ty = cyB;
  }

  // Base triangle + darker "shaded half" (split along the drill axis)
  g.fillStyle(DRILL_STEEL, 1);
  g.fillTriangle(ax, ay, bx2, by2, tx, ty);
  const mx = (ax + bx2) / 2, my = (ay + by2) / 2;
  g.fillStyle(DRILL_DARK, 1);
  g.fillTriangle(mx, my, bx2, by2, tx, ty);

  // Two square notches on each half-edge
  g.fillStyle(DRILL_NOTCH, 1);
  const notch = Math.max(2, Math.round(2 * s));
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const nAx = Math.round(ax + (tx - ax) * t);
    const nAy = Math.round(ay + (ty - ay) * t);
    const nBx = Math.round(bx2 + (tx - bx2) * t);
    const nBy = Math.round(by2 + (ty - by2) * t);
    g.fillRect(nAx - Math.floor(notch / 2), nAy - Math.floor(notch / 2), notch, notch);
    g.fillRect(nBx - Math.floor(notch / 2), nBy - Math.floor(notch / 2), notch, notch);
  }

  // Black outline around the cone
  g.lineStyle(Math.max(1, Math.round(s)), 0x000000, 1);
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(tx, ty);
  g.lineTo(bx2, by2);
  g.strokePath();
  g.lineStyle(0, 0, 0);
}
