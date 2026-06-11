#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CodeState,
  EthereumClient,
  HttpVaraEthProvider,
  VaraEthApi,
  WsVaraEthProvider,
  getMirrorClient,
  getWrappedVaraClient,
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
  DIGGER_SEED: "42",
  DIGGER_TOP_UP: "100000000000000",
  DIGGER_MAX_DEPTH: "10",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
};

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
};

const DIR = {
  Up: 0,
  Right: 1,
  Down: 2,
  Left: 3,
  Current: 4,
};

const WIDTH = 40;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WASM_PATH = path.join(
  ROOT,
  "target/wasm32-gear/release/digger_world.wasm",
);

const EVENT_TYPES = {
  Admin: {
    MapGenerated: "(u64, u64)",
    SessionFinished: "u64",
    SessionStarted: "u64",
  },
  World: {
    AgentDied: "(u64, [u8; 32], u32, u32, u32)",
    AgentExited: "(u64, [u8; 32])",
    AgentMoved: "(u64, [u8; 32], u32, u32, u32, u32)",
    AgentRegistered: "(u64, [u8; 32])",
    AgentSpawned: "(u64, [u8; 32], u32, u32)",
    AgentSurfaced: "(u64, [u8; 32], u32, u32, u32)",
    LadderPlaced: "(u64, [u8; 32], u32, u32, u32)",
    ResourceExtracted: "(u64, [u8; 32], u32, u32, u32, u32)",
    ResourcesMinted: "(u64, [u8; 32], u32, u32, u32)",
    StoneMoved: "(u64, [u8; 32], u32, u32, u32, u32)",
    TileDrilled: "(u64, [u8; 32], u32, u32, u32, u32)",
  },
};

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

function env(name) {
  return process.env[name] || DEFAULTS[name] || "";
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

function requiredEnv(name, aliases = []) {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value) {
      return value;
    }
  }
  throw new Error(
    `Missing ${name}. Create .env from .env.example or export it before running.`,
  );
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
  return hex;
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

function actorIdBytesFromAddress(address) {
  const bytes = Buffer.from(normalizeAddress(address).slice(2), "hex");
  if (bytes.length !== 20) {
    throw new Error(`Expected 20-byte address, got ${bytes.length} bytes`);
  }

  const actor = new Uint8Array(32);
  actor.set(bytes, 12);
  return actor;
}

function compactJson(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
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

  encodeCtor(name, types, args) {
    const type = types.length ? `(String, ${types.join(", ")})` : "String";
    const value = types.length ? [name, ...args] : name;
    return this.create(type, value).toHex();
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
          const decoded = this.create(
            `(String, String, ${eventType})`,
            data,
          );
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

  setProgramId(programId) {
    this.programId = normalizeAddress(programId);
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

  waitForProgramCreated(blockHash, codeId, timeoutMs) {
    const wantedCodeId = normalizeHex(codeId);
    return this.waitFor(
      `ProgramCreated in Vara.eth block_events for ${blockHash}`,
      () => this.eventsAt(blockHash),
      (events) => {
        for (const event of events) {
          const outer = getVariant(event);
          if (outer?.name !== "Router") {
            continue;
          }
          const routerEvent = getVariant(outer.value);
          if (routerEvent?.name !== "ProgramCreated") {
            continue;
          }
          const data = routerEvent.value;
          if (normalizeHex(data.codeId) === wantedCodeId) {
            return normalizeAddress(data.actorId);
          }
        }
        return null;
      },
      timeoutMs,
    );
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
      } else {
        console.log(`[vara-node:event] undecoded ${payload}`);
      }
    }
  }
}

