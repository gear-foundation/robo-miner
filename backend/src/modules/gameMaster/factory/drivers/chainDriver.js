// Real chain driver — runs the factory lifecycle against deployed DiggerWorld
// programs via the operator/admin account. Same shape as dryRunDriver, so the
// factory state machine is identical; only the side effects are real.
//
//   provision  → reuse a persisted program, else validate code (once) +
//                createProgram + executable balance + Create()
//   loadMap    → generateMap + Admin.UploadMap   (→ CREATED, registration open;
//                also reopens a reused program by clearing agents)
//   start      → Admin.StartSession (idempotent: contract auto-starts at cap=10)
//   finish     → Admin.FinishSession
//   recycle    → Admin.UploadMap again (clears agents, bumps session, → CREATED)
//   pollAgents → World.Agents() length
//
// Code is validated ONCE → its code id + the program ids we deploy are persisted
// to state/factory-programs.json, so restarts reuse the pool instead of paying to
// redeploy. Set DIGGER_CODE_ID to skip the code-state check entirely.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMap, randomSeed, gridHash } from '../../genmap.js';
import { createBalanceKeeper } from '../balanceKeeper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../../..'); // backend/src/modules/gameMaster/factory/drivers → repo root
const SESSION_ACTIVE = 1;

export async function createChainDriver({ env, log = console.log, reservedProgramIds = [] }) {
  const { connectDiggerWorldChain } = await import('../../../../chain/diggerWorld.js');
  const chain = await connectDiggerWorldChain(env);

  // Keeps each live world's executable balance funded so injected actions never
  // start failing mid-session (the world would otherwise silently stall).
  const keeper = createBalanceKeeper({
    chain,
    log,
    options: {
      minVara: env.balanceMinVara,
      topUpVara: env.balanceTopUpVara,
      checkMs: env.balanceCheckMs,
      cooldownMs: env.balanceCooldownMs,
    },
  });

  const poolFile = path.resolve(ROOT, process.env.GAMEMASTER_STATE_DIR || 'state', 'factory-programs.json');
  const pool = await loadPool();
  let codeId = env.codeId || pool.codeId || null;
  let reuseIdx = 0; // next persisted program to reuse before deploying a new one
  const reservedPrograms = new Set((reservedProgramIds || []).filter(Boolean).map(String));

  async function loadPool() {
    try {
      return JSON.parse(await readFile(poolFile, 'utf8'));
    } catch {
      return { codeId: null, programs: [] };
    }
  }
  async function savePool() {
    await mkdir(path.dirname(poolFile), { recursive: true });
    await writeFile(poolFile, `${JSON.stringify(pool, null, 2)}\n`);
  }

  async function ensureCode() {
    if (!codeId) {
      codeId = await chain.ensureCodeValidated();
      log(`[chain] code validated ${codeId}`);
    }
    pool.codeId = codeId;
    return codeId;
  }

  async function readSession(programId) {
    const reply = await chain.query(programId, chain.encode.session());
    const arr = chain.decode.session(reply.payload).map((v) => Number(v));
    return { sessionId: arr[0], seed: arr[1], status: arr[2], actionSeq: arr[3] };
  }

  async function readAgents(programId) {
    const reply = await chain.query(programId, chain.encode.agents());
    const arr = chain.decode.agents(reply.payload);
    // World.Agents() → [ActorId] (32-byte hex, '0x'+12 zero bytes + the agent's
    // 20-byte EOA). These are the real owners that registered.
    return Array.isArray(arr) ? arr.map(String) : [];
  }

  async function uploadFreshMap(programId) {
    let map = null;
    for (let attempt = 0; attempt < 5 && !map; attempt += 1) {
      const candidate = generateMap(randomSeed(), { contractSurface: env.contractSurface });
      if (candidate.valid) map = candidate;
    }
    if (!map) throw new Error('could not generate a valid map after 5 attempts');
    await chain.sendAdmin(programId, chain.encode.uploadMap(map.seed, map.map));
    const session = await readSession(programId);
    return { seed: String(map.seed), mapHash: gridHash(map.map), sessionId: session.sessionId };
  }

  return {
    async provision() {
      // Reuse an already-deployed program before paying to create a new one.
      // loadMap's UploadMap reopens it (clears agents → CREATED).
      while (reuseIdx < pool.programs.length) {
        const programId = pool.programs[reuseIdx];
        reuseIdx += 1;
        if (reservedPrograms.has(programId)) continue;
        log(`[chain] reusing program ${programId}`);
        await keeper.ensureNow(programId); // a reused program may be low — top up before opening
        reservedPrograms.add(programId);
        return { programId };
      }
      const code = await ensureCode();
      const programId = await chain.createProgram(code, BigInt(env.topUp));
      await chain.sendAdmin(programId, chain.encode.create());
      pool.programs.push(programId);
      reservedPrograms.add(programId);
      reuseIdx += 1; // this program is now assigned to a world — don't reuse it for the next one
      await savePool();
      log(`[chain] program created + initialized ${programId}`);
      await keeper.ensureNow(programId);
      return { programId };
    },
    async loadMap(world) {
      return uploadFreshMap(world.programId);
    },
    async openLobby() {}, // lobby-mode: register() works in CREATED, nothing to do
    async start(world) {
      // Idempotent: the contract auto-starts when participants reach the cap (10).
      // Only call StartSession if the session is still CREATED — it then requires >= 8.
      const session = await readSession(world.programId);
      if (session.status === SESSION_ACTIVE) return;
      await chain.sendAdmin(world.programId, chain.encode.startSession());
    },
    async finish(world) {
      await chain.sendAdmin(world.programId, chain.encode.finishSession());
    },
    async recycle(world) {
      // UploadMap on the same program clears agents + bumps session → reuse forever.
      return uploadFreshMap(world.programId);
    },
    async retire() {},
    async pollAgents(world) {
      return readAgents(world.programId); // real on-chain owner ActorIds
    },
    // Proactive top-up so a live world never runs its executable balance dry.
    ensureBalance(world) {
      keeper.ensure(world.programId);
    },
    balanceSnapshot: () => keeper.snapshot(),
    disconnect: () => chain.disconnect(),
  };
}
