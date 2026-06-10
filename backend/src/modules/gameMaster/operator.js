// DiggerWorld operator — the off-chain admin service.
//
// Role (spec §5 off-chain services): generate the map off-chain, upload it into
// the contract, and drive the session lifecycle, all signed by ONE admin
// account. The contract never generates a map — it stores what we upload.
//
//   loop:  seed = random()
//          generate + validate + encode map
//          UploadMap(seed, map)                 // contract tile ids
//          StartSession()
//          …wait the session…
//          FinishSession()
//          ResetMap(nextSeed)
//
// Two modes:
//   • dry-run (default, no deps needed): generate maps + write the exact
//     [u32] UploadMap payloads to out/ so you can inspect what would be sent.
//   • live (when the .env below is filled): connect @vara-eth/api as the admin
//     signer, parse world.idl with sails-js, and send the Admin calls for real.
//
// Chain calls follow vara-eth-skills playbooks/vara-eth-ts-api-workflow.md.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { generateMap, randomSeed, gridHash } from './genmap.js';
import { adminActions } from '../../../../frontend/src/chain/world.js';

const IDL_PATH = new URL('../../../../frontend/src/chain/world.idl', import.meta.url);

const ENV = {
  adminKey: process.env.DIGGER_ADMIN_KEY || '',
  ethRpc: process.env.ETH_RPC || '',
  varaEthWs: process.env.VARA_ETH_WS || '',
  router: process.env.ROUTER_ADDRESS || '',
  programId: process.env.WORLD_PROGRAM_ID || '',
  sessionMs: Number(process.env.SESSION_MS || 30 * 60 * 1000),
  contractSurface: Number(process.env.CONTRACT_SURFACE_Y || 1),
};
const LIVE = Boolean(ENV.adminKey && ENV.varaEthWs && ENV.router && ENV.programId);

// ── live chain wiring (deps loaded lazily so dry-run needs nothing) ──────────
async function connect() {
  const { WsVaraEthProvider, createVaraEthApi, getMirrorClient } = await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');
  const { createPublicClient, createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');

  const account = privateKeyToAccount(ENV.adminKey);
  const publicClient = createPublicClient({ transport: http(ENV.ethRpc) });
  const walletClient = createWalletClient({ account, transport: http(ENV.ethRpc) });
  const signer = walletClientToSigner(walletClient);

  const api = await createVaraEthApi(new WsVaraEthProvider(ENV.varaEthWs), publicClient, ENV.router, signer);
  const parser = new SailsIdlParser(); await parser.init();
  const program = new SailsProgram(parser.parse(await readFile(IDL_PATH, 'utf8')));
  program.setProgramId(ENV.programId);
  const mirror = getMirrorClient({ address: ENV.programId, publicClient, signer });

  return { api, program, mirror, admin: adminActions(program) };
}

async function sendAdmin(ctx, payload, label) {
  const tx = await ctx.mirror.sendMessage(payload, 0n);
  await tx.send();
  const { waitForReply } = await tx.setupReplyListener();
  const reply = await waitForReply();
  console.log(`  ✓ ${label} → reply ${reply.code}`);
  return reply;
}

async function uploadNewMap(ctx, seed) {
  const m = generateMap(seed, { contractSurface: ENV.contractSurface });
  if (!m.valid) {
    throw new Error(`generated invalid map seed=${m.seed}: ${m.warnings.join('; ')}`);
  }
  console.log(
    `map seed=${m.seed} ${m.width}x${m.height} surface=${m.contractSurface}/${m.surface} hash=${gridHash(m.map)} ` +
    `(${m.map.length} cells) tiles=${JSON.stringify(m.counts)}`,
  );
  await sendAdmin(ctx, ctx.admin.uploadMap(m.seed, m.map), 'UploadMap');
  return m;
}

async function runSession(ctx) {
  const seed = randomSeed();
  await uploadNewMap(ctx, seed);
  await sendAdmin(ctx, ctx.admin.startSession(), 'StartSession');
  console.log(`session running ~${Math.round(ENV.sessionMs / 60000)} min…`);
  await new Promise((r) => setTimeout(r, ENV.sessionMs)); // (or watch the SessionFinished event)
  await sendAdmin(ctx, ctx.admin.finishSession(), 'FinishSession');
  await sendAdmin(ctx, ctx.admin.resetMap(randomSeed()), 'ResetMap');
}

// ── dry-run (no chain): just produce the maps + UploadMap payloads ───────────
async function dryRun(n) {
  const dir = new URL('../../../out/', import.meta.url);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const m = generateMap(randomSeed(), { contractSurface: ENV.contractSurface });
    const file = new URL(`map-${m.seed}.json`, dir);
    const payload = {
      seed: m.seed,
      width: m.width,
      height: m.height,
      surface: m.surface,
      contractSurface: m.contractSurface,
      valid: m.valid,
      warnings: m.warnings,
      hash: gridHash(m.map),
      counts: m.counts,
      map: m.map,
      renderMap: m.renderMap,
    };
    await writeFile(file, JSON.stringify(payload));
    const status = m.valid ? 'valid' : `INVALID ${m.warnings.join('; ')}`;
    console.log(
      `generated ${m.width}x${m.height} surface=${m.contractSurface}/${m.surface} seed=${m.seed} hash=${gridHash(m.map)} ` +
      `${status} -> backend/out/map-${m.seed}.json  (UploadMap payload)`,
    );
  }
}

async function main() {
  if (!LIVE) {
    console.log('[dry-run] no chain config (.env) — generating maps + UploadMap payloads only.\n');
    return dryRun(Number(process.argv[2] || 1));
  }
  const ctx = await connect();
  console.log(`operator live · admin ${ENV.adminKey.slice(0, 6)}… · program ${ENV.programId}`);
  for (;;) await runSession(ctx); // configured session loop
}

main().catch((e) => { console.error(e); process.exit(1); });
