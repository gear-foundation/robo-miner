import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');

loadDotEnv(path.join(BACKEND_ROOT, '.env'));

const VARA = 1_000_000_000_000n;

export const DEFAULT_DIGGER_DAILY_EXEC_TARGET = 120n * VARA;
export const DEFAULT_SOCIAL_REPOST_FUEL_GRANT = 60n * VARA;
export const DEFAULT_SOCIAL_QUOTE_FUEL_GRANT = 120n * VARA;

export function loadConfig(env = process.env) {
  const storeBackend = (env.BACKEND_STORE || (env.DATABASE_URL ? 'postgres' : 'json')).toLowerCase();
  return {
    rootDir: BACKEND_ROOT,
    stateDir: path.resolve(BACKEND_ROOT, env.BACKEND_STATE_DIR || env.GAMEMASTER_STATE_DIR || 'state'),
    dbFile: path.resolve(BACKEND_ROOT, env.BACKEND_DB_FILE || path.join(env.BACKEND_STATE_DIR || env.GAMEMASTER_STATE_DIR || 'state', 'backend.json')),
    storeBackend,
    databaseUrl: env.DATABASE_URL || '',
    databaseSchema: env.DATABASE_SCHEMA || 'public',
    databaseDocumentId: env.DATABASE_DOCUMENT_ID || 'main',
    network: env.CHAIN_NETWORK || 'hoodi',
    ethRpc: env.ETH_RPC || 'https://hoodi-reth-rpc.gear-tech.io',
    varaEthWs: env.VARA_ETH_WS || 'wss://vara-eth-validator-1.gear-tech.io',
    indexerPollMs: Number(env.INDEXER_POLL_MS || 3000),
    indexerTimeoutMs: Number(env.INDEXER_TIMEOUT_MS || env.DIGGER_QUERY_TIMEOUT_MS || 30000),
    schedulerRegistryMs: Number(env.SCHEDULER_REGISTRY_MS || 60_000),
    schedulerSnapshotMs: Number(env.SCHEDULER_SNAPSHOT_MS || 30_000),
    schedulerRentalMs: Number(env.SCHEDULER_RENTAL_MS || 3_600_000),
    routerAddress: env.ROUTER_ADDRESS || '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',
    adminKey: env.DIGGER_ADMIN_KEY || '',
    adminApiToken: env.ADMIN_API_TOKEN || '',
    worldProgramIds: splitList(env.INDEXER_WORLD_PROGRAM_IDS || env.WORLD_PROGRAM_IDS || env.WORLD_PROGRAM_ID || ''),
    diggerProxyCodeId: env.DIGGER_PROXY_CODE_ID || env.DIGGER_CODE_ID || '',
    diggerProgramIds: splitList(env.DIGGER_PROGRAM_IDS || env.DIGGER_PROXY_PROGRAM_IDS || env.DIGGER_PROXY_PROGRAM_ID || ''),
    redeemProgramIds: splitList(env.INDEXER_REDEEM_PROGRAM_IDS || env.DIGGER_REDEEM_PROGRAM_IDS || env.DIGGER_REDEEM_PROGRAM_ID || env.DIGGER_REDEEM_ID || ''),
    resVmtProgramIds: splitList(env.INDEXER_RES_VMT_PROGRAM_IDS || env.DIGGER_RES_VMT_PROGRAM_IDS || env.DIGGER_RES_VMT_PROGRAM_ID || env.DIGGER_RES_VMT_ID || ''),
    diggerDailyExecTarget: parseBigIntEnv(
      env.DIGGER_DAILY_EXEC_TARGET || env.DIGGER_RENTAL_DAILY_EXEC_TARGET || '',
      DEFAULT_DIGGER_DAILY_EXEC_TARGET,
    ),
    diggerRentalMode: env.DIGGER_RENTAL_MODE || env.BACKEND_DEPLOY_MODE || 'dry-run',
    diggerRentalSeason: env.DIGGER_RENTAL_SEASON || env.SEASON_ID || 'season-1',
    sessionMs: Number(env.SESSION_MS || 30 * 60 * 1000),
    factoryLobbyMin: Number(env.FACTORY_LOBBY_MIN || 8),
    factoryLobbyCap: Number(env.FACTORY_LOBBY_CAP || 10),
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
