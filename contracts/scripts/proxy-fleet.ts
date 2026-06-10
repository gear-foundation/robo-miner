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

const PROXY_IDL_PATH = process.env.DIGGER_PROXY_IDL_PATH || path.join(ROOT, "target/wasm32-gear/release/digger_proxy.idl");
const WORLD_IDL_PATH = process.env.DIGGER_WORLD_IDL_PATH || path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const ENV_PATH = path.join(ROOT, ".env");
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

const SESSION_ACTIVE = 1n;
const AGENT_ACTIVE = 1n;
const MAP_WIDTH = 40;
const MAP_HEIGHT = 64;
const DIR_UP = 0;
const DIR_RIGHT = 1;
const DIR_DOWN = 2;
const DIR_LEFT = 3;
const DIR_CURRENT = 4;
const SIDE_LOOKAHEAD_DEPTH = 0;
const SIDE_LOOKAHEAD_RADIUS = 10;
const RESOURCE_SEARCH_MAX_DISTANCE = 24;
const RESOURCE_DISTANCE_PENALTY = 16;
const RESOURCE_DESCENT_PENALTY = 32;
const RESOURCE_ASCENT_PENALTY = 8;

const TILE_EMPTY = 0;
const TILE_DIRT = 1;
const TILE_STONE = 2;
const TILE_LAVA = 3;
const TILE_LADDER = 4;
const TILE_RESOURCE_SCRST = 10;
const TILE_RESOURCE_BCRST = 11;
const TILE_RESOURCE_HCRST = 12;
const TILE_SURFACE = 20;

type ValidatorMode = "default" | "slot";
type GoldStrategy = "round-robin" | "nearest";

type CliArgs = {
  create?: string;
  steps?: string;
  maxRounds?: string;
  goldStrategy?: GoldStrategy;
  topUp?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  proxyIndexes?: string;
  noDeploy?: boolean;
  noPlay?: boolean;
  untilGold?: boolean;
  goldAndSurface?: boolean;
  surfaceCarried?: boolean;
  help?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

type InjectedReplyMetrics = {
  programId: Address;
  messageId: Hex;
  txHash: Hex;
  promiseMs: number;
  replyCode: Hex | null;
  payloadBytes: number;
};

type SessionView = {
  sessionId: bigint;
  seed: bigint;
  status: bigint;
  actionSeq: bigint;
};

type AgentView = {
  status: bigint;
  x: number;
  y: number;
  hp: bigint;
  ladders: number;
  inventoryScrst: bigint;
  inventoryBcrst: bigint;
  inventoryHcrst: bigint;
  bankedScrst: bigint;
  bankedBcrst: bigint;
  bankedHcrst: bigint;
  backpackCapacity: bigint;
  lastActionSeq: bigint;
};

type PlannedAction = {
  fn: "Drill" | "MoveAgent" | "PlaceLadder" | "Surface";
  direction?: number;
  target?: { x: number; y: number };
  reason: string;
};

type ResourceLookahead = {
  x: number;
  y: number;
  tile: number;
  direction: number;
  depth: number;
  horizontalDistance: number;
  score: number;
  exitLaddersNeeded: number;
};

type ResourcePlannedAction = PlannedAction & {
  resource: ResourceLookahead;
};

type PathStep = {
  from: string;
  direction: number;
  x: number;
  y: number;
  distance: number;
};

type ResourcePathCandidate = {
  x: number;
  y: number;
  tile: number;
  distance: number;
  descent: number;
  ascent: number;
  score: number;
  first: PathStep;
};

type GoldPlannedAction = PlannedAction & {
  distance: number;
  hcrst: { x: number; y: number };
};

function printUsage() {
  console.log(`Usage:
  pnpm proxy-fleet
  pnpm proxy-fleet -- --create 9 --steps 2

Flow:
  1. Uses existing DIGGER_PROXY_CODE_ID from .env.
  2. Creates N new DiggerProxy programs.
  3. Initializes each proxy with owner=signer and world=DIGGER_PROGRAM_ID.
  4. Starts World session if needed.
  5. Registers every proxy in World.
  6. Sends simple gameplay actions through every proxy.

Options:
  --create          Number of additional proxies to create. Default 9.
  --steps           Simple gameplay steps per proxy. Default 2.
  --until-gold      Move agents toward nearest HCRST and stop at first gold.
  --gold-and-surface
                    Mine one HCRST and carry it back to surface via ladders.
  --surface-carried Carry current backpack resources back to surface and bank them.
  --gold-strategy   HCRST strategy: round-robin or nearest. Default round-robin.
  --max-rounds      Safety limit for --until-gold. Rounds for round-robin, moves for nearest. Default 200.
  --proxy-indexes   One-based proxy indexes to play, comma-separated. Example: 2,5.
  --no-deploy       Skip creating new proxies; only use env list.
  --no-play         Deploy/register only.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    switch (arg) {
      case "--":
        break;
      case "--create":
        args.create = next();
        break;
      case "--steps":
        args.steps = next();
        break;
      case "--max-rounds":
        args.maxRounds = next();
        break;
      case "--gold-strategy": {
        const value = next();
        if (value !== "round-robin" && value !== "nearest") {
          throw new Error("--gold-strategy must be either round-robin or nearest");
        }
        args.goldStrategy = value;
        break;
      }
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
      case "--proxy-indexes":
        args.proxyIndexes = next();
        break;
      case "--no-deploy":
        args.noDeploy = true;
        break;
      case "--no-play":
        args.noPlay = true;
        break;
      case "--until-gold":
      case "--gold":
        args.untilGold = true;
        break;
      case "--gold-and-surface":
      case "--mine-gold-and-surface":
        args.goldAndSurface = true;
        args.untilGold = true;
        break;
      case "--surface-carried":
      case "--surface":
        args.surfaceCarried = true;
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

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function valueOrDefault(
  names: string[],
  fallback: keyof typeof DEFAULTS,
  override?: string,
): string {
  return override?.trim() || names.map(envValue).find(Boolean) || DEFAULTS[fallback];
}

function parseNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  const raw = value ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseNonNegativeInt(value, fallback, name);
  if (parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseAmount(value: string, name: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a decimal bigint amount`);
  return BigInt(value);
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${name} must be hex`);
  return hex.toLowerCase() as Hex;
}

function normalizeHex32(value: string, name: string): Hex {
  const hex = normalizeHex(value, name);
  if (hex.length !== 66) throw new Error(`${name} must be 32-byte hex`);
  return hex;
}

function normalizeAddress(value: string, name: string): Address {
  const hex = normalizeHex(value, name);
  if (hex.length === 66) return `0x${hex.slice(-40)}` as Address;
  if (hex.length !== 42) throw new Error(`${name} must be a 20-byte address or 32-byte ActorId`);
  return hex as Address;
}

function normalizePrivateKey(value: string): Hex {
  const hex = normalizeHex(value, "PRIVATE_KEY");
  if (hex.length !== 66) throw new Error("PRIVATE_KEY must be 32-byte hex");
  return hex;
}

function actorIdFromAddress(address: Address): Hex {
  return `0x${"00".repeat(12)}${address.slice(2)}` as Hex;
}

function varaProviderFor(url: string, timeoutMs: number) {
  if (url.startsWith("ws")) {
    return new WsVaraEthProvider(url as `ws://${string}` | `wss://${string}`, { requestTimeout: timeoutMs });
  }
  return new HttpVaraEthProvider(url as `http://${string}` | `https://${string}`, { requestTimeout: timeoutMs });
}

function ethTransportFor(url: string) {
  return url.startsWith("ws") ? webSocket(url) : http(url);
}

