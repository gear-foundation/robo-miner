import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { DiggerRegistryService } from '../src/modules/diggerRegistry/service.js';
import { DiggerRentalService, DiggerSessionLockedError } from '../src/modules/diggerRental/service.js';

const CONFIG = {
  diggerRentalSeason: 'season-1',
  diggerDailyExecTarget: 120000000000000n,
  diggerProgramIds: [],
  diggerProxyCodeId: '0xcode',
};

const OWNER = '0x766270abf5dde72d374b3120c8aedc651ee3f184';
const OWNER_MIXED = '0x766270Abf5DDe72D374b3120c8AEdc651Ee3f184';
const WORLD = '0x936b5395876648772d37e22da57ba37c4e586df2';

test('digger rental request stores owner to active digger and returns existing on duplicate', async () => {
  const store = new MemoryStore();
  const rental = new DiggerRentalService({
    store,
    chain: null,
    config: CONFIG,
    now: fixedNow,
  });

  const first = await rental.requestDigger({
    owner: OWNER_MIXED,
    worldId: WORLD,
    dryRun: true,
  });
  const second = await rental.requestDigger({
    owner: OWNER,
    worldId: WORLD,
    dryRun: true,
  });

  assert.equal(first.status, 'dry-run');
  assert.equal(second.status, 'existing');
  assert.equal(second.programId, first.programId);

  const db = await store.read();
  assert.equal(db.diggers.length, 1);
  assert.equal(db.diggers[0].owner, OWNER);
  assert.equal(db.diggers[0].worldId, WORLD);
  assert.equal(db.diggers[0].status, 'planned');
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
});

test('legacy world labels do not block new digger rentals', async () => {
  const store = new MemoryStore({
    diggers: [{
      id: '0x1111111111111111111111111111111111111111',
      programId: '0x1111111111111111111111111111111111111111',
      owner: OWNER,
      seasonId: 'season-1',
      worldId: 'w011',
      status: 'exited',
    }],
  });
  const rental = new DiggerRentalService({
    store,
    chain: null,
    config: CONFIG,
    now: fixedNow,
  });

  const request = await rental.requestDigger({
    owner: OWNER,
    worldId: WORLD,
    seasonId: 'season-2',
    dryRun: true,
  });
  const queued = await rental.enqueueDiggerRequest({
    owner: OWNER,
    worldId: WORLD,
    seasonId: 'season-3',
  });

  assert.equal(request.status, 'dry-run');
  assert.equal(queued.status, 'pending');
});

test('a dead digger blocks only the current session of its own world', async () => {
  const otherWorld = '0x1111111111111111111111111111111111111111';
  const store = new MemoryStore({
    worlds: [{ id: WORLD, programId: WORLD, sessionId: '8' }],
    diggers: [{
      id: '0x2222222222222222222222222222222222222222',
      programId: '0x2222222222222222222222222222222222222222',
      owner: OWNER,
      seasonId: 'season-1',
      worldId: WORLD,
      sessionId: '8',
      status: 'dead',
    }],
  });
  const rental = new DiggerRentalService({
    store,
    chain: null,
    config: CONFIG,
    now: fixedNow,
  });

  await assert.rejects(
    rental.requestDigger({ owner: OWNER, worldId: WORLD, dryRun: true }),
    (error) => error instanceof DiggerSessionLockedError && error.statusCode === 409,
  );

  const otherWorldRequest = await rental.requestDigger({ owner: OWNER, worldId: otherWorld, dryRun: true });
  assert.equal(otherWorldRequest.status, 'dry-run');

  await store.update((db) => {
    db.worlds[0].sessionId = '9';
  });
  const nextSessionRequest = await rental.requestDigger({ owner: OWNER, worldId: WORLD, dryRun: true });
  assert.equal(nextSessionRequest.status, 'dry-run');
});

