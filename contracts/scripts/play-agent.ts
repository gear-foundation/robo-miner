#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
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
  DIGGER_PROMISE_TIMEOUT_MS: "90000",
  DIGGER_QUERY_TIMEOUT_MS: "30000",
  DIGGER_PLAY_STEPS: "4",
  DIGGER_PLAY_TRANSPORT: "injected",
  DIGGER_VALIDATOR_MODE: "default",
} as const;

const IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");

const MAP_WIDTH = 40;
const MAP_HEIGHT = 64;
const TILE_EMPTY = 0;
const TILE_DIRT = 1;
const TILE_STONE = 2;
const TILE_CHEST = 3;
const TILE_LADDER = 4;
const TILE_RESOURCE_SCRST = 10;
const TILE_RESOURCE_BCRST = 11;
const TILE_RESOURCE_HCRST = 12;
const TILE_SURFACE = 20;
const SESSION_ACTIVE = 1;
const AGENT_ACTIVE = 1;

const DIR = {
  Up: 0,
  Right: 1,
  Down: 2,
  Left: 3,
} as const;

type ValidatorMode = "default" | "slot";

type CliArgs = {
  program?: string;
  steps?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  transport?: "mirror" | "injected";
  help?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

type AgentView = {
  status: number;
  x: number;
  y: number;
  hp: number;
  ladders: number;
  invScrst: number;
  invBcrst: number;
  invHcrst: number;
  bankedScrst: number;
  bankedBcrst: number;
  bankedHcrst: number;
  backpackCapacity: number;
  lastActionSeq: number;
};

type PlannedAction = {
  fn: "Drill" | "MoveAgent";
  direction: number;
  label: string;
  targetX: number;
  targetY: number;
};

function printUsage() {
  console.log(`Usage:
  pnpm run play-agent
  pnpm run play-agent -- --steps 8

Flow:
  - reads World.Session and starts it when needed;
  - reads World.AgentOf and registers when needed;
  - sends Admin/World actions through the selected transport;
  - default transport is injected sendAndWaitForPromise; use --transport mirror only as fallback;
  - decodes each returned reply into AgentView and chooses the next action from that reply.

Environment:
  PRIVATE_KEY       Player/admin private key.
  DIGGER_PROGRAM_ID Digger Mirror address.
  DIGGER_BACKEND_URL Optional backend URL for resolving/requesting a digger.
  DIGGER_WORLD_ID   World program id used with backend digger rental.
  ETHEREUM_RPC      Ethereum Hoodi RPC.
  VARA_ETH_RPC      Vara.eth validator RPC.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const mutable = args as Record<string, string | boolean | undefined>;
  const aliases: Record<string, keyof CliArgs> = {
    p: "program",
    h: "help",
  };
  const booleanFlags = new Set<keyof CliArgs>(["help"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`);

    const [flagPart, inlineValue] = arg.split("=", 2);
    const rawName = flagPart.replace(/^-+/, "");
    const camelName = rawName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    const name = aliases[camelName] ?? (camelName as keyof CliArgs);
    if (!isKnownArg(name)) throw new Error(`Unknown option: ${flagPart}`);

    if (booleanFlags.has(name)) {
      mutable[name] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flagPart}`);
    index += inlineValue === undefined ? 1 : 0;
    mutable[name] = value;
  }

  return args;
}

function isKnownArg(name: string): name is keyof CliArgs {
  return [
    "program",
    "steps",
    "ethRpc",
    "varaRpc",
    "router",
    "privateKey",
    "timeoutMs",
    "promiseTimeoutMs",
    "queryTimeoutMs",
    "validatorMode",
    "transport",
    "help",
  ].includes(name);
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function valueOrDefault(name: keyof typeof DEFAULTS, override?: string): string {
  return override?.trim() || envValue(name) || DEFAULTS[name];
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalNormalizeAddress(value: string | undefined, name: string): Address | null {
  return value ? normalizeAddress(value, name) : null;
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${name} must be a hex string`);
  return hex.toLowerCase() as Hex;
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

function normalizeBackendUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

async function resolveDiggerProgramId(args: CliArgs, owner: Address): Promise<Address> {
  const configured = args.program || envValue("DIGGER_PROGRAM_ID");
  if (configured) return normalizeAddress(configured, "DIGGER_PROGRAM_ID");

  const backendUrl = normalizeBackendUrl(envValue("DIGGER_BACKEND_URL") || envValue("BACKEND_URL"));
  const worldId = optionalNormalizeAddress(
    envValue("DIGGER_WORLD_ID") || envValue("WORLD_PROGRAM_ID"),
    "DIGGER_WORLD_ID",
  );
  if (!backendUrl || !worldId) {
    throw new Error("Missing DIGGER_PROGRAM_ID. Or set DIGGER_BACKEND_URL and DIGGER_WORLD_ID to resolve/request a rented digger.");
  }

  const seasonId = envValue("DIGGER_RENTAL_SEASON") || envValue("SEASON_ID");
  const search = new URLSearchParams({ owner, world: worldId, status: "active" });
  if (seasonId) search.set("season", seasonId);
  const existing = await fetchJson(`${backendUrl}/api/diggers?${search.toString()}`);
  const existingProgramId = existing?.digger?.programId || existing?.diggers?.[0]?.programId;
  if (existingProgramId) {
    return normalizeAddress(existingProgramId, "backend digger programId");
  }

  if (envValue("DIGGER_REQUEST_DIGGER") !== "true") {
    throw new Error("No active digger found for owner/world. Set DIGGER_REQUEST_DIGGER=true to request one from backend.");
  }

  const request = await fetchJson(`${backendUrl}/api/diggers/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner,
      worldId,
      seasonId,
      dryRun: envValue("DIGGER_RENTAL_DRY_RUN") === "true" ? true : undefined,
    }),
  });
  return normalizeAddress(requireValue(request?.programId, "backend request programId"), "backend request programId");
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
  );
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

async function connect(args: CliArgs): Promise<Connection> {
  const privateKey = normalizePrivateKey(
    requireValue(args.privateKey || envValue("PRIVATE_KEY"), "PRIVATE_KEY"),
  );
  const ethRpc = valueOrDefault("ETHEREUM_RPC", args.ethRpc);
  const varaRpc = valueOrDefault("VARA_ETH_RPC", args.varaRpc);
  const router = normalizeAddress(valueOrDefault("ROUTER_ADDRESS", args.router), "ROUTER_ADDRESS");
  const timeoutMs = parsePositiveInt(valueOrDefault("DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs), "timeout");

  const account = privateKeyToAccount(privateKey, { nonceManager });
  const publicClient = createPublicClient({ transport: ethTransportFor(ethRpc) });
  const walletClient = createWalletClient({ transport: ethTransportFor(ethRpc), account });
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

async function loadSails(): Promise<SailsProgram> {
  if (!existsSync(IDL_PATH)) throw new Error(`IDL file does not exist: ${IDL_PATH}`);
  const parser = new SailsIdlParser();
  await parser.init();
  const idl = await readFile(IDL_PATH, "utf8");
  return new SailsProgram(parser.parse(idl));
}

function normalizeReplyCode(code: ReplyCode | string): Hex {
  return typeof code === "string" ? (code as Hex) : bytesToHex(code.toBytes());
}

function decodeScaleCompactLength(bytes: Uint8Array): { length: number; offset: number } {
  const mode = bytes[0] & 0b11;
  if (mode === 0) return { length: bytes[0] >> 2, offset: 1 };
  if (mode === 1) return { length: ((bytes[0] | (bytes[1] << 8)) >> 2), offset: 2 };
  if (mode === 2) {
    const value =
      bytes[0] |
      (bytes[1] << 8) |
      (bytes[2] << 16) |
      (bytes[3] << 24);
    return { length: value >>> 2, offset: 4 };
  }
  throw new Error("unsupported large SCALE compact length");
}

function decodeScaleString(payload: Hex): string | null {
  const bytes = Uint8Array.from(Buffer.from(payload.slice(2), "hex"));
  if (bytes.length === 0) return null;
  try {
    const { length, offset } = decodeScaleCompactLength(bytes);
    if (offset + length > bytes.length) return null;
    return Buffer.from(bytes.subarray(offset, offset + length)).toString("utf8");
  } catch {
    return null;
  }
}

function decodeRawUtf8(payload: Hex): string | null {
  const bytes = Buffer.from(payload.slice(2), "hex");
  if (!bytes.length) return null;
  const text = bytes.toString("utf8");
  return /^[\t\n\r -~]+$/.test(text) ? text : null;
}

function decodeErrorPayload(sails: SailsProgram, payload: Hex): string {
  const fallback = [
    decodeScaleString(payload) ? `scaleString=${JSON.stringify(decodeScaleString(payload))}` : null,
    decodeRawUtf8(payload) ? `rawString=${JSON.stringify(decodeRawUtf8(payload))}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  try {
    const decoded = stringify(sails.decodeError(payload));
    return fallback ? `${decoded}; ${fallback}` : decoded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed to decode error payload: ${message}${fallback ? `; ${fallback}` : ""}`;
  }
}

function assertSuccessReply(code: ReplyCode | string, sails: SailsProgram, payload?: Hex) {
  const replyCode = typeof code === "string" ? ReplyCode.fromBytes(code as Hex) : code;
  if (!replyCode.isSuccess) {
    const decoded =
      payload && payload !== "0x" ? `; decoded=${decodeErrorPayload(sails, payload)}` : "";
    throw new Error(`program reply failed: ${normalizeReplyCode(code)} (${replyCode.reason})${decoded}`);
  }
}

function isSessionAlreadyActiveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("session is already active");
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
    if (nextStateHash.toLowerCase() !== previousStateHash.toLowerCase()) return nextStateHash;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for stateHash change from ${previousStateHash}`);
}

function agentFromView(view: unknown): AgentView {
  if (!Array.isArray(view) || view.length < 13) throw new Error("AgentView has unexpected shape");
  return {
    status: Number(view[0]),
    x: Number(view[1]),
    y: Number(view[2]),
    hp: Number(view[3]),
    ladders: Number(view[4]),
    invScrst: Number(view[5]),
    invBcrst: Number(view[6]),
    invHcrst: Number(view[7]),
    bankedScrst: Number(view[8]),
    bankedBcrst: Number(view[9]),
    bankedHcrst: Number(view[10]),
    backpackCapacity: Number(view[11]),
    lastActionSeq: Number(view[12]),
  };
}

function decodeAgentResult(sails: SailsProgram, fn: "Register" | "Drill" | "MoveAgent", payload: Hex): AgentView {
  return agentFromView(sails.services.World.functions[fn].decodeResult<unknown>(payload));
}

function decodeSessionResult(sails: SailsProgram, payload: Hex): number[] {
  const result = sails.services.Admin.functions.StartSession.decodeResult<unknown>(payload);
  if (!Array.isArray(result)) throw new Error("Session result has unexpected shape");
  return result.map(Number);
}

function decodeSessionQuery(sails: SailsProgram, payload: Hex): number[] {
  const result = sails.services.World.queries.Session.decodeResult<unknown>(payload);
  if (!Array.isArray(result)) throw new Error("Session query has unexpected shape");
  return result.map(Number);
}

function decodeMapSnapshot(sails: SailsProgram, payload: Hex): number[] {
  const result = sails.services.World.queries.MapSnapshot.decodeResult<unknown>(payload);
  if (!Array.isArray(result)) throw new Error("MapSnapshot has unexpected shape");
  return result.map(Number);
}

async function queryProgram<T>(
  connection: Connection,
  sails: SailsProgram,
  programId: Address,
  payload: Hex,
  decode: (payload: Hex) => T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const reply = await withTimeout(
    connection.api.call.program.calculateReplyForHandle(
      connection.accountAddress,
      programId,
      payload,
      0n,
    ),
    timeoutMs,
    label,
  );
  if (!reply?.payload) throw new Error(`${label} did not return payload`);
  assertSuccessReply(reply.code, sails, reply.payload);
  return decode(reply.payload);
}

async function sendInjected<T>(
  connection: Connection,
  sails: SailsProgram,
  programId: Address,
  label: string,
  payload: Hex,
  decode: (payload: Hex) => T,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
): Promise<T> {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: connection.api.eth.publicClient,
    signer: connection.api.eth.signer,
  });
  const previousStateHash = await mirror.stateHash();
  const injected = await connection.api.createInjectedTransaction({
    destination: programId,
    payload,
    value: 0n,
  });
  const recipient =
    validatorMode === "slot" ? await injected.setSlotValidator() : injected.setDefaultValidator();

  console.log(`[${label}] prepared`, {
    recipient,
    messageId: injected.messageId,
    txHash: injected.txHash,
    previousStateHash,
  });

  const rawReply = await withTimeout(
    injected.sendAndWaitForPromise(),
    promiseTimeoutMs,
    `${label} injected promise`,
  );
  const reply = unwrapInjectedPromise(rawReply, label);
  if (!reply?.payload) throw new Error(`${label} did not return an injected promise payload`);
  assertSuccessReply(reply.code, sails, reply.payload);
  const decoded = decode(reply.payload);
  console.log(`[${label}] reply`, stringify(decoded));

  try {
    const nextStateHash = await waitForStateHashChange(connection.api, programId, previousStateHash, stateTimeoutMs);
    console.log(`[${label}] state changed`, { previousStateHash, nextStateHash });
  } catch (error) {
    console.warn(`[${label}] stateHash wait skipped`, error instanceof Error ? error.message : String(error));
  }

  return decoded;
}

