// Demo: drive the squad through the pluggable runner and measure decision
// latency + tick-deadline misses — a stand-in for "will a real LLM keep up?".
//   node src/engine/runner-demo.mjs   (from the frontend/ directory)
//
// A couple of agents are wrapped with simulated "thinking" latency to act like
// slow async LLM calls; with a tick deadline set, the runner reports how often
// they miss the tick (and therefore idle that turn). Scripted and async agents
// use the identical decide(obs) contract.

import { Match } from './match.js';
import { createSquad } from './agents.js';
import { runMatch, formatLatency } from './runner.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap an agent so its decision takes ~ms (simulating model latency).
function withLatency(agent, ms) {
  return { ...agent, name: `${agent.name}*`, decide: async (obs) => { await sleep(ms); return agent.decide(obs); } };
}

const roster = createSquad({ shuttle: 4, prospector: 3, deepdiver: 2, idler: 1 });
// Make two agents "slow thinkers": one comfortably inside the deadline, one over.
roster[0] = withLatency(roster[0], 6);   // ~6ms  → fine
roster[4] = withLatency(roster[4], 22);  // ~22ms → misses a 15ms deadline

const match = new Match({
  seed: 2024,
  spawn: 'wide',
  safeFall: 8,
  miners: roster.map((a) => ({ name: a.name, hat: a.hat, color: a.color, items: a.items || undefined })),
});

const DEADLINE_MS = 15;
console.log(`=== RUNNER DEMO  agents=${roster.length}  deadline=${DEADLINE_MS}ms ===`);

const result = await runMatch(match, roster, { maxTicks: 150, deadlineMs: DEADLINE_MS });

console.log(`\nran ${result.ticks} ticks in ${result.wallMs.toFixed(0)}ms wall ` +
  `(~${(result.wallMs / result.ticks).toFixed(1)}ms/tick)`);
console.log('\n' + formatLatency(roster, result.latency));
console.log(`\nteam score: $${match.state.teamScore}  (slow agents that miss the deadline simply WAIT that tick)`);
