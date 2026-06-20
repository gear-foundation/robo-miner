#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  EthereumClient,
  HttpVaraEthProvider,
  InjectedTransaction,
  VaraEthApi,
  WsVaraEthProvider,
  getMirrorClient,
} from "@vara-eth/api";
import { TypeRegistry } from "@polkadot/types/create";
import { createPublicClient, createWalletClient, http, webSocket } from "viem";
import { privateKeyToAccount, nonceManager } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULTS = {
  ETHEREUM_RPC: "wss://hoodi-reth-rpc.gear-tech.io/ws",
  VARA_ETH_RPC: "wss://vara-eth-validator-1.gear-tech.io",
  ROUTER_ADDRESS: "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
};

const MAP_WIDTH = 40;
const MAP_HEIGHT = 64;
const MAP_CELLS = MAP_WIDTH * MAP_HEIGHT;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const STATE_HASH_SELECTOR = "0x701da98e";
const NONCE_SELECTOR = "0xaffed0e0";
const INITIALIZER_SELECTOR = "0x9ce110d7";
const EXITED_SELECTOR = "0x5ce6c327";

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
};

const EXPECTED_RESOURCES = {
  scrst: 77,
  bcrst: 19,
  hcrst: 4,
  total: 100,
};

const EVENT_TYPES = {
  Admin: {
    MapGenerated: "(u64, u64)",
    SessionFinished: "u64",
    SessionStarted: "u64",
  },
};

function printUsage() {
  console.log(`Usage:
  node scripts/digger-upload-map.mjs --file <map.json> --program <programId> [--seed <u64>]

Inputs:
  --file, -f       JSON map file. Accepts an exported preview object with "tiles" or a raw array.
  --program, -p    Existing Digger mirror/program address. Defaults to DIGGER_PROGRAM_ID.
  --seed, -s       Seed to store in session metadata. Defaults to JSON seed, then DIGGER_UPLOAD_SEED, then DIGGER_SEED.
  --injected       Send as a Vara.eth injected transaction instead of an Ethereum Mirror transaction.
  --payload-out    Write the encoded Admin.UploadMap payload hex to a file.
  --verify-only    Do not send; wait until World.MapSnapshot matches the input map.
  --state-debug    Do not send; read Mirror stateHash and program_readState(stateHash).
  --dry-run        Validate and print the payload summary without sending a transaction.

Environment:
  PRIVATE_KEY      Admin private key. Required unless --dry-run is used.
  ETHEREUM_RPC     Defaults to Hoodi websocket RPC.
  VARA_ETH_RPC     Defaults to Vara.eth validator websocket RPC.
  ROUTER_ADDRESS   Defaults to current Hoodi Router.
  DIGGER_MAP_FILE  Alternative to --file.
`);
}

function parseArgs(argv) {
  const args = {};
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
      case "--payload-out":
        args.payloadOut = next();
        break;
      case "--verify-only":
        args.verifyOnly = true;
        break;
      case "--state-debug":
        args.stateDebug = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--injected":
        args.injected = true;
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

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function envAny(names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name];
    }
  }
  for (const name of names) {
    if (DEFAULTS[name]) {
      return DEFAULTS[name];
    }
  }
  return "";
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function normalizeHex(value) {
  if (typeof value !== "string") {
    throw new Error(`Expected hex string, got ${typeof value}`);
  }
  return value.startsWith("0x") ? value.toLowerCase() : `0x${value.toLowerCase()}`;
}

function normalizeAddress(value) {
  const hex = normalizeHex(value);
  if (hex.length === 66) {
    return `0x${hex.slice(26)}`;
  }
  if (hex.length !== 42 || !/^0x[0-9a-f]+$/.test(hex)) {
    throw new Error("address must be 20-byte or 32-byte hex");
  }
  return hex;
}

function parseU64(value, name) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`Missing ${name}`);
  }
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be decimal u64 or 0x hex`);
  }

  const parsed = BigInt(raw);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${name} is outside u64 range`);
  }
  return parsed;
}