async function connect(args: CliArgs, timeoutMs: number): Promise<Connection> {
  const privateKey = normalizePrivateKey(requireValue(args.privateKey || envValue("PRIVATE_KEY"), "PRIVATE_KEY"));
  const ethRpc = valueOrDefault(["ETHEREUM_RPC", "DIGGER_ETH_RPC"], "ETHEREUM_RPC", args.ethRpc);
  const varaRpc = valueOrDefault(["VARA_ETH_RPC", "DIGGER_VALIDATOR_RPC"], "VARA_ETH_RPC", args.varaRpc);
  const router = normalizeAddress(
    valueOrDefault(["ROUTER_ADDRESS", "DIGGER_ROUTER_ADDRESS"], "ROUTER_ADDRESS", args.router),
    "ROUTER_ADDRESS",
  );

  const account = privateKeyToAccount(privateKey, { nonceManager });
  const publicClient = createPublicClient({ transport: ethTransportFor(ethRpc) });
  const walletClient = createWalletClient({ transport: ethTransportFor(ethRpc), account });
  const provider = varaProviderFor(varaRpc, timeoutMs);
  const api = await createVaraEthApi(provider, publicClient, router, walletClientToSigner(walletClient));

  return {
    api,
    accountAddress: (await api.eth.signer.getAddress()) as Address,
    disconnect: () => provider.disconnect(),
  };
}

async function loadSails(idlPath: string): Promise<SailsProgram> {
  if (!existsSync(idlPath)) throw new Error(`IDL file does not exist: ${idlPath}`);
  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(await readFile(idlPath, "utf8")));
}

function normalizeReplyCode(code: ReplyCode | string): Hex {
  return typeof code === "string" ? (code as Hex) : bytesToHex(code.toBytes());
}

function payloadBytes(payload?: Hex): number {
  return payload ? Math.max(0, (payload.length - 2) / 2) : 0;
}

