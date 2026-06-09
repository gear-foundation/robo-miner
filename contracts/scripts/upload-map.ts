#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
  DIGGER_VALIDATOR_MODE: "default",
} as const;

const IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const MAP_WIDTH = 40;
const MAP_HEIGHT = 64;
const MAP_CELLS = MAP_WIDTH * MAP_HEIGHT;

const TILE = {
  Empty: 0,
  Dirt: 1,
  Stone: 2,
  Lava: 3,
  Ladder: 4,
  Scrst: 10,
  Bcrst: 11,
  Hcrst: 12,
  Surface: 20,
} as const;

const EXPECTED_RESOURCES = {
  scrst: 77,
  bcrst: 19,
  hcrst: 4,
  total: 100,
} as const;

type ValidatorMode = "default" | "slot";

type CliArgs = {
  file?: string;
  program?: string;
  seed?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  payloadOut?: string;
  dryRun?: boolean;
  stateDebug?: boolean;
  verifyOnly?: boolean;
  help?: boolean;
};

type DiggerMap = {
  path: string;
  tiles: number[];
  seed: string | null;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

function printUsage() {
  console.log(`Usage:
  pnpm upload-map -- --file <map.json> --program <mirrorAddress> [--seed <u64>]

Common:
  pnpm upload-map:dry-run
  pnpm upload-map:state
  pnpm upload-map:verify
  pnpm upload-map -- --validator slot

Inputs:
  --file, -f        JSON map file. Accepts an object with "tiles"/"map"/"cells" or a raw array.
  --program, -p     Digger Mirror address. Defaults to DIGGER_PROGRAM_ID.
  --seed, -s        Upload seed. Defaults to map seed, then DIGGER_SEED.
  --payload-out     Write encoded Admin.UploadMap payload hex to a file.
  --dry-run         Validate and encode only.
  --state-debug     Read Mirror stateHash, then program.readState(stateHash).
  --verify-only     Query World.MapSnapshot and compare it with the input map.
  --validator       "default" or "slot". Defaults to DIGGER_VALIDATOR_MODE/default.
  --promise-timeout-ms
                    Max time to wait for injected promise before state polling fallback.
  --query-timeout-ms
                    Max time to wait for calculateReplyForHandle.

Environment:
  PRIVATE_KEY       Admin private key. Required unless only --dry-run is used.
  ETHEREUM_RPC      Ethereum Hoodi RPC. WebSocket is recommended.
  VARA_ETH_RPC      Vara.eth validator RPC.
  ROUTER_ADDRESS    Vara.eth Router contract address.
  DIGGER_PROGRAM_ID Existing Digger Mirror address.
  DIGGER_MAP_FILE   Alternative to --file.
  DIGGER_PROMISE_TIMEOUT_MS
                    Injected promise timeout in milliseconds.
  DIGGER_QUERY_TIMEOUT_MS
                    calculateReplyForHandle timeout in milliseconds.
  DIGGER_SEED       Fallback upload seed.
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
      case "--file":
      case "-f":
        args.file = next();
        break;
      case "--program":
      case "-p":
        args.program = next();
        break;
      case "--seed":
      case "-s":
        args.seed = next();
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
      case "--payload-out":
        args.payloadOut = next();
        break;
      case "--validator": {
        const value = next();
        if (value !== "default" && value !== "slot") {
          throw new Error("--validator must be either default or slot");
        }
        args.validatorMode = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--state-debug":
        args.stateDebug = true;
        break;
      case "--verify-only":
        args.verifyOnly = true;
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

function valueOrDefault(name: keyof typeof DEFAULTS, override?: string): string {
  return override?.trim() || envValue(name) || DEFAULTS[name];
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${name} must be a hex string`);
  }
  return hex.toLowerCase() as Hex;
}

