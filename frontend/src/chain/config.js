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

function num(name, fallback) {
  const value = env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const CHAIN = {
  // Master switch — flip to true (via VITE_CHAIN_ENABLED=true) once the World
  // contract is live and the ids below are filled.
  enabled: env.VITE_CHAIN_ENABLED === 'true',
  network: env.VITE_CHAIN_NETWORK || 'testnet',

  // @vara-eth/api connection inputs.
  ethRpc: env.VITE_ETH_RPC || 'https://hoodi-reth-rpc.gear-tech.io',
  varaEthWs: env.VITE_VARA_ETH_WS || 'wss://vara-eth-validator-1.gear-tech.io',
  routerAddress: env.VITE_ROUTER_ADDRESS || '0xE549b0AfEdA978271FF7E712232B9F7f39A0b060',

  // The World program (one per active map). For a multi-map lobby this is the
  // currently-watched map's program id; the lobby switcher swaps it.
  worldProgramId: env.VITE_WORLD_PROGRAM_ID || '',
  worldProgramIds: (env.VITE_WORLD_PROGRAM_IDS || env.VITE_WORLD_PROGRAM_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  // Optional thin registry / leaderboard program (aggregate across maps).
  registryProgramId: env.VITE_REGISTRY_PROGRAM_ID || '',
  backendUrl: env.VITE_BACKEND_URL || '',
  resVmtProgramId: env.VITE_RES_VMT_PROGRAM_ID || '',
  redeemProgramId: env.VITE_REDEEM_PROGRAM_ID || '',

  // Operator discovery feed (factory /sessions + /matches). When set, the lobby
  // lists live worlds straight from the operator (current vs past + agent
  // counts), no colleague backend required. Takes precedence over backendUrl.
  matchesUrl: env.VITE_MATCHES_URL || '',

  // Fallback poll interval (ms) if push event subscription isn't used.
  pollMs: num('VITE_CHAIN_POLL_MS', 1000),

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

export function redeemReady() {
  return Boolean(CHAIN.enabled && CHAIN.ethRpc && CHAIN.varaEthWs && CHAIN.routerAddress && CHAIN.resVmtProgramId && CHAIN.redeemProgramId);
}
