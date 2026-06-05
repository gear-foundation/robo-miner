// Node smoke test for the headless engine.
//   node src/engine/smoke.mjs   (run from the frontend/ directory)
//
// Verifies: (1) the engine runs in plain Node with no Phaser/DOM, (2) a coop
// run actually mines + sells + digs, (3) the simulation is deterministic —
// two identical matches driven by the same policy end in the same state.

import { Match } from './index.js';

// A tiny deterministic shuttle bot with per-bot memory (a hysteresis state
// machine, so it doesn't oscillate one tile above its turnaround). Each surface
// visit it pushes the turnaround depth a little deeper, so every trip mines
// fresh ore; the climb back is always within the ladder budget because only the
// newly-dug portion below the existing laddered shaft costs ladders. No
// Math.random — fully determined by play, so two runs stay identical.
const MAX_TARGET = 40;
function policy(obs, bs) {
  const s = obs.self;
  if (!s.alive || s.busy) return { type: 'WAIT' };
  if (bs.mode === 'down' && (s.depth >= bs.target || s.cargoCount >= s.maxCargo || s.fuel < 12)) {
    bs.mode = 'up';
  }
  if (bs.mode === 'up') {
    if (s.depth <= 0) {
      bs.mode = 'down';
      bs.target = Math.min(MAX_TARGET, bs.target + 4);
    } else {
      return { type: 'MOVE', dir: 'up' };
    }
  }
  if (s.depth <= 0 && s.fuel < s.maxFuel && s.money >= 5) return { type: 'REFUEL' };
  return { type: 'MOVE', dir: 'down' };
}

function runMatch(seed, minerCount, ticks) {
  const miners = Array.from({ length: minerCount }, (_, i) => ({ name: `bot-${i}` }));
  const match = new Match({ seed, miners, mode: 'coop' });
  const brains = new Map();
  for (const id of match.minerIds) brains.set(id, { mode: 'down', target: 6 });
  for (let t = 0; t < ticks && !match.finished; t++) {
    for (const id of match.minerIds) {
      match.submitAction(id, policy(match.observe(id), brains.get(id)));
    }
    match.advance();
  }
  return match;
}

const SEED = 777;
const MINERS = 3;
const TICKS = 2500;

const a = runMatch(SEED, MINERS, TICKS);
const b = runMatch(SEED, MINERS, TICKS);

const snapA = JSON.stringify(a.snapshot());
const snapB = JSON.stringify(b.snapshot());
const deterministic = snapA === snapB;

console.log('=== Robo-Miner engine smoke test ===');
console.log(`seed=${SEED} miners=${MINERS} ticks=${TICKS}`);
console.log(`deterministic (two runs identical): ${deterministic ? 'PASS' : 'FAIL'}`);

const snap = a.snapshot();
console.log(`team score: ${snap.teamScore}`);
let totalDug = 0;
let totalOre = 0;
let totalDeaths = 0;
for (const m of a.state.miners) {
  totalDug += m.stats.tilesDug;
  totalOre += m.stats.oresCollected;
  totalDeaths += m.stats.deaths;
  console.log(
    `  ${m.name}: depth=${m.ty - 3} money=$${m.money} ` +
    `dug=${m.stats.tilesDug} ore=${m.stats.oresCollected} sold=$${m.stats.sold} deaths=${m.stats.deaths}`,
  );
}
console.log(`totals: dug=${totalDug} ore=${totalOre} deaths=${totalDeaths}`);

console.log('\n--- sample observation (miner 0, fog-limited ascii) ---');
const obs = a.observe(0);
console.log(`pos=(${obs.self.pos.x},${obs.self.pos.y}) depth=${obs.self.depth} fuel=${obs.self.fuel}/${obs.self.maxFuel}`);
console.log(`legalActions: ${obs.legalActions.join(', ')}`);
console.log(obs.view.ascii);

// Basic assertions so the script exits non-zero on regression.
const ok = deterministic && totalDug > 0 && (snap.teamScore > 0 || totalOre > 0);
console.log(`\nRESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);
