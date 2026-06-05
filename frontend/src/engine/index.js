// Public API for the headless Robo-Miner engine.
//
// Pure + deterministic: no Phaser, DOM, audio, Math.random or Date. Runs
// identically in the browser (single-player + spectator) and in Node (the
// authoritative match server). See ../../MULTIPLAYER_PLAN.md for the design.

export { Match } from './match.js';
export { createMatch } from './state.js';
export { GAME_MODES, resolveMode, createMatchForMode } from './modes.js';
export { step, computeTeamScore } from './sim.js';
export { observe } from './observation.js';
export { ACTION, DIRS, DIR_VEC, UPGRADE_STATS, BUYABLE_ITEMS, normalizeAction } from './actions.js';
export { createRng } from './rng.js';
export * as ENGINE_CONSTANTS from './constants.js';