test('digger registry lists my active digger by normalized owner/world filters', async () => {
  const store = new MemoryStore({
    diggers: [
      {
        id: '0x1111111111111111111111111111111111111111',
        programId: '0x1111111111111111111111111111111111111111',
        owner: null,
        seasonId: 'season-1',
        worldId: null,
        status: 'active',
        createdAt: '2026-06-11T00:00:00.000Z',
      },
      {
        id: '0x2222222222222222222222222222222222222222',
        programId: '0x2222222222222222222222222222222222222222',
        owner: OWNER,
        seasonId: 'season-1',
        worldId: WORLD,
        status: 'active',
        executableBalance: '120000000000000',
        createdAt: '2026-06-11T00:00:01.000Z',
      },
    ],
  });
  const registry = new DiggerRegistryService({ store, config: CONFIG });

  const diggers = await registry.list({
    owner: OWNER_MIXED,
    worldId: WORLD.toUpperCase(),
    seasonId: 'season-1',
    status: 'active',
  });

  assert.equal(diggers.length, 1);
  assert.equal(diggers[0].programId, '0x2222222222222222222222222222222222222222');
  assert.equal(Object.hasOwn(diggers[0], 'executableBalance'), false);
  assert.equal(Object.hasOwn(diggers[0], 'executableBalanceObservedAt'), false);
});

test('digger registry ignores legacy world labels while filtering by current world', async () => {
  const store = new MemoryStore({
    diggers: [
      {
        id: '0x1111111111111111111111111111111111111111',
        programId: '0x1111111111111111111111111111111111111111',
        owner: OWNER,
        seasonId: 'season-1',
        worldId: 'w011',
        status: 'exited',
      },
      {
        id: '0x2222222222222222222222222222222222222222',
        programId: '0x2222222222222222222222222222222222222222',
        owner: OWNER,
        seasonId: 'season-1',
        worldId: WORLD,
        status: 'active',
      },
    ],
  });
  const registry = new DiggerRegistryService({ store, config: CONFIG });

  const diggers = await registry.list({ owner: OWNER, worldId: WORLD });

  assert.equal(diggers.length, 1);
  assert.equal(diggers[0].programId, '0x2222222222222222222222222222222222222222');
});

test('digger registry hides legacy executable balance observations', async () => {
  const programId = '0x3333333333333333333333333333333333333333';
  const observedAt = '2026-06-11T01:00:00.000Z';
  const store = new MemoryStore({
    diggers: [{
      id: programId,
      programId,
      owner: OWNER,
      seasonId: 'season-1',
      worldId: WORLD,
      status: 'active',
      executableBalance: '108085080827500',
      executableBalanceObservedAt: observedAt,
    }],
  });
  const registry = new DiggerRegistryService({ store, config: CONFIG });
  const [digger] = await registry.list({ owner: OWNER });

  assert.equal(Object.hasOwn(digger, 'executableBalance'), false);
  assert.equal(Object.hasOwn(digger, 'executableBalanceObservedAt'), false);
});

test('queued live digger rental returns pending and completes to active digger', async () => {
  const store = new MemoryStore();
  const rental = new DiggerRentalService({
    store,
    chain: null,
    config: CONFIG,
    now: fixedNow,
  });

  const queued = await rental.enqueueDiggerRequest({
    owner: OWNER_MIXED,
    worldId: WORLD,
  });
  const duplicate = await rental.enqueueDiggerRequest({
    owner: OWNER,
    worldId: WORLD,
  });

  assert.equal(queued.status, 'pending');
  assert.equal(duplicate.status, 'pending');
  assert.equal(duplicate.requestId, queued.requestId);

  const processor = new DiggerRentalService({
    store,
    chain: {
      async deployDigger() {
        return {
          programId: '0x4444444444444444444444444444444444444444',
          createTxHash: '0xcreate',
          topUpTxHash: '0xtopup',
          initTxHash: '0xinit',
        };
      },
      async verifyDiggerReady({ programId, owner, worldId }) {
        assert.equal(programId, '0x4444444444444444444444444444444444444444');
        assert.equal(owner, OWNER);
        assert.equal(worldId, WORLD);
      },
    },
    config: CONFIG,
    now: fixedNow,
  });

  await processor.processQueuedDiggerRequest(queued.requestId);

  const db = await store.read();
  assert.equal(db.rentalRequests.length, 1);
  assert.equal(db.rentalRequests[0].status, 'confirmed');
  assert.equal(db.rentalRequests[0].programId, '0x4444444444444444444444444444444444444444');
  assert.equal(db.diggers.length, 1);
  assert.equal(db.diggers[0].owner, OWNER);
  assert.equal(db.diggers[0].worldId, WORLD);
  assert.equal(db.diggers[0].status, 'active');
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
  assert.equal(db.jobRuns[0].status, 'ok');
});

