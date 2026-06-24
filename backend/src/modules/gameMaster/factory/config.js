// World-factory tunables (the registrar/operator config).
//
// Everything is env-overridable so ops can tune the lobby without code changes.
// The dry-run CLI (index.js) compresses the timers so a full lobby→run→recycle
// cycle is visible in seconds instead of minutes.

function num(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

const NETWORKS = {
  mainnet: {
    ethRpc: 'https://mainnet-reth-rpc.gear-tech.io',
    varaWs: 'wss://validator-1-eth.vara.network',
    router: '0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6',
  },
  // Hoodi testnet (Vara.eth), chainId 560048. Public endpoints per vara-wiki
  // /docs/vara-eth/reference/network-endpoints. Admin key still comes from env.
  testnet: {
    ethRpc: 'https://hoodi-reth-rpc.gear-tech.io',
    varaWs: 'wss://vara-eth-validator-1.gear-tech.io',
    router: '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',
  },
};

function networkConfig(name) {
  return NETWORKS[String(name || '').toLowerCase()] || NETWORKS.mainnet;
}

// Chain connection + deploy settings (only needed in --chain mode).
export function loadChainEnv(overrides = {}) {
  const network = process.env.CHAIN_NETWORK || 'mainnet';
  const defaults = networkConfig(network);
  return {
    network,
    adminKey: process.env.DIGGER_ADMIN_KEY || '',
    ethRpc: process.env.ETH_RPC || defaults.ethRpc,
    varaWs: process.env.VARA_ETH_WS || defaults.varaWs,
    router: process.env.ROUTER_ADDRESS || defaults.router,
    topUp: process.env.DIGGER_TOP_UP || '1000000000000000', // 1000 VARA initial executable balance
    codeId: process.env.DIGGER_CODE_ID || '',
    wasmPath: process.env.DIGGER_WASM_PATH || '',
    idlPath: process.env.DIGGER_IDL_PATH || '',
    resVmtProgramId: firstListValue(
      process.env.DIGGER_RES_VMT_PROGRAM_ID ||
      process.env.DIGGER_RES_VMT_PROGRAM_IDS ||
      process.env.INDEXER_RES_VMT_PROGRAM_IDS ||
      '',
    ),
    resVmtIdlPath: process.env.DIGGER_RES_VMT_IDL_PATH || '',
    contractSurface: num('CONTRACT_SURFACE_Y', 1),
    timeoutMs: num('DIGGER_EVENT_TIMEOUT_MS', 180000),
    // WS resilience — keep reconnecting on a dropped node connection (so the
    // factory + balanceKeeper survive transient drops instead of dying).
    wsReconnectAttempts: num('WS_RECONNECT_ATTEMPTS', 1000000),
    wsReconnectDelay: num('WS_RECONNECT_DELAY_MS', 2000),

    // ── balanceKeeper (proactive executable-balance top-up) ──────────────────
    // Measured: ~0.56 VARA/s for 10 busy agents; top-up lands ~90s late. So keep
    // a comfortable floor and a cooldown longer than the lag. All env-tunable.
    balanceMinVara: num('BALANCE_MIN_VARA', 700), // top up early enough for validator lag
    balanceTopUpVara: num('BALANCE_TOPUP_VARA', 1200), // amount per top-up
    balanceCheckMs: num('BALANCE_CHECK_MS', 10000), // how often to read each world's EB
    balanceCooldownMs: num('BALANCE_COOLDOWN_MS', 120000), // ≥ the ~90s top-up lag

    ...overrides,
  };
}

function firstListValue(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)[0] || '';
}

export function loadConfig(overrides = {}) {
  const poolSize = num('FACTORY_POOL_MAX', num('FACTORY_POOL_SIZE', 3));
  const allowCreate = bool('FACTORY_ALLOW_CREATE', false);
  const configuredBaseWorlds = num('FACTORY_MIN_OPEN', 1);
  // FACTORY_MIN_OPEN is the BASE number of worlds the factory keeps running — NOT a
  // target to eagerly fill. The factory stands up this many, lets agents fill them,
  // and opens another world ONLY when there is no open lobby left (every current
  // world is full), growing on demand up to FACTORY_POOL_MAX. Clamp to the pool cap
  // so the base can never exceed the hard ceiling.
  const baseWorlds = poolSize > 0
    ? Math.min(configuredBaseWorlds, poolSize)
    : configuredBaseWorlds;

  return {
    // ── pool ────────────────────────────────────────────────────────────────
    // FACTORY_POOL_SIZE is kept as a legacy default for FACTORY_POOL_MAX.
    // FACTORY_POOL_MAX is the hard ceiling on total provisioning/open/active worlds.
    // FACTORY_ALLOW_CREATE=true lets the factory deploy+fund+initialize a new program
    // on demand (when all worlds are full and the cap is not reached); =false keeps a
    // fixed preseeded pool with no runtime deploys.
    poolSize,
    allowCreate,
    baseWorlds, // base worlds kept running; grow on demand (only at 0 open lobbies) up to poolSize

    // ── lobby admission rules ────────────────────────────────────────────────
    lobbyMin: num('FACTORY_LOBBY_MIN', 3), // agents we want gathered before a start
    lobbyCap: num('FACTORY_LOBBY_CAP', 10), // hard cap → auto-start the instant it's reached
    lobbyTimeoutMs: num('FACTORY_LOBBY_TIMEOUT_MS', 0), // legacy idle-since-last-join manual window
    autoStartAtMin: bool('FACTORY_AUTOSTART_AT_MIN', true), // start as soon as lobbyMin is reached
    autoStartOnTimeout: bool('FACTORY_AUTOSTART_ON_TIMEOUT', false), // false ⇒ flag for manual start

    // ── session ──────────────────────────────────────────────────────────────
    sessionMs: num('SESSION_MS', 30 * 60 * 1000), // optional play length metadata
    sessionAutofinish: bool('FACTORY_SESSION_AUTOFINISH', false), // false ⇒ active sessions run until admin/contract finish

    // ── lifecycle mode ───────────────────────────────────────────────────────
    // lobby (true): current contract — UploadMap/ResetMap creates a registration
    // window (SESSION_CREATED); agents join there, then StartSession opens play.
    // prestarted (false): only for future/legacy contracts that allow late join
    // into SESSION_ACTIVE.
    lobbyMode: bool('FACTORY_LOBBY_MODE', true),
    recycle: bool('FACTORY_RECYCLE', true), // reuse a program via reset_map after finish
    pastLimit: num('FACTORY_PAST_LIMIT', 50), // how many retired worlds to keep for the PAST tab
    contractSurface: num('CONTRACT_SURFACE_Y', 1),

    // ── loop ─────────────────────────────────────────────────────────────────
    tickMs: num('FACTORY_TICK_MS', 1000),

    ...overrides,
  };
}