async function sendMirror<T>(
  connection: Connection,
  sails: SailsProgram,
  programId: Address,
  label: string,
  payload: Hex,
  decode: (payload: Hex) => T,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
): Promise<T> {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: connection.api.eth.publicClient,
    signer: connection.api.eth.signer,
  });
  const previousStateHash = await mirror.stateHash();
  const tx = await mirror.sendMessage(payload, 0n);
  const txHash = await tx.send();
  const receipt = await tx.getReceipt();
  const message = await tx.getMessage();

  console.log(`[${label}] sent via mirror`, {
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
  if (!reply?.payload) throw new Error(`${label} did not return a mirror reply payload`);
  assertSuccessReply(reply.replyCode, sails, reply.payload);
  const decoded = decode(reply.payload);
  console.log(`[${label}] reply`, stringify(decoded));

  try {
    const nextStateHash = await waitForStateHashChange(connection.api, programId, previousStateHash, stateTimeoutMs);
    console.log(`[${label}] state changed`, { previousStateHash, nextStateHash });
  } catch (error) {
    console.warn(`[${label}] stateHash wait skipped`, error instanceof Error ? error.message : String(error));
  }

  return decoded;
}

async function sendAction<T>(
  connection: Connection,
  sails: SailsProgram,
  programId: Address,
  label: string,
  payload: Hex,
  decode: (payload: Hex) => T,
  transport: "mirror" | "injected",
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
  stateTimeoutMs: number,
): Promise<T> {
  if (transport === "injected") {
    return sendInjected(
      connection,
      sails,
      programId,
      label,
      payload,
      decode,
      validatorMode,
      promiseTimeoutMs,
      stateTimeoutMs,
    );
  }

  return sendMirror(
    connection,
    sails,
    programId,
    label,
    payload,
    decode,
    promiseTimeoutMs,
    stateTimeoutMs,
  );
}

function tileAt(map: number[], x: number, y: number): number {
  return map[y * MAP_WIDTH + x] ?? TILE_EMPTY;
}

function isDrillable(tile: number): boolean {
  return (
    tile === TILE_DIRT ||
    tile === TILE_STONE ||
    tile === TILE_CHEST ||
    tile === TILE_RESOURCE_SCRST ||
    tile === TILE_RESOURCE_BCRST ||
    tile === TILE_RESOURCE_HCRST
  );
}

function isTraversable(tile: number): boolean {
  return tile === TILE_EMPTY || tile === TILE_SURFACE || tile === TILE_LADDER;
}

function targetPosition(agent: AgentView, direction: number): { x: number; y: number } | null {
  if (direction === DIR.Up) return agent.y === 0 ? null : { x: agent.x, y: agent.y - 1 };
  if (direction === DIR.Right) return agent.x + 1 >= MAP_WIDTH ? null : { x: agent.x + 1, y: agent.y };
  if (direction === DIR.Down) return agent.y + 1 >= MAP_HEIGHT ? null : { x: agent.x, y: agent.y + 1 };
  if (direction === DIR.Left) return agent.x === 0 ? null : { x: agent.x - 1, y: agent.y };
  return null;
}

function directionName(direction: number): string {
  return direction === DIR.Down ? "down" : direction === DIR.Right ? "right" : direction === DIR.Left ? "left" : "up";
}

function planForDirection(agent: AgentView, map: number[], direction: number): PlannedAction | null {
  const target = targetPosition(agent, direction);
  if (!target) return null;
  const tile = tileAt(map, target.x, target.y);
  if (isDrillable(tile)) {
    return {
      fn: "Drill",
      direction,
      label: `drill ${directionName(direction)} tile=${tile}`,
      targetX: target.x,
      targetY: target.y,
    };
  }
  if (isTraversable(tile)) {
    return {
      fn: "MoveAgent",
      direction,
      label: `move ${directionName(direction)} tile=${tile}`,
      targetX: target.x,
      targetY: target.y,
    };
  }
  return null;
}

function chooseNextAction(agent: AgentView, map: number[]): PlannedAction | null {
  return (
    planForDirection(agent, map, DIR.Down) ??
    planForDirection(agent, map, DIR.Right) ??
    planForDirection(agent, map, DIR.Left)
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const steps = parseNonNegativeInt(args.steps || envValue("DIGGER_PLAY_STEPS") || DEFAULTS.DIGGER_PLAY_STEPS, "steps");
  const timeoutMs = parsePositiveInt(valueOrDefault("DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs), "timeout");
  const promiseTimeoutMs = parsePositiveInt(valueOrDefault("DIGGER_PROMISE_TIMEOUT_MS", args.promiseTimeoutMs), "promise timeout");
  const queryTimeoutMs = parsePositiveInt(valueOrDefault("DIGGER_QUERY_TIMEOUT_MS", args.queryTimeoutMs), "query timeout");
  const validatorMode = (args.validatorMode || envValue("DIGGER_VALIDATOR_MODE") || DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;
  const transport = valueOrDefault("DIGGER_PLAY_TRANSPORT", args.transport) as "mirror" | "injected";
  if (transport !== "mirror" && transport !== "injected") {
    throw new Error("--transport must be mirror or injected");
  }

  const sails = await loadSails();
  const connection = await connect(args);
  const programId = await resolveDiggerProgramId(args, connection.accountAddress);
  console.log("[connect]", { account: connection.accountAddress, programId, steps, validatorMode, transport });

  try {
    let session = await queryProgram(
      connection,
      sails,
      programId,
      sails.services.World.queries.Session.encodePayload() as Hex,
      (payload) => decodeSessionQuery(sails, payload),
      queryTimeoutMs,
      "World.Session",
    );

    if (session[2] !== SESSION_ACTIVE) {
      try {
        session = await sendAction(
          connection,
          sails,
          programId,
          "Admin.StartSession",
          sails.services.Admin.functions.StartSession.encodePayload() as Hex,
          (payload) => decodeSessionResult(sails, payload),
          transport,
          validatorMode,
          promiseTimeoutMs,
          timeoutMs,
        );
      } catch (error) {
        if (!isSessionAlreadyActiveError(error)) throw error;
        console.warn("[session] Admin.StartSession skipped: session is already active");
        session = [session[0], session[1], SESSION_ACTIVE, session[3]];
      }
    }
    console.log("[session]", { id: session[0], seed: session[1], status: session[2], actionSeq: session[3] });

    const ownerActor = actorIdFromAddress(connection.accountAddress);
    let agent: AgentView;
    try {
      agent = await queryProgram(
        connection,
        sails,
        programId,
        sails.services.World.queries.AgentOf.encodePayload(ownerActor) as Hex,
        (payload) => agentFromView(sails.services.World.queries.AgentOf.decodeResult<unknown>(payload)),
        queryTimeoutMs,
        "World.AgentOf",
      );
      console.log("[agent] already registered", agent);
    } catch (error) {
      console.log("[agent] registering", error instanceof Error ? error.message : String(error));
      agent = await sendAction(
        connection,
        sails,
        programId,
        "World.Register",
        sails.services.World.functions.Register.encodePayload(ownerActor) as Hex,
        (payload) => decodeAgentResult(sails, "Register", payload),
        transport,
        validatorMode,
        promiseTimeoutMs,
        timeoutMs,
      );
    }

    const map = await queryProgram(
      connection,
      sails,
      programId,
      sails.services.World.queries.MapSnapshot.encodePayload() as Hex,
      (payload) => decodeMapSnapshot(sails, payload),
      queryTimeoutMs,
      "World.MapSnapshot",
    );

    for (let index = 0; index < steps; index += 1) {
      if (agent.status !== AGENT_ACTIVE) {
        console.log("[plan] stopping: agent is not active", agent);
        break;
      }
      const action = chooseNextAction(agent, map);
      if (!action) {
        console.log("[plan] no safe action from reply agent state", agent);
        break;
      }

      console.log(`[plan] step ${index + 1}/${steps}`, {
        from: { x: agent.x, y: agent.y },
        action: action.label,
        target: { x: action.targetX, y: action.targetY },
      });

      const before = agent;
      agent = await sendAction(
        connection,
        sails,
        programId,
        `World.${action.fn}`,
        sails.services.World.functions[action.fn].encodePayload(action.direction) as Hex,
        (payload) => decodeAgentResult(sails, action.fn, payload),
        transport,
        validatorMode,
        promiseTimeoutMs,
        timeoutMs,
      );

      if (action.fn === "Drill") {
        map[action.targetY * MAP_WIDTH + action.targetX] = TILE_EMPTY;
      }

      console.log("[agent] reply-selected state", {
        before: { x: before.x, y: before.y, seq: before.lastActionSeq },
        after: { x: agent.x, y: agent.y, seq: agent.lastActionSeq, inv: agent.invScrst + agent.invBcrst + agent.invHcrst },
      });
    }
  } finally {
    await connection.disconnect().catch(() => undefined);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
