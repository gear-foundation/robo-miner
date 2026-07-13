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
  assert.equal(db.jobRuns[0].status, 'ok');
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
