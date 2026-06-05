// Lobby + spectator demo (terminal).
//   node src/engine/lobby.mjs   (run from the frontend/ directory)
//
// Shows the "rooms" concept from MULTIPLAYER_PLAN.md: several generated maps
// (rooms), a lobby listing, a terrain thumbnail per room (what the menu gallery
// paints), and a live spectator frame with agents (@) overlaid on the map.

import { createRoom, roomSummary, roomSpectatorFrame } from './room.js';

const THUMB = { cols: 40, rows: 44 };

// Plain dig-down policy so agents spread through the mine and show up in the
// spectator overlay at different depths.
function digDown(obs) {
  if (!obs || !obs.self.alive || obs.self.busy) return { type: 'WAIT' };
  return { type: 'MOVE', dir: 'down' };
}

function advance(room, ticks) {
  for (let t = 0; t < ticks && !room.match.finished; t++) {
    for (const id of room.match.minerIds) {
      room.match.submitAction(id, digDown(room.match.observe(id)));
    }
    room.match.advance();
  }
}

const seeds = [101, 777, 2024];
const rooms = seeds.map((seed, i) =>
  createRoom({ id: `room-${seed}`, seed, miners: Array.from({ length: 4 }, (_, k) => ({ name: `bot-${k}` })) }),
);

// Let the agents dig for a bit so the spectator view has motion.
for (const room of rooms) advance(room, 160);

console.log('=== LOBBY ===');
console.log('id           seed   agents alive tick  teamScore  diamond');
for (const room of rooms) {
  const s = roomSummary(room);
  console.log(
    `${s.id.padEnd(12)} ${String(s.seed).padEnd(6)} ${String(s.agents).padEnd(6)} ` +
    `${String(s.alive).padEnd(5)} ${String(s.tick).padEnd(5)} ${String(s.teamScore).padEnd(10)} ${s.diamondFound}`,
  );
}

console.log('\n=== ROOM THUMBNAILS (terrain only — the menu map gallery) ===');
for (const room of rooms) {
  console.log(`\n[${room.id}]  seed=${room.seed}`);
  console.log(room.thumbnail.ascii);
}

console.log('\n=== LIVE SPECTATOR (room-777, @ = agent) ===');
console.log(roomSpectatorFrame(rooms[1], THUMB).ascii);
