import { generateAgentName } from '../agentNames.js';
import { DEFAULT_REDEEM_RATES } from '../../config/networks.js';

const DEFAULT_RATES = DEFAULT_REDEEM_RATES;
const METRICS = new Set(['live', 'banked', 'minted']);

export class LeaderboardService {
  constructor({ store, config, rates = DEFAULT_RATES }) {
    this.store = store;
    this.config = config;
    this.rates = rates;
  }

  async list({ seasonId = null, worldId = null, sessionId = null, owner = null, metric = 'banked', limit = 50 } = {}) {
    const db = await this.store.read();
    const selectedMetric = METRICS.has(metric) ? metric : 'banked';
    const rowsByOwner = new Map();

    for (const stats of db.agentStats) {
      if (seasonId && stats.seasonId !== seasonId) continue;
      if (worldId && stats.worldId !== worldId) continue;
      if (sessionId && String(stats.sessionId) !== String(sessionId)) continue;
      if (owner && normalizeKey(stats.ownerActor) !== normalizeKey(owner)) continue;

      const key = stats.ownerActor;
      const row = rowsByOwner.get(key) || emptyRow(stats);
      mergeRow(row, stats, selectedMetric, this.rates);
      rowsByOwner.set(key, row);
    }

    return [...rowsByOwner.values()]
      .map((row) => ({
        ...row,
        agentName: row.agentName || generateAgentName(row.diggerProgramId || row.ownerActor),
        score: scoreResources(row[selectedMetric], this.rates),
        metric: selectedMetric,
      }))
      .sort(compareRows)
      .slice(0, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  }

  async summary(filters = {}) {
    const [live, banked, minted] = await Promise.all([
      this.list({ ...filters, metric: 'live', limit: 1_000_000 }),
      this.list({ ...filters, metric: 'banked', limit: 1_000_000 }),
      this.list({ ...filters, metric: 'minted', limit: 1_000_000 }),
    ]);
    return {
      players: live.length,
      totals: {
        live: sumMetric(live, 'live', this.rates),
        banked: sumMetric(banked, 'banked', this.rates),
        minted: sumMetric(minted, 'minted', this.rates),
      },
    };
  }
}

function emptyRow(stats) {
  return {
    ownerActor: stats.ownerActor,
    diggerProgramId: stats.diggerProgramId || null,
    agentName: stats.agentName || generateAgentName(stats.diggerProgramId || stats.ownerActor),
    seasonId: stats.seasonId,
    worldsPlayed: 0,
    sessionsPlayed: 0,
    worldIds: [],
    sessionIds: [],
    status: stats.status || 'active',
    live: emptyResources(),
    banked: emptyResources(),
    minted: emptyResources(),
    moves: 0,
    drills: 0,
    laddersPlaced: 0,
    surfaced: 0,
    deaths: 0,
    exits: 0,
    updatedAt: stats.updatedAt || null,
  };
}

function mergeRow(row, stats) {
  addResources(row.live, stats.extracted);
  addResources(row.banked, stats.banked);
  addResources(row.minted, stats.minted);
  row.moves += stats.moves || 0;
  row.drills += stats.drills || 0;
  row.laddersPlaced += stats.laddersPlaced || 0;
  row.surfaced += stats.surfaced || 0;
  row.deaths += stats.status === 'dead' || stats.death ? 1 : 0;
  row.exits += stats.status === 'exited' ? 1 : 0;
  if (!row.worldIds.includes(stats.worldId)) row.worldIds.push(stats.worldId);
  if (!row.sessionIds.includes(String(stats.sessionId))) row.sessionIds.push(String(stats.sessionId));
  row.worldsPlayed = row.worldIds.length;
  row.sessionsPlayed = row.sessionIds.length;
  if (!row.updatedAt || String(stats.updatedAt || '').localeCompare(row.updatedAt) > 0) row.updatedAt = stats.updatedAt;
}

function compareRows(a, b) {
  return (
    b.score - a.score
    || b.live.scrst + b.live.bcrst + b.live.hcrst - (a.live.scrst + a.live.bcrst + a.live.hcrst)
    || b.drills - a.drills
    || String(a.ownerActor).localeCompare(String(b.ownerActor))
  );
}

function sumMetric(rows, metric, rates) {
  const resources = emptyResources();
  for (const row of rows) addResources(resources, row[metric]);
  return { resources, score: scoreResources(resources, rates) };
}

function scoreResources(resources = {}, rates = DEFAULT_RATES) {
  return (
    (resources.scrst || 0) * rates.scrst
    + (resources.bcrst || 0) * rates.bcrst
    + (resources.hcrst || 0) * rates.hcrst
  );
}

function addResources(target, source = {}) {
  target.scrst += source.scrst || 0;
  target.bcrst += source.bcrst || 0;
  target.hcrst += source.hcrst || 0;
}

function emptyResources() {
  return { scrst: 0, bcrst: 0, hcrst: 0 };
}

function normalizeKey(value) {
  return String(value || '').toLowerCase();
}
