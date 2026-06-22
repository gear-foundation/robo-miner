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
  ETHEREUM_RPC: "https://mainnet-reth-rpc.gear-tech.io",
  VARA_ETH_RPC: "wss://validator-1-eth.vara.network",
  ROUTER_ADDRESS: "0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
  DIGGER_PROMISE_TIMEOUT_MS: "60000",
  DIGGER_QUERY_TIMEOUT_MS: "30000",
  DIGGER_TOP_UP: "100000000000000",
  DIGGER_VALIDATOR_MODE: "default",
} as const;

const IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const WASM_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.opt.wasm");
const ENV_PATH = path.join(ROOT, ".env");
const MAP_WIDTH = 40;
const MAP_HEIGHT = 64;
const MAP_CELLS = MAP_WIDTH * MAP_HEIGHT;

const TILE = {
  Empty: 0,
  Dirt: 1,
  Stone: 2,
  Chest: 3,
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
  program?: string;
  codeId?: string;
  codeIdFromWasm?: boolean;
  fromProgram?: string;
  file?: string;
  wasm?: string;
  seed?: string;
  topUp?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  noUpload?: boolean;
  noWriteEnv?: boolean;
  dryRun?: boolean;
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
  pnpm reload-program
  pnpm reload-program -- --program <newMirrorCreatedEarlier>
  pnpm reload-program -- --from-program <oldMirror> --file <map.json>

Flow:
  1. Resolve codeId from --code-id, DIGGER_CODE_ID, or router.programCodeId(old DIGGER_PROGRAM_ID).
  2. Create a new Digger mirror with initial executable balance.
  3. Send Create() to initialize the program shell.
  4. Upload the configured map via injected transaction.
  5. Update DIGGER_PROGRAM_ID in .env unless --no-write-env is set.

Inputs:
  --program          Existing uninitialized/new mirror to resume instead of creating a new one.
  --code-id          Validated Digger wasm code id. Defaults to DIGGER_CODE_ID.
  --code-id-from-wasm
                     Resolve code id from --wasm/current release wasm instead of an existing program.
  --from-program     Existing mirror used only to discover code id. Defaults to DIGGER_PROGRAM_ID.
  --file, -f         Map JSON file. Defaults to DIGGER_MAP_FILE.
  --wasm             Wasm artifact used only if code validation is needed.
  --seed, -s         Upload seed. Defaults to map seed, then DIGGER_SEED.
  --top-up           Initial executable balance. Defaults to DIGGER_TOP_UP or ${DEFAULTS.DIGGER_TOP_UP}.
  --validator        "default" or "slot". Defaults to DIGGER_VALIDATOR_MODE/default.
  --no-upload        Only create and initialize the new program.
  --no-write-env     Do not replace DIGGER_PROGRAM_ID in .env.
  --dry-run          Resolve inputs and print what would be done without sending txs.

Environment:
  PRIVATE_KEY        Admin private key.
  ETHEREUM_RPC       Ethereum mainnet RPC. WebSocket is recommended.
  VARA_ETH_RPC       Vara.eth validator RPC.
  ROUTER_ADDRESS     Vara.eth Router contract address.
  DIGGER_PROGRAM_ID  Existing Digger mirror address.
  DIGGER_MAP_FILE    Alternative to --file.
  DIGGER_SEED        Fallback seed.
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
      case "--code-id":
        args.codeId = next();
        break;
      case "--code-id-from-wasm":
        args.codeIdFromWasm = true;
        break;
      case "--program":
      case "-p":
        args.program = next();
        break;
      case "--from-program":
        args.fromProgram = next();
        break;
      case "--file":
      case "-f":
        args.file = next();
        break;
      case "--wasm":
        args.wasm = next();
        break;
      case "--seed":
      case "-s":
        args.seed = next();
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
      case "--no-upload":
        args.noUpload = true;
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
    if (value) {
      return value;
    }
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

function normalizeHex32(value: string, name: string): Hex {
  const hex = normalizeHex(value, name);
  if (hex.length !== 66) {
    throw new Error(`${name} must be 32-byte hex`);
  }
  return hex;
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

function parseAmount(value: string, name: string): bigint {
  const raw = value.trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a decimal bigint amount`);
  }
  const parsed = BigInt(raw);
  if (parsed < 0n) {
    throw new Error(`${name} must not be negative`);
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
    chest: counts.get(TILE.Chest) ?? 0,
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

function encodeCreatePayload(sails: SailsProgram): Hex {
  const ctor = sails.ctors?.Create;
  if (!ctor) {
    throw new Error("IDL does not contain DiggerWorld.Create constructor");
  }
  return ctor.encodePayload() as Hex;
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
  const ethRpc = valueOrDefault(
    ["ETHEREUM_RPC", "DIGGER_ETH_RPC"],
    "ETHEREUM_RPC",
    args.ethRpc,
  );
  const varaRpc = valueOrDefault(
    ["VARA_ETH_RPC", "DIGGER_VALIDATOR_RPC"],
    "VARA_ETH_RPC",
    args.varaRpc,
  );
  const router = normalizeAddress(
    valueOrDefault(["ROUTER_ADDRESS", "DIGGER_ROUTER_ADDRESS"], "ROUTER_ADDRESS", args.router),
    "ROUTER_ADDRESS",
  );
  const timeoutMs = Number(valueOrDefault(["DIGGER_EVENT_TIMEOUT_MS"], "DIGGER_EVENT_TIMEOUT_MS", args.timeoutMs));

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

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
    if (state === expected) {
      return state;
    }
    await sleep(5_000);
  }

  const state = await api.eth.router.codeState(codeId);
  throw new Error(
    `Timed out waiting for code ${codeId} to become ${codeStateName(expected)}; current=${codeStateName(state)}`,
  );
}

async function resolveCodeId(api: VaraEthApi, args: CliArgs): Promise<Hex> {
  const explicit = args.codeId || envValue("DIGGER_CODE_ID");
  if (explicit) {
    return normalizeHex32(explicit, "DIGGER_CODE_ID");
  }

  if (args.codeIdFromWasm) {
    const wasmPath = resolveFromRoot(args.wasm || WASM_PATH);
    if (!existsSync(wasmPath)) {
      throw new Error(`Wasm artifact does not exist: ${wasmPath}`);
    }
    const wasm = new Uint8Array(await readFile(wasmPath));
    const codeId = generateCodeHash(wasm);
    console.log("[code] resolved from wasm", { wasmPath, codeId });
    return normalizeHex32(codeId, "wasm code hash");
  }

  const fromProgram = normalizeAddress(
    requireValue(args.fromProgram || envValue("DIGGER_PROGRAM_ID"), "--from-program or DIGGER_PROGRAM_ID"),
    "DIGGER_PROGRAM_ID",
  );
  const codeId = await api.eth.router.programCodeId(fromProgram);
  console.log("[code] resolved from existing program", { fromProgram, codeId });
  return normalizeHex32(codeId, "router.programCodeId");
}

async function ensureCodeValidated(
  api: VaraEthApi,
  codeId: Hex,
  args: CliArgs,
  timeoutMs: number,
): Promise<Hex> {
  const state = await api.eth.router.codeState(codeId);
  console.log("[code] state", { codeId, state: codeStateName(state) });

  if (state === CodeState.Validated) {
    return codeId;
  }

  if (state === CodeState.ValidationRequested) {
    await waitForCodeState(api, codeId, CodeState.Validated, timeoutMs);
    return codeId;
  }

  const wasmPath = resolveFromRoot(args.wasm || WASM_PATH);
  if (!existsSync(wasmPath)) {
    throw new Error(`Code is not validated and wasm artifact does not exist: ${wasmPath}`);
  }

  const wasm = new Uint8Array(await readFile(wasmPath));
  const [baseFee, extraFee, accountAddress] = await Promise.all([
    api.eth.router.requestCodeValidationBaseFee(),
    api.eth.router.requestCodeValidationExtraFee(),
    api.eth.signer.getAddress(),
  ]);
  const validationFee = baseFee + extraFee;
  const balance = await api.eth.wvara.balanceOf(accountAddress);

  if (balance < validationFee) {
    throw new Error(
      `Not enough WVARA for code validation: need ${validationFee.toString()}, balance ${balance.toString()}`,
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
  const { signature } = await api.eth.wvara.prepareAndSignPermitData(
    api.eth.router.address,
    validationFee,
    deadline,
  );
  const tx = await api.eth.router.requestCodeValidation(wasm, deadline, signature);
  console.log("[code] requesting validation", {
    wasmPath,
    codeId: tx.codeId,
    validationFee: validationFee.toString(),
    baseFee: baseFee.toString(),
    extraFee: extraFee.toString(),
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

async function readStateSummary(api: VaraEthApi, programId: Address, timeoutMs = 30_000) {
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
      const state = await api.query.program.readState(stateHash);
      return {
        stateHash,
        summary: summarizeState(state),
      };
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out reading state summary for ${programId}; lastStateHash=${lastStateHash}; ${message}`);
}

async function waitForProgramVisible(
  api: VaraEthApi,
  programId: Address,
  timeoutMs: number,
) {
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
        // A just-created mirror can expose a stateHash before the RPC can read it.
      }
    }

    await sleep(2_000);
  }

  throw new Error(`Timed out waiting for program ${programId} to become visible; lastStateHash=${lastStateHash}`);
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

  if (reply) {
    console.log(`[${label}] reply`, {
      txHash: reply.txHash,
      code: reply.replyCode,
      value: reply.value.toString(),
      blockNumber: reply.blockNumber,
    });
    assertSuccessReply(reply.replyCode, sails, reply.payload);
  } else {
    console.warn(`[${label}] continuing with stateHash polling without mirror reply`);
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

  if (reply) {
    console.log(`[${label}] promise`, {
      txHash: reply.txHash,
      code: normalizeReplyCode(reply.code),
      reason: reply.code.reason,
      value: reply.value.toString(),
      replyHash: reply.replyHash,
    });
    assertSuccessReply(reply.code, sails, reply.payload);
  } else {
    console.warn(`[${label}] continuing with stateHash polling without injected promise`);
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

async function verifyMapSnapshot(
  api: VaraEthApi,
  sails: SailsProgram,
  accountAddress: Address,
  programId: Address,
  expectedTiles: number[],
  queryTimeoutMs: number,
) {
  const queryPayload = encodeMapSnapshotPayload(sails);
  const queryReply = await withTimeout(
    api.call.program.calculateReplyForHandle(
      accountAddress,
      programId,
      queryPayload,
      0n,
    ),
    queryTimeoutMs,
    "World.MapSnapshot calculateReplyForHandle",
  );

  if (!queryReply) {
    throw new Error("World.MapSnapshot calculateReplyForHandle did not return");
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

async function updateEnvProgramId(programId: Address) {
  const existing = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
  const next = existing.match(/^DIGGER_PROGRAM_ID=.*$/m)
    ? existing.replace(/^DIGGER_PROGRAM_ID=.*$/m, `DIGGER_PROGRAM_ID=${programId}`)
    : `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}DIGGER_PROGRAM_ID=${programId}\n`;

  if (next !== existing) {
    await writeFile(ENV_PATH, next, "utf8");
  }
  console.log("[env] updated DIGGER_PROGRAM_ID in .env", { programId });
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
    args.topUp || envValue("DIGGER_TOP_UP") || DEFAULTS.DIGGER_TOP_UP,
    "DIGGER_TOP_UP",
  );

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

  const mapFile = args.noUpload ? undefined : args.file || envValue("DIGGER_MAP_FILE");
  const map = args.noUpload ? null : await readMapFile(requireValue(mapFile, "DIGGER_MAP_FILE"));
  const stats = map ? validateMap(map.tiles) : null;
  const seed = parseU64(args.seed || map?.seed || envValue("DIGGER_SEED") || "0", "DIGGER_SEED");
  const sails = await loadSails();
  const createPayload = encodeCreatePayload(sails);
  const uploadPayload = map ? encodeUploadPayload(sails, seed, map.tiles) : null;

  console.log("[reload] prepared", {
    seed: seed.toString(),
    topUp: topUp.toString(),
    validatorMode,
    map: map ? { path: map.path, ...stats } : null,
    createPayloadBytes: (createPayload.length - 2) / 2,
    uploadPayloadBytes: uploadPayload ? (uploadPayload.length - 2) / 2 : null,
    writeEnv: !args.noWriteEnv,
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    return;
  }

  const connection = await connect(args);
  try {
    console.log("[connect] account", connection.accountAddress);

    let codeId: Hex | null = null;
    const programId = args.program
      ? normalizeAddress(args.program, "--program")
      : await (async () => {
          const resolvedCodeId = await ensureCodeValidated(
            connection.api,
            await resolveCodeId(connection.api, args),
            args,
            timeoutMs,
          );
          codeId = resolvedCodeId;
          return createProgram(connection.api, resolvedCodeId, topUp);
        })();

    if (args.program) {
      codeId = normalizeHex32(
        await connection.api.eth.router.programCodeId(programId),
        "router.programCodeId",
      );
      console.log("[code] resolved from resume program", { programId, codeId });
    }

    await waitForProgramVisible(connection.api, programId, timeoutMs);

    const beforeInit = await readStateSummary(connection.api, programId);
    if (beforeInit.summary.initialized === true) {
      console.log("[init] skipped; program is already initialized", {
        programId,
        stateHash: beforeInit.stateHash,
      });
    } else {
      await sendMirrorMessage(
        connection.api,
        programId,
        "init",
        createPayload,
        promiseTimeoutMs,
        timeoutMs,
        sails,
      );
    }

    const afterInit = await readStateSummary(connection.api, programId);
    if (afterInit.summary.initialized !== true) {
      throw new Error(
        `Program is not initialized after init; stateHash=${afterInit.stateHash}`,
      );
    }

    if (map && uploadPayload) {
      const uploadReply = await sendInjectedMessage(
        connection.api,
        programId,
        "upload",
        uploadPayload,
        validatorMode,
        promiseTimeoutMs,
        timeoutMs,
        sails,
      );
      if (uploadReply?.payload && uploadReply.payload !== "0x") {
        console.log("[upload] decoded result", stringify(decodeUploadResult(sails, uploadReply.payload)));
      }
    }

    await printStateDebug(connection.api, programId);

    if (map) {
      try {
        await verifyMapSnapshot(
          connection.api,
          sails,
          connection.accountAddress,
          programId,
          map.tiles,
          queryTimeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[verify] World.MapSnapshot query failed after reload", message);
      }
    }

    if (!args.noWriteEnv) {
      await updateEnvProgramId(programId);
    }

    console.log("[reload] complete", { programId, codeId });
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
