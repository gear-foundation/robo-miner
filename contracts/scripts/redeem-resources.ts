#!/usr/bin/env tsx

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createVaraEthApi,
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
  DIGGER_PROMISE_TIMEOUT_MS: "90000",
  DIGGER_QUERY_TIMEOUT_MS: "60000",
  DIGGER_VALIDATOR_MODE: "default",
} as const;

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

const REDEEM_IDL = String.raw`
!@sails: 1.0.0-beta.5

service Redeem@0x9077a36884dff78d {
    events {
        RedeemCanceled(u128, [u8; 32], u128, u128, u128, u128),
        Redeemed([u8; 32], u128, u128, u128, u128),
        RedeemRequested(u128, [u8; 32], u128, u128, u128, u128),
        ReserveDeposited([u8; 32], u128, u128),
        ReserveSynced(u128, u128),
    }
    functions {
        @query
        AvailableReserve() -> u128 throws String;
        @query
        BcrstRate() -> u128 throws String;
        CancelRedeem(redeem_id: u128) throws String;
        ConfirmRedeem(redeem_id: u128) -> u128 throws String;
        @payable
        DepositReserve() -> u128 throws String;
        @query
        HcrstRate() -> u128 throws String;
        @query
        LockedBalance() -> u128 throws String;
        @query
        PendingRedeemCount() -> u128 throws String;
        Redeem(scrst: u128, bcrst: u128, hcrst: u128) -> u128 throws String;
        @query
        ReserveBalance() -> u128 throws String;
        @query
        ScrstRate() -> u128 throws String;
        @query
        TotalPaid() -> u128 throws String;
        @query
        TotalRedeemedBcrst() -> u128 throws String;
        @query
        TotalRedeemedHcrst() -> u128 throws String;
        @query
        TotalRedeemedScrst() -> u128 throws String;
    }
}

service Admin@0x55e01d646e511900 {
    events {
        AdminAdded([u8; 32]),
        AdminRemoved([u8; 32]),
        FundsWithdrawn([u8; 32], u128, u128),
        Paused([u8; 32]),
        RatesUpdated(u128, u128, u128),
        ResContractUpdated([u8; 32], [u8; 32]),
        Unpaused([u8; 32]),
    }
    functions {
        AddAdmin(admin: ActorId) -> bool throws String;
        @query
        Admins() -> [ActorId] throws String;
        @query
        IsAdmin(account: ActorId) -> bool throws String;
        @query
        IsPaused() -> bool throws String;
        Pause() throws String;
        RemoveAdmin(admin: ActorId) -> bool throws String;
        @query
        ResContract() -> ActorId throws String;
        SetRates(scrst_rate: u128, bcrst_rate: u128, hcrst_rate: u128) throws String;
        SetResContract(res_contract: ActorId) throws String;
        Unpause() throws String;
        @returns_value
        WithdrawFunds(amount: u128) throws String;
    }
}

program DiggerRedeem {
    constructors {
        Create(res_contract: ActorId, scrst_rate: u128, bcrst_rate: u128, hcrst_rate: u128);
    }
    services {
        Redeem@0x9077a36884dff78d,
        Admin@0x55e01d646e511900,
    }
}
`;

type ValidatorMode = "default" | "slot";

