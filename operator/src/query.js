// Read a live DiggerWorld program and print what it returns — Config / MapSnapshot
// (with an ASCII render) / Agents. Read-only: a throwaway account is used only as
// the calculateReplyForHandle `source` (no tx is signed). Follows the
// vara-eth-skills ts-api playbook §9.
//
//   ROUTER_ADDRESS=0x… ETH_RPC=https://… node src/query.js [programId]
//
// Defaults below are pre-filled with the gear-tech testnet WS + the program id
// you gave; you still need ROUTER_ADDRESS + ETH_RPC for the testnet.

import { readFile } from 'node:fs/promises';
import { worldQueries } from '../../frontend/src/chain/world.js';

const ENV = {
  ethRpc: process.env.ETH_RPC || '',
  varaEthWs: process.env.VARA_ETH_WS || 'wss://vara-eth-validator-1.gear-tech.io',
  router: process.env.ROUTER_ADDRESS || '',
  programId: process.argv[2] || process.env.WORLD_PROGRAM_ID || '0x936b5395876648772d37e22da57ba37c4e586df2',
};

const IDL_PATH = new URL('../../frontend/src/chain/world.idl', import.meta.url);
// Live testnet contract tile ids. The frontend translates these into its local
// render constants in chain/source.js.
const GLYPH = {
  0: '.',  // empty/drilled
  1: '#',  // dirt
  2: ' ',  // cave / air
  3: 'X',  // stone
  4: '!',  // lava
  5: 'H',  // ladder
  10: 's', // SCRST
  11: 'b', // BCRST
  12: 'h', // HCRST
  20: '~', // sky/surface cap
};

async function main() {
  if (!ENV.router || !ENV.ethRpc) {
    console.error('Missing endpoints. Need ROUTER_ADDRESS + ETH_RPC to connect.\n  have:');
    console.error('   VARA_ETH_WS      =', ENV.varaEthWs);
    console.error('   WORLD_PROGRAM_ID =', ENV.programId);
    console.error('   ROUTER_ADDRESS   =', ENV.router || '(missing)');
    console.error('   ETH_RPC          =', ENV.ethRpc || '(missing)');
    process.exit(2);
  }

  const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');
  const { createPublicClient, createWalletClient, http } = await import('viem');
  const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');

  const account = privateKeyToAccount(generatePrivateKey()); // read-only source
  const publicClient = createPublicClient({ transport: http(ENV.ethRpc) });
  const walletClient = createWalletClient({ account, transport: http(ENV.ethRpc) });
  const signer = walletClientToSigner(walletClient);
  const api = await createVaraEthApi(new WsVaraEthProvider(ENV.varaEthWs), publicClient, ENV.router, signer);

  const parser = new SailsIdlParser(); await parser.init();
  const program = new SailsProgram(parser.parse(await readFile(IDL_PATH, 'utf8')));
  program.setProgramId(ENV.programId);
  const q = worldQueries(program);
  const src = await signer.getAddress();
  const Wq = program.services.World.queries;
  const call = async (payload) => (await api.call.program.calculateReplyForHandle(src, ENV.programId, payload)).payload;

  console.log('program', ENV.programId, 'via', ENV.varaEthWs, '\n');

  const cfg = Wq.Config.decodeResult(await call(q.config()));
  console.log('Config():', cfg);
  const W = Number(cfg[0]) || 0, H = Number(cfg[1]) || 0;

  const grid = Wq.MapSnapshot.decodeResult(await call(q.mapSnapshot()));
  const hist = {}; for (const t of grid) hist[t] = (hist[t] || 0) + 1;
  console.log(`MapSnapshot(): ${grid.length} cells ${W && H ? `(${W}x${H})` : ''}  tiles:`, hist);
  if (W && H && grid.length === W * H) {
    console.log('--- map ---');
    for (let y = 0; y < H; y++) {
      let row = ''; for (let x = 0; x < W; x++) row += GLYPH[grid[y * W + x]] ?? '?';
      console.log(row);
    }
  }

  const agents = Wq.Agents.decodeResult(await call(q.agents()));
  console.log('Agents():', agents);
  process.exit(0);
}

main().catch((e) => { console.error('query failed:', e?.message || e); process.exit(1); });
