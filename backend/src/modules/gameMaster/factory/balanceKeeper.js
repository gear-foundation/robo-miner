// Proactive executable-balance keeper.
//
// The program pays for every injected agent action out of its executable balance;
// when it hits zero, actions silently fail (surface as a contract "panic") and the
// world stalls. This watches each live world and tops it up BEFORE it runs dry —
// accounting for the ~90s validator lag before a top-up actually lands.
//
// Tuning from measured economics (10 busy agents): ~0.057 VARA/action, ~0.56
// VARA/s. Defaults: top up +400 VARA whenever balance dips under 150 VARA (~4.5
// min of runway at full tilt), with a cooldown ≥ the top-up lag so we never stack
// redundant top-ups while one is still settling. The live 10-agent stream is
// bursty enough that the defaults are intentionally conservative.

const VARA = 1_000_000_000_000n; // 1 VARA in wei
const toVara = (wei) => Number(wei) / 1e12;

export function createBalanceKeeper({ chain, log = console.log, clock = Date.now, options = {} }) {
  const checkMs = options.checkMs ?? 30_000;
  const cooldownMs = options.cooldownMs ?? 120_000; // ≥ the ~90s top-up lag
  const minVara = options.minVara ?? 700;
  const topUpVara = options.topUpVara ?? 1200;
  const minWei = BigInt(Math.round(minVara)) * VARA;
  const topUpWei = BigInt(Math.round(topUpVara)) * VARA;

  const state = new Map(); // programId → { lastCheckAt, lastTopUpAt, busy, lastEb }
  let topUpQueue = Promise.resolve();
  const stateFor = (programId) => {
    let s = state.get(programId);
    if (!s) { s = { lastCheckAt: 0, lastTopUpAt: 0, busy: false, lastEb: null }; state.set(programId, s); }
    return s;
  };

  function enqueueTopUp(fn) {
    const run = topUpQueue.then(fn, fn);
    topUpQueue = run.catch(() => {});
    return run;
  }

  async function check(programId, s) {
    const eb = await chain.readExecutableBalance(programId);
    s.lastEb = eb;
    const now = clock();
    if (eb < minWei && now - s.lastTopUpAt >= cooldownMs) {
      log(`[balance] ${programId} ${toVara(eb).toFixed(1)} VARA < ${minVara} → top up +${topUpVara} VARA`);
      await enqueueTopUp(() => chain.topUpExecutableBalance(programId, topUpWei));
      s.lastTopUpAt = clock();
      log(`[balance] ${programId} top-up sent (+${topUpVara} VARA, applies in ~90s)`);
    }
  }

  return {
    // Non-blocking: throttles internally (one network read per `checkMs`) and runs
    // the read + any top-up in the background, so the factory tick never waits on
    // a balance transaction.
    ensure(programId) {
      if (!programId) return;
      const s = stateFor(programId);
      const now = clock();
      if (s.busy || now - s.lastCheckAt < checkMs) return;
      s.lastCheckAt = now;
      s.busy = true;
      check(programId, s)
        .catch((e) => log(`[balance] ${programId} check failed: ${e?.message || e}`))
        .finally(() => { s.busy = false; });
    },
    // Force an immediate check (await it) — used right after provisioning so a
    // fresh world is funded to operating level without waiting for the throttle.
    async ensureNow(programId) {
      if (!programId) return;
      const s = stateFor(programId);
      if (s.busy) return;
      s.busy = true;
      s.lastCheckAt = clock();
      try { await check(programId, s); }
      catch (e) { log(`[balance] ${programId} check failed: ${e?.message || e}`); }
      finally { s.busy = false; }
    },
    snapshot() {
      return [...state.entries()].map(([programId, s]) => ({
        programId,
        executableVara: s.lastEb == null ? null : toVara(s.lastEb),
        lastTopUpAt: s.lastTopUpAt || null,
      }));
    },
  };
}
