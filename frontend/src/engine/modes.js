// Game modes. A "mode" is just a bundle of existing engine knobs — a world
// preset (spec) + a victory condition + a spawn layout — that the menu picks
// from. Modular by design: it composes `createMatch` options, it does NOT add
// new rules. This is the seam where "single-player vs the agent modes" lives.

import { Match } from './match.js';

export const GAME_MODES = {
  solo: {
    name: 'solo',
    label: 'Single Player',
    spec: 'solo',
    spawn: 'cluster',
    victory: { diamondWins: true },
    maxTicks: 1_000_000,
    miners: 1,
    description: 'One miner, the classic deep dig to the diamond.',
  },
  'coop-gem': {
    name: 'coop-gem',
    label: 'Co-op · Find the Gem',
    spec: 'agents',
    spawn: 'wide',
    victory: { diamondWins: true },
    maxTicks: 20_000,
    miners: 10,
    description: 'A squad of 10 bots digs the real mine; win by carrying the diamond up to the shop.',
  },
  'coop-race': {
    name: 'coop-race',
    label: 'Co-op · Score Race',
    spec: 'agents',
    spawn: 'wide',
    victory: { diamondWins: true, scoreTarget: 5000 },
    maxTicks: 20_000,
    miners: 10,
    description: 'Race to a team score target by mining and selling (the diamond bonus counts too).',
  },
  'coop-timed': {
    name: 'coop-timed',
    label: 'Co-op · Timed Haul',
    spec: 'agents',
    spawn: 'wide',
    victory: { diamondWins: true },
    maxTicks: 6_000,
    miners: 10,
    description: 'Bank the most team value before the tick deadline ends the match.',
  },
  arena: {
    name: 'arena',
    label: 'Arena',
    spec: 'agents',
    spawn: 'wide',
    victory: { diamondWins: true },
    maxTicks: 8_000,
    miners: 8,
    description: 'A smaller squad of 8 bots on a time-boxed dig — quick to watch.',
  },
};

export function resolveMode(mode) {
  if (!mode) return GAME_MODES.solo;
  if (typeof mode === 'string') return GAME_MODES[mode] || GAME_MODES.solo;
  return mode;
}

/**
 * Build a Match wired for a mode.
 * @param {string|object} mode   a GAME_MODES key or a mode object
 * @param {object} [opts]        { seed, miners } — miners is an array of specs;
 *                               if omitted, `mode.miners` empty miners are made.
 */
export function createMatchForMode(mode, opts = {}) {
  const m = resolveMode(mode);
  const miners = opts.miners || Array.from({ length: m.miners || 1 }, (_, i) => ({ name: `${m.name}-${i}` }));
  return new Match({
    seed: opts.seed ?? 12345,
    mode: m.name,
    spec: m.spec,
    spawn: m.spawn,
    victory: m.victory,
    maxTicks: m.maxTicks,
    miners,
  });
}