function normalizeAddress(value: string, name: string): Address {
  const hex = normalizeHex(value, name);

  if (hex.length === 66) {
    return `0x${hex.slice(-40)}` as Address;
  }

  if (hex.length !== 42) {
    throw new Error(`${name} must be a 20-byte address or a 32-byte ActorId`);
  }

  return hex as Address;
}

function normalizePrivateKey(value: string): Hex {
  const hex = normalizeHex(value, "PRIVATE_KEY");
  if (hex.length !== 66) {
    throw new Error("PRIVATE_KEY must be 32-byte hex");
  }
  return hex;
}

function parseU64(value: string, name: string): bigint {
  const raw = value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(raw) && !/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be decimal u64 or 0x hex`);
  }

  const parsed = BigInt(raw);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${name} is outside u64 range`);
  }
  return parsed;
}

function resolveFromRoot(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
}

function normalizeTile(value: unknown, index: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`tile ${index} must be an integer number`);
  }
  if (value < 0 || value > 255) {
    throw new Error(`tile ${index} is outside u8 range`);
  }
  return value;
}

function extractTilesAndSeed(json: unknown): { tiles: unknown[]; seed: string | null } {
  if (Array.isArray(json)) {
    return { tiles: json, seed: null };
  }

  if (!json || typeof json !== "object") {
    throw new Error("map JSON must be an array or an object with a tiles array");
  }

  const record = json as Record<string, unknown>;
  if (record.width !== undefined && Number(record.width) !== MAP_WIDTH) {
    throw new Error(`map width must be ${MAP_WIDTH}`);
  }
  if (record.height !== undefined && Number(record.height) !== MAP_HEIGHT) {
    throw new Error(`map height must be ${MAP_HEIGHT}`);
  }

  const tiles = record.tiles ?? record.map ?? record.cells;
  if (!Array.isArray(tiles)) {
    throw new Error("map JSON object must contain tiles, map, or cells array");
  }

  return {
    tiles,
    seed: record.seed == null ? null : String(record.seed),
  };
}

async function readMapFile(filePath: string): Promise<DiggerMap> {
  const absolutePath = resolveFromRoot(filePath);
  const json = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  const { tiles, seed } = extractTilesAndSeed(json);

  return {
    path: absolutePath,
    tiles: tiles.map(normalizeTile),
    seed,
  };
}

function validateMap(tiles: number[]) {
  if (tiles.length !== MAP_CELLS) {
    throw new Error(`map must contain ${MAP_CELLS} cells, got ${tiles.length}`);
  }

  const knownTiles = new Set<number>(Object.values(TILE));
  const counts = new Map<number, number>();

  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (!knownTiles.has(tile)) {
      throw new Error(`unknown tile ${tile} at index ${index}`);
    }

    const y = Math.floor(index / MAP_WIDTH);
    if (y === 0 && tile !== TILE.Surface) {
      throw new Error(`top row must contain only surface tiles; bad index ${index}`);
    }
    if (y > 0 && tile === TILE.Surface) {
      throw new Error(`surface tile below top row at index ${index}`);
    }

    counts.set(tile, (counts.get(tile) ?? 0) + 1);
  }

  const scrst = counts.get(TILE.Scrst) ?? 0;
  const bcrst = counts.get(TILE.Bcrst) ?? 0;
  const hcrst = counts.get(TILE.Hcrst) ?? 0;
  const total = scrst + bcrst + hcrst;

  if (scrst !== EXPECTED_RESOURCES.scrst) {
    throw new Error(`SCRST count must be ${EXPECTED_RESOURCES.scrst}, got ${scrst}`);
  }
  if (bcrst !== EXPECTED_RESOURCES.bcrst) {
    throw new Error(`BCRST count must be ${EXPECTED_RESOURCES.bcrst}, got ${bcrst}`);
  }
  if (hcrst !== EXPECTED_RESOURCES.hcrst) {
    throw new Error(`HCRST count must be ${EXPECTED_RESOURCES.hcrst}, got ${hcrst}`);
  }
  if (total !== EXPECTED_RESOURCES.total) {
    throw new Error(`resource count must be ${EXPECTED_RESOURCES.total}, got ${total}`);
  }

  return {
    cells: tiles.length,
    scrst,
    bcrst,
    hcrst,
    dirt: counts.get(TILE.Dirt) ?? 0,
    stone: counts.get(TILE.Stone) ?? 0,
    lava: counts.get(TILE.Lava) ?? 0,
    ladder: counts.get(TILE.Ladder) ?? 0,
    surface: counts.get(TILE.Surface) ?? 0,
    empty: counts.get(TILE.Empty) ?? 0,
  };
}

