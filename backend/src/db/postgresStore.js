import pg from 'pg';
import { normalizeDb } from './jsonStore.js';

const { Pool } = pg;
const DEFAULT_DOCUMENT_ID = 'main';
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01', '55P03', '57014']);

export class DatabaseBusyError extends Error {
  constructor(cause) {
    super('database_busy', { cause });
    this.name = 'DatabaseBusyError';
    this.code = 'database_busy';
    this.statusCode = 503;
    this.databaseCode = cause?.code || null;
  }
}

export class PostgresStore {
  constructor({
    connectionString,
    documentId = DEFAULT_DOCUMENT_ID,
    schema = 'public',
    pool = null,
    connectionTimeoutMs = 5_000,
    queryTimeoutMs = 20_000,
    lockTimeoutMs = 5_000,
    statementTimeoutMs = 15_000,
    idleTransactionTimeoutMs = 15_000,
    updateMaxAttempts = 3,
    updateRetryBaseMs = 100,
  }) {
    if (!connectionString && !pool) throw new Error('DATABASE_URL is required for PostgresStore');
    this.documentId = documentId;
    this.schema = schema;
    this.connectionTimeoutMs = positiveInteger(connectionTimeoutMs, 5_000);
    this.queryTimeoutMs = positiveInteger(queryTimeoutMs, 20_000);
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, 5_000);
    this.statementTimeoutMs = positiveInteger(statementTimeoutMs, 15_000);
    this.idleTransactionTimeoutMs = positiveInteger(idleTransactionTimeoutMs, 15_000);
    this.updateMaxAttempts = positiveInteger(updateMaxAttempts, 3);
    this.updateRetryBaseMs = nonNegativeInteger(updateRetryBaseMs, 100);
    this.pool = pool || new Pool({
      connectionString,
      allowExitOnIdle: true,
      connectionTimeoutMillis: this.connectionTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      keepAlive: true,
    });
    this._ready = null;
  }

  async ready() {
    if (!this._ready) this._ready = this.init();
    return this._ready;
  }

  async init() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(this.schema)}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName()} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `INSERT INTO ${this.tableName()} (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [this.documentId, JSON.stringify(normalizeDb({}))],
    );
  }

  async read() {
    await this.ready();
    const result = await this.pool.query(
      `SELECT data FROM ${this.tableName()} WHERE id = $1`,
      [this.documentId],
    );
    return normalizeDb(result.rows[0]?.data || {});
  }

  async write(db) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.tableName()} (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [this.documentId, JSON.stringify(normalizeDb(db))],
    );
  }

  async update(mutator) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.updateMaxAttempts; attempt += 1) {
      try {
        return await this.updateOnce(mutator);
      } catch (error) {
        if (!isRetryableTransactionError(error)) throw error;
        lastError = error;
        if (attempt < this.updateMaxAttempts) {
          await delay(this.updateRetryBaseMs * attempt);
        }
      }
    }
    throw new DatabaseBusyError(lastError);
  }

  async updateOnce(mutator) {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.idleTransactionTimeoutMs}ms'`);
      const result = await client.query(
        `SELECT data FROM ${this.tableName()} WHERE id = $1 FOR UPDATE`,
        [this.documentId],
      );
      const db = normalizeDb(result.rows[0]?.data || {});
      const mutatorResult = await mutator(db);
      await client.query(
        `UPDATE ${this.tableName()} SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
        [this.documentId, JSON.stringify(normalizeDb(db))],
      );
      await client.query('COMMIT');
      return mutatorResult;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  tableName() {
    return `${ident(this.schema)}.backend_documents`;
  }
}

export class PostgresDocumentStore {
  constructor({ connectionString, schema = 'public', pool = null }) {
    if (!connectionString && !pool) throw new Error('DATABASE_URL is required for PostgresDocumentStore');
    this.schema = schema;
    this.pool = pool || new Pool({ connectionString, allowExitOnIdle: true });
    this._ready = null;
  }

  async ready() {
    if (!this._ready) this._ready = this.init();
    return this._ready;
  }

  async init() {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(this.schema)}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName()} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async read(id, fallback = null) {
    await this.ready();
    const result = await this.pool.query(
      `SELECT data FROM ${this.tableName()} WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.data ?? fallback;
  }

  async write(id, data) {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.tableName()} (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [id, JSON.stringify(data ?? null)],
    );
  }

  async deleteMany(ids) {
    await this.ready();
    const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
    if (!uniqueIds.length) return [];
    const result = await this.pool.query(
      `DELETE FROM ${this.tableName()} WHERE id = ANY($1::text[]) RETURNING id`,
      [uniqueIds],
    );
    return result.rows.map((row) => row.id);
  }

  tableName() {
    return `${ident(this.schema)}.backend_documents`;
  }
}

function ident(value) {
  const s = String(value || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) throw new Error(`Invalid Postgres identifier: ${value}`);
  return `"${s.replace(/"/g, '""')}"`;
}

function isRetryableTransactionError(error) {
  return RETRYABLE_TRANSACTION_CODES.has(error?.code);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