function transportFor(url) {
  return url.startsWith("ws") ? webSocket(url) : http(url);
}

function varaProviderFor(url) {
  const options = { requestTimeout: 60_000 };
  return url.startsWith("ws")
    ? new WsVaraEthProvider(url, options)
    : new HttpVaraEthProvider(url, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((item) => Number(item)));
  }
  if (typeof value === "string") {
    const hex = value.startsWith("0x") ? value.slice(2) : value;
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  if (value && typeof value === "object" && Array.isArray(value.bytes)) {
    return Uint8Array.from(value.bytes.map((item) => Number(item)));
  }
  throw new Error(`Unsupported bytes value: ${JSON.stringify(value)}`);
}

function toHex(value) {
  return `0x${Buffer.from(toBytes(value)).toString("hex")}`;
}

function compactJson(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function decodeAbiUint(hex) {
  return BigInt(normalizeHex(hex)).toString();
}

function decodeAbiAddress(hex) {
  const normalized = normalizeHex(hex);
  return normalizeAddress(`0x${normalized.slice(-40)}`);
}

function decodeAbiBool(hex) {
  return BigInt(normalizeHex(hex)) !== 0n;
}

async function ethCall(publicClient, to, data) {
  return normalizeHex(
    await publicClient.request({
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  );
}

async function readMirrorState(publicClient, programId) {
  const [stateHash, nonce, initializer, exited] = await Promise.all([
    ethCall(publicClient, programId, STATE_HASH_SELECTOR),
    ethCall(publicClient, programId, NONCE_SELECTOR),
    ethCall(publicClient, programId, INITIALIZER_SELECTOR),
    ethCall(publicClient, programId, EXITED_SELECTOR),
  ]);

  return {
    stateHash,
    nonce: decodeAbiUint(nonce),
    initializer: decodeAbiAddress(initializer),
    exited: decodeAbiBool(exited),
  };
}

function getVariant(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    return null;
  }
  return { name: entries[0][0], value: entries[0][1] };
}

class Codec {
  constructor() {
    this.registry = new TypeRegistry();
  }

  create(type, value) {
    return this.registry.createType(type, value);
  }

  encodeCall(service, fn, types = [], args = []) {
    const type = types.length
      ? `(String, String, ${types.join(", ")})`
      : "(String, String)";
    return this.create(type, [service, fn, ...args]).toHex();
  }

  decodeResult(payload, returnType) {
    if (!returnType) {
      return null;
    }

    const data = toBytes(payload);
    try {
      const decoded = this.create(`(String, String, ${returnType})`, data);
      return decoded[2].toJSON();
    } catch (error) {
      try {
        const err = this.create("String", data).toString();
        throw new Error(`program returned error payload: ${err}`);
      } catch (stringError) {
        if (stringError.message.startsWith("program returned error payload:")) {
          throw stringError;
        }
        throw error;
      }
    }
  }

  decodeEvent(payload) {
    const data = toBytes(payload);

    for (const [service, events] of Object.entries(EVENT_TYPES)) {
      for (const [eventName, eventType] of Object.entries(events)) {
        try {
          const decoded = this.create(`(String, String, ${eventType})`, data);
          if (decoded[0].toString() !== service || decoded[1].toString() !== eventName) {
            continue;
          }
          return {
            service,
            event: eventName,
            data: decoded[2].toJSON(),
          };
        } catch {
          // Try the next event shape.
        }
      }
    }

    return null;
  }
}

class NodeEventReader {
  constructor(provider, codec, programId) {
    this.provider = provider;
    this.codec = codec;
    this.programId = normalizeAddress(programId);
    this.blockEvents = new Map();
    this.blockOutcomes = new Map();
    this.printedProgramEvents = new Set();
  }

  async eventsAt(blockHash) {
    const hash = normalizeHex(blockHash);
    if (this.blockEvents.has(hash)) {
      return this.blockEvents.get(hash);
    }

    const events = await this.provider.send("block_events", [hash]);
    this.blockEvents.set(hash, events);
    return events;
  }

  async outcomeAt(blockHash) {
    const hash = normalizeHex(blockHash);
    if (this.blockOutcomes.has(hash)) {
      return this.blockOutcomes.get(hash);
    }

    const outcome = await this.provider.send("block_outcome", [hash]);
    this.blockOutcomes.set(hash, outcome);
    this.printProgramEvents(hash, outcome);
    return outcome;
  }

  async waitFor(label, producer, predicate, timeoutMs) {
    const started = Date.now();
    let lastError;

    while (Date.now() - started < timeoutMs) {
      try {
        const value = await producer();
        const matched = predicate(value);
        if (matched) {
          return matched;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(2_000);
    }

    const suffix = lastError ? ` Last RPC error: ${lastError.message}` : "";
    throw new Error(`Timed out waiting for ${label}.${suffix}`);
  }

  waitForMessageQueued(blockHash, payload, timeoutMs) {
    const wantedPayload = normalizeHex(payload);
    return this.waitFor(
      `MessageQueueingRequested in Vara.eth block_events for ${blockHash}`,
      () => this.eventsAt(blockHash),
      (events) => {
        for (const event of events) {
          const outer = getVariant(event);
          if (outer?.name !== "Mirror") {
            continue;
          }
          const actorId = normalizeAddress(outer.value.actorId);
          if (actorId !== this.programId) {
            continue;
          }

          const mirrorEvent = getVariant(outer.value.event);
          if (mirrorEvent?.name !== "MessageQueueingRequested") {
            continue;
          }

          const data = mirrorEvent.value;
          if (toHex(data.payload).toLowerCase() === wantedPayload) {
            return data;
          }
        }
        return null;
      },
      timeoutMs,
    );
  }

  waitForReply(blockHash, messageId, timeoutMs) {
    const wantedMessageId = normalizeHex(messageId);
    return this.waitFor(
      `program reply in Vara.eth block_outcome for ${blockHash}`,
      () => this.outcomeAt(blockHash),
      (outcome) => {
        for (const item of this.programMessages(outcome)) {
          const reply = item.message.replyDetails || item.message.reply_details;
          const replyTo = reply?.to || reply?.replyTo || reply?.reply_to;
          if (replyTo && normalizeHex(replyTo) === wantedMessageId) {
            return item.message;
          }
        }
        return null;
      },
      timeoutMs,
    );
  }

  programMessages(outcome) {
    const messages = [];
    for (const transition of outcome) {
      const actorId = normalizeAddress(transition.actorId || transition.actor_id);
      if (actorId !== this.programId) {
        continue;
      }
      for (const message of transition.messages || []) {
        messages.push({ actorId, message });
      }
    }
    return messages;
  }

  printProgramEvents(blockHash, outcome) {
    for (const item of this.programMessages(outcome)) {
      const destination = normalizeAddress(item.message.destination);
      if (destination !== ZERO_ADDRESS) {
        continue;
      }

      const payload = toHex(item.message.payload);
      const key = `${normalizeHex(blockHash)}:${payload}`;
      if (this.printedProgramEvents.has(key)) {
        continue;
      }
      this.printedProgramEvents.add(key);

      const decoded = this.codec.decodeEvent(payload);
      if (decoded) {
        console.log(
          `[vara-node:event] ${decoded.service}.${decoded.event} ${compactJson(decoded.data)}`,
        );
      }
    }
  }
}

function normalizeTile(value, index) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`tile ${index} must be an integer number`);
  }
  if (value < 0 || value > 255) {
    throw new Error(`tile ${index} is outside u8 range`);
  }
  return value;
}

function extractTilesAndSeed(json) {
  if (Array.isArray(json)) {
    return { tiles: json, seed: null };
  }

  if (!json || typeof json !== "object") {
    throw new Error("map JSON must be an array or an object with a tiles array");
  }

  if (json.width !== undefined && Number(json.width) !== MAP_WIDTH) {
    throw new Error(`map width must be ${MAP_WIDTH}`);
  }
  if (json.height !== undefined && Number(json.height) !== MAP_HEIGHT) {
    throw new Error(`map height must be ${MAP_HEIGHT}`);
  }

  const tiles = json.tiles ?? json.map ?? json.cells;
  if (!Array.isArray(tiles)) {
    throw new Error("map JSON object must contain tiles, map, or cells array");
  }

  return {
    tiles,
    seed: json.seed == null ? null : String(json.seed),
  };
}

async function readMapFile(filePath) {
  const absolutePath = path.resolve(ROOT, filePath);
  const json = JSON.parse(await readFile(absolutePath, "utf8"));
  const { tiles, seed } = extractTilesAndSeed(json);
  const normalized = tiles.map(normalizeTile);
  return { path: absolutePath, tiles: normalized, seed };
}

function validateMap(tiles) {
  if (tiles.length !== MAP_CELLS) {
    throw new Error(`map must contain ${MAP_CELLS} cells, got ${tiles.length}`);
  }

  const counts = new Map();
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (!Object.values(TILE).includes(tile)) {
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

  return { counts, scrst, bcrst, hcrst, total, chest: counts.get(TILE.Chest) ?? 0 };
}

function sameMap(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < b.length; i += 1) {
    if (Number(a[i]) !== b[i]) {
      return false;
    }
  }
  return true;
}

async function sendAndRequire(tx, label) {
  const receipt = await tx.sendAndWaitForReceipt();
  console.log(`[eth:tx] ${label}: ${receipt.transactionHash} ${receipt.status}`);
  if (receipt.status !== "success") {
    throw new Error(`${label} transaction failed`);
  }
  return receipt;
}

async function waitForProgramVisible(api, programId, timeoutMs) {
  const started = Date.now();
  const wanted = normalizeAddress(programId);

  while (Date.now() - started < timeoutMs) {
    const ids = await api.query.program.getIds();
    if (ids.map(normalizeAddress).includes(wanted)) {
      return;
    }
    await sleep(3_000);
  }

  throw new Error(`Timed out waiting for program ${programId} in program_ids`);
}

async function queryProgram(api, codec, accountAddress, programId, payload, returnType) {
  const reply = await api.call.program.calculateReplyForHandle(
    accountAddress,
    programId,
    payload,
    0n,
  );
  return codec.decodeResult(reply.payload, returnType);
}

function injectedReplyField(reply, ...names) {
  for (const name of names) {
    if (reply && reply[name] !== undefined && reply[name] !== null) {
      return reply[name];
    }
  }
  return null;
}

function formatReplyCode(reply) {
  const code = injectedReplyField(reply, "code", "replyCode", "reply_code");
  if (code === null) {
    return "unknown";
  }
  if (typeof code === "string") {
    return normalizeHex(code);
  }
  return toHex(code);
}

function queueSize(queue) {
  if (queue && typeof queue === "object" && "cached_queue_size" in queue) {
    return String(queue.cached_queue_size);
  }
  return "0";
}

function hashField(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    if (typeof value.hash === "string") {
      return value.hash;
    }
    const variant = getVariant(value);
    if (variant?.value) {
      return hashField(variant.value);
    }
  }
  return "";
}

