import assert from 'node:assert/strict';
import test from 'node:test';

import { InjectedIngestService } from '../src/modules/indexer/injectedIngest.js';
import { IndexerProjector } from '../src/modules/indexer/projector.js';
import { LeaderboardService } from '../src/modules/leaderboard/service.js';
import { normalizeDb } from '../src/db/jsonStore.js';

const CONFIG = {
  diggerRentalSeason: 'season-1',
  diggerDailyExecTarget: 120000000000000n,
  sessionMs: 1800000,
  factorySessionAutofinish: false,
};

const WORLD_ID = '0x936b5395876648772d37e22da57ba37c4e586df2';
const OWNER = '0x000000000000000000000000766270abf5dde72d374b3120c8aedc651ee3f184';
const OWNER_2 = '0x00000000000000000000000004300369143d86e30cc8adea289750d1e658c71f';

test('injected AgentSurfaced updates the MVP banked leaderboard', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const published = [];
  const ingest = new InjectedIngestService({
    store,
    config: CONFIG,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
    eventBus: { publishMany: (events) => published.push(...events) },
  });

  const result = await ingest.ingest({
    txHash: '0xtx',
    messageId: '0xmsg',
    events: [{
      programType: 'world',
      programId: WORLD_ID,
      service: 'World',
      event: 'AgentSurfaced',
      args: ['1', OWNER, 20, 1, 0],
    }],
  });

  assert.equal(result.eventsApplied, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].event, 'AgentSurfaced');

  const rows = await new LeaderboardService({ store, config: CONFIG }).list({ metric: 'banked' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].banked, { scrst: 20, bcrst: 1, hcrst: 0 });
  assert.equal(rows[0].score, 20 * 6 + 30);

  const earned = await new LeaderboardService({ store, config: CONFIG }).list({ metric: 'earned' });
  assert.deepEqual(earned[0].earned, { scrst: 20, bcrst: 1, hcrst: 0 });
  assert.equal(earned[0].score, 20 * 6 + 30);
});

test('earned leaderboard preserves surfaced total after ladder trades and minting', async () => {
  const resourceEvent = (id, event, scrst, timestamp) => ({
    id,
    programType: 'world',
    programId: WORLD_ID,
    service: 'World',
    event,
    args: ['1', OWNER, scrst, 0, 0],
    timestamp,
  });
  const store = new MemoryStore({
    worlds: [{ id: 'w001', programId: WORLD_ID, seasonId: 'season-1' }],
    agentStats: [{
      id: `w001:1:${OWNER}`,
      worldId: 'w001',
      sessionId: '1',
      seasonId: 'season-1',
      ownerActor: OWNER,
      status: 'active',
      banked: { scrst: 0, bcrst: 0, hcrst: 0 },
      minted: { scrst: 21, bcrst: 0, hcrst: 0 },
      extracted: { scrst: 31, bcrst: 0, hcrst: 0 },
      updatedAt: '2026-07-14T11:31:46.557Z',
    }],
    chainEvents: [
      resourceEvent('surface-10', 'AgentSurfaced', 10, '2026-07-14T09:53:42.630Z'),
      resourceEvent('surface-18', 'AgentSurfaced', 18, '2026-07-14T10:08:05.381Z'),
      resourceEvent('surface-27', 'AgentSurfaced', 27, '2026-07-14T10:48:38.323Z'),
      resourceEvent('trade-10', 'ResourcesTradedForLadders', 10, '2026-07-14T10:52:51.787Z'),
      resourceEvent('surface-21', 'AgentSurfaced', 21, '2026-07-14T11:26:04.429Z'),
      resourceEvent('mint-21', 'ResourcesMinted', 21, '2026-07-14T11:30:46.335Z'),
    ],
  });

  const [row] = await new LeaderboardService({ store, config: CONFIG }).list({ metric: 'earned' });

  assert.deepEqual(row.banked, { scrst: 0, bcrst: 0, hcrst: 0 });
  assert.deepEqual(row.minted, { scrst: 21, bcrst: 0, hcrst: 0 });
  assert.deepEqual(row.spentBanked, { scrst: 10, bcrst: 0, hcrst: 0 });
  assert.deepEqual(row.earned, { scrst: 31, bcrst: 0, hcrst: 0 });
  assert.equal(row.score, 31 * 6);
});

