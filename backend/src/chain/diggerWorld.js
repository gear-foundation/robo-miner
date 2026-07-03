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
import { cloneWorldConfig, DEFAULT_WORLD_CONFIG } from '../config/networks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IDL = path.join(__dirname, 'diggerWorld.idl');
const DEFAULT_WASM = path.resolve(
  __dirname,
  '../../../contracts/target/wasm32-gear/release/digger_world.opt.wasm',
);
const DEFAULT_RES_VMT_IDL = path.resolve(
  __dirname,
  '../../../contracts/target/wasm32-gear/release/digger_res_vmt.idl',
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const permitDeadline = () => BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
const hexKey = (key) => (key.startsWith('0x') ? key : `0x${key}`);
const SUCCESS_REPLY_CODES = new Set(['0x00010000', '0x00000000']);
const ZERO_STATE_HASH = `0x${'0'.repeat(64)}`;

// 12 zero bytes + 20-byte EOA address = 32-byte ActorId (matches the scripts).
export const actorIdFromAddress = (address) => `0x${'00'.repeat(12)}${address.slice(2)}`;

function normalizeAddress(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`invalid address: ${value}`);
  return text;
}

function actorIdValueToHex(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return `0x${Buffer.from(value).toString('hex')}`;
  if (value && typeof value === 'object') {
    if (typeof value.toHex === 'function') return value.toHex();
    if (typeof value.asHex === 'string') return value.asHex;
  }
  throw new Error(`cannot convert ActorId value to hex: ${String(value)}`);
}

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

function printableReplyPayload(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('0x')) return '';
  const bytes = payload.slice(2).match(/.{1,2}/g)?.map((hex) => Number.parseInt(hex, 16)) || [];
  const text = String.fromCharCode(...bytes).replace(/[^\x20-\x7e]+/g, ' ').trim();
  return text;
}

function assertSuccessfulReply(reply, label) {
  if (reply?.code?.isSuccess === false) {
    const message = printableReplyPayload(reply.payload);
    throw new Error(`${label} failed: ${reply.code.reason || 'error'}${message ? ` ${message}` : ''}`);
  }
  if (reply?.code?.isSuccess === true) return;
  const code = reply?.replyCode || reply?.code?.toString?.();
  if (!code || SUCCESS_REPLY_CODES.has(String(code))) return;
  const message = printableReplyPayload(reply.payload);
  throw new Error(`${label} failed: replyCode=${code}${message ? ` ${message}` : ''}`);
}

function createPayload(sails, worldConfig) {
  const create = sails.ctors.Create;
  if (!create?.args || create.args.length === 0) return create.encodePayload();
  return create.encodePayload(cloneWorldConfig(worldConfig || DEFAULT_WORLD_CONFIG));
}

