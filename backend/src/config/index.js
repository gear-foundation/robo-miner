import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFor, adminKeyFor, DEFAULT_NETWORK } from './networks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');

loadDotEnv(path.join(BACKEND_ROOT, '.env'));

const WVARA = 1_000_000_000_000n;

export const DEFAULT_DIGGER_DAILY_EXEC_TARGET = 120n * WVARA;
export const DEFAULT_SOCIAL_REPOST_FUEL_GRANT = 60n * WVARA;
export const DEFAULT_SOCIAL_QUOTE_FUEL_GRANT = 120n * WVARA;

export function loadConfig(env = process.env) {
  const storeBackend = (env.BACKEND_STORE || (env.DATABASE_URL ? 'postgres' : 'json')).toLowerCase();
  const network = String(env.CHAIN_NETWORK || DEFAULT_NETWORK).toLowerCase();
  const profile = profileFor(network);
  return {
    rootDir: BACKEND_ROOT,
    stateDir: path.resolve(BACKEND_ROOT, env.BACKEND_STATE_DIR || env.GAMEMASTER_STATE_DIR || 'state'),
    dbFile: path.resolve(BACKEND_ROOT, env.BACKEND_DB_FILE || path.join(env.BACKEND_STATE_DIR || env.GAMEMASTER_STATE_DIR || 'state', 'backend.json')),
    storeBackend,
    databaseUrl: env.DATABASE_URL || '',
    databaseSchema: env.DATABASE_SCHEMA || 'public',
    databaseDocumentId: env.DATABASE_DOCUMENT_ID || profile.DOCUMENT_ID,
    databaseConnectionTimeoutMs: Number(env.DATABASE_CONNECTION_TIMEOUT_MS || 5_000),
    databaseQueryTimeoutMs: Number(env.DATABASE_QUERY_TIMEOUT_MS || 20_000),
    databaseLockTimeoutMs: Number(env.DATABASE_LOCK_TIMEOUT_MS || 5_000),
    databaseStatementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 15_000),
    databaseIdleTransactionTimeoutMs: Number(env.DATABASE_IDLE_TRANSACTION_TIMEOUT_MS || 15_000),
    databaseUpdateMaxAttempts: Number(env.DATABASE_UPDATE_MAX_ATTEMPTS || 3),
    databaseUpdateRetryBaseMs: Number(env.DATABASE_UPDATE_RETRY_BASE_MS || 100),
    backendPublicUrl: env.DIGGER_BACKEND_URL || env.BACKEND_URL || '',
    network,
    ethRpc: profile.ETH_RPC,
    varaEthWs: profile.VARA_WS,
    indexerPollMs: Number(env.INDEXER_POLL_MS || 3000),
    indexerTimeoutMs: Number(env.INDEXER_TIMEOUT_MS || env.DIGGER_QUERY_TIMEOUT_MS || 180000),
    schedulerRegistryMs: Number(env.SCHEDULER_REGISTRY_MS || 60_000),
    schedulerSnapshotMs: Number(env.SCHEDULER_SNAPSHOT_MS || 30_000),
    schedulerRentalMs: Number(env.SCHEDULER_RENTAL_MS || 3_600_000),
    balanceCheckMs: profile.BALANCE_CHECK_MS,
    balanceCooldownMs: profile.BALANCE_COOLDOWN_MS,
    worldBalanceMin: BigInt(profile.BALANCE_MIN_WVARA) * WVARA,
    worldBalanceTopUp: BigInt(profile.BALANCE_TOPUP_WVARA) * WVARA,
    routerAddress: profile.ROUTER,
    adminKey: adminKeyFor(network, env),
    adminApiToken: env.ADMIN_API_TOKEN || '',
    worldProgramIds: splitList(env.INDEXER_WORLD_PROGRAM_IDS || env.WORLD_PROGRAM_IDS || env.WORLD_PROGRAM_ID || ''),
    diggerProxyCodeId: profile.PROXY_CODE_ID,
    diggerProxyWasmPath: env.DIGGER_PROXY_WASM_PATH || '',
    diggerProgramIds: splitList(env.INDEXER_PROXY_PROGRAM_IDS || env.DIGGER_PROGRAM_IDS || env.DIGGER_PROXY_PROGRAM_IDS || env.DIGGER_PROXY_PROGRAM_ID || ''),
    redeemProgramIds: profile.REDEEM_PROGRAM_ID ? [profile.REDEEM_PROGRAM_ID] : [],
    resVmtProgramIds: profile.RES_VMT_PROGRAM_ID ? [profile.RES_VMT_PROGRAM_ID] : [],
    diggerDailyExecTarget: parseBigIntEnv(
      env.DIGGER_DAILY_EXEC_TARGET || env.DIGGER_RENTAL_DAILY_EXEC_TARGET || '',
      DEFAULT_DIGGER_DAILY_EXEC_TARGET,
    ),
    diggerRentalMode: env.DIGGER_RENTAL_MODE || env.BACKEND_DEPLOY_MODE || 'dry-run',
    diggerRentalSeason: env.DIGGER_RENTAL_SEASON || env.SEASON_ID || 'season-1',
    sessionMs: profile.SESSION_MS,
    factorySessionAutofinish: profile.SESSION_AUTOFINISH,
    factoryLobbyMin: profile.LOBBY_MIN,
    factoryLobbyCap: profile.LOBBY_CAP,
    factoryLobbyTimeoutMs: profile.LOBBY_TIMEOUT_MS,
    factoryAutoStartAtMin: profile.AUTOSTART_AT_MIN,
    factoryAutoStartOnTimeout: profile.AUTOSTART_ON_TIMEOUT,
    factoryRecycle: profile.RECYCLE,
    contractSurface: profile.CONTRACT_SURFACE,
    diggerIdlPath: env.DIGGER_IDL_PATH || '',
    diggerWasmPath: env.DIGGER_WASM_PATH || '',
    wsReconnectAttempts: profile.WS_RECONNECT_ATTEMPTS,
    wsReconnectDelay: profile.WS_RECONNECT_DELAY,
    socialVerifierMode: env.SOCIAL_VERIFIER_MODE || 'live',
    socialXBearerToken: env.SOCIAL_X_BEARER_TOKEN || env.X_BEARER_TOKEN || '',
    socialXSourceUsername: normalizeUsername(env.SOCIAL_X_SOURCE_USERNAME || env.DIGGER_X_USERNAME || 'VaraNetwork'),
    socialFuelGrantAmounts: {
      repost: parseBigIntEnv(env.SOCIAL_REPOST_FUEL_GRANT || '', DEFAULT_SOCIAL_REPOST_FUEL_GRANT),
      quote: parseBigIntEnv(env.SOCIAL_QUOTE_FUEL_GRANT || '', DEFAULT_SOCIAL_QUOTE_FUEL_GRANT),
    },
  };
}

export function parseBigIntEnv(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  try {
    return BigInt(trimmed);
  } catch (error) {
    throw new Error(`Invalid bigint env value "${value}": ${error.message}`);
  }
}

export function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = stripInlineComment(line.slice(eq + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = unquote(value);
  }
}

function stripInlineComment(value) {
  const hash = value.indexOf(' #');
  return hash === -1 ? value : value.slice(0, hash).trim();
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}
