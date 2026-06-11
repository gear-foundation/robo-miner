#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CodeState,
  createVaraEthApi,
  getMirrorClient,
  HttpVaraEthProvider,
  ReplyCode,
  WsVaraEthProvider,
  type VaraEthApi,
} from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";
import { generateCodeHash } from "@vara-eth/api/util";
import { config as loadEnv } from "dotenv";
import { SailsProgram } from "sails-js";
import { SailsIdlParser } from "sails-js/parser";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

import { unwrapInjectedPromise } from "./injected-reply.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

const DEFAULTS = {
  ETHEREUM_RPC: "wss://hoodi-reth-rpc.gear-tech.io/ws",
  VARA_ETH_RPC: "wss://vara-eth-validator-1.gear-tech.io",
  ROUTER_ADDRESS: "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
  DIGGER_PROMISE_TIMEOUT_MS: "60000",
  DIGGER_QUERY_TIMEOUT_MS: "30000",
  DIGGER_PROXY_TOP_UP: "100000000000000",
  DIGGER_VALIDATOR_MODE: "default",
} as const;

const PROXY_IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_proxy.idl");
const PROXY_WASM_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_proxy.opt.wasm");
const WORLD_IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const ENV_PATH = path.join(ROOT, ".env");
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

type ValidatorMode = "default" | "slot";

type CliArgs = {
  program?: string;
  world?: string;
  owner?: string;
  codeId?: string;
  wasm?: string;
  topUp?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  forceNew?: boolean;
  codeIdFromWasm?: boolean;
  noRegister?: boolean;
  noWriteEnv?: boolean;
  dryRun?: boolean;
  help?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

type SessionView = {
  sessionId: bigint;
  seed: bigint;
  status: bigint;
  actionSeq: bigint;
  raw: string[];
};

const SESSION_ACTIVE = 1n;
const MIN_SESSION_PARTICIPANTS = 8;

function printUsage() {
  console.log(`Usage:
  pnpm deploy-proxy
  pnpm deploy-proxy -- --program <existingProxy>

Flow:
  1. Resolve and validate DiggerProxy code from DIGGER_PROXY_CODE_ID or release wasm.
  2. Create DiggerProxy mirror unless --program or DIGGER_PROXY_PROGRAM_ID exists.
  3. Initialize it with Create(owner, world).
  4. Call Digger.Register() so World stores the proxy address as agent id.
  5. Verify World.AgentOf(proxy) and update .env.

Inputs:
  --program          Existing proxy mirror to resume. Defaults to DIGGER_PROXY_PROGRAM_ID.
  --world            World mirror address. Defaults to DIGGER_PROXY_WORLD_ID, then DIGGER_PROGRAM_ID.
  --owner            Owner ActorId/address. Defaults to signer address.
  --code-id          Proxy code id. Defaults to DIGGER_PROXY_CODE_ID or wasm hash.
  --wasm             Proxy wasm artifact. Defaults to target release digger_proxy.opt.wasm.
  --top-up           Initial executable balance. Defaults to DIGGER_PROXY_TOP_UP.
  --validator        "default" or "slot". Defaults to DIGGER_VALIDATOR_MODE/default.
  --new, --force-new Ignore DIGGER_PROXY_PROGRAM_ID and create a new proxy mirror.
  --code-id-from-wasm
                     Ignore DIGGER_PROXY_CODE_ID and derive code id from proxy wasm.
  --no-register      Deploy/init only; skip Digger.Register().
  --no-write-env     Do not write DIGGER_PROXY_PROGRAM_ID/CODE_ID.
  --dry-run          Resolve local inputs and print payload sizes without sending txs.

Environment:
  PRIVATE_KEY
  ETHEREUM_RPC
  VARA_ETH_RPC
  ROUTER_ADDRESS
  DIGGER_PROGRAM_ID
  DIGGER_PROXY_PROGRAM_ID
  DIGGER_PROXY_CODE_ID
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[i];
    };

    switch (arg) {
      case "--":
        break;
      case "--program":
      case "-p":
        args.program = next();
        break;
      case "--world":
        args.world = next();
        break;
      case "--owner":
        args.owner = next();
        break;
      case "--code-id":
        args.codeId = next();
        break;
      case "--wasm":
        args.wasm = next();
        break;
      case "--top-up":
        args.topUp = next();
        break;
      case "--eth-rpc":
        args.ethRpc = next();
        break;
      case "--vara-rpc":
        args.varaRpc = next();
        break;
      case "--router":
        args.router = next();
        break;
      case "--private-key":
        args.privateKey = next();
        break;
      case "--timeout-ms":
        args.timeoutMs = next();
        break;
      case "--promise-timeout-ms":
        args.promiseTimeoutMs = next();
        break;
      case "--query-timeout-ms":
        args.queryTimeoutMs = next();
        break;
      case "--validator": {
        const value = next();
        if (value !== "default" && value !== "slot") {
          throw new Error("--validator must be either default or slot");
        }
        args.validatorMode = value;
        break;
      }
      case "--new":
      case "--force-new":
        args.forceNew = true;
        break;
      case "--code-id-from-wasm":
        args.codeIdFromWasm = true;
        break;
      case "--no-register":
        args.noRegister = true;
        break;
      case "--no-write-env":
        args.noWriteEnv = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function envAny(names: string[]): string | undefined {
  for (const name of names) {
    const value = envValue(name);
    if (value) return value;
  }
  return undefined;
}

function valueOrDefault(
  names: string[],
  fallback: keyof typeof DEFAULTS,
  override?: string,
): string {
  return override?.trim() || envAny(names) || DEFAULTS[fallback];
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${name} must be a hex string`);
  }
  return hex.toLowerCase() as Hex;
}

