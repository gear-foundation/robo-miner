// Engine balance constants. All real-time (ms) feel from the single-player game
// is converted to discrete TICKS here so the simulation is fully lockstep.

import { SURFACE_Y } from '../config.js';

// Milliseconds a single tick represents — used only to convert the original
// dig durations into tick counts. Not a wall-clock value; the server decides
// how long to actually wait for agent submissions.
export const MS_PER_TICK = 200;

// Falling stones: ticks a stone wobbles before it drops. Player-triggered drops
// get a long warning; cascades (one stone uncovering the next) drop almost at
// once so a slide reads as a single motion.
export const SHAKE_TICKS = 8; // ≈1.5 s warning before a stone drops (matches the game)
export const CASCADE_SHAKE_TICKS = 1;

// Pillars drop a beat after losing support.
export const PILLAR_FALL_GRACE_TICKS = 1;

// Lava crawls one cell every N ticks, capped by a per-source budget and a max
// number of simultaneous active sources (mirrors GameScene's lava limiter).
export const LAVA_STEP_TICKS = 2;
export const LAVA_BUDGET = 18;
export const LAVA_MAX_SOURCES = 8;

// Dynamite fuse, in ticks. The original game uses a 4 s fuse — long enough to
// run out of the blast radius before it goes off.
export const DYNAMITE_FUSE_TICKS = Math.max(1, Math.round(4000 / MS_PER_TICK));

// Falls of more than this many tiles hurt (or trigger a parachute).
export const SAFE_FALL = 3;

// Death → auto-respawn delay (cooperative endless play).
export const RESPAWN_TICKS = 3;
export const RESPAWN_FUEL_FRACTION = 0.3;

// Diamond turn-in jackpot. Deliberately HUGE — it dwarfs a whole run's worth of
// ore so the diamond is unambiguously THE prize, not just another sale. (Maxing
// every upgrade costs ~$358k; the jackpot tops that.) Tune freely.
export const DIAMOND_BONUS = 500000;

// Hard ceiling on a match so a stuck agent set can't run forever.
export const DEFAULT_MAX_TICKS = 5000;

// The walkable surface row (robots stand here; SURFACE_Y is the first dug row).
export const SURFACE_ROW = SURFACE_Y - 1;
