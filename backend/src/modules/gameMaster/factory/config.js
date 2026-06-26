import { profileFor, adminKeyFor, DEFAULT_NETWORK } from '../../../config/networks.js';

function currentNetwork() {
  return String(process.env.CHAIN_NETWORK || DEFAULT_NETWORK).toLowerCase();
}

export function loadChainEnv(overrides = {}) {
  const network = currentNetwork();
  const p = profileFor(network);
  return {
    network,
    adminKey: adminKeyFor(network),
    ethRpc: process.env.ETH_RPC || p.ETH_RPC,
    varaWs: process.env.VARA_ETH_WS || process.env.VARA_ETH_RPC || p.VARA_WS,
    router: process.env.ROUTER_ADDRESS || p.ROUTER,
    discoveryPort: p.DISCOVERY_PORT,
    topUp: process.env.DIGGER_TOP_UP || p.TOP_UP_WEI,
    codeId: process.env.DIGGER_CODE_ID || p.WORLD_CODE_ID,
    wasmPath: process.env.DIGGER_WASM_PATH || '',
    idlPath: process.env.DIGGER_IDL_PATH || '',
    resVmtProgramId: process.env.DIGGER_RES_VMT_PROGRAM_ID || p.RES_VMT_PROGRAM_ID,
    resVmtIdlPath: process.env.DIGGER_RES_VMT_IDL_PATH || '',
    contractSurface: p.CONTRACT_SURFACE,
    timeoutMs: p.EVENT_TIMEOUT_MS,
    wsReconnectAttempts: p.WS_RECONNECT_ATTEMPTS,
    wsReconnectDelay: p.WS_RECONNECT_DELAY,
    balanceMinWvara: p.BALANCE_MIN_WVARA,
    balanceTopUpWvara: p.BALANCE_TOPUP_WVARA,
    balanceCheckMs: p.BALANCE_CHECK_MS,
    balanceCooldownMs: p.BALANCE_COOLDOWN_MS,
    ...overrides,
  };
}

export function loadConfig(overrides = {}) {
  const p = profileFor(currentNetwork());
  return {
    poolSize: p.POOL_MAX,
    allowCreate: p.ALLOW_CREATE,
    baseWorlds: Math.min(p.BASE_WORLDS, p.POOL_MAX),
    lobbyMin: p.LOBBY_MIN,
    lobbyCap: p.LOBBY_CAP,
    lobbyTimeoutMs: p.LOBBY_TIMEOUT_MS,
    autoStartAtMin: p.AUTOSTART_AT_MIN,
    autoStartOnTimeout: p.AUTOSTART_ON_TIMEOUT,
    sessionMs: p.SESSION_MS,
    sessionAutofinish: p.SESSION_AUTOFINISH,
    lobbyMode: p.LOBBY_MODE,
    recycle: p.RECYCLE,
    pastLimit: p.PAST_LIMIT,
    contractSurface: p.CONTRACT_SURFACE,
    tickMs: p.TICK_MS,
    ...overrides,
  };
}
