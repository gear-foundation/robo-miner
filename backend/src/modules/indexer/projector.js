import { applyWorldSessionTiming } from '../gameMaster/sessionTiming.js';

const WORLD_LIVE_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'active']);

export class IndexerProjector {
  constructor({ store, config, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  async applyEvent(event) {
    const normalized = normalizeEvent(event, this.now());
    return this.store.update((db) => {
      if (hasEvent(db, normalized.id)) return { applied: false, reason: 'duplicate', event: normalized };
      db.chainEvents.push(normalized);
      applyProjection(db, normalized, this.config);
      return { applied: true, event: normalized };
    });
  }

  async applyEvents(events) {
    const results = [];
    for (const event of events) {
      results.push(await this.applyEvent(event));
    }
    return results;
  }

  async applySnapshots(snapshots) {
    return this.store.update((db) => {
      for (const snapshot of snapshots) {
        applySnapshotProjection(db, snapshot, this.config);
      }
      return { applied: snapshots.length };
    });
  }
}

export function normalizeEvent(event, now = new Date()) {
  const service = event.service || splitName(event.name).service;
  const eventName = event.event || splitName(event.name).event;
  const args = event.args || event.data || [];
  const programId = event.programId || event.actorId || null;
  const blockNumber = event.blockNumber ?? event.block?.height ?? null;
  const blockHash = event.blockHash || event.block?.hash || null;
  const messageId = event.messageId || null;
  const logIndex = event.logIndex ?? event.index ?? null;
  const id = event.id || [
    programId || 'unknown-program',
    blockHash || blockNumber || 'unknown-block',
    messageId || logIndex || `${service}.${eventName}`,
    service,
    eventName,
  ].join(':');

  return {
    id,
    source: event.source || 'manual',
    programType: event.programType || inferProgramType(service, eventName),
    programId: programId ? normalizeProgramId(programId) : null,
    service,
    event: eventName,
    args,
    blockNumber,
    blockHash,
    txHash: event.txHash || null,
    messageId,
    timestamp: event.timestamp || now.toISOString(),
    receivedAt: now.toISOString(),
  };
}

function applyProjection(db, event, config) {
  if (event.programType === 'world' || event.service === 'World' || isWorldAdminEvent(event)) {
    applyWorldEvent(db, event, config);
    return;
  }
  if (event.programType === 'proxy' || event.service === 'Digger') {
    applyProxyEvent(db, event);
    return;
  }
  if (event.programType === 'resVmt' || event.service === 'Vmt') {
    applyVmtEvent(db, event, config);
    return;
  }
  if (event.programType === 'redeem' || event.service === 'Redeem') {
    applyRedeemEvent(db, event, config);
  }
}

function applySnapshotProjection(db, snapshot, config) {
  if (snapshot.kind === 'world') applyWorldSnapshot(db, snapshot, config);
  if (snapshot.kind === 'proxy') applyProxySnapshot(db, snapshot, config);
  if (snapshot.kind === 'resVmt') applyResVmtSnapshot(db, snapshot, config);
  if (snapshot.kind === 'redeem') applyRedeemSnapshot(db, snapshot, config);
}

function applyWorldSnapshot(db, snapshot, config) {
  const world = findWorldByProgram(db, snapshot.programId);
  const worldId = world?.id || snapshot.programId;
  const seasonId = world?.seasonId || config.diggerRentalSeason;
  const sessionId = snapshot.session?.[0] || '0';
  const status = Number(snapshot.session?.[2] || 0);
  const owners = (snapshot.agents || [])
    .filter((agent) => !agent.error)
    .map((agent) => actorKey(agent.owner));
  if (world) {
    world.session = {
      id: sessionId,
      seed: snapshot.session?.[1] || '0',
      status,
      actionSeq: snapshot.session?.[3] || '0',
    };
    world.sessionId = sessionId;
    world.seed = String(snapshot.session?.[1] || world.seed || '0');
    world.status = worldStatusFromSession(status, world.status);
    world.owners = owners;
    world.agents = owners.length;
    world.updatedAt = snapshot.capturedAt;
    applySnapshotTiming(world, status, snapshot, config);
  }

  for (const agent of snapshot.agents || []) {
    if (agent.error) continue;
    const ownerActor = actorKey(agent.owner);
    const state = agent.state || [];
    const inventory = agent.inventory || [];
    const diggerStatus = diggerStatusFromAgentState(state[0]);
    const digger = upsertDiggerFromActor(db, ownerActor, {
      seasonId,
      worldId,
      sessionId,
      status: diggerStatus,
      targetExecBalance: config.diggerDailyExecTarget.toString(),
      updatedAt: snapshot.capturedAt,
    });
    digger.agentState = {
      status: state[0] ?? 0,
      x: state[1] ?? 0,
      y: state[2] ?? 0,
      hp: state[3] ?? 0,
      laddersRemaining: state[4] ?? 0,
      backpackCapacity: state[11] ?? 0,
      lastActionSeq: String(state[12] ?? 0),
    };

    const stats = upsertAgentStats(db, worldId, sessionId, ownerActor, seasonId, snapshot.capturedAt);
    stats.status = diggerStatus;
    stats.x = state[1] ?? stats.x;
    stats.y = state[2] ?? stats.y;
    stats.banked = {
      scrst: inventory[3] ?? state[8] ?? 0,
      bcrst: inventory[4] ?? state[9] ?? 0,
      hcrst: inventory[5] ?? state[10] ?? 0,
    };
    stats.inventory = {
      scrst: inventory[0] ?? state[5] ?? 0,
      bcrst: inventory[1] ?? state[6] ?? 0,
      hcrst: inventory[2] ?? state[7] ?? 0,
    };
    stats.snapshotAt = snapshot.capturedAt;
  }
}

function applyProxySnapshot(db, snapshot, config) {
  const programId = normalizeProgramId(snapshot.programId);
  let digger = findDiggerByProgram(db, programId);
  if (!digger) {
    digger = {
      id: programId,
      programId,
      owner: null,
      executableBalance: '0',
      lastRefuelAt: null,
      createdAt: snapshot.capturedAt,
    };
    db.diggers.push(digger);
  }
  Object.assign(digger, {
    ownerActor: snapshot.owner,
    worldActor: snapshot.world,
    worldId: actorToEvmAddress(snapshot.world) || snapshot.world,
    seasonId: digger.seasonId || config.diggerRentalSeason,
    status: digger.status || 'active',
    proxyStatus: {
      actionSeq: snapshot.status?.[0] || '0',
      lastAction: snapshot.status?.[1] || '0',
      lastMessageId: snapshot.lastMessageId,
    },
    targetExecBalance: digger.targetExecBalance || config.diggerDailyExecTarget.toString(),
    updatedAt: snapshot.capturedAt,
  });
}

function applyResVmtSnapshot(db, snapshot, config) {
  const stats = upsertEconomyStats(db, config.diggerRentalSeason, snapshot.capturedAt);
  stats.totalSupply = snapshot.totalSupply;
}

function applyRedeemSnapshot(db, snapshot, config) {
  const stats = upsertEconomyStats(db, config.diggerRentalSeason, snapshot.capturedAt);
  stats.reserveBalance = snapshot.reserveBalance;
  stats.lockedBalance = snapshot.lockedBalance;
  stats.paid = snapshot.totalPaid;
  stats.totalRedeemed = snapshot.totalRedeemed;
  stats.pendingRedeems = snapshot.pendingRedeemCount;
}

function applyWorldEvent(db, event, config) {
  const [sessionRaw, ownerRaw, a, b, c, d] = event.args;
  const sessionId = toStringNumber(sessionRaw);
  const programId = event.programId;
  const world = findWorldByProgram(db, programId);
  const worldId = world?.id || programId || 'unknown-world';
  const seasonId = world?.seasonId || config.diggerRentalSeason;

  if (event.service === 'Admin') {
    applyWorldAdminEvent(db, event, world, config);
    return;
  }
  if (event.event === 'SessionStarted') {
    applyWorldSessionEvent(world, event, sessionId, 'active', config);
    return;
  }

  const ownerActor = actorKey(ownerRaw);

  const digger = upsertDiggerFromActor(db, ownerActor, {
    seasonId,
    worldId,
    sessionId,
    status: event.event === 'AgentDied' ? 'dead' : 'active',
    targetExecBalance: config.diggerDailyExecTarget.toString(),
    updatedAt: event.timestamp,
  });
  const stats = upsertAgentStats(db, worldId, sessionId, ownerActor, seasonId, event.timestamp);

  switch (event.event) {
    case 'AgentRegistered':
      digger.status = 'registered';
      stats.registeredAt = stats.registeredAt || event.timestamp;
      applyWorldRegistration(world, ownerActor, sessionId, event.timestamp);
      break;
    case 'AgentSpawned':
      digger.status = 'active';
      stats.spawnedAt = stats.spawnedAt || event.timestamp;
      stats.x = toNumber(a);
      stats.y = toNumber(b);
      break;
    case 'AgentMoved':
      stats.moves += 1;
      stats.fromX = toNumber(a);
      stats.fromY = toNumber(b);
      stats.x = toNumber(c);
      stats.y = toNumber(d);
      break;
    case 'TileDrilled':
      stats.drills += 1;
      stats.lastDrill = { x: toNumber(a), y: toNumber(b), oldTile: toNumber(c), newTile: toNumber(d) };
      break;
    case 'ResourceExtracted':
      stats.resourcesExtracted += 1;
      incrementResource(stats.extracted, toNumber(c), 1);
      stats.lastResource = { x: toNumber(a), y: toNumber(b), kind: toNumber(c), carriedTotal: toNumber(d) };
      break;
    case 'StoneMoved':
      stats.stonesMoved = (stats.stonesMoved || 0) + 1;
      stats.lastStoneMove = { fromX: toNumber(a), fromY: toNumber(b), x: toNumber(c), y: toNumber(d) };
      break;
    case 'LadderPlaced':
      stats.laddersPlaced += 1;
      stats.laddersRemaining = toNumber(c);
      break;
    case 'AgentSurfaced':
      stats.surfaced += 1;
      stats.banked = { scrst: toNumber(a), bcrst: toNumber(b), hcrst: toNumber(c) };
      break;
    case 'AgentDied':
      digger.status = 'dead';
      stats.status = 'dead';
      stats.x = toNumber(a);
      stats.y = toNumber(b);
      stats.death = { x: toNumber(a), y: toNumber(b), cause: toNumber(c), at: event.timestamp };
      break;
    case 'AgentExited':
      digger.status = 'exited';
      stats.status = 'exited';
      stats.exitedAt = event.timestamp;
      break;
    case 'ResourcesMinted':
      stats.minted = { scrst: toNumber(a), bcrst: toNumber(b), hcrst: toNumber(c) };
      break;
    default:
      break;
  }

  digger.updatedAt = event.timestamp;
}

function applyWorldSessionEvent(world, event, sessionId, status, config) {
  if (!world) return;
  world.session = { ...(world.session || {}), id: sessionId };
  world.sessionId = sessionId;
  world.status = status;
  applyWorldSessionTiming(world, { config, timestamp: event.timestamp, status });
  world.updatedAt = event.timestamp;
}

function applyWorldRegistration(world, ownerActor, sessionId, timestamp) {
  if (!world) return;
  const owners = new Set((world.owners || []).map(actorKey));
  owners.add(ownerActor);
  world.owners = [...owners];
  world.agents = world.owners.length;
  world.sessionId = sessionId;
  if (world.status !== 'active') world.status = 'waiting_agents';
  world.updatedAt = timestamp;
}

function applyWorldAdminEvent(_db, event, world, config) {
  if (!world) return;
  const sessionId = toStringNumber(event.args[0]);
  switch (event.event) {
    case 'MapGenerated':
      world.status = 'map_ready';
      world.chain = { ...(world.chain || {}), generatedAt: event.timestamp };
      world.seed = String(event.args[1] ?? world.seed ?? '');
      world.sessionId = sessionId;
      world.session = { ...(world.session || {}), id: sessionId, seed: world.seed, status: 0, actionSeq: '0' };
      world.agents = 0;
      world.owners = [];
      applyWorldSessionTiming(world, { config, timestamp: event.timestamp, status: 'waiting_agents' });
      break;
    case 'SessionStarted':
      world.status = 'active';
      world.sessionId = sessionId;
      world.session = { ...(world.session || {}), id: sessionId, status: 1 };
      applyWorldSessionTiming(world, { config, timestamp: event.timestamp, status: 'active' });
      break;
    case 'SessionFinished':
      world.status = 'finished';
      world.sessionId = sessionId;
      world.session = { ...(world.session || {}), id: sessionId, status: 2 };
      applyWorldSessionTiming(world, { config, timestamp: event.timestamp, status: 'finished' });
      break;
    default:
      break;
  }
  world.updatedAt = event.timestamp;
}

function applySnapshotTiming(world, status, snapshot, config) {
  if (status === 0) {
    applyWorldSessionTiming(world, { config, timestamp: snapshot.capturedAt, status: 'waiting_agents' });
    return;
  }
  if (status === 1 && !world.endsAt) {
    applyWorldSessionTiming(world, {
      config,
      timestamp: world.chain?.startedAt || snapshot.capturedAt,
      status: 'active',
    });
    return;
  }
  if (status === 2 && !world.finishedAt) {
    applyWorldSessionTiming(world, { config, timestamp: snapshot.capturedAt, status: 'finished' });
  }
}

function worldStatusFromSession(status, fallback) {
  if (status === 0) return 'waiting_agents';
  if (status === 1) return 'active';
  if (status === 2) return 'finished';
  return fallback || 'waiting_agents';
}

function diggerStatusFromAgentState(status) {
  if (Number(status) === 3) return 'dead';
  if (Number(status) === 4) return 'exited';
  return 'active';
}

function applyProxyEvent(db, event) {
  if (event.event !== 'Forwarded') return;
  const digger = findDiggerByProgram(db, event.programId);
  if (!digger) return;
  digger.lastForwarded = {
    seq: toStringNumber(event.args[0]),
    action: toNumber(event.args[1]),
    messageId: actorKey(event.args[2]),
    at: event.timestamp,
  };
  digger.updatedAt = event.timestamp;
}

function applyVmtEvent(db, event, config) {
  const stats = upsertEconomyStats(db, config.diggerRentalSeason, event.timestamp);
  switch (event.event) {
    case 'Minted':
      stats.minted.scrst += toNumber(event.args[1]);
      stats.minted.bcrst += toNumber(event.args[2]);
      stats.minted.hcrst += toNumber(event.args[3]);
      break;
    case 'Burned':
      stats.burned.scrst += toNumber(event.args[1]);
      stats.burned.bcrst += toNumber(event.args[2]);
      stats.burned.hcrst += toNumber(event.args[3]);
      break;
    case 'Transfer':
      stats.transfers += 1;
      break;
    case 'RedeemBurnRejected':
      stats.redeemBurnRejected += 1;
      break;
    default:
      break;
  }
}

function applyRedeemEvent(db, event, config) {
  const stats = upsertEconomyStats(db, config.diggerRentalSeason, event.timestamp);
  switch (event.event) {
    case 'ReserveDeposited':
      stats.reserveDeposited += toNumber(event.args[1]);
      stats.reserveBalance = toNumber(event.args[2]);
      break;
    case 'ReserveSynced':
      stats.reserveSynced += toNumber(event.args[0]);
      stats.reserveBalance = toNumber(event.args[1]);
      break;
    case 'RedeemRequested':
      stats.redeemRequested += 1;
      stats.pendingRedeems += 1;
      break;
    case 'Redeemed':
      stats.redeemed += 1;
      stats.pendingRedeems = Math.max(0, stats.pendingRedeems - 1);
      stats.paid += toNumber(event.args[4]);
      break;
    case 'RedeemCanceled':
      stats.redeemCanceled += 1;
      stats.pendingRedeems = Math.max(0, stats.pendingRedeems - 1);
      break;
    default:
      break;
  }
}

function upsertDiggerFromActor(db, ownerActor, patch) {
  const programId = actorToEvmAddress(ownerActor);
  const existing = programId ? findDiggerByProgram(db, programId) : null;
  const now = patch.updatedAt;
  if (existing) {
    Object.assign(existing, patch);
    return existing;
  }
  const digger = {
    id: programId || ownerActor,
    programId,
    actorId: ownerActor,
    owner: null,
    executableBalance: '0',
    lastRefuelAt: null,
    createdAt: now,
    ...patch,
  };
  db.diggers.push(digger);
  return digger;
}

function upsertAgentStats(db, worldId, sessionId, ownerActor, seasonId, now) {
  const id = `${worldId}:${sessionId}:${ownerActor}`;
  let stats = db.agentStats.find((item) => item.id === id);
  if (!stats) {
    stats = {
      id,
      worldId,
      sessionId,
      seasonId,
      ownerActor,
      status: 'active',
      moves: 0,
      drills: 0,
      stonesMoved: 0,
      resourcesExtracted: 0,
      laddersPlaced: 0,
      surfaced: 0,
      extracted: { scrst: 0, bcrst: 0, hcrst: 0 },
      banked: { scrst: 0, bcrst: 0, hcrst: 0 },
      minted: { scrst: 0, bcrst: 0, hcrst: 0 },
      createdAt: now,
      updatedAt: now,
    };
    db.agentStats.push(stats);
  }
  stats.updatedAt = now;
  return stats;
}

function upsertEconomyStats(db, seasonId, now) {
  let stats = db.economyStats.find((item) => item.id === seasonId);
  if (!stats) {
    stats = {
      id: seasonId,
      seasonId,
      minted: { scrst: 0, bcrst: 0, hcrst: 0 },
      burned: { scrst: 0, bcrst: 0, hcrst: 0 },
      transfers: 0,
      reserveDeposited: 0,
      reserveSynced: 0,
      reserveBalance: 0,
      paid: 0,
      redeemRequested: 0,
      redeemed: 0,
      redeemCanceled: 0,
      redeemBurnRejected: 0,
      pendingRedeems: 0,
      createdAt: now,
      updatedAt: now,
    };
    db.economyStats.push(stats);
  }
  stats.updatedAt = now;
  return stats;
}

function findWorldByProgram(db, programId) {
  if (!programId) return null;
  return db.worlds.find((world) => normalizeProgramId(world.programId) === normalizeProgramId(programId)) || null;
}

function findDiggerByProgram(db, programId) {
  if (!programId) return null;
  return db.diggers.find((digger) => normalizeProgramId(digger.programId) === normalizeProgramId(programId)) || null;
}

function hasEvent(db, id) {
  return db.chainEvents.some((event) => event.id === id);
}

function splitName(name = '') {
  const [service, event] = String(name).split('.');
  return { service, event };
}

function inferProgramType(service, event) {
  if (service === 'World') return 'world';
  if (service === 'Digger') return 'proxy';
  if (service === 'Vmt') return 'resVmt';
  if (service === 'Redeem') return 'redeem';
  if (service === 'Admin' && ['MapGenerated', 'SessionStarted', 'SessionFinished', 'ResourceVmtUpdated'].includes(event)) return 'world';
  return 'unknown';
}

function isWorldAdminEvent(event) {
  return event.service === 'Admin' && ['MapGenerated', 'SessionStarted', 'SessionFinished', 'ResourceVmtUpdated'].includes(event.event);
}

function incrementResource(target, kind, amount) {
  if (kind === 0) target.scrst += amount;
  else if (kind === 1) target.bcrst += amount;
  else if (kind === 2) target.hcrst += amount;
}

function actorKey(value) {
  if (Array.isArray(value)) return `0x${value.map((byte) => Number(byte).toString(16).padStart(2, '0')).join('')}`.toLowerCase();
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object' && Array.isArray(value.bytes)) return actorKey(value.bytes);
  return String(value ?? '');
}

function actorToEvmAddress(actor) {
  const hex = actorKey(actor);
  if (!/^0x[0-9a-f]{64}$/.test(hex)) return null;
  if (hex.slice(2, 26) !== '000000000000000000000000') return null;
  return `0x${hex.slice(26)}`;
}

function normalizeProgramId(value) {
  if (!value) return null;
  const actorAddress = actorToEvmAddress(value);
  return (actorAddress || String(value)).toLowerCase();
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(String(value ?? 0));
}

function toStringNumber(value) {
  return String(value ?? 0);
}
