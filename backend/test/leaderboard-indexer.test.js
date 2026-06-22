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
  assert.equal(rows[0].score, 20 * 66 + 330);
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
  assert.equal(rows[0].score, 25 * 66 + 2 * 330 + 1650);
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
    owners: [OWNER, OWNER_2],
    sessionId: '3',
    seed: '4290832138',
    session: { id: '3', seed: '4290832138', status: 0, actionSeq: '0' },
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
