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
  ETHEREUM_RPC: "https://mainnet-reth-rpc.gear-tech.io",
  VARA_ETH_RPC: "wss://validator-1-eth.vara.network",
  ROUTER_ADDRESS: "0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
  DIGGER_PROMISE_TIMEOUT_MS: "90000",
  DIGGER_QUERY_TIMEOUT_MS: "60000",
  DIGGER_VALIDATOR_MODE: "default",
} as const;

const WORLD_IDL_PATH = process.env.DIGGER_WORLD_IDL_PATH || path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const PROXY_IDL_PATH = process.env.DIGGER_PROXY_IDL_PATH || path.join(ROOT, "target/wasm32-gear/release/digger_proxy.idl");

const VMT_IDL = String.raw`
!@sails: 1.0.0-beta.5

service Vmt@0x4e01e4dd806d52bb {
    events {
        Approval([u8; 32], [u8; 32]),
        BatchTransfer([u8; 32], [u8; 32]),
        Burned([u8; 32], u128, u128, u128),
        Minted([u8; 32], u128, u128, u128),
        RedeemBurnRejected(u128, [u8; 32], u128, u128, u128),
        Transfer([u8; 32], [u8; 32], u128, u128),
    }
    functions {
        Approve(operator: ActorId) -> bool throws String;
        @query
        BalanceOf(account: ActorId, id: u128) -> u128 throws String;
        BatchTransferFrom(from: ActorId, to: ActorId, ids: [u128], amounts: [u128]) throws String;
        @query
        BcrstTokenId() -> u128 throws String;
        BurnForRedeem(redeem_id: u128, owner: ActorId, scrst: u128, bcrst: u128, hcrst: u128) throws String;
        @query
        Decimals() -> u128 throws String;
        @query
        HcrstTokenId() -> u128 throws String;
        @query
        IsApproved(account: ActorId, operator: ActorId) -> bool throws String;
        MintResources(to: ActorId, scrst: u128, bcrst: u128, hcrst: u128) throws String;
        @query
        Name() -> String throws String;
        @query
        ScrstTokenId() -> u128 throws String;
        @query
        Symbol() -> String throws String;
        @query
        TotalSupplyOf(id: u128) -> u128 throws String;
        TransferFrom(from: ActorId, to: ActorId, id: u128, amount: u128) throws String;
    }
}

service Admin@0x01d79581eb6b9405 {
    events {
        AdminAdded([u8; 32]),
        AdminRemoved([u8; 32]),
        MinterAdded([u8; 32]),
        MinterRemoved([u8; 32]),
        Paused([u8; 32]),
        RedeemContractUpdated([u8; 32], [u8; 32]),
        Unpaused([u8; 32]),
    }
    functions {
        AddAdmin(admin: ActorId) -> bool throws String;
        AddMinter(minter: ActorId) -> bool throws String;
        @query
        Admins() -> [ActorId] throws String;
        @query
        IsAdmin(account: ActorId) -> bool throws String;
        @query
        IsMinter(account: ActorId) -> bool throws String;
        @query
        IsPaused() -> bool throws String;
        @query
        Minters() -> [ActorId] throws String;
        Pause() throws String;
        @query
        RedeemContract() -> ActorId throws String;
        RemoveAdmin(admin: ActorId) -> bool throws String;
        RemoveMinter(minter: ActorId) -> bool throws String;
        SetRedeemContract(redeem_contract: ActorId) throws String;
        Unpause() throws String;
    }
}

program DiggerResVmt {
    constructors {
        Create(redeem_contract: ActorId, minter: ActorId);
    }
    services {
        Vmt@0x4e01e4dd806d52bb,
        Admin@0x01d79581eb6b9405,
    }
}
`;

type ValidatorMode = "default" | "slot";

type Args = {
  world?: string;
  proxy?: string;
  vmt?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  noMint?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

type AgentView = {
  bankedScrst: bigint;
  bankedBcrst: bigint;
  bankedHcrst: bigint;
  lastActionSeq: bigint;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
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
      case "--world":
        args.world = next();
        break;
      case "--proxy":
        args.proxy = next();
        break;
      case "--vmt":
        args.vmt = next();
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
        if (value !== "default" && value !== "slot") throw new Error("--validator must be default or slot");
        args.validatorMode = value;
        break;
      }
      case "--no-mint":
        args.noMint = true;
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

function valueOrDefault(names: string[], fallback: keyof typeof DEFAULTS, override?: string): string {
  return override?.trim() || names.map(envValue).find(Boolean) || DEFAULTS[fallback];
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${name} must be hex`);
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

function actorIdValueToHex(value: unknown, label: string): Hex {
  if (typeof value === "string") return normalizeHex(value, label);
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return bytesToHex(Uint8Array.from(value.map((item) => Number(item))));
  throw new Error(`${label} returned unsupported ActorId shape: ${JSON.stringify(value)}`);
}

function parsePositiveInt(value: string | undefined, fallback: string, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function ethTransportFor(url: string) {
  return url.startsWith("ws") ? webSocket(url) : http(url);
}

function varaProviderFor(url: string, timeoutMs: number) {
  if (url.startsWith("ws")) {
    return new WsVaraEthProvider(url as `ws://${string}` | `wss://${string}`, { requestTimeout: timeoutMs });
  }
  return new HttpVaraEthProvider(url as `http://${string}` | `https://${string}`, { requestTimeout: timeoutMs });
}