function agentFromView(view) {
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

function carried(agent) {
  return agent.invScrst + agent.invBcrst + agent.invHcrst;
}

function tileAt(map, x, y) {
  return Number(map[y * WIDTH + x]);
}

function isResource(tile) {
  return tile === TILE.Scrst || tile === TILE.Bcrst || tile === TILE.Hcrst;
}

function isOpen(tile) {
  return tile === TILE.Empty || tile === TILE.Surface || tile === TILE.Ladder;
}

function isMineable(tile) {
  return (
    tile === TILE.Dirt ||
    tile === TILE.Stone ||
    tile === TILE.Scrst ||
    tile === TILE.Bcrst ||
    tile === TILE.Hcrst
  );
}

function findTargetResource(map, startX, maxDepth) {
  const candidates = [];
  const maxY = Math.min(maxDepth, 63);

  for (let y = 1; y <= maxY; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (!isResource(tileAt(map, x, y))) {
        continue;
      }
      if (!pathAvoidsLava(map, startX, x, y)) {
        continue;
      }
      candidates.push({ x, y, distance: y + Math.abs(x - startX) });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y);
  return candidates[0] || null;
}

function pathAvoidsLava(map, startX, targetX, targetY) {
  for (let y = 1; y <= targetY; y += 1) {
    if (tileAt(map, startX, y) === TILE.Lava) {
      return false;
    }
  }

  const step = targetX >= startX ? 1 : -1;
  for (let x = startX; x !== targetX + step; x += step) {
    if (tileAt(map, x, targetY) === TILE.Lava) {
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

async function waitForCodeValidated(router, codeId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await router.codeState(codeId);
    if (state === CodeState.Validated) {
      return;
    }
    console.log(`[eth:router] code ${codeId} state: ${CodeState[state]}`);
    await sleep(5_000);
  }
  throw new Error(`Timed out waiting for code ${codeId} validation`);
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

let activeProvider = null;

async function main() {
  loadDotEnv(path.join(ROOT, ".env"));

  const privateKey = requiredEnv("PRIVATE_KEY", ["TESTNET_PRIVATE_KEY"]);
  const ethRpc = envAny(["ETHEREUM_RPC", "TESTNET_ETHEREUM_RPC"]);
  const varaRpc = envAny(["VARA_ETH_RPC", "TESTNET_VARA_ETH_RPC"]);
  const routerAddress = envAny(["ROUTER_ADDRESS", "TESTNET_ROUTER_ADDRESS"]);
  const seed = BigInt(env("DIGGER_SEED"));
  const topUp = BigInt(env("DIGGER_TOP_UP"));
  const eventTimeoutMs = Number(env("DIGGER_EVENT_TIMEOUT_MS"));
  const maxDepth = Number(env("DIGGER_MAX_DEPTH"));

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
  const codec = new Codec();

  const accountAddress = ethereumClient.accountAddress;
  console.log(`[config] eth=${ethRpc}`);
  console.log(`[config] vara=${varaRpc}`);
  console.log(`[config] sender=${accountAddress}`);

  let programId = process.env.DIGGER_PROGRAM_ID
    ? normalizeAddress(process.env.DIGGER_PROGRAM_ID)
    : "";
  let codeId = process.env.DIGGER_CODE_ID
    ? normalizeHex(process.env.DIGGER_CODE_ID)
    : "";

  let reader = new NodeEventReader(provider, codec, programId || ZERO_ADDRESS);

  if (!programId) {
    if (!codeId) {
      if (!existsSync(WASM_PATH)) {
        throw new Error(`Wasm artifact not found: ${WASM_PATH}`);
      }

      const wasm = new Uint8Array(await readFile(WASM_PATH));
      console.log(`[deploy] requesting code validation for ${WASM_PATH}`);
      const uploadTx = await api.routerClient.requestCodeValidation(wasm);
      codeId = normalizeHex(uploadTx.codeId);
      await sendAndRequire(uploadTx, "requestCodeValidation");
      await waitForCodeValidated(api.routerClient, codeId, eventTimeoutMs);
    } else {
      console.log(`[deploy] using code id ${codeId}`);
      await waitForCodeValidated(api.routerClient, codeId, eventTimeoutMs);
    }

    console.log("[deploy] creating program");
    const createTx = await api.routerClient.createProgram(codeId);
    const createReceipt = await sendAndRequire(createTx, "createProgram");
    programId = await reader.waitForProgramCreated(
      createReceipt.blockHash,
      codeId,
      eventTimeoutMs,
    );
    reader.setProgramId(programId);
    console.log(`[deploy] program id from Vara.eth block_events: ${programId}`);
  } else {
    console.log(`[deploy] using existing program ${programId}`);
    reader.setProgramId(programId);
  }

  await waitForProgramVisible(api, programId, eventTimeoutMs);

  const mirror = getMirrorClient(programId, ethereumClient);

  if (topUp > 0n) {
    const wrappedVaraAddress = await api.routerClient.wrappedVara();
    const wvara = getWrappedVaraClient(wrappedVaraAddress, ethereumClient);
    console.log(`[fund] approving ${topUp.toString()} wVARA for ${programId}`);
    await sendAndRequire(await wvara.approve(programId, topUp), "wVARA approve");
    console.log(`[fund] topping up executable balance`);
    const topUpReceipt = await sendAndRequire(
      await mirror.executableBalanceTopUp(topUp),
      "executableBalanceTopUp",
    );
    await reader.eventsAt(topUpReceipt.blockHash);
  }

  async function sendMessage(label, payload, returnType = "Vec<u128>") {
    const tx = await mirror.sendMessage(payload, 0n);
    const receipt = await sendAndRequire(tx, label);
    const queued = await reader.waitForMessageQueued(
      receipt.blockHash,
      payload,
      eventTimeoutMs,
    );
    const reply = await reader.waitForReply(
      receipt.blockHash,
      queued.id,
      eventTimeoutMs,
    );
    const result = codec.decodeResult(reply.payload, returnType);
    console.log(`[reply] ${label}: ${compactJson(result)}`);
    return result;
  }

  async function queryWorld(fn, types, args, returnType) {
    return queryProgram(
      api,
      codec,
      accountAddress,
      programId,
      codec.encodeCall("World", fn, types, args),
      returnType,
    );
  }

  let didInit = false;
  if (!process.env.DIGGER_PROGRAM_ID) {
    await sendMessage(
      "Create",
      codec.encodeCtor("Create", [], []),
      null,
    );
    didInit = true;
  }

  if (didInit) {
    await sendMessage(
      "Admin.ResetMap",
      codec.encodeCall("Admin", "ResetMap", ["u64"], [seed]),
    );
  }

  try {
    await sendMessage(
      "Admin.StartSession",
      codec.encodeCall("Admin", "StartSession"),
    );
  } catch (error) {
    if (didInit) {
      throw error;
    }
    console.log(`[warn] Admin.StartSession skipped: ${error.message}`);
  }

  let agent = agentFromView(
    await sendMessage("World.Register", codec.encodeCall("World", "Register")),
  );
  let map = await queryWorld("MapSnapshot", [], [], "Vec<u32>");
  const shaftX = agent.x;
  const target = findTargetResource(map, shaftX, maxDepth);

  if (target) {
    console.log(`[plan] target resource at (${target.x}, ${target.y})`);
  } else {
    console.log(`[plan] no resource found within depth ${maxDepth}; drilling smoke shaft`);
  }

  async function refreshMap() {
    map = await queryWorld("MapSnapshot", [], [], "Vec<u32>");
  }

  async function drill(direction, label) {
    agent = agentFromView(
      await sendMessage(
        `World.Drill ${label}`,
        codec.encodeCall("World", "Drill", ["u32"], [direction]),
      ),
    );
    await refreshMap();
  }

  async function move(direction, label) {
    agent = agentFromView(
      await sendMessage(
        `World.MoveAgent ${label}`,
        codec.encodeCall("World", "MoveAgent", ["u32"], [direction]),
      ),
    );
  }

  async function placeLadderCurrent() {
    if (agent.y === 0 || agent.ladders <= 0) {
      return;
    }
    if (tileAt(map, agent.x, agent.y) !== TILE.Empty) {
      return;
    }
    agent = agentFromView(
      await sendMessage(
        "World.PlaceLadder current",
        codec.encodeCall("World", "PlaceLadder", ["u32"], [DIR.Current]),
      ),
    );
    await refreshMap();
  }

  async function openAndMove(direction, x, y, label) {
    const tile = tileAt(map, x, y);
    if (tile === TILE.Lava) {
      throw new Error(`Path hit lava at (${x}, ${y})`);
    }
    if (isMineable(tile)) {
      await drill(direction, `${label} drill (${x}, ${y})`);
    }
    if (isOpen(tileAt(map, x, y))) {
      await move(direction, `${label} move (${x}, ${y})`);
    }
  }

  const targetDepth = target ? target.y : Math.min(maxDepth, 6);
  for (let y = 1; y <= targetDepth; y += 1) {
    await openAndMove(DIR.Down, shaftX, y, "down");
    await placeLadderCurrent();
  }

  if (target) {
    while (agent.x !== target.x) {
      const direction = target.x > agent.x ? DIR.Right : DIR.Left;
      const nextX = agent.x + (direction === DIR.Right ? 1 : -1);
      const before = carried(agent);
      const tile = tileAt(map, nextX, agent.y);
      if (isResource(tile)) {
        await drill(direction, `resource (${nextX}, ${agent.y})`);
      }
      if (carried(agent) > before && nextX === target.x) {
        break;
      }
      await openAndMove(direction, nextX, agent.y, "horizontal");
    }
  }

  while (agent.x !== shaftX) {
    const direction = shaftX > agent.x ? DIR.Right : DIR.Left;
    const nextX = agent.x + (direction === DIR.Right ? 1 : -1);
    await move(direction, `return (${nextX}, ${agent.y})`);
  }

  while (agent.y > 0) {
    await move(DIR.Up, `up to y=${agent.y - 1}`);
  }

  agent = agentFromView(
    await sendMessage("World.Surface", codec.encodeCall("World", "Surface")),
  );

  console.log(`[done] final agent: ${compactJson(agent)}`);
  await provider.disconnect?.();
  activeProvider = null;
}

main().catch(async (error) => {
  if (activeProvider) {
    await activeProvider.disconnect?.().catch(() => {});
  }
  console.error(`[error] ${error.stack || error.message}`);
  process.exitCode = 1;
});
