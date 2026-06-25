import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminService } from '../src/modules/admin/service.js';

test('testnet reset clears registry and queues a factory reset request', async () => {
  const store = new MemoryStore({ worlds: [{ id: 'w001' }], jobRuns: [{ id: 'old' }] });
  const documents = new MemoryDocumentStore({
    'testnet:factory:factory-live': { worlds: [{ id: 'w001' }] },
    'testnet:factory:factory-programs': { programs: ['0xold'] },
    'testnet:factory:gamemaster': { worlds: [{ id: 'w001', programId: '0xold' }] },
  });
  const service = new AdminService({
    store,
    documentStore: documents,
    config: makeConfig({ network: 'testnet', databaseDocumentId: 'testnet' }),
    chainFactory: async () => null,
    now: () => new Date('2026-06-25T12:00:00.000Z'),
  });

  const result = await service.resetTestnetState({
    scope: 'all',
    confirm: 'reset-testnet',
    restartFactory: true,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.scope, 'all');
  assert.equal(result.resetRegistry, true);
  assert.equal(result.resetFactory, true);
  assert.equal(result.factoryResetQueued, true);
  assert.deepEqual(documents.deleted, [[
    'testnet:factory:factory-live',
    'testnet:factory:factory-programs',
    'testnet:factory:factory-past',
    'testnet:factory:gamemaster',
    'testnet:factory:balance-keeper',
  ]]);
  assert.equal(documents.writes[0].id, 'testnet:factory:factory-reset-request');
  assert.equal(documents.writes[0].data.status, 'pending');
  assert.equal(documents.writes[0].data.network, 'testnet');

  const db = await store.read();
  assert.deepEqual(db.worlds, []);
  assert.equal(db.jobRuns[0].job, 'admin-testnet-reset');
});

test('testnet factory reset requires a factory restart', async () => {
  const service = new AdminService({
    store: new MemoryStore(),
    documentStore: new MemoryDocumentStore(),
    config: makeConfig({ network: 'testnet', databaseDocumentId: 'testnet' }),
    chainFactory: async () => null,
  });

  await assert.rejects(
    service.resetTestnetState({
      scope: 'factory',
      confirm: 'reset-testnet',
      restartFactory: false,
    }),
    /factory reset requires restartFactory=true/,
  );
});

test('testnet reset is rejected outside the testnet namespace', async () => {
  const service = new AdminService({
    store: new MemoryStore(),
    documentStore: new MemoryDocumentStore(),
    config: makeConfig({ network: 'mainnet', databaseDocumentId: 'mainnet' }),
    chainFactory: async () => null,
  });

  await assert.rejects(
    service.resetTestnetState({
      scope: 'all',
      confirm: 'reset-testnet',
      restartFactory: true,
    }),
    /only available for the testnet/,
  );
});

function makeConfig(overrides = {}) {
  return {
    network: 'testnet',
    databaseDocumentId: 'testnet',
    storeBackend: 'postgres',
    stateDir: '/tmp/digger-state',
    ...overrides,
  };
}

class MemoryStore {
  constructor(initial = {}) {
    this.db = { worlds: [], jobRuns: [], ...structuredClone(initial) };
  }

  async read() {
    return structuredClone(this.db);
  }

  async write(db) {
    this.db = {
      worlds: [],
      jobRuns: [],
      ...structuredClone(db),
    };
  }
}

class MemoryDocumentStore {
  constructor(initial = {}) {
    this.docs = new Map(Object.entries(structuredClone(initial)));
    this.deleted = [];
    this.writes = [];
  }

  async deleteMany(ids) {
    this.deleted.push([...ids]);
    const deleted = [];
    for (const id of ids) {
      if (this.docs.delete(id)) deleted.push(id);
    }
    return deleted;
  }

  async write(id, data) {
    this.docs.set(id, structuredClone(data));
    this.writes.push({ id, data: structuredClone(data) });
  }
}