function assertSuccessReply(code: ReplyCode | string, payload?: Hex) {
  const replyCode = typeof code === "string" ? ReplyCode.fromBytes(code as Hex) : code;
  if (!replyCode.isSuccess) {
    throw new Error(`program reply failed: ${normalizeReplyCode(code)} (${replyCode.reason}) payload=${payload ?? "0x"}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
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

async function waitForStateHashChange(api: VaraEthApi, programId: Address, previous: Hex, timeoutMs: number): Promise<Hex> {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const next = await mirror.stateHash();
    if (next.toLowerCase() !== previous.toLowerCase()) return next;
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for stateHash change for ${programId}`);
}

function summarizeState(state: Awaited<ReturnType<VaraEthApi["query"]["program"]["readState"]>>) {
  const active = "Active" in state.program ? state.program.Active : null;
  return {
    initialized: active?.initialized ?? null,
    executableBalance: state.executableBalance.toString(),
  };
}

async function waitForProgramVisible(api: VaraEthApi, programId: Address, timeoutMs: number) {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const startedAt = Date.now();
  let lastStateHash: Hex = ZERO_HASH;
  while (Date.now() - startedAt < timeoutMs) {
    const stateHash = await mirror.stateHash();
    lastStateHash = stateHash;
    if (stateHash.toLowerCase() !== ZERO_HASH) {
      try {
        const state = await api.query.program.readState(stateHash);
        return { stateHash, summary: summarizeState(state) };
      } catch {
        // Fresh mirrors can expose a state hash before the RPC can read it.
      }
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for program ${programId}; lastStateHash=${lastStateHash}`);
}

async function readStateSummary(api: VaraEthApi, programId: Address) {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const stateHash = await mirror.stateHash();
  return { stateHash, summary: summarizeState(await api.query.program.readState(stateHash)) };
}

async function createProgram(api: VaraEthApi, codeId: Hex, topUp: bigint): Promise<Address> {
  let builder = api.eth.router.createProgramBuilder(codeId);
  if (topUp > 0n) {
    const accountAddress = await api.eth.signer.getAddress();
    const balance = await api.eth.wvara.balanceOf(accountAddress);
    if (balance < topUp) {
      throw new Error(`Not enough WVARA for top-up: need ${topUp}, balance ${balance}`);
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, topUp, deadline);
    builder = builder.withExecutableBalance(topUp, deadline, signature);
  }
  const tx = builder.build();
  const receipt = await tx.sendAndWaitForReceipt();
  const programId = normalizeAddress(await tx.getProgramId(), "ProgramCreated.actorId");
  console.log("[fleet:deploy]", {
    programId,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
  });
  return programId;
}

async function sendMirrorMessage(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
) {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const previous = await mirror.stateHash();
  const tx = await mirror.sendMessage(payload, 0n);
  const txHash = await tx.send();
  const receipt = await tx.getReceipt();
  const message = await tx.getMessage();
  console.log(`[${label}] mirror`, { programId, txHash, messageId: message.id, blockNumber: receipt.blockNumber.toString() });
  const reply = await withTimeout(mirror.waitForReply(message.id, receipt.blockNumber), promiseTimeoutMs, `${label} mirror reply`);
  if (reply) assertSuccessReply(reply.replyCode, reply.payload);
  return waitForStateHashChange(api, programId, previous, stateTimeoutMs);
}

async function sendInjectedMessage(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
) {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const previous = await mirror.stateHash();
  const injected = await api.createInjectedTransaction({ destination: programId, payload, value: 0n });
  validatorMode === "slot" ? await injected.setSlotValidator() : injected.setDefaultValidator();
  console.log(`[${label}] injected`, { programId, messageId: injected.messageId, txHash: injected.txHash });
  const promiseStartedAt = Date.now();
  const rawReply = await withTimeout(injected.sendAndWaitForPromise(), promiseTimeoutMs, `${label} injected promise`);
  const promiseMs = Date.now() - promiseStartedAt;
  const reply = unwrapInjectedPromise(rawReply, label);
  console.log(`[${label}] injected:reply`, {
    programId,
    messageId: injected.messageId,
    txHash: injected.txHash,
    promiseMs,
    replyCode: reply ? normalizeReplyCode(reply.code) : null,
    payloadBytes: reply ? payloadBytes(reply.payload) : 0,
  });
  if (reply) assertSuccessReply(reply.code, reply.payload);
  return waitForStateHashChange(api, programId, previous, stateTimeoutMs);
}

async function sendInjectedMessageAndWaitForReplyOnly(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
) {
  const injected = await api.createInjectedTransaction({ destination: programId, payload, value: 0n });
  validatorMode === "slot" ? await injected.setSlotValidator() : injected.setDefaultValidator();
  console.log(`[${label}] injected`, { programId, messageId: injected.messageId, txHash: injected.txHash });
  const promiseStartedAt = Date.now();
  const rawReply = await withTimeout(injected.sendAndWaitForPromise(), promiseTimeoutMs, `${label} injected promise`);
  const promiseMs = Date.now() - promiseStartedAt;
  const reply = unwrapInjectedPromise(rawReply, label);
  const metrics: InjectedReplyMetrics = {
    programId,
    messageId: injected.messageId as Hex,
    txHash: injected.txHash as Hex,
    promiseMs,
    replyCode: reply ? normalizeReplyCode(reply.code) : null,
    payloadBytes: reply ? payloadBytes(reply.payload) : 0,
  };
  console.log(`[${label}] injected:reply`, metrics);
  if (reply) assertSuccessReply(reply.code, reply.payload);
  return metrics;
}

async function queryProgram(
  connection: Connection,
  programId: Address,
  payload: Hex,
  queryTimeoutMs: number,
  label: string,
): Promise<Hex> {
  const reply = await withTimeout(
    connection.api.call.program.calculateReplyForHandle(connection.accountAddress, programId, payload, 0n),
    queryTimeoutMs,
    label,
  );
  if (!reply) throw new Error(`${label} did not return`);
  assertSuccessReply(reply.code, reply.payload);
  if (!reply.payload) throw new Error(`${label} returned no payload`);
  return reply.payload;
}

function vecToBigInts(value: unknown): bigint[] {
  if (!Array.isArray(value)) throw new Error(`Expected array result`);
  return value.map((item) => BigInt(String(item)));
}

function sessionFromResult(value: unknown): SessionView {
  const raw = vecToBigInts(value);
  if (raw.length < 4) throw new Error("World.Session returned too few fields");
  return { sessionId: raw[0], seed: raw[1], status: raw[2], actionSeq: raw[3] };
}

function agentFromResult(value: unknown): AgentView {
  const raw = vecToBigInts(value);
  if (raw.length < 13) throw new Error("World.AgentOf returned too few fields");
  return {
    status: raw[0],
    x: Number(raw[1]),
    y: Number(raw[2]),
    hp: raw[3],
    ladders: Number(raw[4]),
    inventoryScrst: raw[5],
    inventoryBcrst: raw[6],
    inventoryHcrst: raw[7],
    bankedScrst: raw[8],
    bankedBcrst: raw[9],
    bankedHcrst: raw[10],
    backpackCapacity: raw[11],
    lastActionSeq: raw[12],
  };
}

function agentSummary(agent: AgentView) {
  return {
    status: agent.status.toString(),
    x: agent.x,
    y: agent.y,
    hp: agent.hp.toString(),
    ladders: agent.ladders,
    lastActionSeq: agent.lastActionSeq.toString(),
    inventory: {
      scrst: agent.inventoryScrst.toString(),
      bcrst: agent.inventoryBcrst.toString(),
      hcrst: agent.inventoryHcrst.toString(),
    },
    banked: {
      scrst: agent.bankedScrst.toString(),
      bcrst: agent.bankedBcrst.toString(),
      hcrst: agent.bankedHcrst.toString(),
    },
  };
}

async function readSession(connection: Connection, worldSails: SailsProgram, worldProgramId: Address, queryTimeoutMs: number) {
  const payload = worldSails.services.World.queries.Session.encodePayload() as Hex;
  const reply = await queryProgram(connection, worldProgramId, payload, queryTimeoutMs, "World.Session");
  return sessionFromResult(worldSails.services.World.queries.Session.decodeResult<unknown>(reply));
}

async function ensureSessionActive(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
  queryTimeoutMs: number,
) {
  let session = await readSession(connection, worldSails, worldProgramId, queryTimeoutMs);
  console.log("[fleet:session]", {
    sessionId: session.sessionId.toString(),
    seed: session.seed.toString(),
    status: session.status.toString(),
    actionSeq: session.actionSeq.toString(),
  });
  if (session.status === SESSION_ACTIVE) return session;

  await sendInjectedMessage(
    connection.api,
    worldProgramId,
    "fleet-start-session",
    worldSails.services.Admin.functions.StartSession.encodePayload() as Hex,
    validatorMode,
    promiseTimeoutMs,
    timeoutMs,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    session = await readSession(connection, worldSails, worldProgramId, queryTimeoutMs);
    if (session.status === SESSION_ACTIVE) return session;
    await sleep(2_000);
  }
  throw new Error("World session did not become active");
}

async function readAgent(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  queryTimeoutMs: number,
): Promise<AgentView> {
  const payload = worldSails.services.World.queries.AgentOf.encodePayload(actorIdFromAddress(proxy)) as Hex;
  const reply = await queryProgram(connection, worldProgramId, payload, queryTimeoutMs, `World.AgentOf(${proxy})`);
  return agentFromResult(worldSails.services.World.queries.AgentOf.decodeResult<unknown>(reply));
}

async function readMap(connection: Connection, worldSails: SailsProgram, worldProgramId: Address, queryTimeoutMs: number): Promise<number[]> {
  const payload = worldSails.services.World.queries.MapSnapshot.encodePayload() as Hex;
  const reply = await queryProgram(connection, worldProgramId, payload, queryTimeoutMs, "World.MapSnapshot");
  const decoded = worldSails.services.World.queries.MapSnapshot.decodeResult<unknown>(reply);
  if (!Array.isArray(decoded)) throw new Error("World.MapSnapshot returned non-array");
  return decoded.map((item) => Number(item));
}

function tileAt(map: number[], x: number, y: number): number {
  return map[y * MAP_WIDTH + x] ?? -1;
}

function isDrillable(tile: number): boolean {
  return [TILE_DIRT, TILE_STONE, TILE_RESOURCE_SCRST, TILE_RESOURCE_BCRST, TILE_RESOURCE_HCRST].includes(tile);
}

function isResourceTile(tile: number): boolean {
  return [TILE_RESOURCE_SCRST, TILE_RESOURCE_BCRST, TILE_RESOURCE_HCRST].includes(tile);
}

function isTraversable(tile: number): boolean {
  return [TILE_EMPTY, TILE_LADDER, TILE_SURFACE].includes(tile);
}

function tileName(tile: number): string {
  switch (tile) {
    case TILE_EMPTY:
      return "EMPTY";
    case TILE_DIRT:
      return "DIRT";
    case TILE_STONE:
      return "STONE";
    case TILE_LAVA:
      return "LAVA";
    case TILE_LADDER:
      return "LADDER";
    case TILE_RESOURCE_SCRST:
      return "SCRST";
    case TILE_RESOURCE_BCRST:
      return "BCRST";
    case TILE_RESOURCE_HCRST:
      return "HCRST";
    case TILE_SURFACE:
      return "SURFACE";
    default:
      return `tile ${tile}`;
  }
}

function resourceScore(tile: number): number {
  switch (tile) {
    case TILE_RESOURCE_HCRST:
      return 300;
    case TILE_RESOURCE_BCRST:
      return 200;
    case TILE_RESOURCE_SCRST:
      return 100;
    default:
      return 0;
  }
}

function exitLaddersNeeded(y: number): number {
  return Math.max(0, y);
}

function canPlanAtDepth(agent: AgentView, y: number): boolean {
  if (y <= agent.y) return true;
  return exitLaddersNeeded(y) <= agent.ladders;
}

function ladderBudgetReason(agent: AgentView, y: number): string {
  const needed = exitLaddersNeeded(y);
  if (needed <= agent.ladders) return `exit ladders ${needed}/${agent.ladders}`;
  return `exit ladders ${needed}/${agent.ladders}; do not descend deeper`;
}

function targetOf(agent: AgentView, direction: number): { x: number; y: number } | null {
  if (direction === DIR_UP && agent.y > 0) return { x: agent.x, y: agent.y - 1 };
  if (direction === DIR_DOWN && agent.y + 1 < MAP_HEIGHT) return { x: agent.x, y: agent.y + 1 };
  if (direction === DIR_RIGHT && agent.x + 1 < MAP_WIDTH) return { x: agent.x + 1, y: agent.y };
  if (direction === DIR_LEFT && agent.x > 0) return { x: agent.x - 1, y: agent.y };
  if (direction === DIR_CURRENT) return { x: agent.x, y: agent.y };
  return null;
}

function verticalPathCanBeOpened(agent: AgentView, map: number[], targetY: number): boolean {
  for (let y = agent.y + 1; y <= targetY; y += 1) {
    const tile = tileAt(map, agent.x, y);
    if (tile === TILE_LAVA || tile < 0) return false;
    if (!isTraversable(tile) && !isDrillable(tile)) return false;
  }
  return true;
}

function horizontalPathCanBeOpened(map: number[], fromX: number, toX: number, y: number): boolean {
  const step = toX > fromX ? 1 : -1;
  for (let x = fromX + step; step > 0 ? x <= toX : x >= toX; x += step) {
    const tile = tileAt(map, x, y);
    if (tile === TILE_LAVA || tile < 0) return false;
    if (!isTraversable(tile) && !isDrillable(tile)) return false;
  }
  return true;
}

function sideLookaheadResources(agent: AgentView, map: number[], allowedTiles?: Set<number>): ResourceLookahead[] {
  const resources: ResourceLookahead[] = [];

  for (let depth = 0; depth <= SIDE_LOOKAHEAD_DEPTH; depth += 1) {
    const y = agent.y + depth;
    if (y >= MAP_HEIGHT) continue;
    if (!canPlanAtDepth(agent, y)) continue;
    if (!verticalPathCanBeOpened(agent, map, y)) continue;

    for (let offset = -SIDE_LOOKAHEAD_RADIUS; offset <= SIDE_LOOKAHEAD_RADIUS; offset += 1) {
      if (offset === 0) continue;
      const x = agent.x + offset;
      if (x < 0 || x >= MAP_WIDTH) continue;

      const tile = tileAt(map, x, y);
      if (!isResourceTile(tile)) continue;
      if (allowedTiles && !allowedTiles.has(tile)) continue;
      if (!horizontalPathCanBeOpened(map, agent.x, x, y)) continue;

      const horizontalDistance = Math.abs(offset);

      resources.push({
        x,
        y,
        tile,
        direction: offset > 0 ? DIR_RIGHT : DIR_LEFT,
        depth,
        horizontalDistance,
        score: resourceScore(tile) - depth * 8 - horizontalDistance * 12,
        exitLaddersNeeded: exitLaddersNeeded(y),
      });
    }
  }

  return resources.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.depth !== right.depth) return left.depth - right.depth;
    if (left.horizontalDistance !== right.horizontalDistance) return left.horizontalDistance - right.horizontalDistance;
    return left.direction - right.direction;
  });
}

function planSideLookaheadAction(
  agent: AgentView,
  map: number[],
  allowedTiles?: Set<number>,
): ResourcePlannedAction | null {
  const [resource] = sideLookaheadResources(agent, map, allowedTiles);
  if (!resource) return null;

  if (resource.depth === 0) {
    const target = targetOf(agent, resource.direction);
    if (!target) return null;

    const tile = tileAt(map, target.x, target.y);
    const reason =
      resource.horizontalDistance === 1
        ? `drill adjacent ${tileName(resource.tile)} at ${resource.x},${resource.y}; ${ladderBudgetReason(agent, resource.y)}`
        : `open side tunnel toward ${tileName(resource.tile)} at ${resource.x},${resource.y} ` +
          `(offset ${resource.horizontalDistance}); next tile ${tileName(tile)}; ${ladderBudgetReason(agent, resource.y)}`;

    if (isTraversable(tile)) return { fn: "MoveAgent", direction: resource.direction, target, reason, resource };
    if (isDrillable(tile)) return { fn: "Drill", direction: resource.direction, target, reason, resource };
    return null;
  }

  const target = targetOf(agent, DIR_DOWN);
  if (!target || !canPlanAtDepth(agent, target.y)) return null;

  const tile = tileAt(map, target.x, target.y);
  const reason =
    `descend toward side-lookahead ${tileName(resource.tile)} at ${resource.x},${resource.y} ` +
    `(depth +${resource.depth}); ${ladderBudgetReason(agent, resource.y)}`;

  if (isTraversable(tile)) return { fn: "MoveAgent", direction: DIR_DOWN, target, reason, resource };
  if (isDrillable(tile)) return { fn: "Drill", direction: DIR_DOWN, target, reason: `${reason}; shaft tile ${tileName(tile)}`, resource };
  return null;
}

function directionTarget(x: number, y: number, direction: number): { x: number; y: number } | null {
  if (direction === DIR_UP && y > 0) return { x, y: y - 1 };
  if (direction === DIR_DOWN && y + 1 < MAP_HEIGHT) return { x, y: y + 1 };
  if (direction === DIR_RIGHT && x + 1 < MAP_WIDTH) return { x: x + 1, y };
  if (direction === DIR_LEFT && x > 0) return { x: x - 1, y };
  if (direction === DIR_CURRENT) return { x, y };
  return null;
}

function coordKey(x: number, y: number): string {
  return `${x},${y}`;
}

function firstPathStep(start: string, parents: Map<string, PathStep>, targetKey: string): PathStep | null {
  let cursor = targetKey;
  let first = parents.get(cursor);
  while (first && first.from !== start) {
    cursor = first.from;
    first = parents.get(cursor);
  }
  return first ?? null;
}

function canTraverseInSearch(map: number[], fromX: number, fromY: number, direction: number, toX: number, toY: number): boolean {
  const targetTile = tileAt(map, toX, toY);
  if (!isTraversable(targetTile)) return false;
  if (direction !== DIR_UP) return true;

  const currentTile = tileAt(map, fromX, fromY);
  return currentTile === TILE_LADDER || targetTile === TILE_LADDER;
}

function canOpenPathInSearch(map: number[], direction: number): boolean {
  // Opening an upward non-resource cell would still leave no legal way to move
  // there unless a ladder is already involved. Keep upward pathing for return logic.
  return direction !== DIR_UP;
}

function resourcePathScore(agent: AgentView, tile: number, x: number, y: number, distance: number): number {
  const descent = Math.max(0, y - agent.y);
  const ascent = Math.max(0, agent.y - y);
  return resourceScore(tile)
    - distance * RESOURCE_DISTANCE_PENALTY
    - descent * RESOURCE_DESCENT_PENALTY
    - ascent * RESOURCE_ASCENT_PENALTY;
}

function planNearestResourceAction(agent: AgentView, map: number[], allowedTiles?: Set<number>): PlannedAction | null {
  const start = coordKey(agent.x, agent.y);
  const queue: Array<{ x: number; y: number; distance: number }> = [{ x: agent.x, y: agent.y, distance: 0 }];
  const parents = new Map<string, PathStep>();
  const seen = new Set<string>([start]);
  const candidates: ResourcePathCandidate[] = [];
  const directions = [DIR_RIGHT, DIR_LEFT, DIR_DOWN, DIR_UP];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.distance >= RESOURCE_SEARCH_MAX_DISTANCE) continue;

    for (const direction of directions) {
      const next = directionTarget(current.x, current.y, direction);
      if (!next) continue;
      if (!canPlanAtDepth(agent, next.y)) continue;

      const key = coordKey(next.x, next.y);
      if (seen.has(key)) continue;

      const tile = tileAt(map, next.x, next.y);
      if (tile === TILE_LAVA || tile < 0) continue;

      const distance = current.distance + 1;
      const step: PathStep = {
        from: coordKey(current.x, current.y),
        direction,
        x: next.x,
        y: next.y,
        distance,
      };

      seen.add(key);
      parents.set(key, step);

      if (isResourceTile(tile)) {
        if (!allowedTiles || allowedTiles.has(tile)) {
          const first = firstPathStep(start, parents, key);
          if (first) {
            candidates.push({
              x: next.x,
              y: next.y,
              tile,
              distance,
              descent: Math.max(0, next.y - agent.y),
              ascent: Math.max(0, agent.y - next.y),
              score: resourcePathScore(agent, tile, next.x, next.y, distance),
              first,
            });
          }
        }
        continue;
      }

      if (canTraverseInSearch(map, current.x, current.y, direction, next.x, next.y)) {
        queue.push({ ...next, distance });
        continue;
      }

      if (isDrillable(tile) && canOpenPathInSearch(map, direction)) {
        queue.push({ ...next, distance });
      }
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.descent !== right.descent) return left.descent - right.descent;
    if (left.ascent !== right.ascent) return left.ascent - right.ascent;
    return resourceScore(right.tile) - resourceScore(left.tile);
  });

  const [candidate] = candidates;
  if (!candidate) return null;

  const firstTile = tileAt(map, candidate.first.x, candidate.first.y);
  const target = { x: candidate.first.x, y: candidate.first.y };
  const reason =
    `seek nearest ${tileName(candidate.tile)} at ${candidate.x},${candidate.y}; ` +
    `distance ${candidate.distance}, score ${candidate.score}; first tile ${tileName(firstTile)}; ` +
    ladderBudgetReason(agent, candidate.y);

  if (isTraversable(firstTile)) return { fn: "MoveAgent", direction: candidate.first.direction, target, reason };
  if (isDrillable(firstTile)) return { fn: "Drill", direction: candidate.first.direction, target, reason };
  return null;
}

function chooseAction(agent: AgentView, map: number[]): PlannedAction | null {
  if (agent.status !== AGENT_ACTIVE) return null;

  if (carriedTotal(agent) >= agent.backpackCapacity) {
    return chooseSurfaceAction(agent, map);
  }

  for (const direction of [DIR_RIGHT, DIR_LEFT, DIR_DOWN, DIR_UP]) {
    const target = targetOf(agent, direction);
    if (!target) continue;
    const tile = tileAt(map, target.x, target.y);
    if (isResourceTile(tile)) return { fn: "Drill", direction, target, reason: `drill adjacent ${tileName(tile)}` };
  }

  const sideLookahead = planSideLookaheadAction(agent, map);
  if (sideLookahead) return sideLookahead;

  const nearestResource = planNearestResourceAction(agent, map);
  if (nearestResource) return nearestResource;

  const target = targetOf(agent, DIR_DOWN);
  if (target && canPlanAtDepth(agent, target.y)) {
    const tile = tileAt(map, target.x, target.y);
    const depthReason = `; ${ladderBudgetReason(agent, target.y)}`;
    if (isDrillable(tile)) return { fn: "Drill", direction: DIR_DOWN, target, reason: `drill ${tileName(tile)}${depthReason}` };
    if (isTraversable(tile)) return { fn: "MoveAgent", direction: DIR_DOWN, target, reason: `move into ${tileName(tile)}${depthReason}` };
  }

  return null;
}

function nearestHcrstTarget(agent: AgentView, map: number[]): { x: number; y: number } | null {
  let best: { x: number; y: number; distance: number } | null = null;
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      if (tileAt(map, x, y) !== TILE_RESOURCE_HCRST) continue;
      const distance = Math.abs(agent.x - x) + Math.abs(agent.y - y);
      if (!best || distance < best.distance) best = { x, y, distance };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function directionOrderToward(x: number, target: { x: number; y: number } | null): number[] {
  if (!target || target.x === x) return [DIR_DOWN, DIR_RIGHT, DIR_LEFT];
  return target.x > x
    ? [DIR_RIGHT, DIR_DOWN, DIR_LEFT]
    : [DIR_LEFT, DIR_DOWN, DIR_RIGHT];
}

function planGoldAction(agent: AgentView, map: number[]): GoldPlannedAction | null {
  if (agent.status !== AGENT_ACTIVE) return null;

  const sideResource = planSideLookaheadAction(agent, map);
  if (sideResource) {
    const nearestHcrst = nearestHcrstTarget(agent, map);
    return {
      ...sideResource,
      distance: sideResource.resource.depth + sideResource.resource.horizontalDistance,
      hcrst: sideResource.resource.tile === TILE_RESOURCE_HCRST
        ? { x: sideResource.resource.x, y: sideResource.resource.y }
        : nearestHcrst ?? { x: sideResource.resource.x, y: sideResource.resource.y },
    };
  }

  const targetHcrst = nearestHcrstTarget(agent, map);
  const start = coordKey(agent.x, agent.y);
  const queue: Array<{ x: number; y: number; distance: number }> = [{ x: agent.x, y: agent.y, distance: 0 }];
  const parents = new Map<string, { from: string; direction: number; x: number; y: number; distance: number }>();
  const seen = new Set<string>([start]);

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const direction of directionOrderToward(current.x, targetHcrst)) {
      const next = directionTarget(current.x, current.y, direction);
      if (!next) continue;
      if (!canPlanAtDepth(agent, next.y)) continue;
      const key = coordKey(next.x, next.y);
      if (seen.has(key)) continue;

      const tile = tileAt(map, next.x, next.y);
      if (tile === TILE_LAVA || tile < 0) continue;

      seen.add(key);
      parents.set(key, {
        from: coordKey(current.x, current.y),
        direction,
        x: next.x,
        y: next.y,
        distance: current.distance + 1,
      });

      if (tile === TILE_RESOURCE_HCRST) {
        let cursor = key;
        let first = parents.get(cursor);
        while (first && first.from !== start) {
          cursor = first.from;
          first = parents.get(cursor);
        }
        if (!first) return null;

        const firstTile = tileAt(map, first.x, first.y);
        if (isTraversable(firstTile)) {
          return {
            fn: "MoveAgent",
            direction: first.direction,
            target: { x: first.x, y: first.y },
            reason: `move toward HCRST at ${next.x},${next.y}; ${ladderBudgetReason(agent, next.y)}`,
            distance: current.distance + 1,
            hcrst: next,
          };
        }
        if (isDrillable(firstTile)) {
          return {
            fn: "Drill",
            direction: first.direction,
            target: { x: first.x, y: first.y },
            reason: `drill toward HCRST at ${next.x},${next.y}; tile ${tileName(firstTile)}; ${ladderBudgetReason(agent, next.y)}`,
            distance: current.distance + 1,
            hcrst: next,
          };
        }
        return null;
      }

      queue.push({ ...next, distance: current.distance + 1 });
    }
  }

  return null;
}

function chooseGoldAction(agent: AgentView, map: number[]): PlannedAction | null {
  return planGoldAction(agent, map);
}

function carriedTotal(agent: AgentView): bigint {
  return agent.inventoryScrst + agent.inventoryBcrst + agent.inventoryHcrst;
}

function chooseSurfaceAction(agent: AgentView, map: number[]): PlannedAction | null {
  if (agent.status !== AGENT_ACTIVE) return null;
  if (agent.y === 0) {
    return { fn: "Surface", reason: "bank carried resources on surface" };
  }

  const currentTile = tileAt(map, agent.x, agent.y);
  const targetUp = targetOf(agent, DIR_UP);

  if (targetUp) {
    const targetTile = tileAt(map, targetUp.x, targetUp.y);
    if (
      isTraversable(targetTile) &&
      (currentTile === TILE_LADDER || targetTile === TILE_LADDER)
    ) {
      return {
        fn: "MoveAgent",
        direction: DIR_UP,
        target: targetUp,
        reason: `move up toward surface through ${tileName(targetTile)}`,
      };
    }
  }

  if (currentTile !== TILE_LADDER) {
    const missingLadders = verticalReturnMissingLadders(map, agent.x, agent.y);
    if (currentTile === TILE_EMPTY && missingLadders > 0 && missingLadders <= agent.ladders) {
      return {
        fn: "PlaceLadder",
        direction: DIR_CURRENT,
        target: { x: agent.x, y: agent.y },
        reason: `place ladder at ${agent.x},${agent.y} for direct ascent; missing ${missingLadders}/${agent.ladders}`,
      };
    }

    const ladder = nearestReachableSameRowLadder(agent, map);
    if (ladder) {
      return planHorizontalActionToX(
        agent,
        map,
        ladder.x,
        `return to ladder at ${ladder.x},${agent.y} before surfacing`,
      );
    }

    if (agent.ladders <= 0 || missingLadders > agent.ladders) return null;
    if (currentTile !== TILE_EMPTY) return null;

    return {
      fn: "PlaceLadder",
      direction: DIR_CURRENT,
      target: { x: agent.x, y: agent.y },
      reason: `place ladder at ${agent.x},${agent.y} for ascent; missing ${missingLadders}/${agent.ladders}`,
    };
  }

  const target = targetUp;
  if (!target) return null;
  const targetTile = tileAt(map, target.x, target.y);
  if (isTraversable(targetTile)) {
    return {
      fn: "MoveAgent",
      direction: DIR_UP,
      target,
      reason: `move up toward surface through ${tileName(targetTile)}`,
    };
  }
  if (isDrillable(targetTile)) {
    return {
      fn: "Drill",
      direction: DIR_UP,
      target,
      reason: `open upward return path through ${tileName(targetTile)}`,
    };
  }

  return null;
}

function verticalReturnMissingLadders(map: number[], x: number, y: number): number {
  let missing = 0;
  for (let fromY = y; fromY > 0; fromY -= 1) {
    const currentTile = tileAt(map, x, fromY);
    const targetTile = tileAt(map, x, fromY - 1);
    if (currentTile !== TILE_LADDER && targetTile !== TILE_LADDER) {
      missing += 1;
    }
  }
  return missing;
}

function nearestReachableSameRowLadder(agent: AgentView, map: number[]): { x: number; distance: number } | null {
  for (let distance = 1; distance < MAP_WIDTH; distance += 1) {
    const candidates = [agent.x - distance, agent.x + distance];
    for (const x of candidates) {
      if (x < 0 || x >= MAP_WIDTH) continue;
      if (tileAt(map, x, agent.y) !== TILE_LADDER) continue;
      if (!horizontalPathCanBeOpened(map, agent.x, x, agent.y)) continue;
      return { x, distance };
    }
  }
  return null;
}

function planHorizontalActionToX(agent: AgentView, map: number[], targetX: number, reason: string): PlannedAction | null {
  if (targetX === agent.x) return null;
  const direction = targetX > agent.x ? DIR_RIGHT : DIR_LEFT;
  const target = targetOf(agent, direction);
  if (!target) return null;

  const tile = tileAt(map, target.x, target.y);
  const fullReason = `${reason}; next ${tileName(tile)} at ${target.x},${target.y}`;
  if (isTraversable(tile)) return { fn: "MoveAgent", direction, target, reason: fullReason };
  if (isDrillable(tile)) return { fn: "Drill", direction, target, reason: fullReason };
  return null;
}

async function waitForAgentChange(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  before: AgentView,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const after = await readAgent(connection, worldSails, worldProgramId, proxy, timeoutMs);
    if (
      after.lastActionSeq > before.lastActionSeq ||
      after.x !== before.x ||
      after.y !== before.y ||
      after.inventoryScrst !== before.inventoryScrst ||
      after.inventoryBcrst !== before.inventoryBcrst ||
      after.inventoryHcrst !== before.inventoryHcrst
    ) {
      return after;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for agent change for ${proxy}`);
}

function envProxyList(): Address[] {
  const values = [
    envValue("DIGGER_PROXY_PROGRAM_ID"),
    ...(envValue("DIGGER_PROXY_PROGRAM_IDS") ?? "").split(","),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(values.map((value) => normalizeAddress(value, "proxy id")))];
}

function selectProxyIndexes(proxies: Address[], indexes?: string): Address[] {
  const value = indexes?.trim() || envValue("DIGGER_PROXY_INDEXES");
  if (!value) return proxies;

  const selected = value
    .split(",")
    .map((item) => parsePositiveInt(item.trim(), 0, "--proxy-indexes"))
    .map((index) => {
      if (index < 1 || index > proxies.length) {
        throw new Error(`proxy index ${index} is outside 1..${proxies.length}`);
      }
      return proxies[index - 1];
    });

  return [...new Set(selected.map((proxy) => proxy.toLowerCase()))] as Address[];
}

async function updateProxyList(proxies: Address[]) {
  const unique = [...new Set(proxies.map((proxy) => proxy.toLowerCase()))] as Address[];
  const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
  const values: Record<string, string> = {
    DIGGER_PROXY_PROGRAM_IDS: unique.join(","),
  };
  if (!envValue("DIGGER_PROXY_PROGRAM_ID") && unique[0]) {
    values.DIGGER_PROXY_PROGRAM_ID = unique[0];
  }

  let next = existing;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    next = re.test(next)
      ? next.replace(re, line)
      : `${next}${next.endsWith("\n") || next.length === 0 ? "" : "\n"}${line}\n`;
  }
  if (next !== existing) await writeFile(ENV_PATH, next, "utf8");
  console.log("[fleet:env]", values);
}

async function registerProxy(
  connection: Connection,
  proxySails: SailsProgram,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
  queryTimeoutMs: number,
) {
  try {
    const agent = await readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs);
    console.log("[fleet:registered]", { proxy, ...agentSummary(agent) });
    return agent;
  } catch {
    // Register below.
  }

  await sendInjectedMessage(
    connection.api,
    proxy,
    "fleet-register",
    proxySails.services.Digger.functions.Register.encodePayload() as Hex,
    validatorMode,
    promiseTimeoutMs,
    timeoutMs,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const agent = await readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs);
      console.log("[fleet:registered]", { proxy, ...agentSummary(agent) });
      return agent;
    } catch {
      await sleep(2_000);
    }
  }
  throw new Error(`Timed out registering proxy ${proxy}`);
}

