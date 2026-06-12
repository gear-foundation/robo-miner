import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { DiggerRegistryService } from '../src/modules/diggerRegistry/service.js';
import { DiggerRentalService } from '../src/modules/diggerRental/service.js';

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
