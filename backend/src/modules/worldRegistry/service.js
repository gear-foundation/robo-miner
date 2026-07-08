import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
        upsertById(db.worlds, normalizeWorld(world, season.id, syncedAt));
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
    return db.worlds
      .filter((world) => ACTIVE_STATUSES.has(world.status))
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  }

  async getManifest() {
    await this.ensureConfiguredWorlds();
    const db = await this.store.read();
    const season = pickCurrentSeason(db.seasons, this.now) || this.makeSeason(db.worlds);
    const worlds = [...db.worlds].sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      season,
      active: worlds.filter((world) => ACTIVE_STATUSES.has(world.status)).map(publicWorld),
      past: worlds.filter((world) => PAST_STATUSES.has(world.status)).map(publicWorld),
      worlds: worlds.map(publicWorld),
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

function normalizeWorld(world, seasonId, syncedAt) {
  return {
    id: world.id,
    worldId: world.worldId || world.id,
    seasonId,
    status: world.status,
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
    agents: world.admission?.registeredAgents?.length || 0,
    minAgents: world.admission?.minAgents || 0,
    targetAgents: world.admission?.targetAgents || 0,
    owners: Array.isArray(world.admission?.registeredAgents) ? world.admission.registeredAgents : [],
    sessionId: world.sessionId ?? null,
    mapHash: world.map?.hash || null,
    map: world.paths?.map || null,
    snapshot: world.paths?.snapshot || null,
    events: world.paths?.events || null,
    chain: world.chain || {},
    finishedAt: world.finishedAt || world.chain?.finishedAt || null,
    archivedAt: world.archivedAt || null,
    archiveId: world.archiveId || null,
    archiveUrl: world.archiveUrl || null,
    sourceUpdatedAt: world.updatedAt || null,
    updatedAt: syncedAt,
  };
}

function publicWorld(world) {
  return {
    id: world.id,
    worldId: world.worldId || world.id,
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
    minAgents: config.factoryLobbyMin || 1,
    targetAgents: config.factoryLobbyCap || 10,
    owners: [],
    sessionId: null,
    mapHash: null,
    map: null,
    snapshot: null,
    events: null,
    chain: {},
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