function field(value, snakeName, camelName) {
  return value?.[snakeName] ?? value?.[camelName];
}

function summarizeProgram(program) {
  const variant = getVariant(program);
  if (!variant) {
    return { kind: "Unknown", initialized: "n/a" };
  }
  const active = variant.value && typeof variant.value === "object" ? variant.value : {};
  const initialized =
    "initialized" in active
      ? String(Boolean(active.initialized))
      : "n/a";
  return {
    kind: variant.name,
    initialized,
    allocationsHash: hashField(field(active, "allocations_hash", "allocationsHash")),
    pagesHash: hashField(field(active, "pages_hash", "pagesHash")),
    memoryInfix: field(active, "memory_infix", "memoryInfix"),
  };
}

async function printStateDebug(provider, publicClient, programId) {
  const mirrorState = await readMirrorState(publicClient, programId);
  console.log(`[mirror] stateHash=${mirrorState.stateHash}`);
  console.log(`[mirror] nonce=${mirrorState.nonce}`);
  console.log(`[mirror] initializer=${mirrorState.initializer}`);
  console.log(`[mirror] exited=${mirrorState.exited}`);

  const programState = await provider.send("program_readState", [mirrorState.stateHash]);
  const program = summarizeProgram(programState.program);
  const canonicalQueue = field(programState, "canonical_queue", "canonicalQueue");
  const injectedQueue = field(programState, "injected_queue", "injectedQueue");
  console.log(`[state] program=${program.kind} initialized=${program.initialized}`);
  console.log(`[state] allocationsHash=${program.allocationsHash || "n/a"}`);
  console.log(`[state] pagesHash=${program.pagesHash || "n/a"}`);
  console.log(`[state] memoryInfix=${program.memoryInfix ?? "n/a"}`);
  console.log(`[state] balance=${programState.balance ?? "n/a"}`);
  console.log(
    `[state] executableBalance=${field(programState, "executable_balance", "executableBalance") ?? "n/a"}`,
  );
  console.log(
    `[state] canonicalQueue=${queueSize(canonicalQueue)} injectedQueue=${queueSize(injectedQueue)}`,
  );
  console.log(`[state] canonicalQueueHash=${hashField(canonicalQueue) || "n/a"}`);
  console.log(`[state] injectedQueueHash=${hashField(injectedQueue) || "n/a"}`);
  console.log(`[state] waitlistHash=${hashField(field(programState, "waitlist_hash", "waitlistHash")) || "n/a"}`);
  console.log(`[state] stashHash=${hashField(field(programState, "stash_hash", "stashHash")) || "n/a"}`);
  console.log(`[state] mailboxHash=${hashField(field(programState, "mailbox_hash", "mailboxHash")) || "n/a"}`);
  return { mirrorState, programState };
}

