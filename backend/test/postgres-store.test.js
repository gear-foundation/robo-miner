import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DatabaseBusyError,
  DatabaseUnavailableError,
  PostgresDocumentStore,
  PostgresStore,
} from '../src/db/postgresStore.js';

test('PostgresStore applies transaction timeouts before locking the shared document', async () => {
  const pool = new FakePool();
  const store = makeStore(pool, {
    lockTimeoutMs: 1_234,
    statementTimeoutMs: 5_678,
    idleTransactionTimeoutMs: 9_012,
  });

  const result = await store.update((db) => {
    db.jobRuns.push({ id: 'job-1' });
    return 'updated';
  });

  assert.equal(result, 'updated');
  assert.deepEqual(pool.clients[0].queries.slice(0, 5).map(queryText), [
    'BEGIN',
    "SET LOCAL lock_timeout = '1234ms'",
    "SET LOCAL statement_timeout = '5678ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '9012ms'",
    'SELECT data FROM "public".backend_documents WHERE id = $1 FOR UPDATE',
  ]);
  assert.equal(queryText(pool.clients[0].queries.at(-1)), 'COMMIT');
  assert.equal(pool.clients[0].released, true);
});

test('PostgresStore retries a transient lock timeout and then commits', async () => {
  const lockError = Object.assign(new Error('lock timeout'), { code: '55P03' });
  const pool = new FakePool({ failures: [lockError] });
  const store = makeStore(pool, { updateMaxAttempts: 2 });

  const result = await store.update(() => 'ok');

  assert.equal(result, 'ok');
  assert.equal(pool.clients.length, 2);
  assert.equal(pool.clients[0].queries.some((query) => queryText(query) === 'ROLLBACK'), true);
  assert.equal(pool.clients[0].released, true);
  assert.equal(queryText(pool.clients[1].queries.at(-1)), 'COMMIT');
});

test('PostgresStore returns a 503 database_busy error after retry exhaustion', async () => {
  const pool = new FakePool({
    failures: [
      Object.assign(new Error('lock timeout 1'), { code: '55P03' }),
      Object.assign(new Error('lock timeout 2'), { code: '55P03' }),
      Object.assign(new Error('lock timeout 3'), { code: '55P03' }),
    ],
  });
  const store = makeStore(pool, { updateMaxAttempts: 3 });

  await assert.rejects(
    store.update(() => undefined),
    (error) => {
      assert.equal(error instanceof DatabaseBusyError, true);
      assert.equal(error.message, 'database_busy');
      assert.equal(error.statusCode, 503);
      assert.equal(error.databaseCode, '55P03');
      return true;
    },
  );
  assert.equal(pool.clients.length, 3);
  assert.equal(pool.clients.every((client) => client.released), true);
});

test('PostgresStore does not retry non-transaction errors', async () => {
  const pool = new FakePool({ failures: [Object.assign(new Error('bad data'), { code: '22000' })] });
  const store = makeStore(pool, { updateMaxAttempts: 3 });

  await assert.rejects(store.update(() => undefined), /bad data/);
  assert.equal(pool.clients.length, 1);
});

test('PostgresStore recreates its pool and re-runs initialization after primary failover', async () => {
  const failedPool = new QueryPool({
    readError: Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
  });
  const recoveredPool = new QueryPool({ data: { jobRuns: [{ id: 'after-failover' }] } });
  const pools = [failedPool, recoveredPool];
  const store = new PostgresStore({
    connectionString: 'postgres://database.service/app',
    poolFactory: () => pools.shift(),
    updateMaxAttempts: 2,
    updateRetryBaseMs: 0,
  });

  const db = await store.read();

  assert.equal(db.jobRuns[0].id, 'after-failover');
  assert.equal(failedPool.ended, true);
  assert.equal(recoveredPool.queries.filter((query) => queryText(query).startsWith('CREATE TABLE')).length, 1);
});

