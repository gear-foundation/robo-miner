import { connectDiggerWorldChain } from '../../chain/diggerWorld.js';
import { generateMap, gridHash, randomSeed } from './genmap.js';
import {
  SESSION_ACTIVE,
  SESSION_CREATED,
  SESSION_FINISHED,
  sessionAutofinishEnabled,
  sessionMs,
} from './sessionTiming.js';

const WORLD_LIFECYCLE_STATUSES = new Set(['waiting_agents', 'active', 'finished']);

export class GameMasterLifecycleService {
  constructor({
    store,
    config,
    chainFactory = defaultChainFactory,
    now = () => new Date(),
    logger = console,
  }) {
    this.store = store;
    this.config = config;
    this.chainFactory = chainFactory;
    this.now = now;
    this.logger = logger;
  }

  async run({ dryRun = this.shouldDryRun() } = {}) {
    const now = this.now();
    const db = await this.store.read();
    const plans = db.worlds
      .filter((world) => shouldManageWorld(world))
      .map((world) => planWorldLifecycle(world, { config: this.config, now }));

    await this.applyLocalPatches(plans, now, dryRun);

    const actions = plans.flatMap((plan) => plan.actions.map((action) => ({ ...action, world: plan.world })));
    const actionable = actions.filter((action) => ['start', 'finish', 'recycle'].includes(action.type));
    if (!actionable.length) {
      return summarizeRun({ dryRun, plans, results: [] });
    }

    if (dryRun) {
      return summarizeRun({
        dryRun,
        plans,
        results: actionable.map((action) => ({
          ok: true,
          dryRun: true,
          action: action.type,
          worldId: action.world.id,
          programId: action.world.programId,
          reason: action.reason,
        })),
      });
    }

    let chain = null;
    const results = [];
    try {
      chain = await this.chainFactory(this.config);
      for (const action of actionable) {
        results.push(await this.performAction(chain, action));
      }
      return summarizeRun({ dryRun, plans, results });
    } finally {
      await chain?.disconnect?.();
    }
  }

  shouldDryRun() {
    return !this.config.adminKey;
  }

  async applyLocalPatches(plans, now, dryRun) {
    const patches = plans.filter((plan) => Object.keys(plan.patch).length > 0);
    const actionCount = plans.reduce((sum, plan) => sum + plan.actions.length, 0);
    if (!patches.length && !actionCount) return;

    await this.store.update((db) => {
      for (const plan of patches) {
        const world = findWorld(db, plan.world);
        if (!world) continue;
        applyPatch(world, plan.patch);
      }
      db.jobRuns.push({
        id: `gamemaster-lifecycle:${now.toISOString()}`,
        job: 'gamemaster-lifecycle',
        mode: dryRun ? 'dry-run' : 'live',
        startedAt: now.toISOString(),
        finishedAt: this.now().toISOString(),
        worlds: plans.length,
        actions: actionCount,
      });
    });
  }