function isMethodNotFound(error) {
  return /method not found/i.test(error?.message ?? "");
}

function normalizeInjectedPromise(result) {
  const data = result?.data ?? result;
  const txHash = data?.txHash?.hash ?? data?.txHash ?? result?.txHash;
  const reply = data?.reply ?? result?.reply;
  return {
    txHash,
    reply,
    signature: result?.signature,
    raw: result,
  };
}

function injectedRpcData(injected) {
  return injected._rpcData.map((item) => {
    const tx = { ...item.tx };
    if (tx.public_key && !tx.address) {
      tx.address = tx.public_key;
    }
    delete tx.public_key;
    return { ...item, tx };
  });
}

function ensureInjectedAccepted(acceptance) {
  const variant = getVariant(acceptance);
  if (acceptance === "Accept" || variant?.name === "Accept") {
    return;
  }
  if (variant?.name === "Reject") {
    throw new Error(`injected transaction rejected: ${compactJson(variant.value)}`);
  }
  if (typeof acceptance === "string") {
    throw new Error(`unexpected injected acceptance: ${acceptance}`);
  }
}

async function subscribeInjectedPromise(provider, parameters) {
  const subscriptions = [
    {
      subscribe: "injected_subscribeSendTransactionAndWatch",
      unsubscribe: "injected_unsubscribeSendTransactionAndWatch",
    },
    {
      subscribe: "injected_subscribeTransactionPromise",
      unsubscribe: "injected_unsubscribeTransactionPromise",
    },
  ];
  let lastError;

  for (const subscription of subscriptions) {
    try {
      return await new Promise((resolve, reject) => {
        let unsubscribe;
        let done = false;
        const finish = (fn, value) => {
          if (done) {
            return;
          }
          done = true;
          unsubscribe?.();
          fn(value);
        };

        provider
          .subscribe(
            subscription.subscribe,
            subscription.unsubscribe,
            parameters,
            (error, result) => {
              if (error) {
                finish(reject, error);
              } else {
                finish(resolve, result);
              }
            },
          )
          .then((unsubscribeFn) => {
            unsubscribe = unsubscribeFn;
          })
          .catch((error) => finish(reject, error));
      });
    } catch (error) {
      lastError = error;
      if (!isMethodNotFound(error)) {
        throw error;
      }
      console.log(`[injected] ${subscription.subscribe} is unavailable; trying fallback`);
    }
  }

  throw lastError;
}

