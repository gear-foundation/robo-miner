// The off-chain world model + lobby decision logic.
//
// A "world" is one game instance running on one DiggerWorld program. Its on-chain
// session goes CREATED → ACTIVE → FINISHED; off-chain we track a slightly richer
// lifecycle so the operator can gather agents, start/finish sessions, archive a
// final snapshot, and recycle the same program with a fresh map.

export const WORLD = {
  PROVISIONING: 'provisioning', // deploying/funding the program + uploading the map
  OPEN: 'open', // registration window: agents can join, play has not started yet
  ACTIVE: 'active', // session running, ~30 min timer
  FINISHED: 'finished', // session ended, awaiting recycle/retire
  RETIRED: 'retired', // program released, not reused
  ARCHIVED: 'archived', // frozen snapshot of a completed session
};

let counter = 0;

export function newWorld(now) {
  counter += 1;
  return {
    id: `w${String(counter).padStart(3, '0')}`,
    status: WORLD.PROVISIONING,
    programId: null,
    seed: null,
    mapHash: null,
    sessionId: 0,
    agents: 0, // registered agent count (from chain agents() / sim)
    owners: [], // real on-chain owner ActorIds (World.Agents()) — who actually joined
    createdAt: now,
    openedAt: null,
    lastJoinAt: null,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
    eligibleManualStart: false,
    startReason: null,
  };
}

export function syncWorldCounter(worlds = []) {
  let max = counter;
  for (const world of worlds) {
    const match = /^w(\d+)$/i.exec(String(world?.id || ''));
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  counter = max;
}

// Should this open lobby start now? Two automatic triggers, plus the manual path:
//   • cap reached      → auto-start immediately.
//   • >= min and idle  → either auto-start (if configured) or become eligible for
//                        a manual start (operator decides).
export function decideStart(world, cfg, now) {
  const n = world.agents;
  if (n >= cfg.lobbyCap) return { start: true, reason: 'cap' };
  if (n >= cfg.lobbyMin) {
    const idle = now - (world.lastJoinAt ?? world.openedAt ?? now);
    if (idle >= cfg.lobbyTimeoutMs) {
      return cfg.autoStartOnTimeout
        ? { start: true, reason: 'timeout' }
        : { start: false, eligibleManual: true, reason: 'timeout-await-manual' };
    }
  }
  return { start: false };
}

// Public, registry-facing view of a world (what the frontend lobby ultimately needs).
export function worldView(world, cfg) {
  return {
    id: world.id,
    status: world.status,
    programId: world.programId,
    seed: world.seed,
    sessionId: world.sessionId,
    agents: world.agents,
    owners: world.owners || [],
    minAgents: cfg.lobbyMin,
    capAgents: cfg.lobbyCap,
    eligibleManualStart: world.eligibleManualStart,
    startReason: world.startReason,
    openedAt: world.openedAt,
    startedAt: world.startedAt,
    finishedAt: world.finishedAt,
    archivedAt: world.archivedAt ?? null,
    archiveId: world.archiveId ?? null,
    archiveUrl: world.archiveUrl ?? null,
  };
}
