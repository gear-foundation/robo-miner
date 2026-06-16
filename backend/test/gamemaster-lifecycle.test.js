import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { GameMasterLifecycleService, planWorldLifecycle } from '../src/modules/gameMaster/lifecycle.js';

const PROGRAM_ID = '0xdb0069475ed6d5fc3d9547e467de059a7cafc3ae';

const CONFIG = {
  adminKey: '0xadmin',
  sessionMs: 30 * 60 * 1000,
  factoryLobbyMin: 8,
  factoryLobbyCap: 10,
  factoryLobbyTimeoutMs: 5 * 60 * 1000,
  factoryAutoStartOnTimeout: false,
  factoryRecycle: true,
  factoryRecycleGraceMs: 5000,
  contractSurface: 1,
};

test('newly discovered active session gets a backend deadline instead of finishing immediately', () => {
  const now = new Date('2026-06-16T10:00:00.000Z');
  const world = {
    id: 'world-1',
    programId: PROGRAM_ID,
    status: 'active',
    sessionMs: CONFIG.sessionMs,
    session: { id: '4', status: 1 },
    chain: {},
  };

  const plan = planWorldLifecycle(world, { config: CONFIG, now });

  assert.equal(plan.actions.length, 0);
  assert.equal(plan.patch.startsAt, '2026-06-16T10:00:00.000Z');
  assert.equal(plan.patch.endsAt, '2026-06-16T10:30:00.000Z');
});

test('expired active session is finished by the game master admin', async () => {
  const store = new MemoryStore({
    worlds: [{
      id: 'world-1',
      programId: PROGRAM_ID,
      status: 'active',
      sessionMs: CONFIG.sessionMs,
      session: { id: '4', status: 1 },
      chain: { startedAt: '2026-06-16T10:00:00.000Z' },
      startsAt: '2026-06-16T10:00:00.000Z',
      endsAt: '2026-06-16T10:30:00.000Z',
    }],
  });
  const chain = makeChain();
  const service = new GameMasterLifecycleService({
    store,
    config: CONFIG,
    chainFactory: async () => chain,
    now: () => new Date('2026-06-16T10:31:00.000Z'),
    logger: silentLogger,
  });

  const result = await service.run({ dryRun: false });

  assert.equal(result.mode, 'live');
  assert.equal(result.actions, 1);
  assert.equal(chain.calls[0].payload.type, 'finish');

  const db = await store.read();
  assert.equal(db.worlds[0].status, 'finished');
  assert.equal(db.worlds[0].session.status, 2);
  assert.equal(db.worlds[0].finishedAt, '2026-06-16T10:31:00.000Z');
});

test('finished session is recycled with a fresh uploaded map after the grace period', async () => {
  const store = new MemoryStore({
    worlds: [{
      id: 'world-1',
      programId: PROGRAM_ID,
      status: 'finished',
      sessionMs: CONFIG.sessionMs,
      session: { id: '4', status: 2 },
      finishedAt: '2026-06-16T10:31:00.000Z',
      endsAt: '2026-06-16T10:30:00.000Z',
      agents: 10,
      owners: ['0xowner'],
      chain: { finishedAt: '2026-06-16T10:31:00.000Z' },
    }],
  });
  const chain = makeChain({ nextSessionId: 5 });
  const service = new GameMasterLifecycleService({
    store,
    config: CONFIG,
    chainFactory: async () => chain,
    now: () => new Date('2026-06-16T10:31:06.000Z'),
    logger: silentLogger,
  });

  const result = await service.run({ dryRun: false });

  assert.equal(result.actions, 1);
  assert.equal(chain.calls[0].payload.type, 'uploadMap');
  assert.equal(chain.calls[0].payload.map.length, 40 * 64);

  const db = await store.read();
  assert.equal(db.archives.length, 1);
  assert.equal(db.archives[0].archiveId, 'world-1-s4');
  assert.equal(db.archives[0].snapshot.rawGrid.length, 40 * 64);
  assert.equal(db.archives[0].snapshot.agents[0].owner, '0xowner');
  const archivedWorld = db.worlds.find((world) => world.archiveId === 'world-1-s4');
  assert.equal(archivedWorld.status, 'archived');
  assert.equal(archivedWorld.archiveUrl, '/api/archives/world-1-s4');

  assert.equal(db.worlds[0].status, 'waiting_agents');
  assert.equal(db.worlds[0].sessionId, '5');
  assert.equal(db.worlds[0].agents, 0);
  assert.deepEqual(db.worlds[0].owners, []);
  assert.equal(db.worlds[0].endsAt, null);
  assert.equal(db.worlds[0].finishedAt, null);
});

function makeChain({ nextSessionId = 1 } = {}) {
  return {
    calls: [],
    encode: {
      startSession: () => ({ type: 'start' }),
      finishSession: () => ({ type: 'finish' }),
      uploadMap: (seed, map) => ({ type: 'uploadMap', seed, map }),
      session: () => ({ type: 'session' }),
      config: () => ({ type: 'config' }),
      mapSnapshot: () => ({ type: 'mapSnapshot' }),
      agents: () => ({ type: 'agents' }),
      agentOf: (owner) => ({ type: 'agentOf', owner }),
      inventoryOf: (owner) => ({ type: 'inventoryOf', owner }),
    },
    decode: {
      session: () => [nextSessionId, 123, 0, 0],
      config: () => [40, 64, 1, 10, 8, 10],
      mapSnapshot: () => Array.from({ length: 40 * 64 }, (_, index) => (index < 40 ? 20 : 1)),
      agents: () => ['0xowner'],
      agentOf: () => [1, 2, 3, 10, 0, 0, 0, 0, 0, 0, 0, 10, 7],
      inventoryOf: () => [0, 0, 0, 1, 2, 3],
    },
    async sendAdmin(programId, payload) {
      this.calls.push({ programId, payload });
    },
    async query() {
      return { payload: '0x' };
    },
    async disconnect() {},
  };
}

const silentLogger = {
  warn() {},
};

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
