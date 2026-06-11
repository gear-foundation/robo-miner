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

// Chain connection + deploy settings (only needed in --chain mode).
export function loadChainEnv(overrides = {}) {
  return {
    adminKey: process.env.DIGGER_ADMIN_KEY || '',
    ethRpc: process.env.ETH_RPC || 'https://hoodi-reth-rpc.gear-tech.io',
    varaWs: process.env.VARA_ETH_WS || 'wss://vara-eth-validator-1.gear-tech.io',
    router: process.env.ROUTER_ADDRESS || '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',
    topUp: process.env.DIGGER_TOP_UP || '100000000000000',
    codeId: process.env.DIGGER_CODE_ID || '',
    wasmPath: process.env.DIGGER_WASM_PATH || '',
    idlPath: process.env.DIGGER_IDL_PATH || '',
    contractSurface: num('CONTRACT_SURFACE_Y', 1),
    timeoutMs: num('DIGGER_EVENT_TIMEOUT_MS', 180000),
    ...overrides,
  };
}

export function loadConfig(overrides = {}) {
  return {
    // ── pool ────────────────────────────────────────────────────────────────
    poolSize: num('FACTORY_POOL_SIZE', 3), // max concurrent worlds (provisioning|open|active)
    minOpenWorlds: num('FACTORY_MIN_OPEN', 1), // invariant: always keep >= this many open lobbies

    // ── lobby admission rules ────────────────────────────────────────────────
    lobbyMin: num('FACTORY_LOBBY_MIN', 8), // agents we want gathered before a (manual) start
    lobbyCap: num('FACTORY_LOBBY_CAP', 10), // hard cap → auto-start the instant it's reached
    lobbyTimeoutMs: num('FACTORY_LOBBY_TIMEOUT_MS', 5 * 60 * 1000), // idle-since-last-join window
    autoStartOnTimeout: bool('FACTORY_AUTOSTART_ON_TIMEOUT', false), // false ⇒ flag for manual start

    // ── session ──────────────────────────────────────────────────────────────
    sessionMs: num('SESSION_MS', 30 * 60 * 1000), // play length once started

    // ── lifecycle mode ───────────────────────────────────────────────────────
    // instant-open (false): current contract — StartSession right after UploadMap,
    //   agents join an already-active world.
    // lobby (true): new contract — register allowed in CREATED; we gather agents,
    //   then StartSession opens play. Flip this when the lobby contract lands.
    lobbyMode: bool('FACTORY_LOBBY_MODE', false),
    recycle: bool('FACTORY_RECYCLE', true), // reuse a program via reset_map after finish
    contractSurface: num('CONTRACT_SURFACE_Y', 1),

    // ── loop ─────────────────────────────────────────────────────────────────
    tickMs: num('FACTORY_TICK_MS', 1000),

    ...overrides,
  };
}
