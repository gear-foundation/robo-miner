import assert from 'node:assert/strict';
import test from 'node:test';

import { InjectedIngestService } from '../src/modules/indexer/injectedIngest.js';
import { IndexerProjector } from '../src/modules/indexer/projector.js';
import { LeaderboardService } from '../src/modules/leaderboard/service.js';
import { normalizeDb } from '../src/db/jsonStore.js';

const CONFIG = {
  diggerRentalSeason: 'season-1',
  diggerDailyExecTarget: 120000000000000n,
};

const WORLD_ID = '0x936b5395876648772d37e22da57ba37c4e586df2';
const OWNER = '0x000000000000000000000000766270abf5dde72d374b3120c8aedc651ee3f184';

test('injected AgentSurfaced updates the MVP banked leaderboard', async () => {
  const store = new MemoryStore({
    worlds: [{ id: WORLD_ID, programId: WORLD_ID, seasonId: 'season-1' }],
  });
  const ingest = new InjectedIngestService({
    store,
    config: CONFIG,
    now: () => new Date('2026-06-11T00:00:00.000Z'),
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