async function sendInjectedUpload(api, codec, accountAddress, programId, payload, expectedMap, timeoutMs) {
  const tx = new InjectedTransaction({
    destination: programId,
    payload,
    value: 0n,
  });
  const injected = await api.createInjectedTransaction(tx);
  console.log(`[injected] message=${normalizeHex(tx.messageId)}`);

  if (!tx.recipient) {
    await injected.setRecipient();
  }
  await injected._sign();
  const rpcData = injectedRpcData(injected);

  try {
    const promise = normalizeInjectedPromise(
      await subscribeInjectedPromise(api.provider, rpcData),
    );
    const reply = promise.reply || {};
    const replyPayload = injectedReplyField(reply, "payload");
    if (!replyPayload) {
      throw new Error(`injected promise returned no reply payload: ${compactJson(promise.raw)}`);
    }

    const session = codec.decodeResult(replyPayload, "Vec<u128>");
    console.log(`[injected] tx=${normalizeHex(promise.txHash)} replyCode=${formatReplyCode(reply)}`);
    console.log(`[reply] Admin.UploadMap session=${compactJson(session)}`);
  } catch (error) {
    if (!isMethodNotFound(error)) {
      throw error;
    }

    console.log("[injected] promise subscription is unavailable; sending and polling state");
    const acceptance = await api.provider.send("injected_sendTransaction", rpcData);
    ensureInjectedAccepted(acceptance);
    console.log(`[injected] acceptance=${compactJson(acceptance)}`);
  }

  await waitForUploadedMap(
    api,
    codec,
    accountAddress,
    programId,
    expectedMap,
    timeoutMs,
  );
  console.log("[verify] World.MapSnapshot matches uploaded map");
}