async function loadSails(): Promise<SailsProgram> {
  if (!existsSync(IDL_PATH)) {
    throw new Error(`IDL file does not exist: ${IDL_PATH}`);
  }

  const parser = new SailsIdlParser();
  await parser.init();
  const idl = await readFile(IDL_PATH, "utf8");
  return new SailsProgram(parser.parse(idl));
}

function encodeUploadPayload(sails: SailsProgram, seed: bigint, tiles: number[]): Hex {
  return sails.services.Admin.functions.UploadMap.encodePayload(
    seed.toString(),
    tiles,
  ) as Hex;
}

function encodeMapSnapshotPayload(sails: SailsProgram): Hex {
  return sails.services.World.queries.MapSnapshot.encodePayload() as Hex;
}

function decodeUploadResult(sails: SailsProgram, payload: Hex): unknown {
  return sails.services.Admin.functions.UploadMap.decodeResult(payload);
}

function decodeMapSnapshot(sails: SailsProgram, payload: Hex): number[] {
  const result = sails.services.World.queries.MapSnapshot.decodeResult<unknown>(payload);
  if (!Array.isArray(result)) {
    throw new Error("World.MapSnapshot returned a non-array result");
  }
  return result.map((item, index) => normalizeTile(Number(item), index));
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
  const timeoutMs = Number(valueOrDefault("DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs));

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DIGGER_EVENT_TIMEOUT_MS/--timeout-ms must be a positive number");
  }

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
  const accountAddress = (await api.eth.signer.getAddress()) as Address;

  return {
    api,
    accountAddress,
    disconnect: () => provider.disconnect(),
  };
}

function summarizeState(state: Awaited<ReturnType<VaraEthApi["query"]["program"]["readState"]>>) {
  const program = state.program;
  const active = "Active" in program ? program.Active : null;

  return {
    program: active ? "Active" : Object.keys(program)[0],
    initialized: active?.initialized ?? null,
    pagesHash: active?.pagesHash ?? null,
    allocationsHash: active?.allocationsHash ?? null,
    queueHash: state.queueHash,
    waitlistHash: state.waitlistHash,
    stashHash: state.stashHash,
    mailboxHash: state.mailboxHash,
    balance: state.balance.toString(),
    executableBalance: state.executableBalance.toString(),
  };
}

async function printStateDebug(api: VaraEthApi, programId: Address) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });

  const [stateHash, nonce, initializer, exited] = await Promise.all([
    mirror.stateHash(),
    mirror.nonce(),
    mirror.initializer(),
    mirror.exited(),
  ]);
  const state = await api.query.program.readState(stateHash);

  console.log("[state] mirror", {
    programId,
    stateHash,
    nonce: nonce.toString(),
    initializer,
    exited,
  });
  console.log("[state] program", summarizeState(state));
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

function decodeScaleCompactLength(bytes: Uint8Array): { length: number; offset: number } {
  const mode = bytes[0] & 0b11;
  if (mode === 0) {
    return { length: bytes[0] >> 2, offset: 1 };
  }
  if (mode === 1) {
    return { length: ((bytes[0] | (bytes[1] << 8)) >> 2), offset: 2 };
  }
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
  if (bytes.length === 0) {
    return null;
  }

  try {
    const { length, offset } = decodeScaleCompactLength(bytes);
    if (offset + length > bytes.length) {
      return null;
    }
    return Buffer.from(bytes.subarray(offset, offset + length)).toString("utf8");
  } catch {
    return null;
  }
}