export async function connectDiggerWorldChain(env) {
  const { WsVaraEthProvider, HttpVaraEthProvider, createVaraEthApi, getMirrorClient, CodeState } =
    await import('@vara-eth/api');
  const { walletClientToSigner } = await import('@vara-eth/api/signer');
  const { generateCodeHash } = await import('@vara-eth/api/util');
  const { SailsProgram } = await import('sails-js');
  const { SailsIdlParser } = await import('sails-js/parser');
  const { createPublicClient, createWalletClient, http, webSocket } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');

  if (!env.adminKey) throw new Error('admin key is required for chain mode (set MAINNET_ADMIN_KEY / TESTNET_ADMIN_KEY)');

  const account = privateKeyToAccount(hexKey(env.adminKey));
  const ethTransport = env.ethRpc.startsWith('ws') ? webSocket(env.ethRpc) : http(env.ethRpc);
  const publicClient = createPublicClient({ transport: ethTransport });
  const walletClient = createWalletClient({ account, transport: ethTransport });
  const isWsProvider = env.varaWs.startsWith('ws');
  const wsLabel = `${env.network || 'unknown'} ${env.varaWs}`;
  const provider = isWsProvider
    ? new WsVaraEthProvider(env.varaWs, {
        requestTimeout: env.timeoutMs,
        reconnectAttempts: Number(env.wsReconnectAttempts ?? 1_000_000),
        reconnectDelay: Number(env.wsReconnectDelay ?? 2000),
      })
    : new HttpVaraEthProvider(env.varaWs, { requestTimeout: env.timeoutMs });
  let providerClosing = false;
  let providerReconnectPromise = null;

  async function ensureProviderConnected(reason = 'request') {
    if (!isWsProvider || typeof provider.connect !== 'function' || providerClosing) return;
    if (provider.isConnected === true || provider.connectionState === 'connected') return;
    if (!providerReconnectPromise) {
      console.warn(`[chain] WS reconnecting reason=${reason} endpoint=${wsLabel} state=${provider.connectionState || 'unknown'}`);
      providerReconnectPromise = provider.connect().finally(() => {
        providerReconnectPromise = null;
      });
    }
    await providerReconnectPromise;
  }

  if (typeof provider.on === 'function') {
    provider.on('disconnected', (event) => {
      if (providerClosing) return;
      const details = event?.details || {};
      const reason = details.reason ? ` reason=${JSON.stringify(details.reason)}` : '';
      console.warn(
        `[chain] WS disconnected endpoint=${wsLabel} code=${details.code ?? 'unknown'} ` +
          `wasClean=${details.wasClean ?? 'unknown'}${reason}`,
      );
      ensureProviderConnected('disconnect').catch((error) => {
        console.warn(`[chain] WS reconnect failed endpoint=${wsLabel}: ${error?.message || error}`);
      });
    });
    provider.on('connected', (event) => {
      const ms = event?.details?.connectionDuration ?? 'unknown';
      console.log(`[chain] WS connected endpoint=${wsLabel} attempt=${event?.attempt ?? 'unknown'} ms=${ms}`);
    });
    provider.on('error', (e) => console.warn(`[chain] WS error endpoint=${wsLabel}: ${e?.error?.message || ''}`));
  }
  const api = await createVaraEthApi(provider, publicClient, env.router, walletClientToSigner(walletClient));
  const accountAddress = await api.eth.signer.getAddress();

  const parser = new SailsIdlParser();
  await parser.init();
  const sails = new SailsProgram(parser.parse(await readFile(env.idlPath || DEFAULT_IDL, 'utf8')));
  let resVmtSails = null;

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

  // Admin/ctor messages use injected transactions signed by the admin EOA.
  // The program sees message_source == admin (ensure_admin passes), and the
  // program's executable balance pays for execution. Router/Mirror txs are
  // still required for program creation and executable-balance top-ups.
  async function sendAdmin(programId, payload) {
    await ensureProviderConnected();
    const injected = await api.createInjectedTransaction({ destination: programId, payload, value: 0n });
    injected.setDefaultValidator();
    const reply = await waitForInjectedReply(injected);
    assertSuccessfulReply(reply, 'admin injected message');
    return reply;
  }

  async function query(programId, payload) {
    await ensureProviderConnected();
    return api.call.program.calculateReplyForHandle(accountAddress, programId, payload, 0n);
  }

  async function loadResVmtSails() {
    if (!resVmtSails) {
      resVmtSails = new SailsProgram(parser.parse(await readFile(env.resVmtIdlPath || DEFAULT_RES_VMT_IDL, 'utf8')));
    }
    return resVmtSails;
  }

  async function ensureWorldEconomy(programId, options = {}) {
    const resVmtProgramId = options.resVmtProgramId || env.resVmtProgramId;
    if (!resVmtProgramId) return { skipped: true, reason: 'res VMT is not configured' };

    const normalizedWorld = normalizeAddress(programId);
    const normalizedResVmt = normalizeAddress(resVmtProgramId);
    const worldActor = actorIdFromAddress(normalizedWorld);
    const resVmtActor = actorIdFromAddress(normalizedResVmt);
    const vmtSails = await loadResVmtSails();
    const vmtAdmin = vmtSails.services.Admin;
    const worldAdmin = sails.services.Admin;
    const result = {
      resVmtProgramId: normalizedResVmt,
      worldProgramId: normalizedWorld,
      minterAdded: false,
      resourceVmtUpdated: false,
    };

    const minterReply = await query(normalizedResVmt, vmtAdmin.queries.IsMinter.encodePayload(worldActor));
    const isMinter = vmtAdmin.queries.IsMinter.decodeResult(minterReply.payload);
    result.wasMinter = Boolean(isMinter);
    if (!isMinter) {
      await sendAdmin(normalizedResVmt, vmtAdmin.functions.AddMinter.encodePayload(worldActor));
      result.minterAdded = true;
    }

    const resourceReply = await query(normalizedWorld, worldAdmin.queries.ResourceVmt.encodePayload());
    const currentResourceVmt = actorIdValueToHex(worldAdmin.queries.ResourceVmt.decodeResult(resourceReply.payload));
    result.previousResourceVmt = currentResourceVmt;
    if (currentResourceVmt.toLowerCase() !== resVmtActor.toLowerCase()) {
      await sendAdmin(normalizedWorld, worldAdmin.functions.SetResourceVmt.encodePayload(resVmtActor));
      result.resourceVmtUpdated = true;
    }

    return result;
  }

  // Agent-side write (register/move/drill): injected from this connection's key.
  // Throws on a contract-level error reply so callers see real failures.
  async function sendInjected(programId, payload, value = 0n) {
    await ensureProviderConnected();
    const injected = await api.createInjectedTransaction({ destination: programId, payload, value });
    injected.setDefaultValidator();
    const reply = await waitForInjectedReply(injected);
    assertSuccessfulReply(reply, 'injected message');
    return reply;
  }

  // Program's executable balance pays for every injected agent action. It is NOT
  // wvara.balanceOf(programId) (that reads 0) — it lives in the program state and
  // is read via the Vara.eth node: stateHash → readState.executableBalance (wei).
  async function readExecutableBalance(programId) {
    await ensureProviderConnected();
    const mirror = mirrorFor(programId);
    const stateHash = await mirror.stateHash();
    const st = await api.query.program.readState(stateHash);
    return st.executableBalance; // bigint, 1 wVARA = 1e12
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

  // Read a program's full Vara.eth state (via its mirror state hash). Throws while
  // the program is not yet observable on the validator side (fresh program window).
  async function readProgramState(programId) {
    await ensureProviderConnected();
    const mirror = mirrorFor(programId);
    const stateHash = await mirror.stateHash();
    if (!stateHash || stateHash.toLowerCase() === ZERO_STATE_HASH) {
      throw new Error('not found state hash for program');
    }
    return api.query.program.readState(stateHash);
  }

  function isProgramInitialized(state) {
    const program = state?.program;
    return Boolean(program && 'Active' in program && program.Active?.initialized === true);
  }

  // Run the program's Create() constructor — the program's INIT message. The init
  // MUST go through the Mirror (Ethereum L1): an injected transaction does NOT
  // initialize a freshly created program (it silently never runs the ctor, which is
  // how the factory previously leaked funded-but-uninitialized programs). Idempotent.
  // Ported from contracts/scripts/reload-program.ts (the tested reference).
  async function initializeProgram(programId) {
    const deadline = Date.now() + Number(env.timeoutMs || 180000);
    // 1. Wait through the post-creation registration window until state is readable.
    let state = null;
    while (Date.now() < deadline) {
      try { state = await readProgramState(programId); break; }
      catch { await sleep(2000); }
    }
    if (!state) throw new Error(`program ${programId} not visible within ${env.timeoutMs}ms`);
    if (isProgramInitialized(state)) return;

    // 2. Send Create() through the Mirror, then wait until the program reports initialized.
    const mirror = mirrorFor(programId);
    const tx = await mirror.sendMessage(createPayload(sails, env.worldConfig), 0n);
    await tx.send();
    await tx.getReceipt();
    while (Date.now() < deadline) {
      try {
        if (isProgramInitialized(await readProgramState(programId))) return;
      } catch { /* transient — keep polling */ }
      await sleep(2000);
    }
    throw new Error(`program ${programId} did not initialize after Create()`);
  }

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
    ensureWorldEconomy,
    readProgramState,
    isProgramInitialized,
    initializeProgram,
    encode: {
      create: () => createPayload(sails, env.worldConfig),
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
      config: () => world.queries.Config.encodePayload(),
      agentOf: (owner) => world.queries.AgentOf.encodePayload(owner),
      inventoryOf: (owner) => world.queries.InventoryOf.encodePayload(owner),
      ownerOf: (proxy) => world.queries.OwnerOf.encodePayload(proxy),
      mapSnapshot: () => world.queries.MapSnapshot.encodePayload(),
      mintResources: () => world.functions.MintResources.encodePayload(),
      tradeResourcesForLadders: (scrst, bcrst, hcrst) =>
        world.functions.TradeResourcesForLadders.encodePayload(scrst, bcrst, hcrst),
    },
    decode: {
      agents: (payload) => world.queries.Agents.decodeResult(payload),
      session: (payload) => world.queries.Session.decodeResult(payload),
      config: (payload) => world.queries.Config.decodeResult(payload),
      agentOf: (payload) => world.queries.AgentOf.decodeResult(payload),
      inventoryOf: (payload) => world.queries.InventoryOf.decodeResult(payload),
      ownerOf: (payload) => world.queries.OwnerOf.decodeResult(payload),
      mapSnapshot: (payload) => world.queries.MapSnapshot.decodeResult(payload),
      // The reply of register/move/drill is the agent_view [status,x,y,…] — the
      // per-action result straight from the injected-tx receipt (no snapshot).
      actionView: (fn, payload) => world.functions[fn].decodeResult(payload),
    },
    disconnect: () => {
      providerClosing = true;
      return provider.disconnect();
    },
  };
}