  async performAction(chain, action) {
    const nowDate = this.now();
    const now = nowDate.toISOString();
    try {
      if (action.type === 'start') {
        await chain.sendAdmin(action.world.programId, chain.encode.startSession());
        await this.store.update((db) => {
          const world = findWorld(db, action.world);
          if (!world) return;
          const endsAt = sessionAutofinishEnabled(this.config)
            ? new Date(Date.parse(now) + sessionMs(world, this.config)).toISOString()
            : null;
          applyPatch(world, {
            status: 'active',
            session: { ...(world.session || {}), status: SESSION_ACTIVE },
            startsAt: now,
            endsAt,
            chain: { ...(world.chain || {}), startedAt: now },
            updatedAt: now,
          });
        });
        return actionResult(action, { ok: true });
      }

      if (action.type === 'finish') {
        await chain.sendAdmin(action.world.programId, chain.encode.finishSession());
        await this.store.update((db) => {
          const world = findWorld(db, action.world);
          if (!world) return;
          applyPatch(world, {
            status: 'finished',
            session: { ...(world.session || {}), status: SESSION_FINISHED },
            finishedAt: now,
            chain: { ...(world.chain || {}), finishedAt: now },
            updatedAt: now,
          });
        });
        return actionResult(action, { ok: true });
      }

      if (action.type === 'recycle') {
        await this.ensureArchive(chain, action.world, nowDate);
        const fresh = await uploadFreshMap(chain, action.world.programId, this.config);
        await this.store.update((db) => {
          const world = findWorld(db, action.world);
          if (!world) return;
          const chainState = { ...(world.chain || {}), generatedAt: now };
          delete chainState.startedAt;
          delete chainState.finishedAt;
          applyPatch(world, {
            status: 'waiting_agents',
            seed: fresh.seed,
            sessionId: fresh.sessionId,
            session: {
              id: String(fresh.sessionId),
              seed: fresh.seed,
              status: SESSION_CREATED,
              actionSeq: '0',
            },
            mapHash: fresh.mapHash,
            startsAt: now,
            endsAt: null,
            agents: 0,
            owners: [],
            finishedAt: null,
            archivedAt: null,
            archiveId: null,
            archiveUrl: null,
            chain: chainState,
            updatedAt: now,
          });
        });
        return actionResult(action, { ok: true, seed: fresh.seed, sessionId: fresh.sessionId });
      }

      return actionResult(action, { ok: false, error: `unknown action ${action.type}` });
    } catch (error) {
      this.logger.warn?.('gamemaster.lifecycle.action_failed', {
        action: action.type,
        worldId: action.world.id,
        programId: action.world.programId,
        error: error.message,
      });
      return actionResult(action, { ok: false, error: error.message });
    }
  }

  async ensureArchive(chain, worldRef, timestamp) {
    const existing = await this.store.read();
    const current = findWorld(existing, worldRef);
    if (!current) throw new Error(`world not found for archive: ${worldRef.id}`);
    if (current.archiveId && existing.archives.some((archive) => archive.archiveId === current.archiveId)) return current.archiveId;

    const snapshot = await readWorldSnapshot(chain, current.programId);
    let archiveId = null;
    await this.store.update((db) => {
      const world = findWorld(db, worldRef);
      if (!world) throw new Error(`world not found for archive: ${worldRef.id}`);
      archiveId = archiveCurrentWorld(db, world, snapshot, {
        config: this.config,
        timestamp,
      });
    });
    return archiveId;
  }
}

export function planWorldLifecycle(world, { config, now = new Date() }) {
  const status = normalizeWorldStatus(world);
  const nowMs = now.getTime();
  const patch = {};
  const actions = [];
  const ms = sessionMs(world, config);

  if (status === 'waiting_agents') {
    patch.endsAt = null;
    patch.finishedAt = null;
    const agents = Number(world.agents || 0);
    const minAgents = Number(world.minAgents || config.factoryLobbyMin || 0);
    if (
      config.factoryAutoStartAtMin &&
      agents >= minAgents
    ) {
      actions.push({ type: 'start', reason: 'lobby_min' });
    } else if (
      config.factoryAutoStartOnTimeout &&
      agents >= minAgents &&
      lobbyExpired(world, config, nowMs)
    ) {
      actions.push({ type: 'start', reason: 'lobby_timeout' });
    }
  }

  if (status === 'active') {
    const startedAt = activeStartedAt(world, now);
    const autofinish = sessionAutofinishEnabled(config);
    const endsAt = autofinish ? activeEndsAt(world, startedAt, ms) : null;
    patch.status = 'active';
    patch.startsAt = startedAt.toISOString();
    patch.endsAt = endsAt ? endsAt.toISOString() : null;
    patch.sessionMs = ms;
    patch.chain = {
      ...(world.chain || {}),
      startedAt: world.chain?.startedAt || startedAt.toISOString(),
    };
    if (endsAt && nowMs >= endsAt.getTime()) {
      actions.push({ type: 'finish', reason: 'session_expired' });
    }
  }

  if (status === 'finished') {
    const finishedAt = parseDate(world.finishedAt || world.chain?.finishedAt) || now;
    patch.status = 'finished';
    patch.finishedAt = finishedAt.toISOString();
    patch.chain = {
      ...(world.chain || {}),
      finishedAt: world.chain?.finishedAt || finishedAt.toISOString(),
    };
    if (config.factoryRecycle !== false && nowMs >= finishedAt.getTime() + recycleGraceMs(config)) {
      actions.push({ type: 'recycle', reason: 'finished_recycle' });
    }
  }

  return { world, status, patch: compactPatch(world, patch), actions };
}

