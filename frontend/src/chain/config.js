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

export const CHAIN = {
  // Master switch — flip to true (via VITE_CHAIN_ENABLED=true) once the World
  // contract is live and the ids below are filled.
  enabled: env.VITE_CHAIN_ENABLED === 'true',
  network: env.VITE_CHAIN_NETWORK || 'testnet',

  // @vara-eth/api connection inputs.
  ethRpc: env.VITE_ETH_RPC || '',          // https — Ethereum RPC (publicClient)
  varaEthWs: env.VITE_VARA_ETH_WS || '',   // wss  — Vara.eth RPC (WsVaraEthProvider)
  routerAddress: env.VITE_ROUTER_ADDRESS || '',

  // The World program (one per active map). For a multi-map lobby this is the
  // currently-watched map's program id; the lobby switcher swaps it.
  worldProgramId: env.VITE_WORLD_PROGRAM_ID || '',
  // Optional thin registry / leaderboard program (aggregate across maps).
  registryProgramId: env.VITE_REGISTRY_PROGRAM_ID || '',

  // Fallback poll interval (ms) if push event subscription isn't used.
  pollMs: Number(env.VITE_CHAIN_POLL_MS || 200),
};

// True only when chain mode is on AND the minimum endpoints/ids are present, so
// a half-filled .env never half-connects.
export function chainReady() {
  return Boolean(CHAIN.enabled && CHAIN.varaEthWs && CHAIN.routerAddress && CHAIN.worldProgramId);
}