async function deployProxy(
  connection: Connection,
  proxySails: SailsProgram,
  worldProgramId: Address,
  codeId: Hex,
  topUp: bigint,
  promiseTimeoutMs: number,
  timeoutMs: number,
): Promise<Address> {
  const proxy = await createProgram(connection.api, codeId, topUp);
  await waitForProgramVisible(connection.api, proxy, timeoutMs);
  const before = await readStateSummary(connection.api, proxy);
  if (before.summary.initialized !== true) {
    const createCtor = proxySails.ctors?.Create;
    if (!createCtor) throw new Error("Proxy IDL does not contain Create constructor");
    await sendMirrorMessage(
      connection.api,
      proxy,
      "fleet-init-proxy",
      createCtor.encodePayload(actorIdFromAddress(connection.accountAddress), actorIdFromAddress(worldProgramId)) as Hex,
      promiseTimeoutMs,
      timeoutMs,
    );
  }
  return proxy;
}

async function executeProxyAction(
  connection: Connection,
  proxySails: SailsProgram,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  agent: AgentView,
  action: PlannedAction,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
) {
  const fn = proxySails.services.Digger.functions[action.fn];
  const payload = action.direction === undefined
    ? fn.encodePayload() as Hex
    : fn.encodePayload(action.direction) as Hex;
  const injectedReply = await sendInjectedMessageAndWaitForReplyOnly(
    connection.api,
    proxy,
    `fleet-play-${action.fn}`,
    payload,
    validatorMode,
    promiseTimeoutMs,
  );
  const after = await waitForAgentChange(connection, worldSails, worldProgramId, proxy, agent, timeoutMs);
  console.log("[fleet:play]", {
    proxy,
    action: action.fn,
    direction: action.direction,
    target: action.target,
    reason: action.reason,
    before: { x: agent.x, y: agent.y, seq: agent.lastActionSeq.toString() },
    after: { x: after.x, y: after.y, seq: after.lastActionSeq.toString() },
    inventory: {
      before: {
        scrst: agent.inventoryScrst.toString(),
        bcrst: agent.inventoryBcrst.toString(),
        hcrst: agent.inventoryHcrst.toString(),
      },
      after: {
        scrst: after.inventoryScrst.toString(),
        bcrst: after.inventoryBcrst.toString(),
        hcrst: after.inventoryHcrst.toString(),
      },
    },
    hcrst: { before: agent.inventoryHcrst.toString(), after: after.inventoryHcrst.toString() },
  });
  console.log("[fleet:tx]", JSON.stringify({
    proxy,
    action: action.fn,
    direction: action.direction ?? null,
    target: action.target ?? null,
    reason: action.reason,
    txHash: injectedReply.txHash,
    messageId: injectedReply.messageId,
    promiseMs: injectedReply.promiseMs,
    replyCode: injectedReply.replyCode,
    before: {
      x: agent.x,
      y: agent.y,
      seq: agent.lastActionSeq.toString(),
      inventory: {
        scrst: agent.inventoryScrst.toString(),
        bcrst: agent.inventoryBcrst.toString(),
        hcrst: agent.inventoryHcrst.toString(),
      },
      banked: {
        scrst: agent.bankedScrst.toString(),
        bcrst: agent.bankedBcrst.toString(),
        hcrst: agent.bankedHcrst.toString(),
      },
      ladders: agent.ladders,
    },
    after: {
      x: after.x,
      y: after.y,
      seq: after.lastActionSeq.toString(),
      inventory: {
        scrst: after.inventoryScrst.toString(),
        bcrst: after.inventoryBcrst.toString(),
        hcrst: after.inventoryHcrst.toString(),
      },
      banked: {
        scrst: after.bankedScrst.toString(),
        bcrst: after.bankedBcrst.toString(),
        hcrst: after.bankedHcrst.toString(),
      },
      ladders: after.ladders,
    },
  }));
  return { before: agent, after, action, injectedReply };
}