async function waitForUploadedMap(api, codec, accountAddress, programId, expectedMap, timeoutMs) {
  const payload = codec.encodeCall("World", "MapSnapshot");
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const map = await queryProgram(api, codec, accountAddress, programId, payload, "Vec<u32>");
      if (sameMap(map, expectedMap)) {
        return map;
      }
      lastError = new Error("latest map snapshot does not match uploaded map yet");
    } catch (error) {
      lastError = error;
    }
    await sleep(3_000);
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for uploaded map to be visible.${suffix}`);
}

let activeProvider = null;

async function main() {
  loadDotEnv(path.join(ROOT, ".env"));
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const mapFile = requireValue(args.file || process.env.DIGGER_MAP_FILE, "--file or DIGGER_MAP_FILE");
  const mapInput = await readMapFile(mapFile);
  const stats = validateMap(mapInput.tiles);
  const seedValue =
    args.seed ??
    mapInput.seed ??
    process.env.DIGGER_UPLOAD_SEED ??
    process.env.DIGGER_SEED;
  const seed = parseU64(seedValue, "--seed or map JSON seed");

  const programId = normalizeAddress(
    requireValue(args.program || process.env.DIGGER_PROGRAM_ID, "--program or DIGGER_PROGRAM_ID"),
  );

  const codec = new Codec();
  const payload = codec.encodeCall(
    "Admin",
    "UploadMap",
    ["u64", "Vec<u32>"],
    [seed, mapInput.tiles],
  );

  console.log(`[map] file=${mapInput.path}`);
  console.log(
    `[map] cells=${mapInput.tiles.length} resources=${stats.total} SCRST=${stats.scrst} BCRST=${stats.bcrst} HCRST=${stats.hcrst} chests=${stats.chest}`,
  );
  console.log(`[map] seed=${seed.toString()} program=${programId}`);
  console.log(`[payload] bytes=${(payload.length - 2) / 2}`);

  if (args.payloadOut) {
    const payloadPath = path.resolve(ROOT, args.payloadOut);
    await writeFile(payloadPath, `${payload}\n`, { mode: 0o600 });
    console.log(`[payload] wrote=${payloadPath}`);
  }

  if (args.dryRun) {
    console.log("[dry-run] map is valid; transaction was not sent");
    return;
  }

  const privateKey = normalizeHex(
    requireValue(args.privateKey || process.env.PRIVATE_KEY || process.env.TESTNET_PRIVATE_KEY, "PRIVATE_KEY"),
  );
  const ethRpc = args.ethRpc || envAny(["ETHEREUM_RPC", "TESTNET_ETHEREUM_RPC"]);
  const varaRpc = args.varaRpc || envAny(["VARA_ETH_RPC", "TESTNET_VARA_ETH_RPC"]);
  const routerAddress = args.router || envAny(["ROUTER_ADDRESS", "TESTNET_ROUTER_ADDRESS"]);
  const timeoutMs = Number(args.timeoutMs || envAny(["DIGGER_EVENT_TIMEOUT_MS"]));

  const account = privateKeyToAccount(privateKey, { nonceManager });
  const publicClient = createPublicClient({ transport: transportFor(ethRpc) });
  const walletClient = createWalletClient({
    account,
    transport: transportFor(ethRpc),
  });
  const ethereumClient = new EthereumClient(publicClient, walletClient);
  const provider = varaProviderFor(varaRpc);
  activeProvider = provider;
  const api = new VaraEthApi(provider, ethereumClient, routerAddress);
  const reader = new NodeEventReader(provider, codec, programId);
  const mirror = getMirrorClient(programId, ethereumClient);
  const useInjected =
    args.injected ||
    process.env.DIGGER_UPLOAD_MODE === "injected" ||
    process.env.DIGGER_INJECTED === "1";

  console.log(`[config] eth=${ethRpc}`);
  console.log(`[config] vara=${varaRpc}`);
  console.log(`[config] sender=${ethereumClient.accountAddress}`);
  console.log(`[mode] ${useInjected ? "injected" : "mirror"}`);

  if (args.stateDebug) {
    await printStateDebug(provider, publicClient, programId);
    await provider.disconnect?.();
    activeProvider = null;
    return;
  }

  if (args.verifyOnly) {
    await waitForUploadedMap(
      api,
      codec,
      ethereumClient.accountAddress,
      programId,
      mapInput.tiles,
      timeoutMs,
    );
    console.log("[verify] World.MapSnapshot matches uploaded map");
    await provider.disconnect?.();
    activeProvider = null;
    return;
  }

  if (useInjected) {
    await sendInjectedUpload(
      api,
      codec,
      ethereumClient.accountAddress,
      programId,
      payload,
      mapInput.tiles,
      timeoutMs,
    );
    await provider.disconnect?.();
    activeProvider = null;
    return;
  }

  await waitForProgramVisible(api, programId, timeoutMs);

  const tx = await mirror.sendMessage(payload, 0n);
  const receipt = await sendAndRequire(tx, "Admin.UploadMap");
  const queued = await reader.waitForMessageQueued(receipt.blockHash, payload, timeoutMs);
  console.log(`[vara-node:queue] message=${normalizeHex(queued.id)}`);

  const reply = await reader.waitForReply(receipt.blockHash, queued.id, timeoutMs);
  const session = codec.decodeResult(reply.payload, "Vec<u128>");
  console.log(`[reply] Admin.UploadMap session=${compactJson(session)}`);

  await waitForUploadedMap(
    api,
    codec,
    ethereumClient.accountAddress,
    programId,
    mapInput.tiles,
    timeoutMs,
  );
  console.log("[verify] World.MapSnapshot matches uploaded map");

  await provider.disconnect?.();
  activeProvider = null;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    if (activeProvider) {
      await activeProvider.disconnect?.().catch(() => {});
    }
    console.error(`[error] ${error.stack || error.message}`);
    process.exit(1);
  });