async function defaultChainFactory(config) {
  return connectDiggerWorldChain({
    adminKey: config.adminKey,
    ethRpc: config.ethRpc,
    varaWs: config.varaEthWs,
    router: config.routerAddress,
    idlPath: config.diggerIdlPath,
    wasmPath: config.diggerWasmPath,
    timeoutMs: config.indexerTimeoutMs,
    wsReconnectAttempts: config.wsReconnectAttempts,
    wsReconnectDelay: config.wsReconnectDelay,
  });
}

async function uploadFreshMap(chain, programId, config) {
  let generated = null;
  for (let attempt = 0; attempt < 5 && !generated; attempt += 1) {
    const candidate = generateMap(randomSeed(), { contractSurface: config.contractSurface });
    if (candidate.valid) generated = candidate;
  }
  if (!generated) throw new Error('could not generate a valid map after 5 attempts');

  await chain.sendAdmin(programId, chain.encode.uploadMap(generated.seed, generated.map));
  const reply = await chain.query(programId, chain.encode.session());
  const session = chain.decode.session(reply.payload).map((value) => Number(value));
  return {
    seed: String(generated.seed),
    mapHash: gridHash(generated.map),
    sessionId: String(session[0] ?? ''),
  };
}

async function readWorldSnapshot(chain, programId) {
  const [configReply, sessionReply, mapReply, agentsReply] = await Promise.all([
    chain.query(programId, chain.encode.config()),
    chain.query(programId, chain.encode.session()),
    chain.query(programId, chain.encode.mapSnapshot()),
    chain.query(programId, chain.encode.agents()),
  ]);
  const config = chain.decode.config(configReply.payload).map((value) => Number(value));
  const session = chain.decode.session(sessionReply.payload).map((value) => String(value));
  const rawGrid = chain.decode.mapSnapshot(mapReply.payload).map((value) => Number(value));
  const owners = chain.decode.agents(agentsReply.payload).map(String);
  const agents = await Promise.all(owners.map(async (owner) => {
    const [stateReply, inventoryReply] = await Promise.all([
      chain.query(programId, chain.encode.agentOf(owner)),
      chain.query(programId, chain.encode.inventoryOf(owner)),
    ]);
    return {
      owner,
      state: chain.decode.agentOf(stateReply.payload).map((value) => Number(value)),
      inventory: chain.decode.inventoryOf(inventoryReply.payload).map((value) => Number(value)),
    };
  }));
  return {
    kind: 'world',
    programId,
    capturedAt: new Date().toISOString(),
    session,
    config,
    rawGrid,
    agents,
  };
}

