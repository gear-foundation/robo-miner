// Thin @vara-eth/api wrapper for the operator/admin account.
//
// Responsibilities: validate + upload the DiggerWorld code, create + fund a
// program (executable balance), run its Create() + Admin lifecycle, and read
// World state. Ported faithfully from contracts/scripts/reload-program.ts (the
// tested reference for this SDK version). Deps are imported lazily so dry-run
// never loads them.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IDL = path.join(__dirname, 'world.idl');
const DEFAULT_WASM = path.resolve(
  __dirname,
  '../../../contracts/target/wasm32-gear/release/digger_world.opt.wasm',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const permitDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
const hexKey = (key) => (key.startsWith('0x') ? key : `0x${key}`);

// 12 zero bytes + 20-byte EOA address = 32-byte ActorId (matches the scripts).
export const actorIdFromAddress = (address) => `0x${'00'.repeat(12)}${address.slice(2)}`;

// Send an injected (gasless) message and wait for its reply — the destination
// program's executable balance pays, so the sender EOA needs no funds.
async function waitForInjectedReply(injected) {
  if (typeof injected.sendAndWaitForReceipt === 'function') {
    const receipt = await injected.sendAndWaitForReceipt();
    await receipt.validateSignature?.();
    if (receipt.error) throw new Error(`injected transaction purged: ${receipt.error}`);
    return receipt.promise;
  }
  if (typeof injected.sendAndWaitForPromise === 'function') {
    const reply = await injected.sendAndWaitForPromise();
    await reply.validateSignature?.();
    if (reply.error) throw new Error(`injected transaction purged: ${reply.error}`);
    return reply.promise || reply;
  }
  throw new Error('injected transaction has no receipt/promise waiter');
}

export async function connectChain(env) {
  const { WsVaraEthProvider, HttpVaraEthProvider, createVaraEthApi, getMirrorClient, CodeState } =
    await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { generateCodeHash } = await import('@vara-eth/api/util');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');
  const { createPublicClient, createWalletClient, http, webSocket } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');

  if (!env.adminKey) throw new Error('DIGGER_ADMIN_KEY is required for chain mode');

  const account = privateKeyToAccount(hexKey(env.adminKey));
  const ethTransport = env.ethRpc.startsWith('ws') ? webSocket(env.ethRpc) : http(env.ethRpc);
  const publicClient = createPublicClient({ transport: ethTransport });
  const walletClient = createWalletClient({ account, transport: ethTransport });
  const provider = env.varaWs.startsWith('ws')
    ? new WsVaraEthProvider(env.varaWs, {
        requestTimeout: env.timeoutMs,
        // Resilience: keep reconnecting on a dropped WS instead of dying. Without
        // this a transient disconnect silently kills the factory + balanceKeeper
        // and a world's executable balance drains to 0 (program becomes
        // unresponsive). High attempts ≈ "never give up"; fixed short backoff.
        reconnectAttempts: Number(env.wsReconnectAttempts ?? 1_000_000),
        reconnectDelay: Number(env.wsReconnectDelay ?? 2000),
      })
    : new HttpVaraEthProvider(env.varaWs, { requestTimeout: env.timeoutMs });
  if (typeof provider.on === 'function') {
    provider.on('disconnected', () => console.warn('[chain] WS disconnected — auto-reconnecting…'));
    provider.on('connected', () => console.log('[chain] WS connected'));
    provider.on('error', (e) => console.warn(`[chain] WS error: ${e?.error?.message || ''}`));
  }
  const api = await createVaraEthApi(provider, publicClient, env.router, walletClientToSigner(walletClient));
  const accountAddress = await api.eth.signer.getAddress();

  const parser = new SailsIdlParser();
  await parser.init();
  const sails = new SailsProgram(parser.parse(await readFile(env.idlPath || DEFAULT_IDL, 'utf8')));

  const mirrorFor = (programId) =>
    getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });

  async function waitForCodeState(codeId, expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await api.eth.router.codeState(codeId);
      if (state === expected) return state;
      if (Date.now() > deadline) throw new Error(`timeout waiting for code ${codeId} -> ${expected} (now ${state})`);
      await sleep(2000);
    }
  }

  async function ensureCodeValidated(wasmPath = env.wasmPath || DEFAULT_WASM) {
    const wasm = new Uint8Array(await readFile(wasmPath));
    const codeId = generateCodeHash(wasm);
    const state = await api.eth.router.codeState(codeId);
    if (state === CodeState.Validated) return codeId;
    if (state === CodeState.ValidationRequested) {
      await waitForCodeState(codeId, CodeState.Validated, env.timeoutMs);
      return codeId;
    }
    const baseFee = await api.eth.router.requestCodeValidationBaseFee();
    const balance = await api.eth.wvara.balanceOf(accountAddress);
    if (balance < baseFee) {
      throw new Error(`not enough WVARA for code validation: need ${baseFee}, have ${balance}`);
    }
    const deadline = permitDeadline();
    const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, baseFee, deadline);
    const tx = await api.eth.router.requestCodeValidation(wasm, deadline, signature);
    await tx.sendAndWaitForReceipt();
    await waitForCodeState(tx.codeId, CodeState.Validated, env.timeoutMs);
    return tx.codeId;
  }

  async function createProgram(codeId, topUp) {
    let builder = api.eth.router.createProgramBuilder(codeId);
    if (topUp > 0n) {
      const balance = await api.eth.wvara.balanceOf(accountAddress);
      if (balance < topUp) {
        throw new Error(`not enough WVARA for executable balance: need ${topUp}, have ${balance}`);
      }
      const deadline = permitDeadline();
      const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, topUp, deadline);
      builder = builder.withExecutableBalance(topUp, deadline, signature);
    }
    const tx = builder.build();
    await tx.sendAndWaitForReceipt();
    return await tx.getProgramId();
  }

  // Admin/ctor messages go through the Mirror signed by the admin EOA, so the
  // program sees message_source == admin (ensure_admin passes).
  async function sendAdmin(programId, payload) {
    const mirror = mirrorFor(programId);
    const tx = await mirror.sendMessage(payload, 0n);
    await tx.send();
    const receipt = await tx.getReceipt();
    const message = await tx.getMessage();
    return mirror.waitForReply(message.id, receipt.blockNumber);
  }

  async function query(programId, payload) {
    return api.call.program.calculateReplyForHandle(accountAddress, programId, payload, 0n);
  }

  // Agent-side write (register/move/drill): injected from this connection's key.
  // Throws on a contract-level error reply so callers see real failures.
  async function sendInjected(programId, payload, value = 0n) {
    const injected = await api.createInjectedTransaction({ destination: programId, payload, value });
    injected.setDefaultValidator();
    const reply = await waitForInjectedReply(injected);
    if (reply?.code && reply.code.isSuccess === false) {
      throw new Error(`reply failed: ${reply.code.reason || 'error'}`);
    }
    return reply;
  }

  // Program's executable balance pays for every injected agent action. It is NOT
  // wvara.balanceOf(programId) (that reads 0) — it lives in the program state and
  // is read via the Vara.eth node: stateHash → readState.executableBalance (wei).
  async function readExecutableBalance(programId) {
    const mirror = mirrorFor(programId);
    const stateHash = await mirror.stateHash();
    const st = await api.query.program.readState(stateHash);
    return st.executableBalance; // bigint, 1 VARA = 1e12
  }

  // Top up a program's executable balance. The WVARA permit spender MUST be the
  // PROGRAM (mirror) address, not the router. Lands ~90s later (validator lag).
  async function topUpExecutableBalance(programId, value) {
    const deadline = permitDeadline();
    const { signature } = await api.eth.wvara.prepareAndSignPermitData(programId, value, deadline);
    const mirror = mirrorFor(programId);
    const tx = await mirror.executableBalanceTopUpWithPermit(value, deadline, signature);
    return tx.sendAndWaitForReceipt();
  }

  const wvaraBalanceOf = (address) => api.eth.wvara.balanceOf(address);

  const admin = sails.services.Admin.functions;
  const world = sails.services.World;

  return {
    api,
    provider,
    sails,
    accountAddress,
    mirrorFor,
    ensureCodeValidated,
    createProgram,
    sendAdmin,
    sendInjected,
    readExecutableBalance,
    topUpExecutableBalance,
    wvaraBalanceOf,
    query,
    encode: {
      create: () => sails.ctors.Create.encodePayload(),
      uploadMap: (seed, tiles) => admin.UploadMap.encodePayload(seed, tiles),
      startSession: () => admin.StartSession.encodePayload(),
      finishSession: () => admin.FinishSession.encodePayload(),
      resetMap: (seed) => admin.ResetMap.encodePayload(seed),
      register: (owner) => world.functions.Register.encodePayload(owner),
      moveAgent: (direction) => world.functions.MoveAgent.encodePayload(direction),
      drill: (direction) => world.functions.Drill.encodePayload(direction),
      placeLadder: (direction) => world.functions.PlaceLadder.encodePayload(direction),
      surface: () => world.functions.Surface.encodePayload(),
      agents: () => world.queries.Agents.encodePayload(),
      session: () => world.queries.Session.encodePayload(),
      agentOf: (owner) => world.queries.AgentOf.encodePayload(owner),
      mapSnapshot: () => world.queries.MapSnapshot.encodePayload(),
    },
    decode: {
      agents: (payload) => world.queries.Agents.decodeResult(payload),
      session: (payload) => world.queries.Session.decodeResult(payload),
      agentOf: (payload) => world.queries.AgentOf.decodeResult(payload),
      mapSnapshot: (payload) => world.queries.MapSnapshot.decodeResult(payload),
      // The reply of register/move/drill is the agent_view [status,x,y,…] — the
      // per-action result straight from the injected-tx receipt (no snapshot).
      actionView: (fn, payload) => world.functions[fn].decodeResult(payload),
    },
    disconnect: () => provider.disconnect(),
  };
}
