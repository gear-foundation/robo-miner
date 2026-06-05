// Watch a coop match of scripted bots — the "посмотреть как они играют" harness.
//   node src/engine/watch.mjs [seed] [ticks]   (from the frontend/ directory)
//
// Builds a 10-agent squad from the factory, runs a lockstep coop match on one
// shared map, periodically prints a live spectator frame (@ = agent) and an
// economy snapshot, then a final per-agent + team summary. Fully deterministic.

import { createRoom, roomSpectatorFrame } from './room.js';
import { createSquad } from './agents.js';

const SEED = Number(process.argv[2]) || 2024;
const TICKS = Number(process.argv[3]) || 4000;
const EVERY = Math.max(1, Math.floor(TICKS / 5)); // ~5 spectator snapshots
const THUMB = { cols: 62, rows: 30 };

// 10 agents: a mixed squad so we can watch different behaviours interact.
const roster = createSquad({ shuttle: 4, prospector: 3, deepdiver: 2, idler: 1 });
const room = createRoom({
  id: 'watch',
  seed: SEED,
  spawn: 'wide',
  // Agent-match tuning: forgiving falls so shaft-digging bots don't die on every
  // drop (the strict single-player default makes 10 naive bots a death parade).
  safeFall: 8,
  miners: roster.map((a) => ({ name: a.name, hat: a.hat, color: a.color, items: a.items || undefined })),
});

console.log(`=== WATCH  seed=${SEED} agents=${roster.length} ticks=${TICKS} ===`);
console.log('squad: ' + roster.map((a) => `${a.name}`).join(', '));

function econLine(room) {
  const ms = room.match.state.miners;
  const sold = ms.reduce((a, m) => a + m.stats.sold, 0);
  const spent = ms.reduce((a, m) => a + m.stats.spent, 0);
  const ore = ms.reduce((a, m) => a + m.stats.oresCollected, 0);
  const dug = ms.reduce((a, m) => a + m.stats.tilesDug, 0);
  const deaths = ms.reduce((a, m) => a + m.stats.deaths, 0);
  const deepest = Math.max(...ms.map((m) => m.ty - 3));
  return `dug=${dug} ore=${ore} sold=$${sold} spent=$${spent} deaths=${deaths} deepest=${deepest}m score=$${room.match.state.teamScore}`;
}

for (let t = 0; t < TICKS && !room.match.finished; t++) {
  for (const id of room.match.minerIds) {
    room.match.submitAction(id, roster[id].decide(room.match.observe(id)));
  }
  room.match.advance();
  if ((t + 1) % EVERY === 0 || room.match.finished) {
    console.log(`\n--- tick ${room.match.tick} --- ${econLine(room)}`);
    console.log(roomSpectatorFrame(room, THUMB).ascii);
  }
}

console.log('\n=== FINAL ===');
console.log('agent           kind        depth  money  dug  ore  sold   spent  deaths');
for (let i = 0; i < roster.length; i++) {
  const m = room.match.state.miners[i];
  const a = roster[i];
  console.log(
    `${a.name.padEnd(14)} ${a.kind.padEnd(11)} ${String(m.ty - 3).padStart(4)}  ` +
    `$${String(m.money).padStart(5)} ${String(m.stats.tilesDug).padStart(4)} ${String(m.stats.oresCollected).padStart(4)}  ` +
    `$${String(m.stats.sold).padStart(5)} $${String(m.stats.spent).padStart(5)} ${String(m.stats.deaths).padStart(5)}`,
  );
}
console.log(`\nteam score: $${room.match.state.teamScore}  diamondFound=${room.match.state.diamondFound}  finished=${room.match.finished} (${room.match.state.finishedReason || 'running'})`);
console.log(econLine(room));