function archiveCurrentWorld(db, world, snapshot, { config, timestamp }) {
  const archivedAt = timestamp.toISOString();
  const sessionId = String(world.sessionId ?? world.session?.id ?? snapshot.session?.[0] ?? 0);
  const archiveId = world.archiveId || `${world.id}-s${sessionId}`;
  const archiveUrl = archiveUrlFor(config, archiveId);
  const finishedAt = world.finishedAt || world.chain?.finishedAt || archivedAt;
  const archivePayload = {
    schemaVersion: 1,
    archiveId,
    worldId: world.id,
    id: world.id,
    status: 'archived',
    programId: world.programId || null,
    seed: world.seed ?? snapshot.session?.[1] ?? null,
    mapHash: world.mapHash || null,
    sessionId: Number(sessionId),
    agents: Number(world.agents || snapshot.agents?.length || 0),
    owners: Array.isArray(world.owners) ? world.owners : [],
    minAgents: world.minAgents ?? config.factoryLobbyMin ?? null,
    capAgents: world.targetAgents ?? config.factoryLobbyCap ?? null,
    createdAt: world.createdAt || null,
    openedAt: world.startsAt || null,
    startedAt: world.startsAt || world.chain?.startedAt || null,
    finishedAt,
    archivedAt,
    snapshot,
  };

  upsertByKey(db.archives, 'archiveId', archivePayload);
  upsertById(db.worlds, {
    id: archiveId,
    sourceWorldId: world.id,
    seasonId: world.seasonId,
    status: 'archived',
    deployMode: world.deployMode,
    programId: world.programId,
    seed: archivePayload.seed,
    network: world.network,
    router: world.router,
    startsAt: archivePayload.startedAt,
    endsAt: world.endsAt || finishedAt,
    sessionMs: world.sessionMs || config.sessionMs,
    agents: archivePayload.agents,
    minAgents: archivePayload.minAgents,
    targetAgents: archivePayload.capAgents,
    owners: archivePayload.owners,
    sessionId,
    mapHash: world.mapHash || null,
    map: world.map || null,
    snapshot: null,
    events: null,
    chain: { ...(world.chain || {}), finishedAt },
    finishedAt,
    archivedAt,
    archiveId,
    archiveUrl,
    sourceUpdatedAt: world.updatedAt || null,
    updatedAt: archivedAt,
    createdAt: world.createdAt || archivedAt,
  });
  world.archiveId = archiveId;
  world.archiveUrl = archiveUrl;
  world.archivedAt = archivedAt;
  return archiveId;
}

function archiveUrlFor(config, archiveId) {
  const path = `/api/archives/${encodeURIComponent(archiveId)}`;
  const base = String(config.backendPublicUrl || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

function upsertByKey(items, key, next) {
  const index = items.findIndex((item) => item[key] === next[key]);
  if (index === -1) items.push(next);
  else items[index] = { ...items[index], ...next };
}

function upsertById(items, next) {
  upsertByKey(items, 'id', next);
}

function shouldManageWorld(world) {
  return Boolean(world?.programId && WORLD_LIFECYCLE_STATUSES.has(normalizeWorldStatus(world)));
}

function normalizeWorldStatus(world) {
  const statusCode = Number(world?.session?.status);
  if (statusCode === SESSION_CREATED) return 'waiting_agents';
  if (statusCode === SESSION_ACTIVE) return 'active';
  if (statusCode === SESSION_FINISHED) return 'finished';
  return world?.status || 'waiting_agents';
}

function activeStartedAt(world, now) {
  return parseDate(world.chain?.startedAt) || parseDate(world.startsAt) || now;
}

function activeEndsAt(world, startedAt, ms) {
  return parseDate(world.endsAt) || new Date(startedAt.getTime() + ms);
}

function lobbyExpired(world, config, nowMs) {
  const startedAt = parseDate(world.startsAt || world.createdAt || world.updatedAt);
  if (!startedAt) return false;
  return nowMs >= startedAt.getTime() + Number(config.factoryLobbyTimeoutMs || 0);
}

function recycleGraceMs(config) {
  return Number(config.factoryRecycleGraceMs ?? 5_000);
}

function parseDate(value) {
  const ts = Date.parse(value || '');
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function compactPatch(world, patch) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => !deepEqual(world[key], value)),
  );
}

function deepEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function applyPatch(world, patch) {
  Object.assign(world, patch);
}

function findWorld(db, target) {
  return db.worlds.find((world) => world.id === target.id)
    || db.worlds.find((world) => sameProgram(world.programId, target.programId));
}

function sameProgram(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function summarizeRun({ dryRun, plans, results }) {
  return {
    mode: dryRun ? 'dry-run' : 'live',
    worlds: plans.length,
    actions: results.length,
    planned: plans.reduce((sum, plan) => sum + plan.actions.length, 0),
    results,
  };
}

function actionResult(action, extra) {
  return {
    action: action.type,
    worldId: action.world.id,
    programId: action.world.programId,
    reason: action.reason,
    ...extra,
  };
}
