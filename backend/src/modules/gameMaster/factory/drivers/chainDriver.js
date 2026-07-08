// Real chain driver — runs the factory lifecycle against deployed DiggerWorld
// programs via the operator/admin account. Same shape as dryRunDriver, so the
// factory state machine is identical; only the side effects are real.
//
//   provision  → reuse a persisted program from the fixed pool; optional
//                createProgram is only allowed when FACTORY_ALLOW_CREATE=true
//   loadMap    → generateMap + Admin.UploadMap   (→ CREATED, registration open;
//                also reopens a reused program by clearing agents)
//   start      → Admin.StartSession (contract can also auto-start at cap=10)
//   finish     → Admin.FinishSession
//   recycle    → Admin.UploadMap again (clears agents, bumps session, → CREATED)
//   pollAgents → World.Agents() length
//
// Code is validated ONCE → its code id + deployed program ids are persisted to
// Postgres in production, or to <GAMEMASTER_STATE_DIR>/factory-programs.json in
// local JSON mode. Restarts reuse the pool for the selected code id.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMap, randomSeed, gridHash } from '../../genmap.js';
import { createBalanceKeeper } from '../balanceKeeper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../../..'); // backend/src/modules/gameMaster/factory/drivers → repo root
const SESSION_CREATED = 0;
const SESSION_ACTIVE = 1;
const SESSION_FINISHED = 2;

