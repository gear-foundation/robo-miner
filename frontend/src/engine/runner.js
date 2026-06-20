// Pluggable match runner. Drives any roster of agents against a Match in
// lockstep and measures per-agent decision latency, so a real (async) LLM agent
// plugs in exactly like a scripted bot and we can see whether the model keeps up
// at a given tick cadence.
//
// This is a HARNESS, not part of the deterministic engine core — it is allowed
// to read a wall clock (the engine itself never does). The simulation stays
// deterministic; only the *timing measurements* depend on real time.
//
// Local test-agent shape: an object indexed so agents[minerId] drives miner
// `minerId` with a controller callback.

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function emptyLatency() {
  return { decisions: 0, totalMs: 0, maxMs: 0, missed: 0, errors: 0 };
}

/**
 * Run a match to completion (or maxTicks).
 * @param {Match}  match
 * @param {Array}  agents              local scripted controllers by miner id
 * @param {object} [opts]
 * @param {number} [opts.maxTicks=4000]
 * @param {number} [opts.deadlineMs=Infinity]  a decision slower than this is
 *                                             dropped to WAIT for that tick
 * @param {function} [opts.onSnapshot]  (match, tick) => void, every snapshotEvery
 * @param {number} [opts.snapshotEvery]
 * @returns {Promise<{ticks, latency: Array, wallMs}>}
 */
export async function runMatch(match, agents, opts = {}) {
  const { maxTicks = 4000, deadlineMs = Infinity, onSnapshot, snapshotEvery } = opts;
  const latency = agents.map(emptyLatency);
  const start = clock();

  for (let t = 0; t < maxTicks && !match.finished; t++) {
    // All agents decide from the SAME pre-tick observation, concurrently — that
    // is the lockstep guarantee. Slow agents only cost themselves tempo.
    const decisions = await Promise.all(
      match.minerIds.map(async (id) => {
        const obs = match.observe(id);
        const t0 = clock();
        let action;
        try {
          action = await agents[id].decide(obs);
        } catch {
          latency[id].errors++;
          action = { type: 'WAIT' };
        }
        const dt = clock() - t0;
        const L = latency[id];
        L.decisions++;
        L.totalMs += dt;
        if (dt > L.maxMs) L.maxMs = dt;
        if (dt > deadlineMs) {
          L.missed++;
          action = { type: 'WAIT' }; // missed the tick deadline → idle this tick
        }
        return { id, action };
      }),
    );
    for (const d of decisions) match.submitAction(d.id, d.action);
    match.advance();
    if (onSnapshot && snapshotEvery && (t + 1) % snapshotEvery === 0) {
      onSnapshot(match, match.tick);
    }
  }

  return { ticks: match.tick, latency, wallMs: clock() - start };
}

/** Pretty per-agent latency summary. */
export function formatLatency(agents, latency) {
  const lines = ['agent           decisions  avg(ms)  max(ms)  missed  errors'];
  for (let i = 0; i < agents.length; i++) {
    const L = latency[i];
    const avg = L.decisions ? (L.totalMs / L.decisions) : 0;
    lines.push(
      `${(agents[i].name || `agent-${i}`).padEnd(14)} ` +
      `${String(L.decisions).padStart(9)}  ${avg.toFixed(2).padStart(7)}  ${L.maxMs.toFixed(2).padStart(7)}  ` +
      `${String(L.missed).padStart(6)}  ${String(L.errors).padStart(6)}`,
    );
  }
  return lines.join('\n');
}
