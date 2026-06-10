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
        mode: 'local',
        source: file,
        startedAt: syncedAt,
        finishedAt: this.now().toISOString(),
        worlds: sourceWorlds.length,
        seasonId: season.id,
      });
    });

    return this.getManifest();
  }

  async getCurrentSeason() {
    const db = await this.store.read();
    return pickCurrentSeason(db.seasons, this.now) || this.makeSeason(db.worlds);
  }

  async getLiveWorlds() {
    const db = await this.store.read();
    return db.worlds
      .filter((world) => ACTIVE_STATUSES.has(world.status))
      .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
  }

  async getManifest() {
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
    seasonId,
    status: world.status,
    deployMode: world.deployMode || 'dry-run',
    programId: world.programId || null,
    seed: String(world.seed ?? ''),
    network: world.network || null,
    router: world.router || null,
    startsAt: world.startsAt || null,
    endsAt: world.endsAt || null,
    sessionMs: world.sessionMs || null,
    agents: world.admission?.registeredAgents?.length || 0,
    minAgents: world.admission?.minAgents || 0,
    targetAgents: world.admission?.targetAgents || 0,
    mapHash: world.map?.hash || null,
    map: world.paths?.map || null,
    snapshot: world.paths?.snapshot || null,
    events: world.paths?.events || null,
    chain: world.chain || {},
    sourceUpdatedAt: world.updatedAt || null,
    updatedAt: syncedAt,
  };
}

function publicWorld(world) {
  return {
    id: world.id,
    seasonId: world.seasonId,
    status: world.status,
    deployMode: world.deployMode,
    programId: world.programId,
    seed: world.seed,
    network: world.network,
    router: world.router,
    startsAt: world.startsAt,
    endsAt: world.endsAt,
    sessionMs: world.sessionMs,
    agents: world.agents,
    minAgents: world.minAgents,
    targetAgents: world.targetAgents,
    mapHash: world.mapHash,
    map: world.map,
    snapshot: world.snapshot,
    events: world.events,
  };
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