function normalizeHex32(value: string, name: string): Hex {
  const hex = normalizeHex(value, name);
  if (hex.length !== 66) {
    throw new Error(`${name} must be 32-byte hex`);
  }
  return hex;
}

function normalizeAddress(value: string, name: string): Address {
  const hex = normalizeHex(value, name);
  if (hex.length === 66) return `0x${hex.slice(-40)}` as Address;
  if (hex.length !== 42) {
    throw new Error(`${name} must be a 20-byte address or 32-byte ActorId`);
  }
  return hex as Address;
}

function actorIdFromAddress(address: Address): Hex {
  return `0x${"00".repeat(12)}${address.slice(2)}` as Hex;
}

function normalizeActorId(value: string, name: string): Hex {
  const hex = normalizeHex(value, name);
  if (hex.length === 66) return hex;
  if (hex.length === 42) return actorIdFromAddress(hex as Address);
  throw new Error(`${name} must be a 20-byte address or 32-byte ActorId`);
}

function normalizePrivateKey(value: string): Hex {
  const hex = normalizeHex(value, "PRIVATE_KEY");
  if (hex.length !== 66) throw new Error("PRIVATE_KEY must be 32-byte hex");
  return hex;
}

function parseAmount(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a decimal bigint amount`);
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error(`${name} must not be negative`);
  return parsed;
}

function resolveFromRoot(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
}

function varaProviderFor(url: string, timeoutMs: number) {
  if (url.startsWith("ws")) {
    return new WsVaraEthProvider(url as `ws://${string}` | `wss://${string}`, {
      requestTimeout: timeoutMs,
    });
  }

  return new HttpVaraEthProvider(url as `http://${string}` | `https://${string}`, {
    requestTimeout: timeoutMs,
  });
}

function ethTransportFor(url: string) {
  return url.startsWith("ws") ? webSocket(url) : http(url);
}

