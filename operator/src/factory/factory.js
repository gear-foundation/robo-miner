// The world factory — keeps a pool of DiggerWorld worlds cycling forever so there
// is always at least one open lobby for agents to join.
//
// It is driver-agnostic: the same state machine runs against a dry-run simulator
// (no chain) or a real @vara-eth/api chain driver. All chain side effects go
// through `driver`; the factory only owns the lifecycle + lobby rules.

import { WORLD, newWorld, decideStart, worldView } from './world.js';

const POOL_STATUSES = [WORLD.PROVISIONING, WORLD.OPEN, WORLD.ACTIVE];

export function createFactory({ driver, config, clock = Date.now, log = console.log, publish = null }) {
  const cfg = config;
  const worlds = new Map(); // id → world
  let running = false;
  let timer = null;

  const list = () => [...worlds.values()];
  const countOpen = () => list().filter((w) => w.status === WORLD.OPEN).length;
  const poolBusy = () => list().filter((w) => POOL_STATUSES.includes(w.status)).length;

  async function provisionOne() {
    const world = newWorld(clock());
    worlds.set(world.id, world);
    log(`[factory] + provisioning ${world.id}`);
    try {
      const provisioned = await driver.provision(world); // deploy+fund+Create OR pick a free pool program
      world.programId = provisioned.programId;
      const map = await driver.loadMap(world); // generate + UploadMap (→ CREATED)
      world.seed = map.seed;
      world.mapHash = map.mapHash;
      world.sessionId = map.sessionId ?? world.sessionId;
      if (!cfg.lobbyMode) {
        await driver.start(world); // instant-open: StartSession now so register() works
      } else {
        await driver.openLobby?.(world); // lobby-mode: register works in CREATED, nothing to do
      }
      world.status = WORLD.OPEN;
      world.openedAt = clock();
      world.lastJoinAt = world.openedAt;
      log(
        `[factory]   ${world.id} OPEN program=${world.programId} seed=${world.seed} ` +
          `(${cfg.lobbyMode ? 'lobby' : 'instant-open'})`,
      );
    } catch (error) {
      log(`[factory] ! ${world.id} provision failed: ${error?.message || error}`);
      worlds.delete(world.id);
    }
  }

  async function pollLobby(world) {
    const now = clock();
    const count = await driver.pollAgents(world);
    if (count > world.agents) {
      world.agents = count;
      world.lastJoinAt = now;
      log(`[factory]   ${world.id} agents ${count}/${cfg.lobbyCap}`);
    }
    const decision = decideStart(world, cfg, now);
    if (decision.eligibleManual && !world.eligibleManualStart) {
      world.eligibleManualStart = true;
      log(
        `[factory]   ${world.id} READY for manual start ` +
          `(${world.agents} agents, idle ≥ ${cfg.lobbyTimeoutMs}ms)`,
      );
    }
    if (decision.start) await startWorld(world, decision.reason);
  }

  async function startWorld(world, reason) {
    if (world.status !== WORLD.OPEN) return;
    if (world.agents < cfg.lobbyMin) {
      log(`[factory]   ${world.id} starting below min (${world.agents} < ${cfg.lobbyMin}) — reason=${reason}`);
    }
    if (cfg.lobbyMode) await driver.start(world); // instant-open already started at provision
    world.status = WORLD.ACTIVE;
    world.startedAt = clock();
    world.startReason = reason;
    log(
      `[factory] > ${world.id} START (${reason}) agents=${world.agents} → ` +
        `running ~${Math.round(cfg.sessionMs / 1000)}s`,
    );
  }

  async function tickActive(world) {
    if (clock() - world.startedAt >= cfg.sessionMs) {
      await driver.finish(world);
      world.status = WORLD.FINISHED;
      world.finishedAt = clock();
      log(
        `[factory] = ${world.id} FINISHED ` +
          `(ran ${Math.round((world.finishedAt - world.startedAt) / 1000)}s, ${world.agents} agents)`,
      );
    }
  }

  async function recycleWorld(world) {
    if (cfg.recycle && poolBusy() < cfg.poolSize) {
      const map = await driver.recycle(world); // reset_map → fresh map, agents cleared, → CREATED
      world.seed = map.seed;
      world.mapHash = map.mapHash;
      world.sessionId = map.sessionId ?? world.sessionId + 1;
      world.agents = 0;
      world.startedAt = null;
      world.finishedAt = null;
      world.eligibleManualStart = false;
      world.startReason = null;
      if (!cfg.lobbyMode) await driver.start(world);
      world.status = WORLD.OPEN;
      world.openedAt = clock();
      world.lastJoinAt = world.openedAt;
      log(`[factory] ↺ ${world.id} OPEN again (session ${world.sessionId}, program ${world.programId})`);
    } else {
      await driver.retire?.(world);
      world.status = WORLD.RETIRED;
      log(`[factory] x ${world.id} retired (program ${world.programId})`);
    }
  }

  async function tick() {
    // Invariant: keep at least minOpenWorlds open lobbies, bounded by pool capacity.
    while (countOpen() < cfg.minOpenWorlds && poolBusy() < cfg.poolSize) {
      await provisionOne();
    }
    for (const world of list()) {
      if (world.status === WORLD.OPEN) await pollLobby(world);
      else if (world.status === WORLD.ACTIVE) await tickActive(world);
      else if (world.status === WORLD.FINISHED) await recycleWorld(world);
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
      if (world) await startWorld(world, 'manual');
    },
    async start() {
      if (running) return;
      running = true;
      log(
        `[factory] starting · pool=${cfg.poolSize} minOpen=${cfg.minOpenWorlds} ` +
          `lobby=${cfg.lobbyMin}..${cfg.lobbyCap} timeout=${cfg.lobbyTimeoutMs}ms ` +
          `session=${cfg.sessionMs}ms mode=${cfg.lobbyMode ? 'lobby' : 'instant-open'}`,
      );
      const loop = async () => {
        if (!running) return;
        try {
          await tick();
        } catch (error) {
          log(`[factory] tick error: ${error?.message || error}`);
        }
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
