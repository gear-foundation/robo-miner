import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseBusyError, PostgresStore } from '../src/db/postgresStore.js';

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

function makeStore(pool, overrides = {}) {
  const store = new PostgresStore({
    pool,
    updateRetryBaseMs: 0,
    ...overrides,
  });
  store._ready = Promise.resolve();
  return store;
}

class FakePool {
  constructor({ failures = [] } = {}) {
    this.failures = [...failures];
    this.clients = [];
  }

  async connect() {
    const client = new FakeClient(this.failures.shift() || null);
    this.clients.push(client);
    return client;
  }
}

class FakeClient {
  constructor(failure) {
    this.failure = failure;
    this.queries = [];
    this.released = false;
  }

  async query(text, params = undefined) {
    this.queries.push({ text, params });
    if (String(text).includes('FOR UPDATE') && this.failure) throw this.failure;
    if (String(text).includes('FOR UPDATE')) return { rows: [{ data: {} }] };
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

function queryText(query) {
  return String(query.text).replace(/\s+/g, ' ').trim();
}
