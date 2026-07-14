import { generateAgentName } from '../agentNames.js';
import { DEFAULT_REDEEM_RATES } from '../../config/networks.js';
import {
  applyMintAccounting,
  applySurfaceAccounting,
  applyTradeAccounting,
  maxResources,
  syncEarnedResources,
} from '../indexer/resourceAccounting.js';

const DEFAULT_RATES = DEFAULT_REDEEM_RATES;
const METRICS = new Set(['live', 'banked', 'minted', 'earned']);

export class LeaderboardService {
  constructor({ store, config, rates = DEFAULT_RATES }) {
    this.store = store;
    this.config = config;
    this.rates = rates;
  }

  async list({ seasonId = null, worldId = null, sessionId = null, owner = null, metric = 'earned', limit = 50 } = {}) {
    const db = await this.store.read();
    const selectedMetric = METRICS.has(metric) ? metric : 'earned';
    const rowsByOwner = new Map();
    const resourceHistory = buildResourceHistory(db);

    for (const stats of db.agentStats) {
      if (seasonId && stats.seasonId !== seasonId) continue;
      if (worldId && stats.worldId !== worldId) continue;
      if (sessionId && String(stats.sessionId) !== String(sessionId)) continue;
      const resolved = resolveLeaderboardIdentity(db, stats);
      if (owner && normalizeKey(resolved.ownerActor) !== normalizeActorKey(owner)) continue;

      const key = normalizeKey(resolved.ownerActor);
      const history = resourceHistory.get(agentStatsKey(stats.worldId, stats.sessionId, stats.ownerActor));
      const resolvedStats = withResourceHistory({ ...stats, ...resolved }, history);
      const row = rowsByOwner.get(key) || emptyRow(resolvedStats);
      mergeRow(row, resolvedStats, selectedMetric, this.rates);
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
    const [live, banked, minted, earned] = await Promise.all([
      this.list({ ...filters, metric: 'live', limit: 1_000_000 }),
      this.list({ ...filters, metric: 'banked', limit: 1_000_000 }),
      this.list({ ...filters, metric: 'minted', limit: 1_000_000 }),
      this.list({ ...filters, metric: 'earned', limit: 1_000_000 }),
    ]);
    return {
      players: live.length,
      totals: {
        live: sumMetric(live, 'live', this.rates),
        banked: sumMetric(banked, 'banked', this.rates),
        minted: sumMetric(minted, 'minted', this.rates),
        earned: sumMetric(earned, 'earned', this.rates),
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
    spentBanked: emptyResources(),
    earned: emptyResources(),
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
  addResources(row.spentBanked, stats.spentBanked);
  addResources(row.earned, stats.earned);
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

function buildResourceHistory(db) {
  const history = new Map();
  const events = [...(db.chainEvents || [])]
    .filter((event) => ['AgentSurfaced', 'ResourcesMinted', 'ResourcesTradedForLadders'].includes(event.event))
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));

  for (const event of events) {
    const sessionId = event.args?.[0];
    const ownerActor = event.args?.[1];
    if (sessionId === undefined || !ownerActor) continue;
    const world = db.worlds.find((item) => normalizeEvmAddress(item.programId) === normalizeEvmAddress(event.programId));
    const worldId = world?.id || event.programId;
    const key = agentStatsKey(worldId, sessionId, ownerActor);
    const stats = history.get(key) || {};
    const resources = {
      scrst: Number(event.args?.[2] || 0),
      bcrst: Number(event.args?.[3] || 0),
      hcrst: Number(event.args?.[4] || 0),
    };
    if (event.event === 'AgentSurfaced') applySurfaceAccounting(stats, resources);
    if (event.event === 'ResourcesMinted') applyMintAccounting(stats, resources);
    if (event.event === 'ResourcesTradedForLadders') applyTradeAccounting(stats, resources);
    history.set(key, stats);
  }
  return history;
}

function withResourceHistory(stats, history = null) {
  const result = {
    ...stats,
    minted: maxResources(stats.minted, history?.minted),
    spentBanked: maxResources(stats.spentBanked, history?.spentBanked),
    surfacedResources: maxResources(stats.surfacedResources, history?.surfacedResources),
  };
  syncEarnedResources(result);
  result.earned = maxResources(maxResources(result.earned, stats.earned), history?.earned);
  return result;
}

function agentStatsKey(worldId, sessionId, ownerActor) {
  return `${normalizeKey(worldId)}:${String(sessionId)}:${normalizeKey(ownerActor)}`;
}

function resolveLeaderboardIdentity(db, stats) {
  const proxyProgramId = stats.diggerProgramId || actorToEvmAddress(stats.ownerActor);
  const digger = proxyProgramId
    ? db.diggers.find((item) => normalizeEvmAddress(item.programId || item.id) === normalizeEvmAddress(proxyProgramId))
    : null;
  if (!digger?.owner) {
    return {
      ownerActor: stats.ownerActor,
      diggerProgramId: stats.diggerProgramId || null,
      agentName: stats.agentName || null,
    };
  }
  return {
    ownerActor: evmAddressToActor(digger.owner) || stats.ownerActor,
    diggerProgramId: digger.programId || proxyProgramId || null,
    agentName: digger.agentName || stats.agentName || null,
  };
}

function normalizeActorKey(value) {
  return normalizeKey(evmAddressToActor(value) || value);
}

function normalizeEvmAddress(value) {
  return normalizeKey(actorToEvmAddress(value) || value);
}

function actorToEvmAddress(value) {
  const hex = normalizeKey(value).replace(/^0x/, '');
  if (!/^[0-9a-f]{40,64}$/.test(hex)) return null;
  return `0x${hex.slice(-40)}`;
}

function evmAddressToActor(value) {
  const hex = normalizeKey(value).replace(/^0x/, '');
  if (/^[0-9a-f]{64}$/.test(hex)) return `0x${hex}`;
  if (!/^[0-9a-f]{40}$/.test(hex)) return null;
  return `0x${'0'.repeat(24)}${hex}`;
}