function decodeRawUtf8(payload: Hex): string | null {
  const bytes = Buffer.from(payload.slice(2), "hex");
  if (!bytes.length) {
    return null;
  }

  const text = bytes.toString("utf8");
  return /^[\t\n\r -~]+$/.test(text) ? text : null;
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
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function decodeErrorPayload(sails: SailsProgram, payload: Hex): string | null {
  const scaleString = decodeScaleString(payload);
  const rawString = decodeRawUtf8(payload);
  const fallback = [
    scaleString ? `scaleString=${JSON.stringify(scaleString)}` : null,
    rawString ? `rawString=${JSON.stringify(rawString)}` : null,
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

function assertSuccessReply(
  code: ReplyCode | string,
  sails?: SailsProgram,
  payload?: Hex,
) {
  const replyCode = typeof code === "string" ? ReplyCode.fromBytes(code as Hex) : code;
  if (!replyCode.isSuccess) {
    const decoded =
      sails && payload && payload !== "0x" ? `; decoded=${decodeErrorPayload(sails, payload)}` : "";
    throw new Error(
      `program reply failed: ${normalizeReplyCode(code)} (${replyCode.reason})${decoded}`,
    );
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
    if (nextStateHash.toLowerCase() !== previousStateHash.toLowerCase()) {
      return nextStateHash;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(`Timed out waiting for stateHash change from ${previousStateHash}`);
}

async function verifyMap(
  api: VaraEthApi,
  sails: SailsProgram,
  accountAddress: Address,
  programId: Address,
  expectedTiles: number[],
  queryTimeoutMs: number,
) {
  const mirror = getMirrorClient({
    address: programId,
    publicClient: api.eth.publicClient,
    signer: api.eth.signer,
  });
  const stateHash = await mirror.stateHash();
  const queryPayload = encodeMapSnapshotPayload(sails);
  console.log("[verify] calculateReplyForHandle", { stateHash });
  const queryReply = await withTimeout(
    api.call.program.calculateReplyForHandle(
      accountAddress,
      programId,
      queryPayload,
      0n,
    ),
    queryTimeoutMs,
    "calculateReplyForHandle",
  );

  if (!queryReply) {
    throw new Error(
      `calculateReplyForHandle did not return; mirror stateHash ${stateHash}`,
    );
  }

  assertSuccessReply(queryReply.code, sails, queryReply.payload);
  const actualTiles = decodeMapSnapshot(sails, queryReply.payload);
  const mismatch = actualTiles.findIndex((tile, index) => tile !== expectedTiles[index]);

  if (mismatch !== -1) {
    throw new Error(
      `World.MapSnapshot mismatch at index ${mismatch}: expected ${expectedTiles[mismatch]}, got ${actualTiles[mismatch]}`,
    );
  }

  console.log("[verify] World.MapSnapshot matches input map", {
    cells: actualTiles.length,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const programId = normalizeAddress(
    requireValue(args.program || envValue("DIGGER_PROGRAM_ID"), "DIGGER_PROGRAM_ID"),
    "DIGGER_PROGRAM_ID",
  );
  const timeoutMs = Number(valueOrDefault("DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs));
  const promiseTimeoutMs = Number(
    valueOrDefault("DIGGER_PROMISE_TIMEOUT_MS", args.promiseTimeoutMs),
  );
  const queryTimeoutMs = Number(
    valueOrDefault("DIGGER_QUERY_TIMEOUT_MS", args.queryTimeoutMs),
  );
  const validatorMode = (args.validatorMode ||
    envValue("DIGGER_VALIDATOR_MODE") ||
    DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;

  if (validatorMode !== "default" && validatorMode !== "slot") {
    throw new Error("DIGGER_VALIDATOR_MODE must be either default or slot");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DIGGER_EVENT_TIMEOUT_MS/--timeout-ms must be a positive number");
  }
  if (!Number.isFinite(promiseTimeoutMs) || promiseTimeoutMs <= 0) {
    throw new Error("DIGGER_PROMISE_TIMEOUT_MS/--promise-timeout-ms must be a positive number");
  }
  if (!Number.isFinite(queryTimeoutMs) || queryTimeoutMs <= 0) {
    throw new Error("DIGGER_QUERY_TIMEOUT_MS/--query-timeout-ms must be a positive number");
  }

  const needsMap = !args.stateDebug;
  const mapFile = args.file || envValue("DIGGER_MAP_FILE");
  const map = needsMap ? await readMapFile(requireValue(mapFile, "DIGGER_MAP_FILE")) : null;
  const stats = map ? validateMap(map.tiles) : null;
  const seed = map
    ? parseU64(args.seed || map.seed || envValue("DIGGER_SEED") || "0", "DIGGER_SEED")
    : 0n;
  const sails = await loadSails();
  const payload = map ? encodeUploadPayload(sails, seed, map.tiles) : null;

  if (map && args.payloadOut) {
    await writeFile(resolveFromRoot(args.payloadOut), `${payload}\n`, "utf8");
  }

  if (map) {
    console.log("[map] loaded", {
      path: map.path,
      seed: seed.toString(),
      ...stats,
      payloadBytes: payload ? (payload.length - 2) / 2 : 0,
    });
  }

  if (args.dryRun) {
    console.log("[dry-run] encoded", {
      payloadBytes: payload ? (payload.length - 2) / 2 : 0,
      payloadPrefix: payload?.slice(0, 66),
      payloadOut: args.payloadOut ? resolveFromRoot(args.payloadOut) : null,
    });
    return;
  }

  const connection = await connect(args);
  try {
    console.log("[connect] account", connection.accountAddress);

    if (args.stateDebug) {
      await printStateDebug(connection.api, programId);
      return;
    }

    if (!map || !payload) {
      throw new Error("map and payload are required");
    }

    if (args.verifyOnly) {
      await printStateDebug(connection.api, programId);
      await verifyMap(
        connection.api,
        sails,
        connection.accountAddress,
        programId,
        map.tiles,
        queryTimeoutMs,
      );
      return;
    }

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
      validatorMode === "slot"
        ? await injected.setSlotValidator()
        : injected.setDefaultValidator();

    console.log("[tx] prepared", {
      destination: injected.destination,
      recipient,
      messageId: injected.messageId,
      txHash: injected.txHash,
      previousStateHash,
      validatorMode,
    });

    const reply = await withTimeout(
      injected.sendAndWaitForPromise(),
      promiseTimeoutMs,
      "injected promise",
    );

    if (reply) {
      const code = normalizeReplyCode(reply.code);
      console.log("[tx] promise", {
        txHash: reply.txHash,
        code,
        reason: reply.code.reason,
        value: reply.value.toString(),
        replyHash: reply.replyHash,
        signature: reply.signature,
      });

      assertSuccessReply(reply.code, sails, reply.payload);

      if (reply.payload !== "0x") {
        console.log("[tx] decoded result", stringify(decodeUploadResult(sails, reply.payload)));
      }
    } else {
      console.warn("[tx] continuing with stateHash polling without injected promise");
    }

    const nextStateHash = await waitForStateHashChange(
      connection.api,
      programId,
      previousStateHash,
      timeoutMs,
    );
    console.log("[state] changed", { previousStateHash, nextStateHash });

    await printStateDebug(connection.api, programId);
    try {
      await verifyMap(
        connection.api,
        sails,
        connection.accountAddress,
        programId,
        map.tiles,
        queryTimeoutMs,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[verify] World.MapSnapshot query failed after upload", message);
    }
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
