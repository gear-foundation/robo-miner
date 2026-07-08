export const DEFAULT_WORLD_CONFIG = [
  [40, 64, 100, 77, 19, 4, 1, 50, 10, 1000],
  [1, 2, 1, 4, 1, 12],
];

export const DEFAULT_REDEEM_RATES = { scrst: 6, bcrst: 30, hcrst: 150 };

export function cloneWorldConfig(config = DEFAULT_WORLD_CONFIG) {
  return config.map((section) => section.map(Number));
}

export function parseWorldConfig(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Array.isArray(parsed[0]) ||
    !Array.isArray(parsed[1]) ||
    parsed[0].length !== 10 ||
    parsed[1].length !== 6
  ) {
    throw new Error('DIGGER_WORLD_CONFIG must be [[10 base u32 values],[6 ladder exchange u32 values]]');
  }
  return cloneWorldConfig(parsed);
}

export const MAINNET = {
  ETH_RPC: 'https://mainnet-reth-rpc.gear-tech.io',
  VARA_WS: 'wss://validator-1-eth.vara.network',
  ROUTER: '0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6',
  DOCUMENT_ID: 'mainnet',
  DISCOVERY_PORT: 8780,
  WORLD_CODE_ID: '0x9e5e17dabbe4c1c0ae20b4c48981bbca866ffe24f1427fa807b98ddb57a72ff2',
  WORLD_CONFIG: DEFAULT_WORLD_CONFIG,
  REDEEM_RATES: DEFAULT_REDEEM_RATES,
  PROXY_CODE_ID: '0x2390d97aea22bbc45af6efe8bca29d06c80cebbddd55d9c0796eb724b77a5e93',
  RES_VMT_PROGRAM_ID: '0x09ca219f6b7f4c897ddcf60c6ab16c2802f51cfb',
  REDEEM_PROGRAM_ID: '0x5f627eb3d4658ed0f793e94142d4dfdba68090ee',
  TOP_UP_WEI: '1200000000000000',
  BASE_WORLDS: 6,
  POOL_MAX: 6,
  ALLOW_CREATE: true,
  LOBBY_MODE: true,
  LOBBY_MIN: 1,
  LOBBY_CAP: 10,
  LOBBY_TIMEOUT_MS: 0,
  AUTOSTART_AT_MIN: true,
  AUTOSTART_ON_TIMEOUT: false,
  RECYCLE: true,
  SESSION_AUTOFINISH: false,
  SESSION_MS: 0,
  TICK_MS: 6000,
  PAST_LIMIT: 50,
  BALANCE_MIN_WVARA: 700,
  BALANCE_TOPUP_WVARA: 1200,
  BALANCE_CHECK_MS: 30000,
  BALANCE_COOLDOWN_MS: 120000,
  EVENT_TIMEOUT_MS: 180000,
  CONTRACT_SURFACE: 1,
  WS_RECONNECT_ATTEMPTS: 1000000,
  WS_RECONNECT_DELAY: 2000,
};

export const TESTNET = {
  ETH_RPC: 'https://hoodi-reth-rpc.gear-tech.io',
  VARA_WS: 'wss://vara-eth-validator-1.gear-tech.io',
  ROUTER: '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',
  DOCUMENT_ID: 'testnet',
  DISCOVERY_PORT: 8781,
  WORLD_CODE_ID: '0xc0aee115c4256e5fa18ddd91764bf23354883989cf2cfe04ad4e6dedc118e8af',
  WORLD_CONFIG: DEFAULT_WORLD_CONFIG,
  REDEEM_RATES: DEFAULT_REDEEM_RATES,
  PROXY_CODE_ID: '0x67190d741f9d1463934751fc57b6ff7b6c386f6897ff7ff974a2694422cd77ea',
  RES_VMT_PROGRAM_ID: '0x4888c0ed7cc9a61e0f537e88d6abc93e15d91240',
  REDEEM_PROGRAM_ID: '0x9c5b14f959efa66d5015dd111912fc851232b787',
  TOP_UP_WEI: '300000000000000',
  BASE_WORLDS: 3,
  POOL_MAX: 6,
  ALLOW_CREATE: true,
  LOBBY_MODE: true,
  LOBBY_MIN: 1,
  LOBBY_CAP: 10,
  LOBBY_TIMEOUT_MS: 0,
  AUTOSTART_AT_MIN: true,
  AUTOSTART_ON_TIMEOUT: false,
  RECYCLE: true,
  SESSION_AUTOFINISH: false,
  SESSION_MS: 0,
  TICK_MS: 6000,
  PAST_LIMIT: 50,
  BALANCE_MIN_WVARA: 50,
  BALANCE_TOPUP_WVARA: 100,
  BALANCE_CHECK_MS: 30000,
  BALANCE_COOLDOWN_MS: 120000,
  EVENT_TIMEOUT_MS: 180000,
  CONTRACT_SURFACE: 1,
  WS_RECONNECT_ATTEMPTS: 1000000,
  WS_RECONNECT_DELAY: 2000,
};

export const NETWORKS = { mainnet: MAINNET, testnet: TESTNET };
export const DEFAULT_NETWORK = 'mainnet';

export function profileFor(network) {
  const key = String(network || '').toLowerCase();
  const profile = NETWORKS[key];
  if (!profile) {
    throw new Error(`unknown CHAIN_NETWORK "${network}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`);
  }
  return profile;
}

export function adminKeyFor(network, env = process.env) {
  return env[`${String(network || '').toUpperCase()}_ADMIN_KEY`] || env.DIGGER_ADMIN_KEY || '';
}