test('PostgresStore does not permanently cache a failed readiness check', async () => {
  const failedPool = new QueryPool({
    initError: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  const recoveredPool = new QueryPool({ data: { worlds: [{ id: 'world-1' }] } });
  const pools = [failedPool, recoveredPool];
  const store = new PostgresStore({
    connectionString: 'postgres://database.service/app',
    poolFactory: () => pools.shift(),
    updateMaxAttempts: 2,
    updateRetryBaseMs: 0,
  });

  const db = await store.read();

  assert.equal(db.worlds[0].id, 'world-1');
  assert.equal(failedPool.ended, true);
});

test('PostgresStore reconnects and retries a transaction interrupted by failover', async () => {
  const failoverError = Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' });
  const failedPool = new FakePool({ failures: [failoverError] });
  const recoveredPool = new FakePool();
  const pools = [failedPool, recoveredPool];
  const store = new PostgresStore({
    connectionString: 'postgres://database.service/app',
    poolFactory: () => pools.shift(),
    updateMaxAttempts: 2,
    updateRetryBaseMs: 0,
  });

  const result = await store.update((db) => {
    db.jobRuns.push({ id: 'recovered-write' });
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(failedPool.ended, true);
  assert.equal(failedPool.clients[0].releaseError, failoverError);
  assert.equal(queryText(recoveredPool.clients[0].queries.at(-1)), 'COMMIT');
});

test('PostgresStore returns database_unavailable when reconnect attempts are exhausted', async () => {
  const pools = Array.from({ length: 4 }, () => new QueryPool({
    initError: Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' }),
  }));
  const store = new PostgresStore({
    connectionString: 'postgres://database.service/app',
    poolFactory: () => pools.shift(),
    updateMaxAttempts: 3,
    updateRetryBaseMs: 0,
  });

  await assert.rejects(
    store.read(),
    (error) => error instanceof DatabaseUnavailableError
      && error.statusCode === 503
      && error.databaseCode === '08006',
  );
});

test('PostgresDocumentStore also reconnects after primary failover', async () => {
  const failedPool = new QueryPool({
    readError: Object.assign(new Error('server closed the connection unexpectedly'), { code: '08006' }),
  });
  const recoveredPool = new QueryPool({ data: { status: 'ready' } });
  const pools = [failedPool, recoveredPool];
  const store = new PostgresDocumentStore({
    connectionString: 'postgres://database.service/app',
    poolFactory: () => pools.shift(),
    updateMaxAttempts: 2,
    updateRetryBaseMs: 0,
  });

  assert.deepEqual(await store.read('redeem:1'), { status: 'ready' });
  assert.equal(failedPool.ended, true);
});

function makeStore(pool, overrides = {}) {
  const store = new PostgresStore({
    pool,
    updateRetryBaseMs: 0,
    ...overrides,
  });
  store._ready = Promise.resolve();
  store._readyPool = pool;
  return store;
}

class FakePool {
  constructor({ failures = [] } = {}) {
    this.failures = [...failures];
    this.clients = [];
    this.ended = false;
  }

  on() {}

  async query() {
    return { rows: [] };
  }

  async connect() {
    const client = new FakeClient(this.failures.shift() || null);
    this.clients.push(client);
    return client;
  }

  async end() {
    this.ended = true;
  }
}

class FakeClient {
  constructor(failure) {
    this.failure = failure;
    this.queries = [];
    this.released = false;
    this.releaseError = null;
  }

  async query(text, params = undefined) {
    this.queries.push({ text, params });
    if (String(text).includes('FOR UPDATE') && this.failure) throw this.failure;
    if (String(text).includes('FOR UPDATE')) return { rows: [{ data: {} }] };
    return { rows: [] };
  }

  release(error = undefined) {
    this.released = true;
    this.releaseError = error || null;
  }
}

class QueryPool {
  constructor({ data = {}, initError = null, readError = null } = {}) {
    this.data = data;
    this.initError = initError;
    this.readError = readError;
    this.queries = [];
    this.ended = false;
  }

  on() {}

  async query(text, params = undefined) {
    const query = { text, params };
    this.queries.push(query);
    if (String(text).startsWith('CREATE SCHEMA') && this.initError) {
      const error = this.initError;
      this.initError = null;
      throw error;
    }
    if (/SELECT data FROM/.test(String(text)) && this.readError) {
      const error = this.readError;
      this.readError = null;
      throw error;
    }
    if (/SELECT data FROM/.test(String(text))) return { rows: [{ data: this.data }] };
    return { rows: [] };
  }

  async end() {
    this.ended = true;
  }
}

function queryText(query) {
  return String(query.text).replace(/\s+/g, ' ').trim();
}
