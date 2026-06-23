// The world factory — keeps a pool of DiggerWorld worlds cycling forever so there
// is always at least one open lobby for agents to join.
//
// It is driver-agnostic: the same state machine runs against a dry-run simulator
// (no chain) or a real @vara-eth/api chain driver. All chain side effects go
// through `driver`; the factory only owns the lifecycle + lobby rules.

import { WORLD, newWorld, syncWorldCounter, decideStart, worldView } from './world.js';

const POOL_STATUSES = [WORLD.PROVISIONING, WORLD.OPEN, WORLD.ACTIVE];
const SESSION_FINISHED = 2;

export function createFactory({
  driver,
  config,
  clock = Date.now,
  log = console.log,
  publish = null,
  initialLive = [], // open/active/finished worlds restored after an operator restart
  initialPast = [], // archived worlds restored from disk (survive restarts)
  onLive = null, // persist callback whenever the live pool changes
  onPast = null, // persist callback whenever the past list changes
  onArchive = null, // persist a frozen chain snapshot before a program is recycled
}) {
  const cfg = config;
  syncWorldCounter(initialLive);
  const worlds = new Map(initialLive.map((world) => [world.id, world])); // id → world
  const pastStore = [...initialPast]; // retired worlds, kept for the PAST tab
  let running = false;
  let timer = null;

  const active = () => [...worlds.values()];
  const list = () => [...worlds.values(), ...pastStore]; // live + past (for publish/snapshot)
  const countOpen = () => active().filter((w) => w.status === WORLD.OPEN).length;
  const poolBusy = () => active().filter((w) => POOL_STATUSES.includes(w.status)).length;
  const poolHasCapacity = () => cfg.poolSize === 0 || poolBusy() < cfg.poolSize;

  async function persistLive() {
    try { await onLive?.(active()); }
    catch (error) { log(`[factory] live persist error: ${error?.message || error}`); }
  }

  async function persistPast() {
    try { await onPast?.(pastStore); }
    catch (error) { log(`[factory] past persist error: ${error?.message || error}`); }
  }

  async function archiveFinishedWorld(world) {
    if (world.archiveId) return true;
    if (!onArchive) return true;
    try {
      const archive = await onArchive(world);
      if (archive?.archiveId) {
        world.archiveId = archive.archiveId;
        world.archiveUrl = archive.archiveUrl || `/archives/${archive.archiveId}`;
        world.archivedAt = archive.archivedAt || clock();
        log(`[factory]   ${world.id} snapshot saved ${world.archiveId}`);
        await persistLive();
      }
      return true;
    } catch (error) {
      log(`[factory] ! ${world.id} snapshot failed: ${error?.message || error}`);
      return false;
    }
  }

  async function pushPastSnapshot(world) {
    if (world.archiveId && pastStore.some((past) => past.archiveId === world.archiveId)) return;
    pastStore.push({
      ...world,
      status: WORLD.ARCHIVED,
      finishedAt: world.finishedAt || clock(),
      archivedAt: world.archivedAt || clock(),
    });
    const limit = cfg.pastLimit || 50;
    while (pastStore.length > limit) pastStore.shift();
    await persistPast();
  }

  async function provisionOne() {
    const world = newWorld(clock());
    worlds.set(world.id, world);
    await persistLive();
    log(`[factory] + provisioning ${world.id}`);
    try {
      const provisioned = await driver.provision(world); // deploy+fund+Create OR pick a free pool program
      world.programId = provisioned.programId;
      const map = await driver.loadMap(world); // generate + UploadMap (→ CREATED)
      world.seed = map.seed;
      world.mapHash = map.mapHash;
      world.sessionId = map.sessionId ?? world.sessionId;
      if (!cfg.lobbyMode) {
        await driver.start(world); // prestarted mode: only valid for contracts that allow late join
      } else {
        await driver.openLobby?.(world); // current contract: Register works only in CREATED
      }
      world.status = WORLD.OPEN;
      world.openedAt = clock();
      world.lastJoinAt = world.openedAt;
      log(
        `[factory]   ${world.id} OPEN program=${world.programId} seed=${world.seed} ` +
          `(${cfg.lobbyMode ? 'registration' : 'prestarted'})`,
      );
      await persistLive();
    } catch (error) {
      log(`[factory] ! ${world.id} provision failed: ${error?.message || error}`);
      worlds.delete(world.id);
      await persistLive();
    }
  }

  async function pollLobby(world) {
    const now = clock();
    const owners = await driver.pollAgents(world);
    const count = Array.isArray(owners) ? owners.length : owners;
    if (Array.isArray(owners)) world.owners = owners; // keep real participant list fresh
    if (count > world.agents) {
      world.agents = count;
      world.lastJoinAt = now;
      log(`[factory]   ${world.id} agents ${count}/${cfg.lobbyCap}`);
      await persistLive();
    }
    const decision = decideStart(world, cfg, now);
    if (decision.eligibleManual && !world.eligibleManualStart) {
      world.eligibleManualStart = true;
      log(
        `[factory]   ${world.id} READY for manual start ` +
          `(${world.agents} agents, idle ≥ ${cfg.lobbyTimeoutMs}ms)`,
      );
      await persistLive();
    }
    if (decision.start) await startWorld(world, decision.reason);
  }

  async function startWorld(world, reason) {
    if (world.status !== WORLD.OPEN) return;
    if (world.agents < cfg.lobbyMin) {
      log(`[factory]   ${world.id} starting below min (${world.agents} < ${cfg.lobbyMin}) — reason=${reason}`);
    }
    if (cfg.lobbyMode) await driver.start(world); // registration mode: StartSession moves CREATED → ACTIVE
    world.status = WORLD.ACTIVE;
    world.startedAt = clock();
    world.startReason = reason;
    const runLabel = cfg.sessionAutofinish && cfg.sessionMs > 0
      ? `running ~${Math.round(cfg.sessionMs / 1000)}s`
      : 'running until admin/contract finish';
    log(
      `[factory] > ${world.id} START (${reason}) agents=${world.agents} → ` +
        runLabel,
    );
    await persistLive();
  }

  async function tickActive(world) {
    if (typeof driver.pollSession === 'function') {
      const session = await driver.pollSession(world);
      if (session?.sessionId != null) world.sessionId = session.sessionId;
      if (session?.seed != null) world.seed = String(session.seed);
      if (Number(session?.status) === SESSION_FINISHED) {
        world.status = WORLD.FINISHED;
        world.finishedAt = clock();
        log(`[factory] = ${world.id} FINISHED by contract session status`);
        await persistLive();
        return;
      }
    }
    if (!cfg.sessionAutofinish || Number(cfg.sessionMs) <= 0) return;
    if (clock() - world.startedAt >= cfg.sessionMs) {
      await driver.finish(world);
      world.status = WORLD.FINISHED;
      world.finishedAt = clock();
      log(
        `[factory] = ${world.id} FINISHED ` +
          `(ran ${Math.round((world.finishedAt - world.startedAt) / 1000)}s, ${world.agents} agents)`,
      );
      await persistLive();
    }
  }

  async function recycleWorld(world) {
    const archived = await archiveFinishedWorld(world);
    if (!archived) return;
    await pushPastSnapshot(world);

    if (cfg.recycle) {
      const map = await driver.recycle(world); // reset_map → fresh map, agents cleared, → CREATED
      world.seed = map.seed;
      world.mapHash = map.mapHash;
      world.sessionId = map.sessionId ?? world.sessionId + 1;
      world.agents = 0;
      world.owners = [];
      world.startedAt = null;
      world.finishedAt = null;
      world.archivedAt = null;
      world.archiveId = null;
      world.archiveUrl = null;
      world.eligibleManualStart = false;
      world.startReason = null;
      if (!cfg.lobbyMode) await driver.start(world);
      world.status = WORLD.OPEN;
      world.openedAt = clock();
      world.lastJoinAt = world.openedAt;
      log(`[factory] ↺ ${world.id} OPEN again (session ${world.sessionId}, program ${world.programId})`);
      await persistLive();
    } else {
      await driver.retire?.(world);
      world.status = WORLD.RETIRED;
      world.finishedAt = world.finishedAt || clock();
      worlds.delete(world.id); // move out of the live map into the durable past list
      await persistLive();
      log(`[factory] x ${world.id} retired → PAST (${pastStore.length} kept) program=${world.programId}`);
    }
  }

  async function tick() {
    for (const world of active()) {
      if (world.status === WORLD.OPEN) {
        driver.ensureBalance?.(world); // proactive top-up so the open world stays fundable
        await pollLobby(world);
      } else if (world.status === WORLD.ACTIVE) {
        driver.ensureBalance?.(world); // keep the running session funded (agents pay from it)
        await tickActive(world);
      }
      if (world.status === WORLD.FINISHED) {
        await recycleWorld(world);
      }
    }
    // Recycle/restore existing programs before provisioning. Otherwise a just
    // finished world temporarily drops the open-lobby count and the factory pays
    // to create a replacement program instead of resetting the same contract.
    while (countOpen() < cfg.minOpenWorlds && poolHasCapacity()) {
      await provisionOne();
    }
    // Publish the world list for the colleague's World Registry to serve (gamemaster.json).
    if (publish) {
      try {
        await publish(list());
      } catch (error) {
        log(`[factory] publish error: ${error?.message || error}`);
      }
    }
  }

  return {
    config: cfg,
    worlds: list,
    snapshot: () => list().map((w) => worldView(w, cfg)),
    // Operator override: start a specific open lobby by hand (the "запускаем руками" path).
    startManual: async (id) => {
      const world = worlds.get(id);
      if (world) {
        await startWorld(world, 'manual');
        await persistLive();
      }
    },
    async start() {
      if (running) return;
      running = true;
      log(
        `[factory] starting · pool=${cfg.poolSize === 0 ? 'elastic' : cfg.poolSize} minOpen=${cfg.minOpenWorlds} ` +
          `lobby=${cfg.lobbyMin}..${cfg.lobbyCap} startAtMin=${cfg.autoStartAtMin} timeout=${cfg.lobbyTimeoutMs}ms ` +
          `session=${cfg.sessionAutofinish ? `${cfg.sessionMs}ms` : 'manual'} mode=${cfg.lobbyMode ? 'registration' : 'prestarted'}`,
      );
      if (initialLive.length) {
        log(`[factory] restored ${initialLive.length} live world(s) from disk`);
        await persistLive();
      }
      const loop = async () => {
        if (!running) return;
        try {
          await tick();
        } catch (error) {
          log(`[factory] tick error: ${error?.message || error}`);
        }
        await persistLive();
        timer = setTimeout(loop, cfg.tickMs);
      };
      await loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
