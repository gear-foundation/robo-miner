#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const NETWORK_PRESETS = {
  hoodi: {
    backendUrl: "https://api-digger-eth.vara.network",
    ethRpc: "https://hoodi-reth-rpc.gear-tech.io",
    varaRpc: "wss://vara-eth-validator-1.gear-tech.io",
    router: "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060",
  },
  mainnet: {
    backendUrl: "",
    ethRpc: "",
    varaRpc: "",
    router: "",
  },
};

const DEFAULTS = {
  network: "hoodi",
  account: "agent-eth",
  timeoutMs: "240000",
};

const IDL = {
  proxy: path.join(ROOT, "assets/idl/digger_proxy.idl"),
  world: path.join(ROOT, "assets/idl/digger_world.idl"),
  vmt: path.join(ROOT, "assets/idl/digger_res_vmt.idl"),
  redeem: path.join(ROOT, "assets/idl/digger_redeem.idl"),
};

const DIRECTIONS = new Map([
  ["0", { name: "up", value: 0 }],
  ["up", { name: "up", value: 0 }],
  ["u", { name: "up", value: 0 }],
  ["1", { name: "right", value: 1 }],
  ["right", { name: "right", value: 1 }],
  ["r", { name: "right", value: 1 }],
  ["2", { name: "down", value: 2 }],
  ["down", { name: "down", value: 2 }],
  ["d", { name: "down", value: 2 }],
  ["3", { name: "left", value: 3 }],
  ["left", { name: "left", value: 3 }],
  ["l", { name: "left", value: 3 }],
]);

const DIRECTIONS_WITH_CURRENT = new Map([
  ...DIRECTIONS,
  ["4", { name: "current", value: 4 }],
  ["current", { name: "current", value: 4 }],
  ["c", { name: "current", value: 4 }],
]);

const AGENT_FIELD_ORDER = [
  "status",
  "x",
  "y",
  "hp",
  "ladders",
  "invScrst",
  "invBcrst",
  "invHcrst",
  "bankedScrst",
  "bankedBcrst",
  "bankedHcrst",
  "capacity",
  "lastActionSeq",
];

const INVENTORY_FIELD_ORDER = [
  "scrst",
  "bcrst",
  "hcrst",
  "bankedScrst",
  "bankedBcrst",
  "bankedHcrst",
];

const SESSION_FIELD_ORDER = ["sessionId", "seed", "status", "actionSeq"];

const TILE_NAMES = new Map([
  [0, "empty"],
  [1, "dirt"],
  [2, "stone"],
  [3, "lava"],
  [4, "ladder"],
  [10, "scrst"],
  [11, "bcrst"],
  [12, "hcrst"],
  [20, "surface"],
]);

