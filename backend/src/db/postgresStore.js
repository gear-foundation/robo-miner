import pg from 'pg';
import { normalizeDb } from './jsonStore.js';
import { createLogger } from '../logger.js';

const { Pool } = pg;
const logger = createLogger('database');
const DEFAULT_DOCUMENT_ID = 'main';
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01', '55P03', '57014']);
const RETRYABLE_CONNECTION_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '25006',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

export class DatabaseBusyError extends Error {
  constructor(cause) {
    super('database_busy', { cause });
    this.name = 'DatabaseBusyError';
    this.code = 'database_busy';
    this.statusCode = 503;
    this.databaseCode = cause?.code || null;
  }
}

export class DatabaseUnavailableError extends Error {
  constructor(cause) {
    super('database_unavailable', { cause });
    this.name = 'DatabaseUnavailableError';
    this.code = 'database_unavailable';
    this.statusCode = 503;
    this.databaseCode = cause?.code || null;
  }
}

class ResilientPostgresPool {
  constructor({
    connectionString,
    pool = null,
    poolFactory = null,
    connectionTimeoutMs = 5_000,
    queryTimeoutMs = 20_000,
    maxAttempts = 3,
    retryBaseMs = 100,
  }) {
    this.connectionString = connectionString || null;
    this.connectionTimeoutMs = positiveInteger(connectionTimeoutMs, 5_000);
    this.queryTimeoutMs = positiveInteger(queryTimeoutMs, 20_000);
    this.maxAttempts = positiveInteger(maxAttempts, 3);
    this.retryBaseMs = nonNegativeInteger(retryBaseMs, 100);
    this.poolFactory = poolFactory || (this.connectionString ? (options) => new Pool(options) : null);
    this._ready = null;
    this._readyPool = null;
    this._closed = false;
    this.pool = pool || this.createPool();
    this.watchPool(this.pool);
  }

  createPool() {
    if (!this.poolFactory) throw new Error('Postgres pool cannot be recreated without DATABASE_URL');
    return this.poolFactory({
      connectionString: this.connectionString,
      allowExitOnIdle: true,
      connectionTimeoutMillis: this.connectionTimeoutMs,
      query_timeout: this.queryTimeoutMs,
      keepAlive: true,
    });
  }

  watchPool(pool) {
    pool?.on?.('error', (error) => {
      if (isRetryableConnectionError(error)) this.replacePool(pool, error);
    });
  }

  async ready(pool = this.pool) {
    if (this._ready && this._readyPool === pool) return this._ready;
    const ready = this.init(pool);
    this._ready = ready;
    this._readyPool = pool;
    try {
      return await ready;
    } catch (error) {
      if (this._ready === ready) {
        this._ready = null;
        this._readyPool = null;
      }
      throw error;
    }
  }

  async withRetry(operation, { retryTransactions = true } = {}) {
    let lastError = null;
    let lastKind = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const pool = this.pool;
      try {
        await this.ready(pool);
        return await operation(pool);
      } catch (error) {
        lastError = error;
        if (isRetryableConnectionError(error)) {
          lastKind = 'connection';
          this.replacePool(pool, error);
        } else if (retryTransactions && isRetryableTransactionError(error)) {
          lastKind = 'transaction';
        } else {
          throw error;
        }
        if (attempt < this.maxAttempts) await delay(retryDelay(this.retryBaseMs, attempt));
      }
    }
    if (lastKind === 'connection') throw new DatabaseUnavailableError(lastError);
    throw new DatabaseBusyError(lastError);
  }

  replacePool(failedPool, cause = null) {
    if (this._closed || this.pool !== failedPool || !this.poolFactory) return false;
    const replacement = this.createPool();
    this.pool = replacement;
    this._ready = null;
    this._readyPool = null;
    this.watchPool(replacement);
    retirePool(failedPool);
    logger.warn('pool.recreated', {
      reason: 'retryable_connection_error',
      databaseCode: cause?.code || null,
    });
    return true;
  }

  async close() {
    this._closed = true;
    await this.pool.end();
  }
}

