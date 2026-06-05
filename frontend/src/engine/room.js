// A "room" = one generated map + the match running on it. This is the unit the
// lobby lists and the spectator enters. Kept deliberately light here; the
// authoritative multi-room host (create / list / join / reap) lands with the
// server in Phase 2 of MULTIPLAYER_PLAN.md.

import { Match } from './match.js';
import { roomThumbnail } from './preview.js';

let _roomSeq = 0;

/**
 * Create a room around a fresh match.
 * @param {object} opts  forwarded to Match ({ seed, miners, mode, maxTicks });
 *                       plus optional { id, thumb:{cols,rows} }.
 */
export function createRoom(opts = {}) {
  const match = new Match(opts);
  return {
    id: opts.id || `room-${++_roomSeq}`,
    seed: match.state.seed,
    mode: match.state.mode,
    status: 'running', // 'lobby' | 'running' | 'finished'
    match,
    // Terrain-only thumbnail for the lobby gallery (agents overlaid live).
    thumbnail: roomThumbnail(match.state.world, opts.thumb),
  };
}

/** Compact listing for the lobby UI. */
export function roomSummary(room) {
  const s = room.match.snapshot();
  return {
    id: room.id,
    seed: room.seed,
    mode: room.mode,
    status: s.finished ? 'finished' : room.status,
    tick: s.tick,
    agents: s.miners.length,
    alive: s.miners.filter((m) => m.alive).length,
    teamScore: s.teamScore,
    diamondFound: s.diamondFound,
  };
}

/** Live spectator frame: thumbnail with current agent positions overlaid. */
export function roomSpectatorFrame(room, thumb) {
  const s = room.match.snapshot();
  return roomThumbnail(room.match.state.world, {
    ...thumb,
    miners: s.miners.filter((m) => m.alive).map((m) => ({ x: m.x, y: m.y })),
  });
}