function usage() {
  console.log(`Usage:
  robo-miner-live identity [--network hoodi|mainnet] --account agent-eth --passphrase "$PASSPHRASE"
  robo-miner-live worlds [--network hoodi|mainnet] [--raw]
  robo-miner-live request-digger [--owner <0xaddress>] [--world <0xworld>] [--season <season-id>]
  robo-miner-live diggers [--owner <0xaddress>] [--season <season-id>] [--status active|planned|pending|failed]
  robo-miner-live digger-info [--digger <0xdigger>] [--owner <0xowner>]
  robo-miner-live query [--world <0xworld>] [--digger <0xdigger>] [--owner <0xowner>] [--summary] [--no-map] [--raw]
  robo-miner-live balances [--vmt <0xvmt>] [--owner <0xowner>] [--redeem <0xredeem>]

Commands:
  identity        Show wallet EVM address and ActorId without printing secrets.
  worlds          Print active worlds from the backend manifest.
  request-digger  Call the backend rental API for owner + world + season.
  diggers         List public backend diggers for owner + season; do not use world lookup.
  digger-info     Read Digger.Owner, Digger.World, Digger.Status, LastMessageId.
  register        Legacy diagnostic only. Prefer vara-wallet call Digger/Register.
  setworld        Legacy diagnostic only. Prefer vara-wallet call Digger/SetWorld.
  query           Read World.Session, Agents, MapSnapshot, AgentOf, InventoryOf via calculateReplyForHandle.
  move            Legacy diagnostic only. Prefer vara-wallet call Digger/MoveAgent.
  drill           Legacy diagnostic only. Prefer vara-wallet call Digger/Drill.
  place-ladder    Legacy diagnostic only. Prefer vara-wallet call Digger/PlaceLadder.
  surface         Legacy diagnostic only. Prefer vara-wallet call Digger/Surface.
  mint-resources  Legacy diagnostic only. Prefer vara-wallet call Digger/MintResources.
  balances        Read RES VMT token ids, owner balances, and redeem approval.
  approve-redeem  Legacy diagnostic only. Prefer vara-wallet call Vmt/Approve.
  redeem-info     Read Redeem reserve, rates, and pending count.
  redeem          Legacy diagnostic only. Prefer vara-wallet call Redeem/Redeem.
  cancel-redeem   Legacy diagnostic only. Prefer vara-wallet call Redeem/CancelRedeem.
  confirm-redeem  Legacy diagnostic only. Prefer vara-wallet call Redeem/ConfirmRedeem.
  exit            Legacy diagnostic only. Prefer vara-wallet call Digger/Exit.
  verify-agent    Alias for query --summary with AgentOf-focused output.

Defaults target Vara.eth Hoodi. Use --network mainnet or VARA_ETH_NETWORK=mainnet
only with explicit --eth-rpc, --vara-rpc, --router, and --backend-url values.
IDs may be passed as flags or ROBO_MINER_WORLD_ID, ROBO_MINER_DIGGER_PROGRAM_ID,
ROBO_MINER_OWNER_ADDRESS, ROBO_MINER_RES_VMT_PROGRAM_ID, ROBO_MINER_REDEEM_PROGRAM_ID.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    return { help: true };
  }
  const args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = camel(arg.slice(2));
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function env(name, fallback) {
  return process.env[`ROBO_MINER_${name}`] || process.env[name] || fallback;
}

function config(args, requirements = {}) {
  const required = {
    backendUrl: true,
    ethRpc: true,
    varaRpc: true,
    router: true,
    ...requirements,
  };
  const network = String(
    args.network
      || process.env.ROBO_MINER_NETWORK
      || process.env.VARA_ETH_NETWORK
      || DEFAULTS.network,
  ).toLowerCase();
  const preset = NETWORK_PRESETS[network];
  if (!preset) {
    throw new Error(`Unsupported network: ${network}. Use hoodi or mainnet.`);
  }
  const backendUrl = args.backendUrl || env("BACKEND_URL", preset.backendUrl);
  const ethRpc = args.ethRpc || env("ETH_RPC", preset.ethRpc);
  const varaRpc = args.varaRpc || env("VARA_RPC", preset.varaRpc);
  const router = args.router || env("ROUTER", preset.router);
  const missing = [];
  if (required.backendUrl && !backendUrl) {
    missing.push("backend URL (--backend-url or ROBO_MINER_BACKEND_URL)");
  }
  if (required.ethRpc && !ethRpc) {
    missing.push("Ethereum RPC (--eth-rpc or ROBO_MINER_ETH_RPC)");
  }
  if (required.varaRpc && !varaRpc) {
    missing.push("Vara.eth validator RPC (--vara-rpc or ROBO_MINER_VARA_RPC)");
  }
  if (required.router && !router) {
    missing.push("router address (--router or ROBO_MINER_ROUTER)");
  }
  if (missing.length) {
    throw new Error(
      `Network ${network} has no complete built-in preset. Provide ${missing.join(", ")}.`,
    );
  }
  return {
    network,
    backendUrl,
    ethRpc,
    varaRpc,
    router: router ? normalizeAddress(router, "router") : "",
    account: args.account
      || process.env.ROBO_MINER_WALLET_ACCOUNT
      || process.env.VARA_WALLET_ACCOUNT
      || process.env.WALLET_ACCOUNT
      || DEFAULTS.account,
    passphrase: args.passphrase || env("PASSPHRASE", ""),
    timeoutMs: Number(args.timeoutMs || env("TIMEOUT_MS", DEFAULTS.timeoutMs)),
  };
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return value;
}

function optionalArgEnv(args, key, envName) {
  return args[key] || env(envName, "");
}

function requireArgEnv(args, key, envName) {
  const value = optionalArgEnv(args, key, envName);
  if (!value) {
    const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    throw new Error(`Missing --${flag} or ROBO_MINER_${envName}`);
  }
  return value;
}

function normalizeHex(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be a 0x-prefixed hex string`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value, field = "address") {
  const hex = normalizeHex(value, field);
  const body = hex.slice(2);
  if (body.length === 40) return `0x${body}`;
  if (body.length === 64 && body.startsWith("0".repeat(24))) return `0x${body.slice(24)}`;
  throw new Error(`${field} must be a 20-byte EVM address or 32-byte ActorId`);
}

function actorIdFromAddress(value) {
  const address = normalizeAddress(value, "address");
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function directionFromArg(value) {
  const direction = DIRECTIONS.get(String(value).toLowerCase());
  if (!direction) {
    throw new Error("direction must be one of: up, right, down, left, 0, 1, 2, 3");
  }
  return direction;
}

function directionWithCurrentFromArg(value) {
  const direction = DIRECTIONS_WITH_CURRENT.get(String(value).toLowerCase());
  if (!direction) {
    throw new Error("direction must be one of: up, right, down, left, current, 0, 1, 2, 3, 4");
  }
  return direction;
}

function uintArg(args, key, fallback = "0") {
  const raw = args[key] ?? fallback;
  const value = BigInt(raw);
  if (value < 0n) {
    throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be non-negative`);
  }
  return value;
}

function transportFor(url, http, webSocket) {
  return url.startsWith("http") ? http(url) : webSocket(url);
}

function walletKey(account, passphrase, network) {
  if (!passphrase) {
    throw new Error("Missing passphrase. Pass --passphrase or set PASSPHRASE.");
  }
  const out = execFileSync("vara-wallet", [
    "--chain",
    "vara-eth",
    "--network",
    network,
    "--json",
    "vara-eth:wallet",
    "keys",
    account,
    "--passphrase",
    passphrase,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  if (!parsed.privateKey || !parsed.address) {
    throw new Error(`vara-wallet did not return key material for account ${account}`);
  }
  return parsed;
}

async function connect(cfg, withSigner = true) {
  const [
    { createVaraEthApi, WsVaraEthProvider },
    { walletClientToSigner },
    { createPublicClient, createWalletClient, http, webSocket },
    { privateKeyToAccount },
  ] = await loadVaraEthRuntime();
  const publicClient = createPublicClient({ transport: transportFor(cfg.ethRpc, http, webSocket) });
  let signer;
  let address;
  if (withSigner) {
    const key = walletKey(cfg.account, cfg.passphrase, cfg.network);
    const account = privateKeyToAccount(key.privateKey);
    const walletClient = createWalletClient({ transport: transportFor(cfg.ethRpc, http, webSocket), account });
    signer = walletClientToSigner(walletClient);
    address = key.address;
  }
  const provider = new WsVaraEthProvider(cfg.varaRpc, { requestTimeout: cfg.timeoutMs });
  const api = await createVaraEthApi(provider, publicClient, cfg.router, signer);
  return {
    api,
    provider,
    address,
    disconnect: () => provider.disconnect().catch(() => undefined),
  };
}

async function loadSails(idlPath) {
  const [{ SailsProgram }, { SailsIdlParser }] = await Promise.all([
    import("sails-js"),
    import("sails-js/parser"),
  ]);
  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(await readFile(idlPath, "utf8")));
}

async function loadVaraEthRuntime() {
  try {
    return await Promise.all([
      import("@vara-eth/api"),
      import("@vara-eth/api/signer"),
      import("viem"),
      import("viem/accounts"),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Vara.eth runtime dependencies are unavailable or too old: ${message}. `
      + "Install this skill as an npm package so its dependencies are installed "
      + "next to the skill, or run npm install in the skill package directory.",
    );
  }
}

function replyCodeJson(code) {
  return {
    reason: code?.reason ?? null,
    isSuccess: Boolean(code?.isSuccess),
    raw: code?.toBytes
      ? `0x${Array.from(code.toBytes()).map((b) => b.toString(16).padStart(2, "0")).join("")}`
      : null,
  };
}

function receiptJson(receipt) {
  const base = {
    txHash: receipt.txHash,
    validator: receipt.address ?? null,
    error: receipt.error ?? null,
  };
  if (receipt.error) return base;
  const promise = receipt.promise;
  return {
    ...base,
    reply: {
      payload: promise.payload,
      value: promise.value.toString(),
      code: replyCodeJson(promise.code),
    },
  };
}

async function sendDiggerCall(args, functionName, callArgs = [], extra = {}) {
  const cfg = config(args);
  const diggerProgramId = normalizeAddress(requireArgEnv(args, "digger", "DIGGER_PROGRAM_ID"), "digger");
  const proxySails = await loadSails(IDL.proxy);
  const fn = proxySails.services.Digger.functions[functionName];
  if (!fn) throw new Error(`Digger function not found in IDL: ${functionName}`);
  const payload = fn.encodePayload(...callArgs);
  const connection = await connect(cfg, true);
  try {
    const injected = await connection.api.createInjectedTransaction({
      destination: diggerProgramId,
      payload,
      value: 0n,
    });
    await injected.sign();
    const receipt = await injected.sendAndWaitForReceipt();
    await receipt.validateSignature();
    let decodedReply = null;
    let decodeReplyError = null;
    if (!receipt.error && receipt.promise?.payload) {
      try {
        decodedReply = fn.decodeResult(receipt.promise.payload);
      } catch (error) {
        decodeReplyError = error instanceof Error ? error.message : String(error);
      }
    }
    output({
      command: functionName,
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      account: cfg.account,
      ownerAddress: connection.address,
      ownerActorId: actorIdFromAddress(connection.address),
      diggerProgramId,
      diggerActorId: actorIdFromAddress(diggerProgramId),
      messageId: injected.messageId,
      txHash: injected.txHash,
      ...extra,
      receipt: receiptJson(receipt),
      decodedReply,
      decodeReplyError,
    });
    if (receipt.error) process.exitCode = 1;
  } finally {
    await connection.disconnect();
  }
}

async function sendProgramCall(args, {
  idlPath,
  serviceName,
  functionName,
  programId,
  programLabel,
  callArgs = [],
  value = 0n,
  extra = {},
}) {
  const cfg = config(args);
  const destination = normalizeAddress(programId, programLabel);
  const sails = await loadSails(idlPath);
  const service = sails.services[serviceName];
  if (!service) throw new Error(`Service not found in IDL: ${serviceName}`);
  const fn = service.functions[functionName];
  if (!fn) throw new Error(`${serviceName} function not found in IDL: ${functionName}`);
  const payload = fn.encodePayload(...callArgs);
  const connection = await connect(cfg, true);
  try {
    const injected = await connection.api.createInjectedTransaction({
      destination,
      payload,
      value,
    });
    await injected.sign();
    const receipt = await injected.sendAndWaitForReceipt();
    await receipt.validateSignature();
    let decodedReply = null;
    let decodeReplyError = null;
    if (!receipt.error && receipt.promise?.payload) {
      try {
        decodedReply = fn.decodeResult(receipt.promise.payload);
      } catch (error) {
        decodeReplyError = error instanceof Error ? error.message : String(error);
      }
    }
    output({
      command: `${serviceName}.${functionName}`,
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      account: cfg.account,
      ownerAddress: connection.address,
      ownerActorId: actorIdFromAddress(connection.address),
      programId: destination,
      programActorId: actorIdFromAddress(destination),
      messageId: injected.messageId,
      txHash: injected.txHash,
      ...extra,
      receipt: receiptJson(receipt),
      decodedReply,
      decodeReplyError,
    });
    if (receipt.error) process.exitCode = 1;
  } finally {
    await connection.disconnect();
  }
}

async function calculateSailsQuery(api, sails, serviceName, caller, programId, queryName, queryArgs = []) {
  const service = sails.services[serviceName];
  if (!service) throw new Error(`Service not found in IDL: ${serviceName}`);
  const query = service.queries[queryName];
  if (!query) throw new Error(`${serviceName} query not found in IDL: ${queryName}`);
  const payload = query.encodePayload(...queryArgs);
  const reply = await api.call.program.calculateReplyForHandle(caller, programId, payload, 0n);
  let decoded = null;
  let decodeError = null;
  try {
    decoded = query.decodeResult(reply.payload);
  } catch (error) {
    decodeError = error instanceof Error ? error.message : String(error);
  }
  return {
    replyCode: replyCodeJson(reply.code),
    payload: reply.payload,
    decoded,
    decodeError,
  };
}

async function calculateWorldQuery(api, worldSails, caller, worldId, queryName, queryArgs = []) {
  return calculateSailsQuery(api, worldSails, "World", caller, worldId, queryName, queryArgs);
}

function arrayView(decoded) {
  if (!Array.isArray(decoded)) return null;
  return decoded.map((value) => normalizeJsonValue(value));
}

function recordView(decoded, fields) {
  const values = arrayView(decoded);
  if (!values) return null;
  const view = {};
  for (let i = 0; i < values.length; i += 1) {
    view[fields[i] || `field${i}`] = values[i];
  }
  return view;
}

function actorView(decoded) {
  const actorId = typeof decoded === "string" ? decoded.toLowerCase() : null;
  if (!actorId) return normalizeJsonValue(decoded);
  let evmAddress = null;
  try {
    evmAddress = normalizeAddress(actorId, "actorId");
  } catch {
    evmAddress = null;
  }
  return { actorId, evmAddress };
}

function scalarView(decoded) {
  return normalizeJsonValue(decoded);
}

function normalizeJsonValue(value) {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= max ? Number(value) : value.toString();
  }
  return value;
}