test('world snapshot reconciles banked totals when injected event is missing', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const projector = new IndexerProjector({
    store,
    config: CONFIG,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  });

  await projector.applySnapshots([{
    kind: 'world',
    programId: WORLD_ID,
    capturedAt: '2026-06-11T00:00:05.000Z',
    session: ['1', '42', 1, '7'],
    agents: [{
      owner: OWNER,
      state: [1, 3, 0, 10, 0, 0, 0, 0, 25, 2, 1, 10, 7],
      inventory: [0, 0, 0, 25, 2, 1],
    }],
  }]);

  const rows = await new LeaderboardService({ store, config: CONFIG }).list({ metric: 'banked' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].banked, { scrst: 25, bcrst: 2, hcrst: 1 });
  assert.equal(rows[0].score, 25 * 6 + 2 * 30 + 150);
});

test('world snapshots preserve dead and exited digger statuses', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const projector = new IndexerProjector({ store, config: CONFIG });

  await projector.applySnapshots([{
    kind: 'world',
    programId: WORLD_ID,
    capturedAt: '2026-06-11T00:00:05.000Z',
    session: ['1', '42', 1, '7'],
    agents: [
      { owner: OWNER, state: [2], inventory: [] },
      { owner: OWNER_2, state: [3], inventory: [] },
      { owner: '0x0000000000000000000000001111111111111111111111111111111111111111', state: [4], inventory: [] },
    ],
  }]);

  let db = await store.read();
  assert.equal(db.worlds[0].registeredAgents, 3);
  assert.equal(db.worlds[0].activeAgents, 1);
  assert.equal(db.worlds[0].agents, 1);
  assert.equal(db.diggers.find((digger) => digger.actorId === OWNER).status, 'active');
  assert.equal(db.diggers.find((digger) => digger.actorId === OWNER_2).status, 'dead');
  const exited = db.diggers.find((digger) => digger.actorId?.endsWith('1111111111111111111111111111111111111111'));
  assert.equal(exited.status, 'exited');

  const deadProgramId = db.diggers.find((digger) => digger.actorId === OWNER_2).programId;
  await projector.applySnapshots([{
    kind: 'proxy',
    programId: deadProgramId,
    capturedAt: '2026-06-11T00:00:06.000Z',
    owner: OWNER_2,
    world: `0x${'00'.repeat(12)}${WORLD_ID.slice(2)}`,
    status: ['1', '1'],
    lastMessageId: OWNER_2,
  }]);

  db = await store.read();
  assert.equal(db.diggers.find((digger) => digger.programId === deadProgramId).status, 'dead');
});

test('world snapshot updates public world session status and agent count', async () => {
  const store = new MemoryStore({
    worlds: [{
      id: 'world-1',
      programId: WORLD_ID,
      seasonId: 'season-1',
      status: 'waiting_agents',
      agents: 0,
      owners: [],
      sessionId: null,
      seed: '',
    }],
  });
  const projector = new IndexerProjector({
    store,
    config: CONFIG,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
  });

  await projector.applySnapshots([{
    kind: 'world',
    programId: WORLD_ID,
    capturedAt: '2026-06-11T00:00:05.000Z',
    session: ['3', '4290832138', 0, '0'],
    agents: [
      { owner: OWNER, state: [1, 1, 0, 10], inventory: [] },
      { owner: OWNER_2, state: [1, 2, 0, 10], inventory: [] },
    ],
  }]);

  let db = await store.read();
  assert.deepEqual(db.worlds[0], {
    id: 'world-1',
    programId: WORLD_ID,
    seasonId: 'season-1',
    status: 'waiting_agents',
    agents: 2,
    activeAgents: 2,
    registeredAgents: 2,
    owners: [OWNER, OWNER_2],
    activeOwners: [OWNER, OWNER_2],
    sessionId: '3',
    seed: '4290832138',
    session: { id: '3', seed: '4290832138', status: 0, actionSeq: '0' },
    chainUpdatedAt: '2026-06-11T00:00:05.000Z',
    updatedAt: '2026-06-11T00:00:05.000Z',
  });

  await projector.applySnapshots([{
    kind: 'world',
    programId: WORLD_ID,
    capturedAt: '2026-06-11T00:00:10.000Z',
    session: ['3', '4290832138', 1, '0'],
    agents: [{ owner: OWNER, state: [1, 1, 0, 10], inventory: [] }],
  }]);

  db = await store.read();
  assert.equal(db.worlds[0].status, 'active');
  assert.equal(db.worlds[0].agents, 1);
  assert.deepEqual(db.worlds[0].owners, [OWNER]);
  assert.equal(db.worlds[0].startsAt, '2026-06-11T00:00:10.000Z');
  assert.equal(db.worlds[0].endsAt, null);
});