export class PostgresStore extends ResilientPostgresPool {
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
    poolFactory = null,
  }) {
    if (!connectionString && !pool) throw new Error('DATABASE_URL is required for PostgresStore');
    super({
      connectionString,
      pool,
      poolFactory,
      connectionTimeoutMs,
      queryTimeoutMs,
      maxAttempts: updateMaxAttempts,
      retryBaseMs: updateRetryBaseMs,
    });
    this.documentId = documentId;
    this.schema = schema;
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, 5_000);
    this.statementTimeoutMs = positiveInteger(statementTimeoutMs, 15_000);
    this.idleTransactionTimeoutMs = positiveInteger(idleTransactionTimeoutMs, 15_000);
  }

  async init(pool) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(this.schema)}`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName()} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `INSERT INTO ${this.tableName()} (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [this.documentId, JSON.stringify(normalizeDb({}))],
    );
  }

  async read() {
    return this.withRetry(async (pool) => {
      const result = await pool.query(
        `SELECT data FROM ${this.tableName()} WHERE id = $1`,
        [this.documentId],
      );
      return normalizeDb(result.rows[0]?.data || {});
    });
  }

  async write(db) {
    return this.withRetry((pool) => pool.query(
      `INSERT INTO ${this.tableName()} (id, data, updated_at)
        VALUES ($1, $2::jsonb, now())
        ON CONFLICT (id)
        DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [this.documentId, JSON.stringify(normalizeDb(db))],
    ));
  }

  async update(mutator) {
    return this.withRetry((pool) => this.updateOnce(mutator, pool), { retryTransactions: true });
  }

  async updateOnce(mutator, pool = this.pool) {
    await this.ready(pool);
    const client = await pool.connect();
    let caughtError = null;
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
      caughtError = error;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(isRetryableConnectionError(caughtError) ? caughtError : undefined);
    }
  }

  tableName() {
    return `${ident(this.schema)}.backend_documents`;
  }
}

export class PostgresDocumentStore extends ResilientPostgresPool {
  constructor({
    connectionString,
    schema = 'public',
    pool = null,
    poolFactory = null,
    connectionTimeoutMs = 5_000,
    queryTimeoutMs = 20_000,
    updateMaxAttempts = 3,
    updateRetryBaseMs = 100,
  }) {
    if (!connectionString && !pool) throw new Error('DATABASE_URL is required for PostgresDocumentStore');
    super({
      connectionString,
      pool,
      poolFactory,
      connectionTimeoutMs,
      queryTimeoutMs,
      maxAttempts: updateMaxAttempts,
      retryBaseMs: updateRetryBaseMs,
    });
    this.schema = schema;
  }

  async init(pool) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(this.schema)}`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName()} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async read(id, fallback = null) {
    return this.withRetry(async (pool) => {
      const result = await pool.query(
        `SELECT data FROM ${this.tableName()} WHERE id = $1`,
        [id],
      );
      return result.rows[0]?.data ?? fallback;
    });
  }

  async write(id, data) {
    return this.withRetry((pool) => pool.query(
      `INSERT INTO ${this.tableName()} (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [id, JSON.stringify(data ?? null)],
    ));
  }

  async deleteMany(ids) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
    if (!uniqueIds.length) return [];
    return this.withRetry(async (pool) => {
      const result = await pool.query(
        `DELETE FROM ${this.tableName()} WHERE id = ANY($1::text[]) RETURNING id`,
        [uniqueIds],
      );
      return result.rows.map((row) => row.id);
    });
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

export function isRetryableConnectionError(error) {
  const code = String(error?.code || '');
  if (code.startsWith('08') || RETRYABLE_CONNECTION_CODES.has(code)) return true;
  return /connection terminated|connection.*closed|server closed the connection|socket hang up|socket.*closed|not queryable/i
    .test(String(error?.message || ''));
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

function retryDelay(baseMs, attempt) {
  if (baseMs <= 0) return 0;
  const exponential = baseMs * (2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(Math.random() * exponential);
}

function retirePool(pool) {
  try {
    Promise.resolve(pool?.end?.()).catch(() => undefined);
  } catch {
    // The failed pool has already been detached; a close error must not block reconnect.
  }
}
