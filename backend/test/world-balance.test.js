import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { WorldBalanceService, selectWorldPrograms } from '../src/modules/gameMaster/worldBalance.js';

const VARA = 1_000_000_000_000n;
const WORLD_A = '0xb0860e1262e3677a65e24f821c8b6e4e5f5cd04b';
const WORLD_B = '0xcd8abd56353212b1c7b7107c150fbea366eb8663';

const CONFIG = {
  diggerRentalSeason: 'season-1',
  balanceCooldownMs: 120_000,
  worldBalanceMin: 150n * VARA,
  worldBalanceTopUp: 400n * VARA,
};

test('world balance top-up selects only current world programs', () => {
  const db = normalizeDb({
    worlds: [
      world({ id: 'live-a', programId: WORLD_A, status: 'waiting_agents' }),
      world({ id: 'dupe-a', programId: WORLD_A, status: 'active' }),
      world({ id: 'past-a', programId: WORLD_A, status: 'archived' }),
      world({ id: 'finished-b', programId: WORLD_B, status: 'finished' }),
    ],
  });

  const selected = selectWorldPrograms(db);

  assert.deepEqual(selected.map((item) => item.id), ['live-a']);
});

test('world balance top-up funds live worlds below the threshold', async () => {
  const store = new MemoryStore({
    worlds: [
      world({ id: 'world-1', programId: WORLD_A, status: 'waiting_agents' }),
    ],
  });
  const chain = {
    topUps: [],
    async readExecutableBalance(programId) {
      assert.equal(programId, WORLD_A);
      return 10n * VARA;
    },
    async topUpExecutableBalance(programId, amount) {
      this.topUps.push({ programId, amount });
      return { transactionHash: '0xtx', status: 'success' };
    },
  };
  const service = new WorldBalanceService({
    store,
    chain,
    config: CONFIG,
    now: () => new Date('2026-06-16T12:00:00.000Z'),
    logger: silentLogger,
  });

  const result = await service.run({ dryRun: false });

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'confirmed');
  assert.deepEqual(chain.topUps, [{ programId: WORLD_A, amount: 400n * VARA }]);

  const db = await store.read();
  assert.equal(db.worlds[0].executableBalance, (410n * VARA).toString());
  assert.equal(db.fuelGrants[0].type, 'world-balance');
  assert.equal(db.fuelGrants[0].programId, WORLD_A);
  assert.equal(db.jobRuns[0].job, 'world-balance-top-up');
});

test('world balance top-up respects cooldown after a recent live grant', async () => {
  const store = new MemoryStore({
    worlds: [
      world({ id: 'world-1', programId: WORLD_A, status: 'active' }),
    ],
    fuelGrants: [{
      id: 'grant-1',
      idempotencyKey: 'grant-1',
      type: 'world-balance',
      programId: WORLD_A,
      status: 'confirmed',
      updatedAt: '2026-06-16T12:00:30.000Z',
    }],
  });
  const chain = {
    topUps: [],
    async readExecutableBalance() {
      return 10n * VARA;
    },
    async topUpExecutableBalance(programId, amount) {
      this.topUps.push({ programId, amount });
      return { transactionHash: '0xtx', status: 'success' };
    },
  };
  const service = new WorldBalanceService({
    store,
    chain,
    config: CONFIG,
    now: () => new Date('2026-06-16T12:01:00.000Z'),
    logger: silentLogger,
  });

  const result = await service.run({ dryRun: false });

  assert.equal(result[0].status, 'skipped');
  assert.equal(result[0].reason, 'cooldown');
  assert.deepEqual(chain.topUps, []);
});

test('world balance dry run records intent without sending chain top-up', async () => {
  const store = new MemoryStore({
    worlds: [
      world({ id: 'world-1', programId: WORLD_A, status: 'open', executableBalance: '0' }),
    ],
  });
  const service = new WorldBalanceService({
    store,
    chain: null,
    config: CONFIG,
    now: () => new Date('2026-06-16T12:00:00.000Z'),
    logger: silentLogger,
  });

  const result = await service.run({ dryRun: true });

  assert.equal(result[0].status, 'dry-run');
  const db = await store.read();
  assert.equal(db.fuelGrants[0].status, 'dry-run');
  assert.equal(db.worlds[0].executableBalance, '0');
});

function world(overrides = {}) {
  return {
    id: overrides.id || 'world',
    seasonId: 'season-1',
    status: overrides.status || 'waiting_agents',
    programId: overrides.programId || WORLD_A,
    executableBalance: overrides.executableBalance || '0',
    updatedAt: '2026-06-16T11:00:00.000Z',
  };
}

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

const silentLogger = {
  info() {},
};