type Args = {
  proxy?: string;
  vmt?: string;
  redeem?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  promiseTimeoutMs?: string;
  queryTimeoutMs?: string;
  validatorMode?: ValidatorMode;
  noConfigure?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
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
      case "--proxy":
        args.proxy = next();
        break;
      case "--vmt":
        args.vmt = next();
        break;
      case "--redeem":
        args.redeem = next();
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
      case "--no-configure":
        args.noConfigure = true;
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
  throw new Error(`${label} returned unsupported ActorId shape`);
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

function parsePositiveInt(value: string | undefined, fallback: string, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
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

async function loadSails(idl: string): Promise<SailsProgram> {
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

  console.log("[redeem:tx]", JSON.stringify({
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

function bigintResult(program: SailsProgram, service: string, query: string, payload: Hex): bigint {
  return BigInt(String(program.services[service].queries[query].decodeResult<unknown>(payload)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promiseTimeoutMs = parsePositiveInt(args.promiseTimeoutMs, DEFAULTS.DIGGER_PROMISE_TIMEOUT_MS, "--promise-timeout-ms");
  const queryTimeoutMs = parsePositiveInt(args.queryTimeoutMs, DEFAULTS.DIGGER_QUERY_TIMEOUT_MS, "--query-timeout-ms");
  const validatorMode = (args.validatorMode || envValue("DIGGER_VALIDATOR_MODE") || DEFAULTS.DIGGER_VALIDATOR_MODE) as ValidatorMode;

  const proxyProgramId = normalizeAddress(args.proxy || requireValue(envValue("DIGGER_PROXY_PROGRAM_ID"), "DIGGER_PROXY_PROGRAM_ID"), "proxy");
  const vmtProgramId = normalizeAddress(
    requireValue(args.vmt || envValue("DIGGER_RESOURCE_VMT"), "DIGGER_RESOURCE_VMT"),
    "vmt",
  );
  const redeemProgramId = normalizeAddress(
    requireValue(args.redeem || envValue("DIGGER_REDEEM_PROGRAM_ID"), "DIGGER_REDEEM_PROGRAM_ID"),
    "redeem",
  );
  const proxyActor = actorIdFromAddress(proxyProgramId);
  const accountActor = actorIdFromAddress(normalizeAddress(envValue("ACCOUNT_ADDRESS") || "0xee98b6381b0a6a18a4a4e6d74355b015319a6809", "account"));
  const vmtActor = actorIdFromAddress(vmtProgramId);
  const redeemActor = actorIdFromAddress(redeemProgramId);

  const [vmtSails, redeemSails] = await Promise.all([loadSails(VMT_IDL), loadSails(REDEEM_IDL)]);
  const connection = await connect(args, queryTimeoutMs);

  try {
    const signerActor = actorIdFromAddress(connection.accountAddress);
    console.log("[redeem:start]", {
      account: connection.accountAddress,
      signerActor,
      proxyProgramId,
      proxyActor,
      vmtProgramId,
      vmtActor,
      redeemProgramId,
      redeemActor,
    });

    const vmtRedeemBefore = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Admin.queries.RedeemContract.encodePayload() as Hex,
      (payload) => actorIdValueToHex(vmtSails.services.Admin.queries.RedeemContract.decodeResult<unknown>(payload), "VMT.RedeemContract"),
      queryTimeoutMs,
      "VMT.Admin.RedeemContract",
    );
    const redeemResBefore = await queryPayload(
      connection,
      redeemProgramId,
      redeemSails.services.Admin.queries.ResContract.encodePayload() as Hex,
      (payload) => actorIdValueToHex(redeemSails.services.Admin.queries.ResContract.decodeResult<unknown>(payload), "Redeem.ResContract"),
      queryTimeoutMs,
      "Redeem.Admin.ResContract",
    );
    console.log("[redeem:config:before]", { vmtRedeemBefore, redeemResBefore });

    if (!args.noConfigure && vmtRedeemBefore.toLowerCase() !== redeemActor.toLowerCase()) {
      await sendInjected(
        connection,
        vmtProgramId,
        "VMT.Admin.SetRedeemContract",
        vmtSails.services.Admin.functions.SetRedeemContract.encodePayload(redeemActor) as Hex,
        () => null,
        validatorMode,
        promiseTimeoutMs,
      );
    }

    if (!args.noConfigure && redeemResBefore.toLowerCase() !== vmtActor.toLowerCase()) {
      await sendInjected(
        connection,
        redeemProgramId,
        "Redeem.Admin.SetResContract",
        redeemSails.services.Admin.functions.SetResContract.encodePayload(vmtActor) as Hex,
        () => null,
        validatorMode,
        promiseTimeoutMs,
      );
    }

    const vmtRedeemAfter = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Admin.queries.RedeemContract.encodePayload() as Hex,
      (payload) => actorIdValueToHex(vmtSails.services.Admin.queries.RedeemContract.decodeResult<unknown>(payload), "VMT.RedeemContract after"),
      queryTimeoutMs,
      "VMT.Admin.RedeemContract after",
    );
    const redeemResAfter = await queryPayload(
      connection,
      redeemProgramId,
      redeemSails.services.Admin.queries.ResContract.encodePayload() as Hex,
      (payload) => actorIdValueToHex(redeemSails.services.Admin.queries.ResContract.decodeResult<unknown>(payload), "Redeem.ResContract after"),
      queryTimeoutMs,
      "Redeem.Admin.ResContract after",
    );
    console.log("[redeem:config:after]", { vmtRedeemAfter, redeemResAfter });

    const scrstTokenId = await queryPayload(connection, vmtProgramId, vmtSails.services.Vmt.queries.ScrstTokenId.encodePayload() as Hex, (payload) => bigintResult(vmtSails, "Vmt", "ScrstTokenId", payload), queryTimeoutMs, "VMT.ScrstTokenId");
    const bcrstTokenId = await queryPayload(connection, vmtProgramId, vmtSails.services.Vmt.queries.BcrstTokenId.encodePayload() as Hex, (payload) => bigintResult(vmtSails, "Vmt", "BcrstTokenId", payload), queryTimeoutMs, "VMT.BcrstTokenId");
    const hcrstTokenId = await queryPayload(connection, vmtProgramId, vmtSails.services.Vmt.queries.HcrstTokenId.encodePayload() as Hex, (payload) => bigintResult(vmtSails, "Vmt", "HcrstTokenId", payload), queryTimeoutMs, "VMT.HcrstTokenId");

    const balanceOf = (owner: Hex, tokenId: bigint, label: string) => queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.BalanceOf.encodePayload(owner, tokenId) as Hex,
      (payload) => BigInt(String(vmtSails.services.Vmt.queries.BalanceOf.decodeResult<unknown>(payload))),
      queryTimeoutMs,
      label,
    );
    const proxyBalances = {
      scrst: await balanceOf(proxyActor, scrstTokenId, "VMT.BalanceOf proxy SCRST"),
      bcrst: await balanceOf(proxyActor, bcrstTokenId, "VMT.BalanceOf proxy BCRST"),
      hcrst: await balanceOf(proxyActor, hcrstTokenId, "VMT.BalanceOf proxy HCRST"),
    };
    const signerBalances = {
      scrst: await balanceOf(signerActor, scrstTokenId, "VMT.BalanceOf signer SCRST"),
      bcrst: await balanceOf(signerActor, bcrstTokenId, "VMT.BalanceOf signer BCRST"),
      hcrst: await balanceOf(signerActor, hcrstTokenId, "VMT.BalanceOf signer HCRST"),
    };
    console.log("[redeem:vmt-balances]", {
      tokenIds: { scrst: scrstTokenId.toString(), bcrst: bcrstTokenId.toString(), hcrst: hcrstTokenId.toString() },
      proxy: { scrst: proxyBalances.scrst.toString(), bcrst: proxyBalances.bcrst.toString(), hcrst: proxyBalances.hcrst.toString() },
      signer: { scrst: signerBalances.scrst.toString(), bcrst: signerBalances.bcrst.toString(), hcrst: signerBalances.hcrst.toString() },
    });

    const isProxyApproved = await queryPayload(
      connection,
      vmtProgramId,
      vmtSails.services.Vmt.queries.IsApproved.encodePayload(proxyActor, redeemActor) as Hex,
      (payload) => vmtSails.services.Vmt.queries.IsApproved.decodeResult<boolean>(payload),
      queryTimeoutMs,
      "VMT.IsApproved(proxy, redeem)",
    );
    console.log("[redeem:vmt-approval]", { proxyActor, redeemActor, isProxyApproved });

    const redeemState = {
      scrstRate: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.ScrstRate.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "ScrstRate", payload), queryTimeoutMs, "Redeem.ScrstRate"),
      bcrstRate: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.BcrstRate.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "BcrstRate", payload), queryTimeoutMs, "Redeem.BcrstRate"),
      hcrstRate: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.HcrstRate.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "HcrstRate", payload), queryTimeoutMs, "Redeem.HcrstRate"),
      reserve: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.ReserveBalance.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "ReserveBalance", payload), queryTimeoutMs, "Redeem.ReserveBalance"),
      availableReserve: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.AvailableReserve.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "AvailableReserve", payload), queryTimeoutMs, "Redeem.AvailableReserve"),
      locked: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.LockedBalance.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "LockedBalance", payload), queryTimeoutMs, "Redeem.LockedBalance"),
      pending: await queryPayload(connection, redeemProgramId, redeemSails.services.Redeem.queries.PendingRedeemCount.encodePayload() as Hex, (payload) => bigintResult(redeemSails, "Redeem", "PendingRedeemCount", payload), queryTimeoutMs, "Redeem.PendingRedeemCount"),
    };
    console.log("[redeem:state]", Object.fromEntries(
      Object.entries(redeemState).map(([key, value]) => [key, value.toString()]),
    ));

    console.log("[redeem:next]", {
      canRedeemNowFromSigner: signerBalances.scrst + signerBalances.bcrst + signerBalances.hcrst > 0n,
      proxyHasTokens: proxyBalances.scrst + proxyBalances.bcrst + proxyBalances.hcrst > 0n,
      note: "Current DiggerProxy has no Redeem/Approve forwarding method, so proxy-owned VMT cannot be redeemed until proxy is extended or tokens are minted/transferred to signer.",
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