async function connect(args: CliArgs, timeoutMs: number): Promise<Connection> {
  const privateKey = normalizePrivateKey(
    requireValue(args.privateKey || envValue("PRIVATE_KEY"), "PRIVATE_KEY"),
  );
  const ethRpc = valueOrDefault(
    ["ETHEREUM_RPC", "DIGGER_ETH_RPC", "TESTNET_ETHEREUM_RPC"],
    "ETHEREUM_RPC",
    args.ethRpc,
  );
  const varaRpc = valueOrDefault(
    ["VARA_ETH_RPC", "DIGGER_VALIDATOR_RPC", "TESTNET_VARA_ETH_RPC"],
    "VARA_ETH_RPC",
    args.varaRpc,
  );
  const router = normalizeAddress(
    valueOrDefault(
      ["ROUTER_ADDRESS", "DIGGER_ROUTER_ADDRESS", "TESTNET_ROUTER_ADDRESS"],
      "ROUTER_ADDRESS",
      args.router,
    ),
    "ROUTER_ADDRESS",
  );

  const account = privateKeyToAccount(privateKey, { nonceManager });
  const ethTransport = ethTransportFor(ethRpc);
  const publicClient = createPublicClient({ transport: ethTransport });
  const walletClient = createWalletClient({ transport: ethTransport, account });
  const provider = varaProviderFor(varaRpc, timeoutMs);
  const api = await createVaraEthApi(
    provider,
    publicClient,
    router,
    walletClientToSigner(walletClient),
  );

  return {
    api,
    accountAddress: (await api.eth.signer.getAddress()) as Address,
    disconnect: () => provider.disconnect(),
  };
}

async function loadSails(idlPath: string): Promise<SailsProgram> {
  if (!existsSync(idlPath)) {
    throw new Error(`IDL file does not exist: ${idlPath}`);
  }

  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(await readFile(idlPath, "utf8")));
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function normalizeReplyCode(code: ReplyCode | string): Hex {
  return typeof code === "string" ? (code as Hex) : bytesToHex(code.toBytes());
}

function decodeErrorPayload(sails: SailsProgram | undefined, payload: Hex | undefined): string {
  if (!sails || !payload || payload === "0x") return "";
  try {
    return `; decoded=${stringify(sails.decodeError(payload))}`;
  } catch {
    return "";
  }
}

