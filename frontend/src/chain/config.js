// On-chain integration config (Vara.eth).
//
// Everything that ties the frontend to the contract lives here and comes from
// Vite env, so switching network / redeploying never touches code. Until the
// World contract is deployed these stay empty and `CHAIN.enabled` is false →
// the agent arena runs on the local engine (current behaviour).
//
// Field shapes follow @vara-eth/api (see chain/source.js + the vara-eth-skills
// `playbooks/vara-eth-ts-api-workflow.md`): a Router address, an Ethereum HTTP
// RPC, a Vara.eth WS RPC, and the World program id we read state from and
// subscribe to. Redeem/registration live on the L1 Mirror layer (separate).

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

const NETWORKS = {
  mainnet: {
    ethRpc: 'https://mainnet-reth-rpc.gear-tech.io',
    varaEthWs: 'wss://validator-1-eth.vara.network',
    routerAddress: '0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6',
    resVmtProgramId: '0x2295edd92104c5f9f4f9bddef28d1c20c3e9f448',
    redeemProgramId: '0xdb8dae5f6fc193006d428e12ee0c717715c6b887',
    explorer: 'https://etherscan.io',
  },
  // Hoodi testnet (Vara.eth), chainId 560048 — see vara-wiki network-endpoints.
  testnet: {
    ethRpc: 'https://hoodi-reth-rpc.gear-tech.io',
    varaEthWs: 'wss://vara-eth-validator-1.gear-tech.io',
    routerAddress: '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',
    resVmtProgramId: '',
    redeemProgramId: '',
    explorer: 'https://hoodi.etherscan.io',
  },
};

function num(name, fallback) {
  const value = env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function networkConfig(name) {
  return NETWORKS[String(name || '').toLowerCase()] || NETWORKS.mainnet;
}

// Network is runtime-switchable ONLY where the toggle exists (dev, or
// VITE_NETWORK_TOGGLE=true): the toggle writes localStorage, which then wins over
// the build-time VITE_CHAIN_NETWORK. In a normal prod build the toggle is hidden,
// so a stale localStorage value can't pin a user to the wrong network.
function storedNetwork() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('mp_network')) || '';
  } catch {
    return '';
  }
}
const networkToggleEnabled = Boolean(env.DEV) || env.VITE_NETWORK_TOGGLE === 'true';
const network = String((networkToggleEnabled && storedNetwork()) || env.VITE_CHAIN_NETWORK || 'mainnet').toLowerCase();
const defaults = networkConfig(network);

export const CHAIN = {
  // Master switch — flip to true (via VITE_CHAIN_ENABLED=true) once the World
  // contract is live and the ids below are filled.
  enabled: env.VITE_CHAIN_ENABLED === 'true',
  network,

  // @vara-eth/api connection inputs — driven entirely by the selected network's
  // preset, so the toggle switches chain (router/RPC/WS), not just a label.
  ethRpc: defaults.ethRpc,
  varaEthWs: defaults.varaEthWs,
  routerAddress: defaults.routerAddress,
  explorerUrl: defaults.explorer,

  // The World program (one per active map). Direct world routes pass the id in
  // the URL. Lobby discovery comes from the operator API; these ids are only a
  // last-resort fallback when discovery is unavailable.
  worldProgramId: env.VITE_WORLD_PROGRAM_ID || '',
  worldProgramIds: (env.VITE_WORLD_PROGRAM_IDS || env.VITE_WORLD_PROGRAM_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // Optional thin registry / leaderboard program (aggregate across maps).
  registryProgramId: env.VITE_REGISTRY_PROGRAM_ID || '',
  backendUrl: env.VITE_BACKEND_URL || '',
  resVmtProgramId: defaults.resVmtProgramId || env.VITE_RES_VMT_PROGRAM_ID || '',
  redeemProgramId: defaults.redeemProgramId || env.VITE_REDEEM_PROGRAM_ID || '',

  // Operator discovery feed (factory /sessions + /matches). If empty, the
  // frontend uses backendUrl for the same endpoints.
  matchesUrl: env.VITE_MATCHES_URL || '',

  // Logical contract surface. The new Config()[6] is starting_hp, not surface.
  contractSurfaceY: num('VITE_CONTRACT_SURFACE_Y', 1),

  // Spectator map renderer. `chunks` repaints only dirty map sectors, `viewport`
  // repaints the padded camera area, and `full` is useful for quick comparisons.
  renderMode: env.VITE_CHAIN_RENDER_MODE || 'chunks',
};

// Chain spectator playback timings. Visual-only game feel lives in code, not in
// env: the contract already confirmed the action, so the frontend only decides
// how the result is shown.
export const CHAIN_PLAYBACK = {
  moveMs: 120,
  digMs: 420,
  chestFuseMs: 700,
  stoneShakeMs: 520,
  stoneStepMs: 90,
  eventGroupGraceMs: 35,
  maxVisualQueue: 4,
  maxGroupsPerFrame: 4,
};

// True only when chain mode is on AND the minimum endpoints/ids are present, so
// a half-filled .env never half-connects.
export function chainReady(programId = CHAIN.worldProgramId) {
  return Boolean(CHAIN.enabled && CHAIN.ethRpc && CHAIN.varaEthWs && CHAIN.routerAddress && programId);
}

export function discoveryBaseUrl() {
  return String(CHAIN.matchesUrl || CHAIN.backendUrl || '').replace(/\/+$/, '');
}

// Append the active network to a discovery/API path so one backend can serve both
// (the ?network= switch). Use instead of `${discoveryBaseUrl()}${path}`.
export function discoveryUrl(path) {
  const base = discoveryBaseUrl();
  const rel = String(path || '');
  if (!base) return rel;
  const sep = rel.includes('?') ? '&' : '?';
  return `${base}${rel}${sep}network=${encodeURIComponent(CHAIN.network)}`;
}

// UI/console toggle: persist the chosen network and reload so the whole app
// (chain config + lobby data) re-resolves for it.
export function setNetwork(name) {
  const next = String(name || '').toLowerCase();
  try { localStorage.setItem('mp_network', next); } catch { /* non-browser */ }
  if (typeof location !== 'undefined') location.reload();
}
if (typeof window !== 'undefined') {
  window.mpSetNetwork = setNetwork;
  window.mpNetwork = CHAIN.network;
}

export function addressExplorerUrl(address) {
  return address ? `${CHAIN.explorerUrl}/address/${address}` : '#';
}

export function redeemReady() {
  return Boolean(CHAIN.enabled && CHAIN.ethRpc && CHAIN.varaEthWs && CHAIN.routerAddress && CHAIN.resVmtProgramId && CHAIN.redeemProgramId);
}