export async function createChainDriver({
  env,
  log = console.log,
  reservedProgramIds = [],
  documentStore = null,
  documentPrefix = '',
}) {
  const { connectDiggerWorldChain } = await import('../../../../chain/diggerWorld.js');
  const chain = await connectDiggerWorldChain(env);

  // Keeps each live world's executable balance funded so injected actions never
  // start failing mid-session (the world would otherwise silently stall).
  const keeper = createBalanceKeeper({
    chain,
    log,
    stateStore: documentStore,
    stateDocumentId: `${documentPrefix}factory:balance-keeper`,
    options: {
      minWvara: env.balanceMinWvara,
      topUpWvara: env.balanceTopUpWvara,
      checkMs: env.balanceCheckMs,
      cooldownMs: env.balanceCooldownMs,
    },
  });

  const poolFile = path.resolve(ROOT, process.env.GAMEMASTER_STATE_DIR || 'state', 'factory-programs.json');
  const poolDocumentId = `${documentPrefix}factory:factory-programs`;
  const poolResetRequestId = env.resetRequestId || null;
  const pool = await loadPool();
  let codeId = env.codeId || pool.codeId || null;
  let reuseIdx = 0; // next persisted program to reuse before deploying a new one
  const reservedPrograms = new Set((reservedProgramIds || []).filter(Boolean).map(String));
  const hardPoolSize = Number(env.poolSize || 0);
  const allowCreate = env.allowCreate === true || env.allowCreate === 'true' || env.allowCreate === 1;
  const adminReplyTimeoutMs = Number(env.timeoutMs || 180000);

  async function loadPool() {
    const doc = await documentStore?.read(poolDocumentId, undefined);
    if (doc !== undefined) return normalizePool(doc);
    try {
      return normalizePool(JSON.parse(await readFile(poolFile, 'utf8')));
    } catch {
      return { codeId: env.codeId || null, programs: [] };
    }
  }
  async function savePool() {
    if (documentStore) {
      await documentStore.write(poolDocumentId, pool);
      return;
    }
    await mkdir(path.dirname(poolFile), { recursive: true });
    await writeFile(poolFile, `${JSON.stringify(pool, null, 2)}\n`);
  }

  function knownProgramCount() {
    return new Set([...pool.programs, ...reservedPrograms].filter(Boolean).map(String)).size;
  }

  function normalizePool(value) {
    if (poolResetRequestId && value?.resetRequestId !== poolResetRequestId) {
      return { resetRequestId: poolResetRequestId, codeId: env.codeId || null, programs: [] };
    }
    if (poolCodeMismatch(value, env.codeId)) {
      log(
        `[chain] ignoring program pool for codeId=${value?.codeId || 'none'} ` +
        `(expected ${env.codeId})`,
      );
      return {
        resetRequestId: value?.resetRequestId || poolResetRequestId || null,
        codeId: env.codeId || null,
        programs: [],
      };
    }
    return {
      resetRequestId: value?.resetRequestId || poolResetRequestId || null,
      codeId: value?.codeId || null,
      programs: Array.isArray(value?.programs) ? value.programs : [],
    };
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

  async function waitForAdminReply(label, operation) {
    const promise = operation();
    promise.catch(() => {});
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`${label} reply timeout after ${adminReplyTimeoutMs}ms`)),
          adminReplyTimeoutMs,
        );
      }),
    ]);
  }

  async function waitForSession(programId, predicate, label) {
    const deadline = Date.now() + adminReplyTimeoutMs;
    let lastSession = null;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        lastSession = await readSession(programId);
        if (predicate(lastSession)) return lastSession;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `${label} state recovery failed; last session=${JSON.stringify(lastSession)} ` +
      `last error=${lastError?.message || lastError || '-'}`,
    );
  }

  async function sendAdminWithSessionRecovery(programId, label, payload, predicate) {
    try {
      await waitForAdminReply(label, () => chain.sendAdmin(programId, payload));
      return await waitForSession(programId, predicate, label);
    } catch (error) {
      log(`[chain] ${label} reply missing; checking session state: ${error?.message || error}`);
      return waitForSession(programId, predicate, label);
    }
  }

  async function readAgents(programId) {
    const reply = await chain.query(programId, chain.encode.agents());
    const arr = chain.decode.agents(reply.payload);
    // World.Agents() → [ActorId] (32-byte hex, '0x'+12 zero bytes + the agent's
    // 20-byte EOA). These are the real owners that registered.
    return Array.isArray(arr) ? arr.map(String) : [];
  }

  async function readSnapshot(programId) {
    const [configReply, sessionReply, mapReply, agentsReply] = await Promise.all([
      chain.query(programId, chain.encode.config()),
      chain.query(programId, chain.encode.session()),
      chain.query(programId, chain.encode.mapSnapshot()),
      chain.query(programId, chain.encode.agents()),
    ]);
    const config = chain.decode.config(configReply.payload).map((v) => Number(v));
    const session = chain.decode.session(sessionReply.payload).map((v) => Number(v));
    const rawGrid = chain.decode.mapSnapshot(mapReply.payload).map((v) => Number(v));
    const owners = chain.decode.agents(agentsReply.payload).map(String);
    const agents = await Promise.all(owners.map(async (owner, index) => {
      const [stateReply, inventoryReply] = await Promise.all([
        chain.query(programId, chain.encode.agentOf(owner)),
        chain.query(programId, chain.encode.inventoryOf(owner)),
      ]);
      return {
        index,
        owner,
        state: chain.decode.agentOf(stateReply.payload).map((v) => Number(v)),
        inventory: chain.decode.inventoryOf(inventoryReply.payload).map((v) => Number(v)),
      };
    }));
    return { config, session, rawGrid, agents };
  }

  async function uploadFreshMap(programId) {
    let map = null;
    for (let attempt = 0; attempt < 5 && !map; attempt += 1) {
      const candidate = generateMap(randomSeed(), { contractSurface: env.contractSurface });
      if (candidate.valid) map = candidate;
    }
    if (!map) throw new Error('could not generate a valid map after 5 attempts');
    const expectedSeed = Number(map.seed);
    const session = await sendAdminWithSessionRecovery(
      programId,
      'UploadMap',
      chain.encode.uploadMap(map.seed, map.map),
      (state) => Number(state.seed) === expectedSeed && Number(state.status) === SESSION_CREATED,
    );
    return { seed: String(map.seed), mapHash: gridHash(map.map), sessionId: session.sessionId };
  }

  async function configureWorldEconomy(programId) {
    if (!env.resVmtProgramId) return;
    const result = await chain.ensureWorldEconomy(programId);
    if (result?.skipped) {
      log(`[chain] economy skipped ${programId}: ${result.reason}`);
      return;
    }
    log(
      `[chain] economy configured ${programId} ` +
      `resVmt=${result.resVmtProgramId} ` +
      `minter=${result.wasMinter ? 'existing' : 'added'} ` +
      `resourceVmt=${result.resourceVmtUpdated ? 'updated' : 'existing'}`,
    );
  }

  async function rememberProgram(programId) {
    if (pool.programs.includes(programId)) return;
    pool.programs.push(programId);
    await savePool();
  }

  async function ensureProgramInitialized(programId) {
    // The Create() ctor (the program's INIT message) MUST go through the Mirror on
    // Ethereum L1 — an injected tx does not initialize a freshly created program.
    // chain.initializeProgram waits through the registration window, runs Create()
    // via the mirror, and confirms `initialized` before returning. Idempotent: it
    // no-ops if the program is already initialized (reused pool programs).
    log(`[chain] ensuring program initialized ${programId}`);
    await chain.initializeProgram(programId);
    return readSession(programId);
  }

  return {
    async provision() {
      // Reuse an already-deployed program before paying to create a new one.
      // loadMap's UploadMap reopens it (clears agents → CREATED).
      while (reuseIdx < pool.programs.length) {
        const programId = pool.programs[reuseIdx];
        if (reservedPrograms.has(programId)) {
          reuseIdx += 1;
          continue;
        }
        log(`[chain] reusing program ${programId}`);
        await ensureProgramInitialized(programId);
        await keeper.ensureNow(programId); // a reused program may be low — top up before opening
        await configureWorldEconomy(programId);
        reservedPrograms.add(programId);
        reuseIdx += 1;
        return { programId };
      }
      if (hardPoolSize > 0 && knownProgramCount() >= hardPoolSize) {
        throw new Error(
          `program pool hard cap reached (${knownProgramCount()}/${hardPoolSize}); ` +
          'refusing to create a new on-chain program',
        );
      }
      if (!allowCreate) {
        throw new Error(
          `program pool exhausted (${knownProgramCount()}/${hardPoolSize || 'unbounded'}) ` +
          'and FACTORY_ALLOW_CREATE=false; refusing to create a new on-chain program',
        );
      }
      const code = await ensureCode();
      const programId = await chain.createProgram(code, BigInt(env.topUp));
      // createProgram already charged the initial executable balance. Persist the
      // program before any later chain step so a dropped Create/UploadMap reply
      // cannot leak a funded program outside the pool.
      await rememberProgram(programId);
      await ensureProgramInitialized(programId);
      await configureWorldEconomy(programId);
      reservedPrograms.add(programId);
      reuseIdx += 1; // this program is now assigned to a world — don't reuse it for the next one
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
      // Only call StartSession if the session is still CREATED; the contract
      // enforces its own minimum participant count.
      const session = await readSession(world.programId);
      if (session.status === SESSION_ACTIVE) return;
      await sendAdminWithSessionRecovery(
        world.programId,
        'StartSession',
        chain.encode.startSession(),
        (state) => Number(state.status) === SESSION_ACTIVE,
      );
    },
    async finish(world) {
      await sendAdminWithSessionRecovery(
        world.programId,
        'FinishSession',
        chain.encode.finishSession(),
        (state) => Number(state.status) === SESSION_FINISHED,
      );
    },
    async recycle(world) {
      // UploadMap on the same program clears agents + bumps session → reuse forever.
      return uploadFreshMap(world.programId);
    },
    async retire() {},
    async pollSession(world) {
      return readSession(world.programId);
    },
    async pollAgents(world) {
      return readAgents(world.programId); // real on-chain owner ActorIds
    },
    async archiveSnapshot(world) {
      return readSnapshot(world.programId);
    },
    // Proactive top-up so a live world never runs its executable balance dry.
    ensureBalance(world) {
      keeper.ensure(world.programId);
    },
    balanceSnapshot: () => keeper.snapshot(),
    disconnect: () => chain.disconnect(),
  };
}

export function poolCodeMismatch(pool, expectedCodeId) {
  if (!expectedCodeId) return false;
  const programs = Array.isArray(pool?.programs) ? pool.programs.filter(Boolean) : [];
  if (programs.length === 0) return false;
  if (!pool?.codeId) return true;
  return String(pool.codeId).toLowerCase() !== String(expectedCodeId).toLowerCase();
}