test('daily live top-up reads executable balance from chain and does not persist it on digger', async () => {
  const programId = '0x3333333333333333333333333333333333333333';
  const current = 30_000_000_000_000n;
  const expectedTopUp = CONFIG.diggerDailyExecTarget - current;
  const calls = [];
  const store = new MemoryStore({
    diggers: [{
      id: programId,
      programId,
      owner: OWNER,
      seasonId: 'season-1',
      status: 'active',
      executableBalance: CONFIG.diggerDailyExecTarget.toString(),
    }],
  });
  const rental = new DiggerRentalService({
    store,
    chain: {
      async readExecutableBalance(id) {
        calls.push({ type: 'read', programId: id });
        return current;
      },
      async topUpExecutableBalance(id, amount) {
        calls.push({ type: 'top-up', programId: id, amount });
        return { transactionHash: '0xtopup', status: 'success' };
      },
    },
    config: CONFIG,
    now: fixedNow,
  });

  const results = await rental.runDailyTopUp({ dryRun: false });

  assert.deepEqual(calls, [
    { type: 'read', programId },
    { type: 'top-up', programId, amount: expectedTopUp },
  ]);
  assert.equal(results[0].current, current.toString());
  assert.equal(results[0].amount, expectedTopUp.toString());
  const db = await store.read();
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
  assert.equal(db.fuelGrants[0].balanceBefore, current.toString());
});

test('daily dry-run reports unknown balance unless the operator supplies an assumption', async () => {
  const programId = '0x6666666666666666666666666666666666666666';
  const store = new MemoryStore({
    diggers: [{
      id: programId,
      programId,
      seasonId: 'season-1',
      status: 'active',
    }],
  });
  const rental = new DiggerRentalService({ store, chain: null, config: CONFIG, now: fixedNow });

  const unknown = await rental.runDailyTopUp({ dryRun: true });
  assert.deepEqual(unknown, [{
    programId,
    status: 'skipped',
    reason: 'current_balance_unknown',
    current: null,
    target: CONFIG.diggerDailyExecTarget.toString(),
  }]);

  const assumed = await rental.runDailyTopUp({ dryRun: true, assumeBalance: 20_000_000_000_000n });
  assert.equal(assumed[0].status, 'dry-run');
  assert.equal(assumed[0].amount, '100000000000000');
});

test('queued live digger rentals can be processed as a scheduler batch', async () => {
  const store = new MemoryStore();
  const rental = new DiggerRentalService({
    store,
    chain: null,
    config: CONFIG,
    now: fixedNow,
  });
  const queued = await rental.enqueueDiggerRequest({
    owner: OWNER,
    worldId: WORLD,
  });
  const processor = new DiggerRentalService({
    store,
    chain: {
      async deployDigger() {
        return {
          programId: '0x5555555555555555555555555555555555555555',
          createTxHash: '0xcreate',
          topUpTxHash: '0xtopup',
          initTxHash: '0xinit',
        };
      },
      async verifyDiggerReady() {},
    },
    config: CONFIG,
    now: fixedNow,
  });

  const results = await processor.processQueuedDiggerRequests();

  assert.deepEqual(results, [{
    requestId: queued.requestId,
    status: 'confirmed',
    programId: '0x5555555555555555555555555555555555555555',
  }]);
  const db = await store.read();
  assert.equal(db.rentalRequests[0].status, 'confirmed');
  assert.equal(db.diggers[0].status, 'active');
});