async function connect(args: Args, timeoutMs: number): Promise<Connection> {
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

async function loadSailsFile(idlPath: string): Promise<SailsProgram> {
  if (!existsSync(idlPath)) throw new Error(`IDL file does not exist: ${idlPath}`);
  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(await readFile(idlPath, "utf8")));
}

async function loadSailsText(idl: string): Promise<SailsProgram> {
  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(idl));
}

function normalizeReplyCode(code: ReplyCode | string): Hex {
  return typeof code === "string" ? (code as Hex) : bytesToHex(code.toBytes());
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

async function queryPayload<T>(
  connection: Connection,
  programId: Address,
  payload: Hex,
  decode: (payload: Hex) => T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const reply = await withTimeout(
    connection.api.call.program.calculateReplyForHandle(connection.accountAddress, programId, payload, 0n),
    timeoutMs,
    label,
  );
  if (!reply) throw new Error(`${label} did not return`);
  assertSuccessReply(reply.code, reply.payload);
  if (!reply.payload) throw new Error(`${label} returned no payload`);
  return decode(reply.payload);
}

async function sendInjected<T>(
  connection: Connection,
  programId: Address,
  label: string,
  payload: Hex,
  decode: (payload: Hex) => T,
  validatorMode: ValidatorMode,
  promiseTimeoutMs: number,
) {
  const injected = await connection.api.createInjectedTransaction({ destination: programId, payload, value: 0n });
  validatorMode === "slot" ? await injected.setSlotValidator() : injected.setDefaultValidator();

  const startedAt = Date.now();
  const rawReply = await withTimeout(injected.sendAndWaitForPromise(), promiseTimeoutMs, `${label} injected promise`);
  const promiseMs = Date.now() - startedAt;
  const reply = unwrapInjectedPromise(rawReply, label);
  if (!reply) throw new Error(`${label} returned no reply`);
  assertSuccessReply(reply.code, reply.payload);

  const decoded = reply.payload ? decode(reply.payload) : null;
  console.log("[mint:tx]", JSON.stringify({
    label,
    destination: programId,
    txHash: injected.txHash,
    messageId: injected.messageId,
    promiseMs,
    replyCode: normalizeReplyCode(reply.code),
    decoded,
  }, (_, value) => (typeof value === "bigint" ? value.toString() : value)));

  return decoded;
}

function vecToBigInts(value: unknown): bigint[] {
  if (!Array.isArray(value)) throw new Error("expected vector result");
  return value.map((item) => BigInt(String(item)));
}

function agentFromResult(value: unknown): AgentView {
  const raw = vecToBigInts(value);
  if (raw.length < 13) throw new Error("World.AgentOf returned too few fields");
  return {
    bankedScrst: raw[8],
    bankedBcrst: raw[9],
    bankedHcrst: raw[10],
    lastActionSeq: raw[12],
  };
}

function bankedTotal(agent: AgentView): bigint {
  return agent.bankedScrst + agent.bankedBcrst + agent.bankedHcrst;
}

async function waitForMintedAgentState(
  connection: Connection,
  worldSails: SailsProgram,
  worldProgramId: Address,
  proxyActor: Hex,
  before: AgentView,
  timeoutMs: number,
  queryTimeoutMs: number,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const agent = await queryPayload(
      connection,
      worldProgramId,
      worldSails.services.World.queries.AgentOf.encodePayload(proxyActor) as Hex,
      (payload) => agentFromResult(worldSails.services.World.queries.AgentOf.decodeResult<unknown>(payload)),
      queryTimeoutMs,
      "World.AgentOf wait minted",
    );
    if (agent.lastActionSeq > before.lastActionSeq || bankedTotal(agent) < bankedTotal(before)) return agent;
    await sleep(2_000);
  }
  throw new Error("Timed out waiting for World.MintResources state change");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = parsePositiveInt(args.timeoutMs, DEFAULTS.DIGGER_EVENT_TIMEOUT_MS, "--timeout-ms");
  const promiseTimeoutMs = parsePositiveInt(args.promiseTimeoutMs, DEFAULTS.DIGGER_PROMISE_TIMEOUT_MS, "--promise-timeout-ms");
  const queryTimeoutMs = parsePositiveInt(args.queryTimeoutMs, DEFAULTS.DIGGER_QUERY_TIMEOUT_MS, "--query-timeout-ms");
  const validatorMode = (args.validatorMode || envValue("DIGGER_VALIDATOR_MODE") || DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;

  const worldProgramId = normalizeAddress(args.world || requireValue(envValue("DIGGER_PROGRAM_ID"), "DIGGER_PROGRAM_ID"), "world");
  const proxyProgramId = normalizeAddress(args.proxy || requireValue(envValue("DIGGER_PROXY_PROGRAM_ID"), "DIGGER_PROXY_PROGRAM_ID"), "proxy");
  const vmtProgramId = normalizeAddress(
    requireValue(args.vmt || envValue("DIGGER_RESOURCE_VMT"), "DIGGER_RESOURCE_VMT"),
    "vmt",
  );
  const worldActor = actorIdFromAddress(worldProgramId);
  const proxyActor = actorIdFromAddress(proxyProgramId);
  const vmtActor = actorIdFromAddress(vmtProgramId);

  const [worldSails, proxySails, vmtSails] = await Promise.all([
    loadSailsFile(WORLD_IDL_PATH),
    loadSailsFile(PROXY_IDL_PATH),
    loadSailsText(VMT_IDL),
  ]);
  const connection = await connect(args, timeoutMs);

  try {
    console.log("[mint:start]", {
      account: connection.accountAddress,
      worldProgramId,
      proxyProgramId,
      vmtProgramId,
      worldActor,
      proxyActor,
      vmtActor,
    });

    const ownerActor = await queryPayload(
      connection,
      proxyProgramId,
      proxySails.services.Digger.queries.Owner.encodePayload() as Hex,
      (payload) => actorIdValueToHex(proxySails.services.Digger.queries.Owner.decodeResult<unknown>(payload), "Proxy.Digger.Owner"),
      queryTimeoutMs,
      "Proxy.Digger.Owner",
    );
    console.log("[mint:proxy-owner]", { ownerActor });

    const isMinter = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Admin.queries.IsMinter.encodePayload(worldActor) as Hex,
      (payload) => vmtSails.services.Admin.queries.IsMinter.decodeResult<boolean>(payload),
      queryTimeoutMs,
      "VMT.Admin.IsMinter(world)",
    );
    console.log("[mint:minter:before]", { worldActor, isMinter });

    if (!isMinter) {
      await sendInjected(
        connection,
        vmtProgramId,
        "VMT.Admin.AddMinter(world)",
        vmtSails.services.Admin.functions.AddMinter.encodePayload(worldActor) as Hex,
        (payload) => vmtSails.services.Admin.functions.AddMinter.decodeResult<boolean>(payload),
        validatorMode,
        promiseTimeoutMs,
      );
    }

    const isMinterAfter = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Admin.queries.IsMinter.encodePayload(worldActor) as Hex,
      (payload) => vmtSails.services.Admin.queries.IsMinter.decodeResult<boolean>(payload),
      queryTimeoutMs,
      "VMT.Admin.IsMinter(world) after",
    );
    console.log("[mint:minter:after]", { worldActor, isMinter: isMinterAfter });

    const currentResourceVmt = await queryPayload(
      connection,
      worldProgramId,
      worldSails.services.Admin.queries.ResourceVmt.encodePayload() as Hex,
      (payload) => actorIdValueToHex(worldSails.services.Admin.queries.ResourceVmt.decodeResult<unknown>(payload), "World.Admin.ResourceVmt"),
      queryTimeoutMs,
      "World.Admin.ResourceVmt",
    );
    console.log("[mint:world-resource-vmt:before]", { currentResourceVmt });

    if (currentResourceVmt.toLowerCase() !== vmtActor.toLowerCase()) {
      await sendInjected(
        connection,
        worldProgramId,
        "World.Admin.SetResourceVmt",
        worldSails.services.Admin.functions.SetResourceVmt.encodePayload(vmtActor) as Hex,
        (payload) => actorIdValueToHex(worldSails.services.Admin.functions.SetResourceVmt.decodeResult<unknown>(payload), "SetResourceVmt"),
        validatorMode,
        promiseTimeoutMs,
      );
    }

    const resourceVmtAfter = await queryPayload(
      connection,
      worldProgramId,
      worldSails.services.Admin.queries.ResourceVmt.encodePayload() as Hex,
      (payload) => actorIdValueToHex(worldSails.services.Admin.queries.ResourceVmt.decodeResult<unknown>(payload), "World.Admin.ResourceVmt after"),
      queryTimeoutMs,
      "World.Admin.ResourceVmt after",
    );
    console.log("[mint:world-resource-vmt:after]", { resourceVmt: resourceVmtAfter });

    const agentBefore = await queryPayload(
      connection,
      worldProgramId,
      worldSails.services.World.queries.AgentOf.encodePayload(proxyActor) as Hex,
      (payload) => agentFromResult(worldSails.services.World.queries.AgentOf.decodeResult<unknown>(payload)),
      queryTimeoutMs,
      "World.AgentOf before",
    );
    console.log("[mint:agent:before]", {
      bankedScrst: agentBefore.bankedScrst.toString(),
      bankedBcrst: agentBefore.bankedBcrst.toString(),
      bankedHcrst: agentBefore.bankedHcrst.toString(),
      lastActionSeq: agentBefore.lastActionSeq.toString(),
    });

    const scrstTokenId = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.ScrstTokenId.encodePayload() as Hex,
      (payload) => BigInt(String(vmtSails.services.Vmt.queries.ScrstTokenId.decodeResult<unknown>(payload))),
      queryTimeoutMs,
      "VMT.ScrstTokenId",
    );
    const bcrstTokenId = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.BcrstTokenId.encodePayload() as Hex,
      (payload) => BigInt(String(vmtSails.services.Vmt.queries.BcrstTokenId.decodeResult<unknown>(payload))),
      queryTimeoutMs,
      "VMT.BcrstTokenId",
    );
    const hcrstTokenId = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.HcrstTokenId.encodePayload() as Hex,
      (payload) => BigInt(String(vmtSails.services.Vmt.queries.HcrstTokenId.decodeResult<unknown>(payload))),
      queryTimeoutMs,
      "VMT.HcrstTokenId",
    );

    const balanceOf = (tokenId: bigint, label: string) => queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.BalanceOf.encodePayload(ownerActor, tokenId) as Hex,
      (payload) => BigInt(String(vmtSails.services.Vmt.queries.BalanceOf.decodeResult<unknown>(payload))),
      queryTimeoutMs,
      label,
    );
    const balancesBefore = {
      scrst: await balanceOf(scrstTokenId, "VMT.BalanceOf SCRST before"),
      bcrst: await balanceOf(bcrstTokenId, "VMT.BalanceOf BCRST before"),
      hcrst: await balanceOf(hcrstTokenId, "VMT.BalanceOf HCRST before"),
    };
    console.log("[mint:vmt-balances:before]", {
      ownerActor,
      scrst: balancesBefore.scrst.toString(),
      bcrst: balancesBefore.bcrst.toString(),
      hcrst: balancesBefore.hcrst.toString(),
      tokenIds: {
        scrst: scrstTokenId.toString(),
        bcrst: bcrstTokenId.toString(),
        hcrst: hcrstTokenId.toString(),
      },
    });

    if (!args.noMint && bankedTotal(agentBefore) > 0n) {
      await sendInjected(
        connection,
        proxyProgramId,
        "Proxy.Digger.MintResources",
        proxySails.services.Digger.functions.MintResources.encodePayload() as Hex,
        (payload) => proxySails.services.Digger.functions.MintResources.decodeResult<unknown>(payload),
        validatorMode,
        promiseTimeoutMs,
      );

      const agentAfter = await waitForMintedAgentState(
        connection,
        worldSails,
        worldProgramId,
        proxyActor,
        agentBefore,
        timeoutMs,
        queryTimeoutMs,
      );
      console.log("[mint:agent:after]", {
        bankedScrst: agentAfter.bankedScrst.toString(),
        bankedBcrst: agentAfter.bankedBcrst.toString(),
        bankedHcrst: agentAfter.bankedHcrst.toString(),
        lastActionSeq: agentAfter.lastActionSeq.toString(),
      });
    }

    const balancesAfter = {
      scrst: await balanceOf(scrstTokenId, "VMT.BalanceOf SCRST after"),
      bcrst: await balanceOf(bcrstTokenId, "VMT.BalanceOf BCRST after"),
      hcrst: await balanceOf(hcrstTokenId, "VMT.BalanceOf HCRST after"),
    };
    console.log("[mint:vmt-balances:after]", {
      ownerActor,
      scrst: balancesAfter.scrst.toString(),
      bcrst: balancesAfter.bcrst.toString(),
      hcrst: balancesAfter.hcrst.toString(),
      delta: {
        scrst: (balancesAfter.scrst - balancesBefore.scrst).toString(),
        bcrst: (balancesAfter.bcrst - balancesBefore.bcrst).toString(),
        hcrst: (balancesAfter.hcrst - balancesBefore.hcrst).toString(),
      },
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