async function playProxyStep(
  connection: Connection,
  proxySails: SailsProgram,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
  queryTimeoutMs: number,
  mode: "simple" | "gold" = "simple",
) {
  const [agent, map] = await Promise.all([
    readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs),
    readMap(connection, worldSails, worldProgramId, queryTimeoutMs),
  ]);
  const action = mode === "gold"
    ? chooseGoldAction(agent, map) ?? chooseAction(agent, map)
    : chooseAction(agent, map);
  if (!action) {
    console.log("[fleet:play:skip]", { proxy, x: agent.x, y: agent.y, status: agent.status.toString() });
    return { before: agent, after: agent, action: null };
  }

  return executeProxyAction(
    connection,
    proxySails,
    worldSails,
    worldProgramId,
    proxy,
    agent,
    action,
    validatorMode,
    promiseTimeoutMs,
    timeoutMs,
  );
}

async function mineGoldAndSurface(
  connection: Connection,
  proxySails: SailsProgram,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
  queryTimeoutMs: number,
  maxRounds: number,
) {
  let agent = await readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs);
  const initialBankedHcrst = agent.bankedHcrst;
  let phase: "mine" | "surface" = agent.inventoryHcrst > 0n ? "surface" : "mine";

  for (let move = 1; move <= maxRounds; move += 1) {
    const map = await readMap(connection, worldSails, worldProgramId, queryTimeoutMs);
    const action = phase === "mine"
      ? chooseGoldAction(agent, map)
      : chooseSurfaceAction(agent, map);

    if (!action) {
      console.log("[fleet:gold-surface-stop]", {
        proxy,
        move,
        phase,
        reason: phase === "mine" ? "no reachable HCRST action" : "no surface return action",
        agent: agentSummary(agent),
        carried: carriedTotal(agent).toString(),
      });
      return { complete: false, agent, move, phase };
    }

    console.log("[fleet:gold-surface-step]", {
      proxy,
      move,
      phase,
      action: action.fn,
      direction: action.direction,
      target: action.target,
      reason: action.reason,
      before: agentSummary(agent),
      carried: carriedTotal(agent).toString(),
    });

    const before = agent;
    const result = await executeProxyAction(
      connection,
      proxySails,
      worldSails,
      worldProgramId,
      proxy,
      agent,
      action,
      validatorMode,
      promiseTimeoutMs,
      timeoutMs,
    );
    agent = result.after;

    if (phase === "mine" && agent.inventoryHcrst > before.inventoryHcrst) {
      console.log("[fleet:gold-extracted]", {
        proxy,
        move,
        hcrst: { before: before.inventoryHcrst.toString(), after: agent.inventoryHcrst.toString() },
        position: { x: agent.x, y: agent.y },
        ladders: agent.ladders,
      });
      phase = "surface";
      continue;
    }

    if (phase === "surface" && agent.bankedHcrst > initialBankedHcrst && agent.inventoryHcrst === 0n) {
      console.log("[fleet:gold-surfaced]", {
        proxy,
        move,
        bankedHcrst: agent.bankedHcrst.toString(),
        final: agentSummary(agent),
      });
      return { complete: true, agent, move, phase };
    }
  }

  console.log("[fleet:gold-surface-timeout]", {
    proxy,
    maxRounds,
    phase,
    agent: agentSummary(agent),
    carried: carriedTotal(agent).toString(),
  });
  return { complete: false, agent, move: maxRounds, phase };
}