test('queued rental stays unpublished when proxy readiness verification fails', async () => {
  const store = new MemoryStore();
  const rental = new DiggerRentalService({ store, chain: null, config: CONFIG, now: fixedNow });
  const queued = await rental.enqueueDiggerRequest({ owner: OWNER, worldId: WORLD });
  const processor = new DiggerRentalService({
    store,
    chain: {
      async deployDigger() {
        return { programId: '0x6666666666666666666666666666666666666666' };
      },
      async verifyDiggerReady() {
        throw new Error('proxy owner/world query timed out');
      },
    },
    config: CONFIG,
    now: fixedNow,
  });

  await assert.rejects(() => processor.processQueuedDiggerRequest(queued.requestId), /timed out/);
  const db = await store.read();
  assert.equal(db.rentalRequests[0].status, 'failed');
  assert.equal(db.rentalRequests[0].programId, null);
  assert.equal(db.diggers.length, 0);
});

test('queued rental preserves a broadcast transaction for safe recovery after a receipt timeout', async () => {
  const store = new MemoryStore();
  const rental = new DiggerRentalService({ store, chain: null, config: CONFIG, now: fixedNow });
  const queued = await rental.enqueueDiggerRequest({ owner: OWNER, worldId: WORLD });
  const processor = new DiggerRentalService({
    store,
    chain: {
      async deployDigger({ onProgress }) {
        await onProgress({ stage: 'create_broadcast', createTxHash: '0xbroadcast' });
        throw new Error('create program receipt timed out after 120000ms');
      },
      async verifyDiggerReady() {},
    },
    config: CONFIG,
    now: fixedNow,
  });

  await assert.rejects(() => processor.processQueuedDiggerRequest(queued.requestId), /receipt timed out/);
  const db = await store.read();
  assert.equal(db.rentalRequests[0].status, 'confirmation_pending');
  assert.equal(db.rentalRequests[0].stage, 'create_broadcast');
  assert.equal(db.rentalRequests[0].createTxHash, '0xbroadcast');

  const duplicate = await rental.enqueueDiggerRequest({ owner: OWNER, worldId: WORLD });
  assert.equal(duplicate.status, 'confirmation_pending');
  assert.equal(duplicate.requestId, queued.requestId);
});

test('daily grant idempotency does not persist the freshly observed executable balance', async () => {
  const programId = '0x7777777777777777777777777777777777777777';
  const observed = 108085080827500n;
  const store = new MemoryStore({
    worlds: [{ id: WORLD, status: 'active' }],
    diggers: [{
      id: programId,
      programId,
      owner: OWNER,
      seasonId: 'season-1',
      worldId: WORLD,
      status: 'active',
      targetExecBalance: CONFIG.diggerDailyExecTarget.toString(),
      executableBalance: CONFIG.diggerDailyExecTarget.toString(),
    }],
    fuelGrants: [{
      id: 'today',
      idempotencyKey: `season-1:${programId}:2026-06-11:daily-rental`,
      status: 'confirmed',
    }],
  });
  const rental = new DiggerRentalService({
    store,
    chain: {
      async readExecutableBalance() { return observed; },
      async topUpExecutableBalance() { throw new Error('must not top up twice in one day'); },
    },
    config: CONFIG,
    now: fixedNow,
  });

  const results = await rental.runDailyTopUp({ dryRun: false });
  assert.equal(results[0].reason, 'already_granted_today');
  const db = await store.read();
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalanceObservedAt'), false);
});

function fixedNow() {
  return new Date('2026-06-11T00:00:00.000Z');
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