function assertSuccessReply(
  code: ReplyCode | string,
  sails?: SailsProgram,
  payload?: Hex,
) {
  const replyCode = typeof code === "string" ? ReplyCode.fromBytes(code as Hex) : code;
  if (!replyCode.isSuccess) {
    throw new Error(
      `program reply failed: ${normalizeReplyCode(code)} (${replyCode.reason})${decodeErrorPayload(sails, payload)}`,
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      console.warn(`[timeout] ${label} did not finish within ${timeoutMs}ms`);
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codeStateName(state: CodeState): string {
  switch (state) {
    case CodeState.Unknown:
      return "Unknown";
    case CodeState.ValidationRequested:
      return "ValidationRequested";
    case CodeState.Validated:
      return "Validated";
    default:
      return String(state);
  }
}

async function waitForCodeState(
  api: VaraEthApi,
  codeId: Hex,
  expected: CodeState,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await api.eth.router.codeState(codeId);
    if (state === expected) return state;
    await sleep(5_000);
  }

  const state = await api.eth.router.codeState(codeId);
  throw new Error(
    `Timed out waiting for code ${codeId} to become ${codeStateName(expected)}; current=${codeStateName(state)}`,
  );
}

async function resolveProxyCodeId(args: CliArgs): Promise<Hex> {
  if (!args.codeIdFromWasm) {
    const explicit = args.codeId || envValue("DIGGER_PROXY_CODE_ID");
    if (explicit) return normalizeHex32(explicit, "DIGGER_PROXY_CODE_ID");
  }

  const wasmPath = resolveFromRoot(args.wasm || PROXY_WASM_PATH);
  if (!existsSync(wasmPath)) throw new Error(`Wasm artifact does not exist: ${wasmPath}`);
  const codeId = generateCodeHash(new Uint8Array(await readFile(wasmPath)));
  console.log("[code] resolved from proxy wasm", { wasmPath, codeId });
  return normalizeHex32(codeId, "proxy wasm code hash");
}

async function ensureCodeValidated(
  api: VaraEthApi,
  codeId: Hex,
  args: CliArgs,
  timeoutMs: number,
): Promise<Hex> {
  const state = await api.eth.router.codeState(codeId);
  console.log("[code] state", { codeId, state: codeStateName(state) });

  if (state === CodeState.Validated) return codeId;
  if (state === CodeState.ValidationRequested) {
    await waitForCodeState(api, codeId, CodeState.Validated, timeoutMs);
    return codeId;
  }

  const wasmPath = resolveFromRoot(args.wasm || PROXY_WASM_PATH);
  if (!existsSync(wasmPath)) {
    throw new Error(`Code is not validated and wasm artifact does not exist: ${wasmPath}`);
  }

  const wasm = new Uint8Array(await readFile(wasmPath));
  const [baseFee, accountAddress] = await Promise.all([
    api.eth.router.requestCodeValidationBaseFee(),
    api.eth.signer.getAddress(),
  ]);
  const balance = await api.eth.wvara.balanceOf(accountAddress);
  if (balance < baseFee) {
    throw new Error(
      `Not enough WVARA for code validation: need ${baseFee.toString()}, balance ${balance.toString()}`,
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
  const { signature } = await api.eth.wvara.prepareAndSignPermitData(
    api.eth.router.address,
    baseFee,
    deadline,
  );
  const tx = await api.eth.router.requestCodeValidation(wasm, deadline, signature);
  console.log("[code] requesting validation", {
    wasmPath,
    codeId: tx.codeId,
    validationFee: baseFee.toString(),
    blobVersionedHashes: tx.blobVersionedHashes,
  });
  const receipt = await tx.sendAndWaitForReceipt();
  console.log("[code] validation tx", {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  });
  await waitForCodeState(api, tx.codeId, CodeState.Validated, timeoutMs);
  return tx.codeId;
}

async function createProgram(api: VaraEthApi, codeId: Hex, topUp: bigint) {
  let builder = api.eth.router.createProgramBuilder(codeId);

  if (topUp > 0n) {
    const accountAddress = await api.eth.signer.getAddress();
    const balance = await api.eth.wvara.balanceOf(accountAddress);
    if (balance < topUp) {
      throw new Error(
        `Not enough WVARA for initial executable balance: need ${topUp.toString()}, balance ${balance.toString()}`,
      );
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    const { signature } = await api.eth.wvara.prepareAndSignPermitData(
      api.eth.router.address,
      topUp,
      deadline,
    );
    builder = builder.withExecutableBalance(topUp, deadline, signature);
  }

  const tx = builder.build();
  const receipt = await tx.sendAndWaitForReceipt();
  const programId = normalizeAddress(await tx.getProgramId(), "ProgramCreated.actorId");
  console.log("[deploy] createProgram", {
    programId,
    codeId,
    topUp: topUp.toString(),
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  });
  return programId;
}

function summarizeState(state: Awaited<ReturnType<VaraEthApi["query"]["program"]["readState"]>>) {
  const active = "Active" in state.program ? state.program.Active : null;
  return {
    program: active ? "Active" : Object.keys(state.program)[0],
    initialized: active?.initialized ?? null,
    pagesHash: active?.pagesHash ?? null,
    balance: state.balance.toString(),
    executableBalance: state.executableBalance.toString(),
  };
}

async function waitForProgramVisible(api: VaraEthApi, programId: Address, timeoutMs: number) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const startedAt = Date.now();
  let lastStateHash: Hex = ZERO_HASH;

  while (Date.now() - startedAt < timeoutMs) {
    const stateHash = await mirror.stateHash();
    lastStateHash = stateHash;
    if (stateHash.toLowerCase() !== ZERO_HASH) {
      try {
        const state = await api.query.program.readState(stateHash);
        console.log("[deploy] program visible", {
          programId,
          stateHash,
          program: summarizeState(state),
        });
        return;
      } catch {
        // Fresh mirrors can expose a state hash before the RPC can read it.
      }
    }
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for program ${programId}; lastStateHash=${lastStateHash}`);
}

async function readStateSummary(api: VaraEthApi, programId: Address, timeoutMs: number) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const startedAt = Date.now();
  let lastStateHash: Hex = ZERO_HASH;
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    const stateHash = await mirror.stateHash();
    lastStateHash = stateHash;
    try {
      return {
        stateHash,
        summary: summarizeState(await api.query.program.readState(stateHash)),
      };
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out reading state for ${programId}; lastStateHash=${lastStateHash}; ${message}`);
}

async function waitForStateHashChange(
  api: VaraEthApi,
  programId: Address,
  previousStateHash: Hex,
  timeoutMs: number,
): Promise<Hex> {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const nextStateHash = await mirror.stateHash();
    if (nextStateHash.toLowerCase() !== previousStateHash.toLowerCase()) {
      return nextStateHash;
    }
    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for stateHash change from ${previousStateHash}`);
}

async function sendInjectedMessage(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
  sails?: SailsProgram,
) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const previousStateHash = await mirror.stateHash();
  const injected = await api.createInjectedTransaction({
    destination: programId,
    payload,
    value: 0n,
  });
  const recipient =
    validatorMode === "slot"
      ? await injected.setSlotValidator()
      : injected.setDefaultValidator();

  console.log(`[${label}] prepared`, {
    destination: injected.destination,
    recipient,
    messageId: injected.messageId,
    txHash: injected.txHash,
    previousStateHash,
    validatorMode,
  });

  const rawReply = await withTimeout(
    injected.sendAndWaitForPromise(),
    promiseTimeoutMs,
    `${label} injected promise`,
  );
  const reply = unwrapInjectedPromise(rawReply, label);

  if (!reply) {
    console.warn(`[${label}] continuing with stateHash polling without injected promise`);
  } else {
    console.log(`[${label}] promise`, {
      txHash: reply.txHash,
      code: normalizeReplyCode(reply.code),
      reason: reply.code.reason,
      value: reply.value.toString(),
      replyHash: reply.replyHash,
      payloadBytes: reply.payload ? (reply.payload.length - 2) / 2 : 0,
    });
    assertSuccessReply(reply.code, sails, reply.payload);
  }

  const nextStateHash = await waitForStateHashChange(
    api,
    programId,
    previousStateHash,
    stateTimeoutMs,
  );
  console.log(`[${label}] state changed`, { previousStateHash, nextStateHash });

  return reply;
}

async function sendMirrorMessage(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
  sails?: SailsProgram,
) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const previousStateHash = await mirror.stateHash();
  const tx = await mirror.sendMessage(payload, 0n);
  const txHash = await tx.send();
  const receipt = await tx.getReceipt();
  const message = await tx.getMessage();

  console.log(`[${label}] sent via mirror`, {
    destination: programId,
    txHash,
    messageId: message.id,
    blockNumber: receipt.blockNumber.toString(),
    previousStateHash,
  });

  const reply = await withTimeout(
    mirror.waitForReply(message.id, receipt.blockNumber),
    promiseTimeoutMs,
    `${label} mirror reply`,
  );

  if (!reply) {
    console.warn(`[${label}] continuing with stateHash polling without mirror reply`);
  } else {
    console.log(`[${label}] reply`, {
      txHash: reply.txHash,
      code: reply.replyCode,
      value: reply.value.toString(),
      blockNumber: reply.blockNumber,
      payloadBytes: reply.payload ? (reply.payload.length - 2) / 2 : 0,
    });
    assertSuccessReply(reply.replyCode, sails, reply.payload);
  }

  const nextStateHash = await waitForStateHashChange(
    api,
    programId,
    previousStateHash,
    stateTimeoutMs,
  );
  console.log(`[${label}] state changed`, { previousStateHash, nextStateHash });

  return reply;
}

async function queryProgram(
  api: VaraEthApi,
  caller: Address,
  programId: Address,
  payload: Hex,
  timeoutMs: number,
  label: string,
  sails?: SailsProgram,
): Promise<Hex> {
  const reply = await withTimeout(
    api.call.program.calculateReplyForHandle(caller, programId, payload, 0n),
    timeoutMs,
    label,
  );
  if (!reply) throw new Error(`${label} did not return`);
  assertSuccessReply(reply.code, sails, reply.payload);
  if (!reply.payload) throw new Error(`${label} returned no payload`);
  return reply.payload;
}

function bytes32FromDecoded(value: unknown): Hex {
  if (value instanceof Uint8Array) return bytesToHex(value) as Hex;
  if (Array.isArray(value)) {
    return bytesToHex(Uint8Array.from(value.map((item) => Number(item)))) as Hex;
  }
  if (typeof value === "string") return normalizeHex32(value, "bytes32 result");
  throw new Error(`Cannot decode bytes32 result: ${stringify(value)}`);
}

function vecToStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`Expected array result, got ${stringify(value)}`);
  return value.map((item) => String(item));
}

function sessionFromDecoded(value: unknown): SessionView {
  const raw = vecToStrings(value);
  if (raw.length < 4) throw new Error(`World.Session returned too few fields: ${stringify(value)}`);
  return {
    sessionId: BigInt(raw[0]),
    seed: BigInt(raw[1]),
    status: BigInt(raw[2]),
    actionSeq: BigInt(raw[3]),
    raw,
  };
}

async function readProxyOwnerWorld(
  connection: Connection,
  proxySails: SailsProgram,
  proxyProgramId: Address,
  queryTimeoutMs: number,
) {
  const [ownerPayload, worldPayload] = await Promise.all([
    queryProgram(
      connection.api,
      connection.accountAddress,
      proxyProgramId,
      proxySails.services.Digger.queries.Owner.encodePayload() as Hex,
      queryTimeoutMs,
      "Digger.Owner",
      proxySails,
    ),
    queryProgram(
      connection.api,
      connection.accountAddress,
      proxyProgramId,
      proxySails.services.Digger.queries.World.encodePayload() as Hex,
      queryTimeoutMs,
      "Digger.World",
      proxySails,
    ),
  ]);

  return {
    owner: proxySails.services.Digger.queries.Owner.decodeResult<unknown>(ownerPayload),
    world: proxySails.services.Digger.queries.World.decodeResult<unknown>(worldPayload),
  };
}

async function queryWorldAgent(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxyActorId: Hex,
  queryTimeoutMs: number,
): Promise<string[]> {
  const payload = worldSails.services.World.queries.AgentOf.encodePayload(proxyActorId) as Hex;
  const replyPayload = await queryProgram(
    connection.api,
    connection.accountAddress,
    worldProgramId,
    payload,
    queryTimeoutMs,
    "World.AgentOf(proxy)",
    worldSails,
  );
  return vecToStrings(worldSails.services.World.queries.AgentOf.decodeResult<unknown>(replyPayload));
}

async function readWorldSession(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  queryTimeoutMs: number,
): Promise<SessionView> {
  const payload = worldSails.services.World.queries.Session.encodePayload() as Hex;
  const replyPayload = await queryProgram(
    connection.api,
    connection.accountAddress,
    worldProgramId,
    payload,
    queryTimeoutMs,
    "World.Session",
    worldSails,
  );
  return sessionFromDecoded(worldSails.services.World.queries.Session.decodeResult<unknown>(replyPayload));
}

async function readWorldAgentCount(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  queryTimeoutMs: number,
): Promise<number> {
  const payload = worldSails.services.World.queries.Agents.encodePayload() as Hex;
  const replyPayload = await queryProgram(
    connection.api,
    connection.accountAddress,
    worldProgramId,
    payload,
    queryTimeoutMs,
    "World.Agents",
    worldSails,
  );
  const agents = worldSails.services.World.queries.Agents.decodeResult<unknown>(replyPayload);
  if (!Array.isArray(agents)) throw new Error("World.Agents returned a non-array result");
  return agents.length;
}

async function waitForWorldSessionActive(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  timeoutMs: number,
): Promise<SessionView> {
  const startedAt = Date.now();
  let latest: SessionView | null = null;
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      latest = await readWorldSession(connection, worldSails, worldProgramId, timeoutMs);
      if (latest.status === SESSION_ACTIVE) return latest;
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }

  if (latest) {
    throw new Error(`Timed out waiting for active World.Session; latest=${stringify(latest)}`);
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for active World.Session; ${message}`);
}

async function waitForWorldAgent(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxyActorId: Hex,
  timeoutMs: number,
): Promise<string[]> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await queryWorldAgent(connection, worldSails, worldProgramId, proxyActorId, timeoutMs);
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for World.AgentOf(proxy); ${message}`);
}

async function updateEnvValues(values: Record<string, string>) {
  const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
  let next = existing;

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    next = re.test(next)
      ? next.replace(re, line)
      : `${next}${next.endsWith("\n") || next.length === 0 ? "" : "\n"}${line}\n`;
  }

  if (next !== existing) await writeFile(ENV_PATH, next, "utf8");
  console.log("[env] updated .env", values);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const timeoutMs = Number(valueOrDefault(["DIGGER_EVENT_TIMEOUT_MS"], "DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs));
  const promiseTimeoutMs = Number(
    valueOrDefault(["DIGGER_PROMISE_TIMEOUT_MS"], "DIGGER_PROMISE_TIMEOUT_MS", args.promiseTimeoutMs),
  );
  const queryTimeoutMs = Number(
    valueOrDefault(["DIGGER_QUERY_TIMEOUT_MS"], "DIGGER_QUERY_TIMEOUT_MS", args.queryTimeoutMs),
  );
  const validatorMode = (args.validatorMode ||
    envValue("DIGGER_VALIDATOR_MODE") ||
    DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;
  const topUp = parseAmount(
    args.topUp || envValue("DIGGER_PROXY_TOP_UP") || DEFAULTS.DIGGER_PROXY_TOP_UP,
    "DIGGER_PROXY_TOP_UP",
  );
  const worldProgramId = normalizeAddress(
    requireValue(
      args.world || envValue("DIGGER_PROXY_WORLD_ID") || envValue("DIGGER_PROGRAM_ID"),
      "--world, DIGGER_PROXY_WORLD_ID, or DIGGER_PROGRAM_ID",
    ),
    "world program id",
  );
  if (args.forceNew && args.program) {
    throw new Error("--new/--force-new cannot be combined with --program");
  }
  const resumeProgram = args.forceNew ? undefined : args.program || envValue("DIGGER_PROXY_PROGRAM_ID");
  const proxySails = await loadSails(PROXY_IDL_PATH);
  const worldSails = await loadSails(WORLD_IDL_PATH);
  const worldActorId = actorIdFromAddress(worldProgramId);
  const ownerInput = args.owner || envValue("DIGGER_PROXY_OWNER") || "<signer>";

  if (validatorMode !== "default" && validatorMode !== "slot") {
    throw new Error("DIGGER_VALIDATOR_MODE must be either default or slot");
  }
  for (const [name, value] of Object.entries({ timeoutMs, promiseTimeoutMs, queryTimeoutMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }

  console.log("[proxy] prepared", {
    worldProgramId,
    worldActorId,
    owner: ownerInput,
    topUp: topUp.toString(),
    validatorMode,
    resumeProgram: resumeProgram || null,
    forceNew: Boolean(args.forceNew),
    codeIdFromWasm: Boolean(args.codeIdFromWasm),
    writeEnv: !args.noWriteEnv,
    register: !args.noRegister,
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) return;

  const connection = await connect(args, timeoutMs);
  try {
    const ownerActorId = normalizeActorId(
      args.owner || envValue("DIGGER_PROXY_OWNER") || connection.accountAddress,
      "proxy owner",
    );
    const createCtor = proxySails.ctors?.Create;
    if (!createCtor) throw new Error("Proxy IDL does not contain DiggerProxy.Create constructor");
    const createPayload = createCtor.encodePayload(ownerActorId, worldActorId) as Hex;
    const registerPayload = proxySails.services.Digger.functions.Register.encodePayload() as Hex;

    console.log("[connect]", {
      account: connection.accountAddress,
      ownerActorId,
      createPayloadBytes: (createPayload.length - 2) / 2,
      registerPayloadBytes: (registerPayload.length - 2) / 2,
    });

    let codeId: Hex | null = null;
    const proxyProgramId = resumeProgram
      ? normalizeAddress(resumeProgram, "DIGGER_PROXY_PROGRAM_ID")
      : await (async () => {
          const resolved = await ensureCodeValidated(
            connection.api,
            await resolveProxyCodeId(args),
            args,
            timeoutMs,
          );
          codeId = resolved;
          return createProgram(connection.api, resolved, topUp);
        })();

    if (resumeProgram) {
      codeId = normalizeHex32(
        await connection.api.eth.router.programCodeId(proxyProgramId),
        "router.programCodeId(proxy)",
      );
      console.log("[code] resolved from existing proxy", { proxyProgramId, codeId });
    }

    await waitForProgramVisible(connection.api, proxyProgramId, timeoutMs);

    const beforeInit = await readStateSummary(connection.api, proxyProgramId, queryTimeoutMs);
    if (beforeInit.summary.initialized === true) {
      console.log("[init] skipped; proxy already initialized", {
        proxyProgramId,
        stateHash: beforeInit.stateHash,
      });
    } else {
      await sendMirrorMessage(
        connection.api,
        proxyProgramId,
        "init-proxy",
        createPayload,
        promiseTimeoutMs,
        timeoutMs,
        proxySails,
      );
    }

    const proxyState = await readStateSummary(connection.api, proxyProgramId, queryTimeoutMs);
    if (proxyState.summary.initialized !== true) {
      throw new Error(`Proxy is not initialized after init; stateHash=${proxyState.stateHash}`);
    }

    console.log("[proxy] owner/world", await readProxyOwnerWorld(
      connection,
      proxySails,
      proxyProgramId,
      queryTimeoutMs,
    ));

    const proxyActorId = actorIdFromAddress(proxyProgramId);
    let session = await readWorldSession(
      connection,
      worldSails,
      worldProgramId,
      queryTimeoutMs,
    );
    console.log("[world] session", {
      sessionId: session.sessionId.toString(),
      seed: session.seed.toString(),
      status: session.status.toString(),
      actionSeq: session.actionSeq.toString(),
    });

    let agent: string[] | null = null;
    try {
      agent = await queryWorldAgent(
        connection,
        worldSails,
        worldProgramId,
        proxyActorId,
        queryTimeoutMs,
      );
      console.log("[world] proxy already registered", { proxyActorId, agent });
    } catch (error) {
      console.log("[world] proxy not registered yet", error instanceof Error ? error.message : String(error));
    }

    if (!agent && !args.noRegister) {
      const registerReply = await sendInjectedMessage(
        connection.api,
        proxyProgramId,
        "digger-register",
        registerPayload,
        validatorMode,
        promiseTimeoutMs,
        timeoutMs,
        proxySails,
      );
      if (registerReply?.payload && registerReply.payload !== "0x") {
        const decoded = proxySails.services.Digger.functions.Register.decodeResult<unknown>(registerReply.payload);
        console.log("[digger-register] forwarded message id", bytes32FromDecoded(decoded));
      }
      agent = await waitForWorldAgent(
        connection,
        worldSails,
        worldProgramId,
        proxyActorId,
        timeoutMs,
      );
      console.log("[world] proxy registered", { proxyActorId, agent });
    }

    session = await readWorldSession(
      connection,
      worldSails,
      worldProgramId,
      queryTimeoutMs,
    );
    const agentCount = await readWorldAgentCount(
      connection,
      worldSails,
      worldProgramId,
      queryTimeoutMs,
    );
    console.log("[world] post-register session", {
      sessionId: session.sessionId.toString(),
      seed: session.seed.toString(),
      status: session.status.toString(),
      actionSeq: session.actionSeq.toString(),
      agentCount,
    });

    if (session.status !== SESSION_ACTIVE && agentCount >= MIN_SESSION_PARTICIPANTS) {
      const startPayload = worldSails.services.Admin.functions.StartSession.encodePayload() as Hex;
      await sendInjectedMessage(
        connection.api,
        worldProgramId,
        "world-start-session",
        startPayload,
        validatorMode,
        promiseTimeoutMs,
        timeoutMs,
        worldSails,
      );
      session = await waitForWorldSessionActive(
        connection,
        worldSails,
        worldProgramId,
        timeoutMs,
      );
      console.log("[world] session active", {
        sessionId: session.sessionId.toString(),
        seed: session.seed.toString(),
        status: session.status.toString(),
        actionSeq: session.actionSeq.toString(),
      });
    } else if (session.status !== SESSION_ACTIVE) {
      console.log("[world] session remains in registration phase", {
        agentCount,
        minToStart: MIN_SESSION_PARTICIPANTS,
      });
    }

    if (!args.noWriteEnv && codeId) {
      await updateEnvValues({
        DIGGER_PROXY_PROGRAM_ID: proxyProgramId,
        DIGGER_PROXY_CODE_ID: codeId,
      });
    }

    console.log("[proxy] complete", {
      proxyProgramId,
      proxyActorId,
      worldProgramId,
      codeId,
      registered: Boolean(agent),
    });
  } finally {
    await connection.disconnect().catch(() => undefined);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${message}`);
    process.exit(1);
  });