test('injected events without tx hash still receive unique ids', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  let tick = 0;
  const ingest = new InjectedIngestService({
    store,
    config: CONFIG,
    now: () => new Date(`2026-06-11T00:00:0${tick++}.000Z`),
  });

  const event = {
    programType: 'world',
    programId: WORLD_ID,
    service: 'World',
    event: 'AgentMoved',
    args: ['1', OWNER, 3, 0, 4, 0],
  };
  const first = await ingest.ingest({ events: [event] });
  const second = await ingest.ingest({
    events: [{ ...event, args: ['1', OWNER, 4, 0, 5, 0] }],
  });

  assert.equal(first.eventsApplied, 1);
  assert.equal(second.eventsApplied, 1);
  assert.equal((await store.read()).chainEvents.length, 2);
});

test('injected StoneMoved and AgentDied are stored and projected for diagnostics', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const ingest = new InjectedIngestService({
    store,
    config: CONFIG,
    now: () => new Date('2026-06-11T00:01:00.000Z'),
  });

  const result = await ingest.ingest({
    messageId: 'stone-crush-1',
    events: [
      {
        programType: 'world',
        programId: WORLD_ID,
        service: 'World',
        event: 'StoneMoved',
        args: ['1', OWNER, 3, 1, 3, 3],
      },
      {
        programType: 'world',
        programId: WORLD_ID,
        service: 'World',
        event: 'AgentDied',
        args: ['1', OWNER, 3, 3, 2],
      },
    ],
  });

  assert.equal(result.eventsApplied, 2);
  const db = await store.read();
  const stats = db.agentStats.find((row) => row.ownerActor === OWNER);
  assert.equal(stats.stonesMoved, 1);
  assert.deepEqual(stats.lastStoneMove, { fromX: 3, fromY: 1, x: 3, y: 3 });
  assert.equal(stats.status, 'dead');
  assert.equal(stats.x, 3);
  assert.equal(stats.y, 3);
  assert.deepEqual(stats.death, { x: 3, y: 3, cause: 2, at: '2026-06-11T00:01:00.000Z' });
});

test('resource extraction uses the contract resource kind ids 1, 2, and 3', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const projector = new IndexerProjector({ store, config: CONFIG });

  await projector.applyEvents([1, 2, 3].map((kind) => ({
    id: `resource-${kind}`,
    programType: 'world',
    programId: WORLD_ID,
    service: 'World',
    event: 'ResourceExtracted',
    args: ['1', OWNER, 3, 4, kind, kind],
  })));

  const stats = (await store.read()).agentStats[0];
  assert.deepEqual(stats.extracted, { scrst: 1, bcrst: 1, hcrst: 1 });
});

class MemoryStore {
  constructor(initial = {}) {
    this.db = normalizeDb(initial);
  }

  async read() {
    return structuredClone(this.db);
  }

  async update(mutator) {
    const db = await this.read();
    const result = await mutator(db);
    this.db = normalizeDb(db);
    return result;
  }
}