function bankedTotal(agent: AgentView): bigint {
  return agent.bankedScrst + agent.bankedBcrst + agent.bankedHcrst;
}

async function returnCarriedToSurface(
  connection: Connection,
  proxySails: SailsProgram,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxy: Address,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  timeoutMs: number,
  queryTimeoutMs: number,
  maxRounds: number,
) {
  let agent = await readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs);
  const initialBanked = bankedTotal(agent);
  const initialCarried = carriedTotal(agent);

  if (initialCarried === 0n) {
    console.log("[fleet:surface-carried:empty]", { proxy, agent: agentSummary(agent) });
    return { complete: true, agent, move: 0 };
  }

  for (let move = 1; move <= maxRounds; move += 1) {
    const map = await readMap(connection, worldSails, worldProgramId, queryTimeoutMs);
    const action = chooseSurfaceAction(agent, map);

    if (!action) {
      console.log("[fleet:surface-carried-stop]", {
        proxy,
        move,
        reason: "no surface return action",
        agent: agentSummary(agent),
        carried: carriedTotal(agent).toString(),
        banked: bankedTotal(agent).toString(),
      });
      return { complete: false, agent, move };
    }

    console.log("[fleet:surface-carried-step]", {
      proxy,
      move,
      action: action.fn,
      direction: action.direction,
      target: action.target,
      reason: action.reason,
      before: agentSummary(agent),
      carried: carriedTotal(agent).toString(),
      banked: bankedTotal(agent).toString(),
    });

    const result = await executeProxyAction(
      connection,
      proxySails,
      worldSails,
      worldProgramId,
      proxy,
      agent,
      action,
      validatorMode,
      promiseTimeoutMs,
      timeoutMs,
    );
    agent = result.after;

    if (carriedTotal(agent) === 0n && bankedTotal(agent) > initialBanked) {
      console.log("[fleet:surface-carried-complete]", {
        proxy,
        move,
        initialCarried: initialCarried.toString(),
        final: agentSummary(agent),
      });
      return { complete: true, agent, move };
    }
  }

  console.log("[fleet:surface-carried-timeout]", {
    proxy,
    maxRounds,
    agent: agentSummary(agent),
    carried: carriedTotal(agent).toString(),
    banked: bankedTotal(agent).toString(),
  });
  return { complete: false, agent, move: maxRounds };
}

