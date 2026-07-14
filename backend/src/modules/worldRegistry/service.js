import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { worldIdentity } from './identity.js';

const ACTIVE_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'active']);
const PAST_STATUSES = new Set(['finished', 'archived']);

export class WorldRegistryService {
  constructor({ store, config, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  async syncFromGameMaster({ registryFile = null } = {}) {
    const file = registryFile || path.join(this.config.stateDir, 'gamemaster.json');
    const source = await readJson(file, null);
    const sourceWorlds = Array.isArray(source?.worlds) ? source.worlds : [];
    return this.syncWorldRecords(sourceWorlds, { source: file, mode: 'local' });
  }

  async syncWorldRecords(sourceWorlds, { source = 'memory', mode = 'memory' } = {}) {
    const season = this.makeSeason(sourceWorlds);
    const syncedAt = this.now().toISOString();

    await this.store.update((db) => {
      upsertById(db.seasons, {
        ...season,
        updatedAt: syncedAt,
      });

      for (const world of sourceWorlds) {
        const existing = db.worlds.find((item) => item.id === world.id) || null;
        upsertById(db.worlds, normalizeWorld(world, season.id, syncedAt, existing));
      }

      db.jobRuns.push({
        id: `world-registry-sync:${syncedAt}`,
        job: 'world-registry-sync',
        mode,
        source,
        startedAt: syncedAt,
        finishedAt: this.now().toISOString(),
        worlds: sourceWorlds.length,
        seasonId: season.id,
      });
    });

    return this.getManifest();
  }

  async getCurrentSeason() {
    await this.ensureConfiguredWorlds();
    const db = await this.store.read();
    return pickCurrentSeason(db.seasons, this.now) || this.makeSeason(db.worlds);
  }

  async getLiveWorlds() {
    await this.ensureConfiguredWorlds();
    const db = await this.store.read();
    return resolveLiveWorlds(db.worlds).worlds
      .filter((world) => ACTIVE_STATUSES.has(world.status))
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  }

  async getManifest() {
    await this.ensureConfiguredWorlds();
    const db = await this.store.read();
    const season = pickCurrentSeason(db.seasons, this.now) || this.makeSeason(db.worlds);
    const resolved = resolveLiveWorlds(db.worlds);
    const worlds = [...resolved.worlds].sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      season,
      active: worlds.filter((world) => ACTIVE_STATUSES.has(world.status)).map(publicWorld),
      past: worlds.filter((world) => PAST_STATUSES.has(world.status)).map(publicWorld),
      worlds: worlds.map(publicWorld),
      diagnostics: { worldProgramCollisions: resolved.collisions },
    };
  }

  async ensureConfiguredWorlds() {
    const programIds = this.config.worldProgramIds || [];
    if (!programIds.length) return;
    const existing = await this.store.read();
    const missing = programIds
      .map((programId, index) => ({ programId, index }))
      .filter(({ programId }) => !existing.worlds.some((world) => sameProgram(world.programId, programId)));
    if (!missing.length) return;

    const now = this.now().toISOString();
    const seasonId = this.config.diggerRentalSeason || 'season-1';

    await this.store.update((db) => {
      let added = 0;
      for (const { index, programId } of missing) {
        if (db.worlds.some((world) => sameProgram(world.programId, programId))) continue;
        db.worlds.push(configuredWorldRecord({
          index,
          programId,
          seasonId,
          config: this.config,
          now,
        }));
        added += 1;
      }
      if (!added) return;

      upsertById(db.seasons, {
        ...this.makeSeason(db.worlds),
        id: seasonId,
        slug: seasonId,
        updatedAt: now,
      });
      db.jobRuns.push({
        id: `world-registry-configured:${now}`,
        job: 'world-registry-configured',
        mode: 'env',
        source: 'INDEXER_WORLD_PROGRAM_IDS',
        startedAt: now,
        finishedAt: now,
        worlds: added,
        seasonId,
      });
    });
  }

  makeSeason(worlds) {
    const seasonId = this.config.diggerRentalSeason || 'season-1';
    const starts = worlds.map((world) => Date.parse(world.startsAt)).filter(Number.isFinite);
    const ends = worlds.map((world) => Date.parse(world.endsAt)).filter(Number.isFinite);
    return {
      id: seasonId,
      slug: seasonId,
      status: 'active',
      startsAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      endsAt: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      config: {
        diggerDailyExecTarget: this.config.diggerDailyExecTarget.toString(),
        network: this.config.network,
        router: this.config.routerAddress,
        sessionAutofinish: Boolean(this.config.factorySessionAutofinish),
      },
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
  }
}

export function resolveLiveWorlds(worlds) {
  const byProgram = new Map();
  for (const world of worlds) {
    if (!ACTIVE_STATUSES.has(world.status) || !world.programId) continue;
    const key = String(world.programId).toLowerCase();
    const group = byProgram.get(key) || [];
    group.push(world);
    byProgram.set(key, group);
  }
  const dropped = new Set();
  const collisions = [];
  for (const [programId, group] of byProgram) {
    if (group.length < 2) continue;
    const ranked = [...group].sort(compareLiveWorldFreshness);
    const winner = ranked[0];
    const runnerUp = ranked[1];
    if (sameFreshness(winner, runnerUp)) {
      for (const world of group) dropped.add(world.id);
      collisions.push({ programId, resolution: 'omitted_tie', keptWorldId: null, droppedWorldIds: group.map((world) => world.id) });
    } else {
      for (const world of ranked.slice(1)) dropped.add(world.id);
      collisions.push({ programId, resolution: 'kept_newest', keptWorldId: winner.id, droppedWorldIds: ranked.slice(1).map((world) => world.id) });
    }
  }
  return { worlds: worlds.filter((world) => !dropped.has(world.id)), collisions };
}

function compareLiveWorldFreshness(left, right) {
  return freshness(right.sourceUpdatedAt) - freshness(left.sourceUpdatedAt)
    || freshness(right.startsAt) - freshness(left.startsAt)
    || String(left.id).localeCompare(String(right.id));
}

function sameFreshness(left, right) {
  return freshness(left.sourceUpdatedAt) === freshness(right.sourceUpdatedAt)
    && freshness(left.startsAt) === freshness(right.startsAt);
}

function freshness(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

export function pickCurrentSeason(seasons, now = () => new Date()) {
  const ts = now().getTime();
  return [...seasons]
    .filter((season) => season.status === 'active')
    .sort((a, b) => String(b.startsAt || '').localeCompare(String(a.startsAt || '')))
    .find((season) => {
      const starts = season.startsAt ? Date.parse(season.startsAt) : -Infinity;
      const ends = season.endsAt ? Date.parse(season.endsAt) : Infinity;
      return starts <= ts && ts <= ends;
    }) || seasons.find((season) => season.status === 'active') || null;
}

function normalizeWorld(world, seasonId, syncedAt, existing = null) {
  const identity = worldIdentity(world);
  const factoryOwners = Array.isArray(world.admission?.registeredAgents)
    ? world.admission.registeredAgents
    : [];
  const factoryRegisteredAgents = factoryOwners.length;
  const preserveChainState = hasCurrentChainState(existing, world);
  const activeAgents = preserveChainState
    ? numberOr(existing.activeAgents, numberOr(existing.agents, 0))
    : numberOr(world.activeAgents, 0);
  const registeredAgents = preserveChainState
    ? numberOr(existing.registeredAgents, Array.isArray(existing.owners) ? existing.owners.length : 0)
    : factoryRegisteredAgents;
  return {
    id: world.id,
    ...identity,
    seasonId,
    status: preserveChainState ? existing.status : world.status,
    deployMode: world.deployMode || 'dry-run',
    codeId: world.codeId || null,
    programId: world.programId || null,
    seed: String(world.seed ?? ''),
    network: world.network || null,
    router: world.router || null,
    startsAt: world.startsAt || null,
    endsAt: world.endsAt || null,
    sessionMs: world.sessionMs || null,
    sessionAutofinish: Boolean(world.sessionAutofinish),
    agents: activeAgents,
    activeAgents,
    registeredAgents,
    minAgents: world.admission?.minAgents || 0,
    targetAgents: world.admission?.targetAgents || 0,
    owners: preserveChainState ? (existing.owners || []) : factoryOwners,
    activeOwners: preserveChainState ? (existing.activeOwners || []) : [],
    sessionId: preserveChainState ? existing.sessionId : (world.sessionId ?? null),
    mapHash: world.map?.hash || null,
    map: world.paths?.map || null,
    snapshot: world.paths?.snapshot || null,
    events: world.paths?.events || null,
    chain: preserveChainState ? { ...(world.chain || {}), ...(existing.chain || {}) } : (world.chain || {}),
    chainUpdatedAt: preserveChainState ? existing.chainUpdatedAt : null,
    finishedAt: world.finishedAt || world.chain?.finishedAt || null,
    archivedAt: world.archivedAt || null,
    archiveId: world.archiveId || null,
    archiveUrl: world.archiveUrl || null,
    sourceUpdatedAt: world.updatedAt || null,
    updatedAt: syncedAt,
  };
}

function publicWorld(world) {
  const identity = worldIdentity(world);
  return {
    id: world.id,
    ...identity,
    seasonId: world.seasonId,
    status: world.status,
    deployMode: world.deployMode,
    codeId: world.codeId || null,
    programId: world.programId,
    seed: world.seed,
    network: world.network,
    router: world.router,
    startsAt: world.startsAt,
    endsAt: world.endsAt,
    sessionMs: world.sessionMs,
    sessionAutofinish: Boolean(world.sessionAutofinish),
    agents: world.agents,
    activeAgents: numberOr(world.activeAgents, numberOr(world.agents, 0)),
    registeredAgents: numberOr(world.registeredAgents, Array.isArray(world.owners) ? world.owners.length : 0),
    minAgents: world.minAgents,
    targetAgents: world.targetAgents,
    owners: world.owners || [],
    sessionId: world.sessionId ?? null,
    mapHash: world.mapHash,
    map: world.map,
    snapshot: world.snapshot,
    events: world.events,
    finishedAt: world.finishedAt || null,
    archivedAt: world.archivedAt || null,
    archiveId: world.archiveId || null,
    archiveUrl: world.archiveUrl || null,
  };
}

function configuredWorldRecord({ index, programId, seasonId, config, now }) {
  return {
    id: `configured-world-${index + 1}`,
    seasonId,
    status: 'waiting_agents',
    deployMode: 'live',
    programId,
    seed: '',
    network: config.network || null,
    router: config.routerAddress || null,
    startsAt: now,
    endsAt: null,
    sessionMs: config.sessionMs || 30 * 60 * 1000,
    sessionAutofinish: Boolean(config.factorySessionAutofinish),
    agents: 0,
    activeAgents: 0,
    registeredAgents: 0,
    minAgents: config.factoryLobbyMin || 1,
    targetAgents: config.factoryLobbyCap || 10,
    owners: [],
    activeOwners: [],
    sessionId: null,
    mapHash: null,
    map: null,
    snapshot: null,
    events: null,
    chain: {},
    chainUpdatedAt: null,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
    sourceUpdatedAt: null,
    updatedAt: now,
    createdAt: now,
  };
}

function sameProgram(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function hasCurrentChainState(existing, source) {
  if (!existing?.chainUpdatedAt || !sameProgram(existing.programId, source.programId)) return false;
  const existingSessionId = sessionIdOf(existing);
  const sourceSessionId = sessionIdOf(source);
  return existingSessionId !== null && sourceSessionId !== null && existingSessionId === sourceSessionId;
}

function sessionIdOf(world) {
  const value = world?.sessionId ?? world?.session?.id ?? null;
  return value === null || value === undefined ? null : String(value);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function upsertById(items, next) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) items.push(next);
  else items[index] = { ...items[index], ...next };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