function mapView(decoded, includeTiles) {
  const tiles = arrayView(decoded);
  if (!tiles) return null;
  const counts = {};
  for (const tile of tiles) {
    const name = TILE_NAMES.get(tile) || `tile_${tile}`;
    counts[name] = (counts[name] || 0) + 1;
  }
  return {
    width: 40,
    height: 64,
    tileCount: tiles.length,
    counts,
    ...(includeTiles ? { tiles } : {}),
  };
}

function mapQueryOutput(mapSnapshot, includeMapTiles, includeRaw) {
  return {
    replyCode: mapSnapshot.replyCode,
    decodeError: mapSnapshot.decodeError,
    ...(includeRaw ? {
      payload: mapSnapshot.payload,
      decoded: mapSnapshot.decoded,
    } : {}),
    view: mapView(mapSnapshot.decoded, includeMapTiles),
  };
}

async function cmdIdentity(args) {
  const cfg = config(args, {
    backendUrl: false,
    ethRpc: false,
    varaRpc: false,
    router: false,
  });
  const key = walletKey(cfg.account, cfg.passphrase, cfg.network);
  output({
    network: cfg.network,
    account: cfg.account,
    ownerAddress: key.address,
    ownerActorId: actorIdFromAddress(key.address),
  });
}

async function cmdWorlds(args) {
  const cfg = config(args, {
    ethRpc: false,
    varaRpc: false,
    router: false,
  });
  const res = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/manifest`);
  if (!res.ok) throw new Error(`manifest request failed: ${res.status} ${res.statusText}`);
  const manifest = await res.json();
  if (args.raw) {
    output({
      network: cfg.network,
      backendUrl: cfg.backendUrl,
      manifest,
    });
    return;
  }
  output({
    network: cfg.network,
    backendUrl: cfg.backendUrl,
    seasonId: manifest?.season?.id ?? null,
    manifestNetwork: manifest?.season?.config?.network ?? null,
    router: manifest?.season?.config?.router ?? null,
    seasonConfig: manifest?.season?.config ?? null,
    economy: manifest?.economy ?? manifest?.season?.economy ?? null,
    active: (manifest?.active ?? []).map((world) => ({
      id: world.id,
      status: world.status,
      programId: world.programId,
      agents: world.agents,
      targetAgents: world.targetAgents,
      sessionId: world.sessionId,
    })),
  });
}

async function cmdRequestDigger(args) {
  const cfg = config(args, {
    ethRpc: false,
    varaRpc: false,
    router: false,
  });
  const owner = normalizeAddress(requireArgEnv(args, "owner", "OWNER_ADDRESS"), "owner");
  const worldId = normalizeAddress(requireArgEnv(args, "world", "WORLD_ID"), "world");
  const seasonId = requireArgEnv(args, "season", "SEASON_ID");
  const body = {
    owner,
    worldId,
    seasonId,
    dryRun: Boolean(args.dryRun),
  };
  const res = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/diggers/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  output({ ok: res.ok, network: cfg.network, status: res.status, request: body, response: data });
  if (!res.ok) process.exitCode = 1;
}

async function cmdDiggers(args) {
  const cfg = config(args, {
    ethRpc: false,
    varaRpc: false,
    router: false,
  });
  const owner = normalizeAddress(requireArgEnv(args, "owner", "OWNER_ADDRESS"), "owner");
  const seasonId = optionalArgEnv(args, "season", "SEASON_ID");
  const status = args.status || "active";
  const params = new URLSearchParams({ owner });
  if (seasonId) params.set("season", seasonId);
  if (status) params.set("status", status);

  const res = await fetch(`${cfg.backendUrl.replace(/\/$/, "")}/api/diggers?${params.toString()}`);
  const data = await res.json().catch(() => null);
  output({
    ok: res.ok,
    network: cfg.network,
    status: res.status,
    request: {
      owner,
      season: seasonId || null,
      status: status || null,
      world: null,
    },
    response: data,
  });
  if (!res.ok) process.exitCode = 1;
}

async function cmdRegister(args) {
  await sendDiggerCall(args, "Register");
}

async function cmdSetWorld(args) {
  const worldId = normalizeAddress(requireArgEnv(args, "world", "WORLD_ID"), "world");
  const worldActorId = actorIdFromAddress(worldId);
  await sendDiggerCall(args, "SetWorld", [worldActorId], {
    worldId,
    worldActorId,
  });
}

async function cmdDiggerInfo(args) {
  const cfg = config(args);
  const diggerProgramId = normalizeAddress(requireArgEnv(args, "digger", "DIGGER_PROGRAM_ID"), "digger");
  const caller = normalizeAddress(
    args.caller || args.owner || env("OWNER_ADDRESS", "") || "0x0000000000000000000000000000000000000000",
    "caller",
  );
  const proxySails = await loadSails(IDL.proxy);
  const connection = await connect(cfg, false);
  try {
    const owner = await calculateSailsQuery(connection.api, proxySails, "Digger", caller, diggerProgramId, "Owner");
    const world = await calculateSailsQuery(connection.api, proxySails, "Digger", caller, diggerProgramId, "World");
    const status = await calculateSailsQuery(connection.api, proxySails, "Digger", caller, diggerProgramId, "Status");
    const lastMessageId = await calculateSailsQuery(
      connection.api,
      proxySails,
      "Digger",
      caller,
      diggerProgramId,
      "LastMessageId",
    );
    output({
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      diggerProgramId,
      diggerActorId: actorIdFromAddress(diggerProgramId),
      caller,
      owner: { ...owner, view: actorView(owner.decoded) },
      world: { ...world, view: actorView(world.decoded) },
      status: { ...status, view: arrayView(status.decoded) ?? scalarView(status.decoded) },
      lastMessageId: { ...lastMessageId, view: scalarView(lastMessageId.decoded) },
    });
    if (owner.decodeError || world.decodeError || status.decodeError || lastMessageId.decodeError) {
      process.exitCode = 1;
    }
  } finally {
    await connection.disconnect();
  }
}

async function cmdMove(args) {
  const direction = directionFromArg(requireArg(args, "direction"));
  await sendDiggerCall(args, "MoveAgent", [direction.value], { direction });
}

async function cmdDrill(args) {
  const direction = directionFromArg(requireArg(args, "direction"));
  await sendDiggerCall(args, "Drill", [direction.value], { direction });
}

async function cmdPlaceLadder(args) {
  const direction = directionWithCurrentFromArg(requireArg(args, "direction"));
  await sendDiggerCall(args, "PlaceLadder", [direction.value], { direction });
}

async function cmdSurface(args) {
  await sendDiggerCall(args, "Surface");
}

async function cmdExit(args) {
  await sendDiggerCall(args, "Exit");
}

async function cmdMintResources(args) {
  await sendDiggerCall(args, "MintResources");
}

async function cmdBalances(args) {
  const cfg = config(args);
  const vmtProgramId = normalizeAddress(requireArgEnv(args, "vmt", "RES_VMT_PROGRAM_ID"), "vmt");
  const ownerAddressOrActor = requireArgEnv(args, "owner", "OWNER_ADDRESS");
  const ownerActorId = actorIdFromAddress(ownerAddressOrActor);
  const redeemProgramId = optionalArgEnv(args, "redeem", "REDEEM_PROGRAM_ID")
    ? normalizeAddress(optionalArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem")
    : null;
  const redeemActorId = redeemProgramId ? actorIdFromAddress(redeemProgramId) : null;
  const caller = normalizeAddress(args.caller || env("OWNER_ADDRESS", "") || "0x0000000000000000000000000000000000000000", "caller");
  const vmtSails = await loadSails(IDL.vmt);
  const connection = await connect(cfg, false);
  try {
    const tokenIdQuery = async (name) => calculateSailsQuery(connection.api, vmtSails, "Vmt", caller, vmtProgramId, name);
    const scrstTokenId = await tokenIdQuery("ScrstTokenId");
    const bcrstTokenId = await tokenIdQuery("BcrstTokenId");
    const hcrstTokenId = await tokenIdQuery("HcrstTokenId");
    const balanceOf = async (tokenIdResult) => calculateSailsQuery(
      connection.api,
      vmtSails,
      "Vmt",
      caller,
      vmtProgramId,
      "BalanceOf",
      [ownerActorId, BigInt(String(tokenIdResult.decoded))],
    );
    const scrst = await balanceOf(scrstTokenId);
    const bcrst = await balanceOf(bcrstTokenId);
    const hcrst = await balanceOf(hcrstTokenId);
    const approval = redeemActorId
      ? await calculateSailsQuery(
          connection.api,
          vmtSails,
          "Vmt",
          caller,
          vmtProgramId,
          "IsApproved",
          [ownerActorId, redeemActorId],
        )
      : null;
    output({
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      vmtProgramId,
      ownerActorId,
      redeemProgramId,
      redeemActorId,
      tokenIds: {
        scrst: scalarView(scrstTokenId.decoded),
        bcrst: scalarView(bcrstTokenId.decoded),
        hcrst: scalarView(hcrstTokenId.decoded),
      },
      balances: {
        scrst: scalarView(scrst.decoded),
        bcrst: scalarView(bcrst.decoded),
        hcrst: scalarView(hcrst.decoded),
      },
      approval: approval
        ? {
            approvedForRedeem: scalarView(approval.decoded),
            replyCode: approval.replyCode,
            decodeError: approval.decodeError,
          }
        : null,
    });
    if (
      scrstTokenId.decodeError
      || bcrstTokenId.decodeError
      || hcrstTokenId.decodeError
      || scrst.decodeError
      || bcrst.decodeError
      || hcrst.decodeError
      || approval?.decodeError
    ) {
      process.exitCode = 1;
    }
  } finally {
    await connection.disconnect();
  }
}

async function cmdApproveRedeem(args) {
  const vmtProgramId = normalizeAddress(requireArgEnv(args, "vmt", "RES_VMT_PROGRAM_ID"), "vmt");
  const redeemProgramId = normalizeAddress(requireArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem");
  const redeemActorId = actorIdFromAddress(redeemProgramId);
  await sendProgramCall(args, {
    idlPath: IDL.vmt,
    serviceName: "Vmt",
    functionName: "Approve",
    programId: vmtProgramId,
    programLabel: "vmt",
    callArgs: [redeemActorId],
    extra: { vmtProgramId, redeemProgramId, redeemActorId },
  });
}

async function cmdRedeemInfo(args) {
  const cfg = config(args);
  const redeemProgramId = normalizeAddress(requireArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem");
  const caller = normalizeAddress(args.caller || env("OWNER_ADDRESS", "") || "0x0000000000000000000000000000000000000000", "caller");
  const redeemSails = await loadSails(IDL.redeem);
  const connection = await connect(cfg, false);
  try {
    const query = async (name) => calculateSailsQuery(connection.api, redeemSails, "Redeem", caller, redeemProgramId, name);
    const results = {
      availableReserve: await query("AvailableReserve"),
      reserveBalance: await query("ReserveBalance"),
      lockedBalance: await query("LockedBalance"),
      scrstRate: await query("ScrstRate"),
      bcrstRate: await query("BcrstRate"),
      hcrstRate: await query("HcrstRate"),
      varaUnit: await query("VaraUnit"),
      pendingRedeemCount: await query("PendingRedeemCount"),
      totalPaid: await query("TotalPaid"),
      totalRedeemedScrst: await query("TotalRedeemedScrst"),
      totalRedeemedBcrst: await query("TotalRedeemedBcrst"),
      totalRedeemedHcrst: await query("TotalRedeemedHcrst"),
    };
    output({
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      redeemProgramId,
      redeemActorId: actorIdFromAddress(redeemProgramId),
      state: Object.fromEntries(
        Object.entries(results).map(([key, result]) => [key, scalarView(result.decoded)]),
      ),
      raw: results,
    });
    if (Object.values(results).some((result) => result.decodeError)) {
      process.exitCode = 1;
    }
  } finally {
    await connection.disconnect();
  }
}

async function cmdRedeem(args) {
  const redeemProgramId = normalizeAddress(requireArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem");
  const scrst = uintArg(args, "scrst");
  const bcrst = uintArg(args, "bcrst");
  const hcrst = uintArg(args, "hcrst");
  if (scrst + bcrst + hcrst === 0n) {
    throw new Error("At least one redeem amount must be greater than zero.");
  }
  await sendProgramCall(args, {
    idlPath: IDL.redeem,
    serviceName: "Redeem",
    functionName: "Redeem",
    programId: redeemProgramId,
    programLabel: "redeem",
    callArgs: [scrst, bcrst, hcrst],
    extra: {
      redeemProgramId,
      redeemActorId: actorIdFromAddress(redeemProgramId),
      amounts: { scrst, bcrst, hcrst },
    },
  });
}

async function cmdCancelRedeem(args) {
  const redeemProgramId = normalizeAddress(requireArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem");
  if (args.redeemId === undefined && args.id === undefined) {
    throw new Error("Missing --redeem-id or --id");
  }
  const redeemId = uintArg({ redeemId: args.redeemId ?? args.id }, "redeemId");
  await sendProgramCall(args, {
    idlPath: IDL.redeem,
    serviceName: "Redeem",
    functionName: "CancelRedeem",
    programId: redeemProgramId,
    programLabel: "redeem",
    callArgs: [redeemId],
    extra: {
      redeemProgramId,
      redeemActorId: actorIdFromAddress(redeemProgramId),
      redeemId,
    },
  });
}

async function cmdConfirmRedeem(args) {
  const redeemProgramId = normalizeAddress(requireArgEnv(args, "redeem", "REDEEM_PROGRAM_ID"), "redeem");
  if (args.redeemId === undefined && args.id === undefined) {
    throw new Error("Missing --redeem-id or --id");
  }
  const redeemId = uintArg({ redeemId: args.redeemId ?? args.id }, "redeemId");
  await sendProgramCall(args, {
    idlPath: IDL.redeem,
    serviceName: "Redeem",
    functionName: "ConfirmRedeem",
    programId: redeemProgramId,
    programLabel: "redeem",
    callArgs: [redeemId],
    extra: {
      redeemProgramId,
      redeemActorId: actorIdFromAddress(redeemProgramId),
      redeemId,
    },
  });
}

async function cmdQuery(args) {
  const cfg = config(args);
  const worldId = normalizeAddress(requireArgEnv(args, "world", "WORLD_ID"), "world");
  const diggerValue = optionalArgEnv(args, "digger", "DIGGER_PROGRAM_ID");
  const diggerProgramId = diggerValue ? normalizeAddress(diggerValue, "digger") : null;
  const diggerActorId = diggerProgramId ? actorIdFromAddress(diggerProgramId) : null;
  const caller = normalizeAddress(
    args.caller || args.owner || env("OWNER_ADDRESS", "") || "0x0000000000000000000000000000000000000000",
    "caller",
  );
  const includeMapTiles = !args.summary;
  const worldSails = await loadSails(IDL.world);
  const connection = await connect(cfg, false);
  try {
    const session = await calculateWorldQuery(connection.api, worldSails, caller, worldId, "Session");
    const agents = await calculateWorldQuery(connection.api, worldSails, caller, worldId, "Agents");
    const mapSnapshot = args.noMap
      ? null
      : await calculateWorldQuery(connection.api, worldSails, caller, worldId, "MapSnapshot");
    const agent = diggerActorId
      ? await calculateWorldQuery(connection.api, worldSails, caller, worldId, "AgentOf", [diggerActorId])
      : null;
    const inventory = diggerActorId
      ? await calculateWorldQuery(connection.api, worldSails, caller, worldId, "InventoryOf", [diggerActorId])
      : null;

    output({
      network: cfg.network,
      rpcVersion: connection.api.rpcVersion,
      worldId,
      caller,
      diggerProgramId,
      diggerActorId,
      session: {
        ...session,
        view: recordView(session.decoded, SESSION_FIELD_ORDER),
      },
      agents: {
        ...agents,
        view: arrayView(agents.decoded),
      },
      map: mapSnapshot
        ? mapQueryOutput(mapSnapshot, includeMapTiles, Boolean(args.raw))
        : null,
      agent: agent
        ? {
            ...agent,
            view: recordView(agent.decoded, AGENT_FIELD_ORDER),
          }
        : null,
      inventory: inventory
        ? {
            ...inventory,
            view: recordView(inventory.decoded, INVENTORY_FIELD_ORDER),
          }
        : null,
    });

    if (session.decodeError || (mapSnapshot && mapSnapshot.decodeError)) {
      process.exitCode = 1;
    }
  } finally {
    await connection.disconnect();
  }
}

async function cmdVerifyAgent(args) {
  args.summary = true;
  args.noMap = true;
  await cmdQuery(args);
}

function output(value) {
  console.log(JSON.stringify(value, (_key, item) => (
    typeof item === "bigint" ? item.toString() : item
  ), 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.help) {
    usage();
    return;
  }
  switch (args.command) {
    case "identity":
      await cmdIdentity(args);
      break;
    case "worlds":
      await cmdWorlds(args);
      break;
    case "request-digger":
      await cmdRequestDigger(args);
      break;
    case "diggers":
    case "list-diggers":
      await cmdDiggers(args);
      break;
    case "digger-info":
      await cmdDiggerInfo(args);
      break;
    case "register":
      await cmdRegister(args);
      break;
    case "setworld":
    case "set-world":
      await cmdSetWorld(args);
      break;
    case "query":
      await cmdQuery(args);
      break;
    case "verify-agent":
      await cmdVerifyAgent(args);
      break;
    case "move":
      await cmdMove(args);
      break;
    case "drill":
      await cmdDrill(args);
      break;
    case "place-ladder":
    case "placeLadder":
      await cmdPlaceLadder(args);
      break;
    case "surface":
      await cmdSurface(args);
      break;
    case "exit":
      await cmdExit(args);
      break;
    case "mint":
    case "mint-resources":
      await cmdMintResources(args);
      break;
    case "balances":
      await cmdBalances(args);
      break;
    case "approve-redeem":
      await cmdApproveRedeem(args);
      break;
    case "redeem-info":
      await cmdRedeemInfo(args);
      break;
    case "redeem":
      await cmdRedeem(args);
      break;
    case "cancel-redeem":
      await cmdCancelRedeem(args);
      break;
    case "confirm-redeem":
      await cmdConfirmRedeem(args);
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
});