async function selectNearestGoldCandidate(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxies: Address[],
  queryTimeoutMs: number,
) {
  const [map, agents] = await Promise.all([
    readMap(connection, worldSails, worldProgramId, queryTimeoutMs),
    Promise.all(proxies.map((proxy) => readAgent(connection, worldSails, worldProgramId, proxy, queryTimeoutMs))),
  ]);

  let best: { proxy: Address; agent: AgentView; action: GoldPlannedAction; index: number } | null = null;
  for (let index = 0; index < proxies.length; index += 1) {
    const action = planGoldAction(agents[index], map);
    if (!action) continue;
    if (!best || action.distance < best.action.distance) {
      best = { proxy: proxies[index], agent: agents[index], action, index };
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const createCount = args.noDeploy ? 0 : parseNonNegativeInt(args.create, 9, "--create");
  const goldAndSurface = Boolean(args.goldAndSurface);
  const surfaceCarried = Boolean(args.surfaceCarried);
  const untilGold = Boolean(args.untilGold || goldAndSurface);
  const steps = args.noPlay || untilGold || surfaceCarried ? 0 : parseNonNegativeInt(args.steps, 2, "--steps");
  const maxRounds = parsePositiveInt(args.maxRounds, 200, "--max-rounds");
  const timeoutMs = parsePositiveInt(valueOrDefault(["DIGGER_EVENT_TIMEOUT_MS"], "DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs), 180_000, "--timeout-ms");
  const promiseTimeoutMs = parsePositiveInt(valueOrDefault(["DIGGER_PROMISE_TIMEOUT_MS"], "DIGGER_PROMISE_TIMEOUT_MS", args.promiseTimeoutMs), 60_000, "--promise-timeout-ms");
  const queryTimeoutMs = parsePositiveInt(valueOrDefault(["DIGGER_QUERY_TIMEOUT_MS"], "DIGGER_QUERY_TIMEOUT_MS", args.queryTimeoutMs), 30_000, "--query-timeout-ms");
  const validatorMode = (args.validatorMode || envValue("DIGGER_VALIDATOR_MODE") || DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;
  const goldStrategy = (args.goldStrategy || envValue("DIGGER_GOLD_STRATEGY") || "round-robin") as GoldStrategy;
  const topUp = parseAmount(args.topUp || envValue("DIGGER_PROXY_TOP_UP") || DEFAULTS.DIGGER_PROXY_TOP_UP, "DIGGER_PROXY_TOP_UP");
  const worldProgramId = normalizeAddress(requireValue(envValue("DIGGER_PROGRAM_ID"), "DIGGER_PROGRAM_ID"), "DIGGER_PROGRAM_ID");
  const codeId = normalizeHex32(requireValue(envValue("DIGGER_PROXY_CODE_ID"), "DIGGER_PROXY_CODE_ID"), "DIGGER_PROXY_CODE_ID");

  if (validatorMode !== "default" && validatorMode !== "slot") throw new Error("validator mode must be default or slot");
  if (goldStrategy !== "round-robin" && goldStrategy !== "nearest") throw new Error("gold strategy must be round-robin or nearest");

  const [proxySails, worldSails] = await Promise.all([loadSails(PROXY_IDL_PATH), loadSails(WORLD_IDL_PATH)]);
  const connection = await connect(args, timeoutMs);
  try {
    console.log("[fleet:start]", {
      account: connection.accountAddress,
      worldProgramId,
      codeId,
      createCount,
      steps,
      untilGold,
      goldAndSurface,
      surfaceCarried,
      goldStrategy,
      maxRounds,
      validatorMode,
      topUp: topUp.toString(),
    });

    const codeState = await connection.api.eth.router.codeState(codeId);
    if (codeState !== CodeState.Validated) {
      throw new Error(`DIGGER_PROXY_CODE_ID is not validated; state=${String(codeState)}`);
    }

    await ensureSessionActive(connection, worldSails, worldProgramId, validatorMode, promiseTimeoutMs, timeoutMs, queryTimeoutMs);

    const proxies = envProxyList();
    const newProxies: Address[] = [];
    for (let i = 0; i < createCount; i += 1) {
      console.log("[fleet:create]", { index: i + 1, of: createCount });
      const proxy = await deployProxy(connection, proxySails, worldProgramId, codeId, topUp, promiseTimeoutMs, timeoutMs);
      await registerProxy(connection, proxySails, worldSails, worldProgramId, proxy, validatorMode, promiseTimeoutMs, timeoutMs, queryTimeoutMs);
      proxies.push(proxy);
      newProxies.push(proxy);
      await updateProxyList(proxies);
    }

    const allProxies = [...new Set(proxies.map((proxy) => proxy.toLowerCase()))] as Address[];
    const playProxies = selectProxyIndexes(allProxies, args.proxyIndexes);
    const registerProxies = args.proxyIndexes ? playProxies : allProxies;
    for (const proxy of registerProxies) {
      await registerProxy(connection, proxySails, worldSails, worldProgramId, proxy, validatorMode, promiseTimeoutMs, timeoutMs, queryTimeoutMs);
    }
    await updateProxyList(allProxies);

    if (surfaceCarried && !args.noPlay) {
      for (const proxy of playProxies) {
        await returnCarriedToSurface(
          connection,
          proxySails,
          worldSails,
          worldProgramId,
          proxy,
          validatorMode,
          promiseTimeoutMs,
          timeoutMs,
          queryTimeoutMs,
          maxRounds,
        );
      }
    } else if (goldAndSurface && !args.noPlay) {
      for (const proxy of playProxies) {
        await mineGoldAndSurface(
          connection,
          proxySails,
          worldSails,
          worldProgramId,
          proxy,
          validatorMode,
          promiseTimeoutMs,
          timeoutMs,
          queryTimeoutMs,
          maxRounds,
        );
      }
    } else if (untilGold && !args.noPlay && goldStrategy === "nearest") {
      let found = false;
      for (let move = 0; move < maxRounds && !found; move += 1) {
        const candidate = await selectNearestGoldCandidate(
          connection,
          worldSails,
          worldProgramId,
          playProxies,
          queryTimeoutMs,
        );
        if (!candidate) {
          console.log("[fleet:gold-no-candidate]", { move: move + 1, proxies: playProxies.length });
          break;
        }
        console.log("[fleet:gold-pick]", {
          move: move + 1,
          of: maxRounds,
          proxy: candidate.proxy,
          index: candidate.index,
          position: { x: candidate.agent.x, y: candidate.agent.y },
          action: candidate.action.fn,
          target: candidate.action.target,
          hcrst: candidate.action.hcrst,
          distance: candidate.action.distance,
          inventoryHcrst: candidate.agent.inventoryHcrst.toString(),
        });
        const result = await executeProxyAction(
          connection,
          proxySails,
          worldSails,
          worldProgramId,
          candidate.proxy,
          candidate.agent,
          candidate.action,
          validatorMode,
          promiseTimeoutMs,
          timeoutMs,
        );
        if (result.after.inventoryHcrst > result.before.inventoryHcrst) {
          console.log("[fleet:gold-found]", {
            proxy: candidate.proxy,
            action: result.action,
            beforeHcrst: result.before.inventoryHcrst.toString(),
            afterHcrst: result.after.inventoryHcrst.toString(),
            position: { x: result.after.x, y: result.after.y },
            move: move + 1,
          });
          found = true;
        }
      }
      if (!found) {
        console.log("[fleet:gold-not-found]", { maxRounds, goldStrategy });
      }
    } else if (untilGold && !args.noPlay) {
      let found = false;
      for (let round = 0; round < maxRounds && !found; round += 1) {
        console.log("[fleet:gold-round]", { round: round + 1, of: maxRounds, proxies: playProxies.length });
        for (const proxy of playProxies) {
          const result = await playProxyStep(
            connection,
            proxySails,
            worldSails,
            worldProgramId,
            proxy,
            validatorMode,
            promiseTimeoutMs,
            timeoutMs,
            queryTimeoutMs,
            "gold",
          );
          if (result.after.inventoryHcrst > result.before.inventoryHcrst) {
            console.log("[fleet:gold-found]", {
              proxy,
              action: result.action,
              beforeHcrst: result.before.inventoryHcrst.toString(),
              afterHcrst: result.after.inventoryHcrst.toString(),
              position: { x: result.after.x, y: result.after.y },
              round: round + 1,
            });
            found = true;
            break;
          }
        }
      }
      if (!found) {
        console.log("[fleet:gold-not-found]", { maxRounds, goldStrategy });
      }
    } else {
      for (let step = 0; step < steps; step += 1) {
        console.log("[fleet:play-step]", { step: step + 1, of: steps, proxies: playProxies.length });
        for (const proxy of playProxies) {
          await playProxyStep(connection, proxySails, worldSails, worldProgramId, proxy, validatorMode, promiseTimeoutMs, timeoutMs, queryTimeoutMs);
        }
      }
    }

    console.log("[fleet:complete]", {
      created: newProxies,
      allProxies,
      playProxies,
      steps,
      untilGold,
      goldAndSurface,
      surfaceCarried,
      goldStrategy,
    });
  } finally {
    await connection.disconnect().catch(() => undefined);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
