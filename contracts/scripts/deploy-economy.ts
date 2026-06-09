#!/usr/bin/env tsx

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

const DEFAULTS = {
  ETHEREUM_RPC: "wss://hoodi-reth-rpc.gear-tech.io/ws",
  VARA_ETH_RPC: "wss://vara-eth-validator-1.gear-tech.io",
  ROUTER_ADDRESS: "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060",
  DIGGER_EVENT_TIMEOUT_MS: "180000",
  DIGGER_PROMISE_TIMEOUT_MS: "60000",
  DIGGER_ECONOMY_TOP_UP: "100000000000000",
  SCRST_RATE: "66",
  BCRST_RATE: "330",
  HCRST_RATE: "1650",
} as const;

const RES_IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_res_vmt.idl");
const RES_WASM_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_res_vmt.opt.wasm");
const REDEEM_IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_redeem.idl");
const REDEEM_WASM_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_redeem.opt.wasm");
const ZERO_ACTOR = `0x${"0".repeat(64)}` as Hex;

type CliArgs = {
  resCodeId?: string;
  redeemCodeId?: string;
  resProgram?: string;
  redeemProgram?: string;
  initialMinter?: string;
  addMinter?: string[];
  topUp?: string;
  reserveTopUp?: string;
  scrstRate?: string;
  bcrstRate?: string;
  hcrstRate?: string;
  smoke?: boolean;
  noSmoke?: boolean;
  manifest?: string;
  ethRpc?: string;
  varaRpc?: string;
  router?: string;
  privateKey?: string;
  timeoutMs?: string;
  promiseTimeoutMs?: string;
  dryRun?: boolean;
  skipBuild?: boolean;
  skipResInit?: boolean;
  skipRedeemInit?: boolean;
  skipLink?: boolean;
  help?: boolean;
};

type Connection = {
  api: VaraEthApi;
  accountAddress: Address;
  disconnect: () => Promise<void>;
};

type ContractSpec = {
  name: "res-vmt" | "redeem";
  codeIdEnv: string;
  wasmPath: string;
};

function printUsage() {
  console.log(`Usage:
  pnpm deploy-economy
  pnpm deploy-economy -- --reserve-top-up 1000000000000000 --smoke
  pnpm deploy-economy -- --res-code-id 0x... --redeem-code-id 0x...

Flow:
  1. Check built IDL/WASM artifacts.
  2. Resolve or upload/validate RES VMT and redeem code ids.
  3. Create res-vmt with placeholder redeem_contract=0x0 and initial minter.
  4. Create redeem with res_contract=res-vmt and configured rates.
  5. Initialize both programs.
  6. Configure res-vmt.redeem_contract = redeem.
  7. Add optional extra minter actors.
  8. Optionally fund redeem reserve and smoke mint/redeem.
  9. Write deployment manifest.

Inputs:
  --res-code-id          Existing validated digger-res-vmt code id. Defaults to DIGGER_RES_VMT_CODE_ID.
  --redeem-code-id       Existing validated digger-redeem code id. Defaults to DIGGER_REDEEM_CODE_ID.
  --res-program          Existing res-vmt mirror to resume instead of creating.
  --redeem-program       Existing redeem mirror to resume instead of creating.
  --skip-res-init        Do not call res-vmt Create when res-vmt already initialized.
  --skip-redeem-init     Do not call redeem Create when redeem already initialized.
  --skip-link            Do not call res-vmt.Admin.SetRedeemContract.
  --initial-minter       Initial RES minter. Defaults to signer address.
  --add-minter           Extra minter to add after deploy. Can be passed multiple times.
  --top-up               Initial executable balance for each created program.
  --reserve-top-up       Native value sent to redeem.deposit_reserve.
  --scrst-rate           Defaults to ${DEFAULTS.SCRST_RATE}.
  --bcrst-rate           Defaults to ${DEFAULTS.BCRST_RATE}.
  --hcrst-rate           Defaults to ${DEFAULTS.HCRST_RATE}.
  --smoke                Mint 1/1/1 RES to signer, then redeem it. Requires signer to be a minter and reserve to be funded.
  --no-smoke             Skip smoke even if --reserve-top-up is set.
  --manifest             Output manifest path. Defaults to deployments/digger-economy-<timestamp>.json.
  --skip-build           Do not run cargo build --release before checking artifacts.
  --dry-run              Resolve inputs and print plan without sending txs.

Environment:
  PRIVATE_KEY, ETHEREUM_RPC, VARA_ETH_RPC, ROUTER_ADDRESS
  DIGGER_RES_VMT_CODE_ID, DIGGER_REDEEM_CODE_ID
  DIGGER_ECONOMY_TOP_UP, DIGGER_REDEEM_RESERVE_TOP_UP
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
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--res-code-id":
        args.resCodeId = next();
        break;
      case "--redeem-code-id":
        args.redeemCodeId = next();
        break;
      case "--res-program":
        args.resProgram = next();
        break;
      case "--redeem-program":
        args.redeemProgram = next();
        break;
      case "--initial-minter":
        args.initialMinter = next();
        break;
      case "--add-minter":
        args.addMinter = [...(args.addMinter ?? []), next()];
        break;
      case "--top-up":
        args.topUp = next();
        break;
      case "--reserve-top-up":
        args.reserveTopUp = next();
        break;
      case "--scrst-rate":
        args.scrstRate = next();
        break;
      case "--bcrst-rate":
        args.bcrstRate = next();
        break;
      case "--hcrst-rate":
        args.hcrstRate = next();
        break;
      case "--smoke":
        args.smoke = true;
        break;
      case "--no-smoke":
        args.noSmoke = true;
        break;
      case "--manifest":
        args.manifest = next();
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
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-build":
        args.skipBuild = true;
        break;
      case "--skip-res-init":
        args.skipResInit = true;
        break;
      case "--skip-redeem-init":
        args.skipRedeemInit = true;
        break;
      case "--skip-link":
        args.skipLink = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeHex(value: string, name: string): Hex {
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`${name} must be hex`);
  return hex as Hex;
}

function normalizeHex32(value: string, name: string): Hex {
  const hex = normalizeHex(value, name);
  if (hex.length !== 66) throw new Error(`${name} must be 32 bytes`);
  return hex;
}

function normalizeAddress(value: string, name: string): Address {
  const hex = normalizeHex(value, name);

  if (hex.length === 66) {
    return `0x${hex.slice(-40)}` as Address;
  }

  if (hex.length !== 42) throw new Error(`${name} must be an Ethereum address`);
  return hex as Address;
}

function actorIdFromAddress(address: Address): Hex {
  return `0x${"0".repeat(24)}${address.slice(2)}` as Hex;
}

function normalizePrivateKey(value: string): Hex {
  return normalizeHex32(value, "PRIVATE_KEY");
}

function parseAmount(value: string | undefined, name: string): bigint {
  const raw = value ?? "0";
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer`);
  return BigInt(raw);
}

function parseU128(value: string | undefined, name: string): string {
  const raw = requireValue(value, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an unsigned integer`);
  return raw;
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function buildArtifacts(skipBuild: boolean) {
  if (skipBuild) {
    console.log("[build] skipped");
    return;
  }

  console.log("[build] cargo build --release");
  await runCommand("cargo", ["build", "--release"], ROOT);
}

function checkArtifacts() {
  const artifacts = [
    { label: "res-vmt IDL", path: RES_IDL_PATH },
    { label: "res-vmt WASM", path: RES_WASM_PATH },
    { label: "redeem IDL", path: REDEEM_IDL_PATH },
    { label: "redeem WASM", path: REDEEM_WASM_PATH },
  ];

  for (const artifact of artifacts) {
    if (!existsSync(artifact.path)) {
      throw new Error(`Missing ${artifact.label}: ${artifact.path}`);
    }
  }

  console.log("[artifacts] ready", Object.fromEntries(artifacts.map((artifact) => [artifact.label, artifact.path])));
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
  const ethRpc = args.ethRpc || envValue("ETHEREUM_RPC") || envValue("DIGGER_ETH_RPC") || DEFAULTS.ETHEREUM_RPC;
  const varaRpc = args.varaRpc || envValue("VARA_ETH_RPC") || envValue("DIGGER_VALIDATOR_RPC") || DEFAULTS.VARA_ETH_RPC;
  const router = normalizeAddress(args.router || envValue("ROUTER_ADDRESS") || envValue("DIGGER_ROUTER_ADDRESS") || DEFAULTS.ROUTER_ADDRESS, "ROUTER_ADDRESS");

  const account = privateKeyToAccount(privateKey, { nonceManager });
  const publicClient = createPublicClient({ transport: ethTransportFor(ethRpc) });
  const walletClient = createWalletClient({ transport: ethTransportFor(ethRpc), account });
  const provider = varaProviderFor(varaRpc, timeoutMs);
  const api = await createVaraEthApi(provider, publicClient, router, walletClientToSigner(walletClient));
  const accountAddress = (await api.eth.signer.getAddress()) as Address;

  return { api, accountAddress, disconnect: () => provider.disconnect() };
}

async function loadSails(idlPath: string): Promise<SailsProgram> {
  if (!existsSync(idlPath)) throw new Error(`IDL file does not exist: ${idlPath}`);
  const parser = new SailsIdlParser();
  await parser.init();
  const idl = await readFile(idlPath, "utf8");
  return new SailsProgram(parser.parse(idl));
}

function normalizeReplyCode(code: ReplyCode | string): Hex {
  return typeof code === "string" ? (code as Hex) : bytesToHex(code.toBytes());
}

function assertSuccessReply(code: ReplyCode | string) {
  const replyCode = typeof code === "string" ? ReplyCode.fromBytes(code as Hex) : code;
  if (!replyCode.isSuccess) {
    throw new Error(`program reply failed: ${normalizeReplyCode(code)} (${replyCode.reason})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForCodeState(api: VaraEthApi, codeId: Hex, expected: CodeState, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await api.eth.router.codeState(codeId);
    if (state === expected) return;
    await sleep(5_000);
  }
  const state = await api.eth.router.codeState(codeId);
  throw new Error(`Timed out waiting for code ${codeId}; expected=${codeStateName(expected)} current=${codeStateName(state)}`);
}

async function ensureCodeValidated(api: VaraEthApi, spec: ContractSpec, explicitCodeId: string | undefined, timeoutMs: number): Promise<Hex> {
  let codeId: Hex;
  if (explicitCodeId) {
    codeId = normalizeHex32(explicitCodeId, spec.codeIdEnv);
  } else if (envValue(spec.codeIdEnv)) {
    codeId = normalizeHex32(envValue(spec.codeIdEnv)!, spec.codeIdEnv);
  } else {
    if (!existsSync(spec.wasmPath)) throw new Error(`WASM artifact does not exist: ${spec.wasmPath}`);
    const wasm = new Uint8Array(await readFile(spec.wasmPath));
    codeId = normalizeHex32(generateCodeHash(wasm), `${spec.name} wasm code hash`);
  }

  const state = await api.eth.router.codeState(codeId);
  console.log("[code] state", { contract: spec.name, codeId, state: codeStateName(state) });
  if (state === CodeState.Validated) return codeId;
  if (state === CodeState.ValidationRequested) {
    await waitForCodeState(api, codeId, CodeState.Validated, timeoutMs);
    return codeId;
  }

  if (!existsSync(spec.wasmPath)) {
    throw new Error(`${spec.name} code is not validated and WASM artifact does not exist: ${spec.wasmPath}`);
  }

  const wasm = new Uint8Array(await readFile(spec.wasmPath));
  const [baseFee, accountAddress] = await Promise.all([
    api.eth.router.requestCodeValidationBaseFee(),
    api.eth.signer.getAddress(),
  ]);
  const validationFee = baseFee;
  const balance = await api.eth.wvara.balanceOf(accountAddress);
  if (balance < validationFee) {
    throw new Error(`Not enough WVARA for ${spec.name} validation: need ${validationFee}, balance ${balance}`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
  const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, validationFee, deadline);
  const tx = await api.eth.router.requestCodeValidation(wasm, deadline, signature);
  console.log("[code] requesting validation", {
    contract: spec.name,
    codeId: tx.codeId,
    validationFee: validationFee.toString(),
    baseFee: baseFee.toString(),
  });
  const receipt = await tx.sendAndWaitForReceipt();
  console.log("[code] validation tx", { contract: spec.name, txHash: receipt.transactionHash, status: receipt.status });
  await waitForCodeState(api, tx.codeId, CodeState.Validated, timeoutMs);
  return normalizeHex32(tx.codeId, `${spec.name} code id`);
}

async function createProgram(api: VaraEthApi, label: string, codeId: Hex, topUp: bigint): Promise<Address> {
  let builder = api.eth.router.createProgramBuilder(codeId);
  if (topUp > 0n) {
    const accountAddress = await api.eth.signer.getAddress();
    const balance = await api.eth.wvara.balanceOf(accountAddress);
    if (balance < topUp) throw new Error(`Not enough WVARA for ${label} top-up: need ${topUp}, balance ${balance}`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
    const { signature } = await api.eth.wvara.prepareAndSignPermitData(api.eth.router.address, topUp, deadline);
    builder = builder.withExecutableBalance(topUp, deadline, signature);
  }

  const tx = builder.build();
  const receipt = await tx.sendAndWaitForReceipt();
  const programId = normalizeAddress(await tx.getProgramId(), `${label} program id`);
  console.log("[deploy] createProgram", { label, programId, codeId, topUp: topUp.toString(), txHash: receipt.transactionHash, status: receipt.status });
  return programId;
}

async function sendMirrorMessage(
  api: VaraEthApi,
  programId: Address,
  label: string,
  payload: Hex,
  value: bigint,
  promiseTimeoutMs: number,
) {
  const mirror = getMirrorClient({ address: programId, publicClient: api.eth.publicClient, signer: api.eth.signer });
  const tx = await mirror.sendMessage(payload, value);
  const txHash = await tx.send();
  const receipt = await tx.getReceipt();
  const message = await tx.getMessage();
  console.log(`[${label}] sent`, { programId, txHash, messageId: message.id, value: value.toString() });

  const reply = await withTimeout(mirror.waitForReply(message.id, receipt.blockNumber), promiseTimeoutMs, `${label} reply`);
  if (reply) {
    console.log(`[${label}] reply`, { code: reply.replyCode, value: reply.value.toString() });
    assertSuccessReply(reply.replyCode);
  } else {
    console.warn(`[${label}] no reply observed before timeout`);
  }
  return reply;
}

async function writeManifest(manifestPath: string, manifest: unknown) {
  const outputPath = path.resolve(ROOT, manifestPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log("[manifest] wrote", { path: outputPath });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const timeoutMs = Number(args.timeoutMs || envValue("DIGGER_EVENT_TIMEOUT_MS") || DEFAULTS.DIGGER_EVENT_TIMEOUT_MS);
  const promiseTimeoutMs = Number(args.promiseTimeoutMs || envValue("DIGGER_PROMISE_TIMEOUT_MS") || DEFAULTS.DIGGER_PROMISE_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isFinite(promiseTimeoutMs) || promiseTimeoutMs <= 0) throw new Error("--promise-timeout-ms must be positive");

  const topUp = parseAmount(args.topUp || envValue("DIGGER_ECONOMY_TOP_UP") || DEFAULTS.DIGGER_ECONOMY_TOP_UP, "DIGGER_ECONOMY_TOP_UP");
  const reserveTopUp = parseAmount(args.reserveTopUp || envValue("DIGGER_REDEEM_RESERVE_TOP_UP"), "DIGGER_REDEEM_RESERVE_TOP_UP");
  const rates = {
    scrst: parseU128(args.scrstRate || envValue("SCRST_RATE") || DEFAULTS.SCRST_RATE, "SCRST_RATE"),
    bcrst: parseU128(args.bcrstRate || envValue("BCRST_RATE") || DEFAULTS.BCRST_RATE, "BCRST_RATE"),
    hcrst: parseU128(args.hcrstRate || envValue("HCRST_RATE") || DEFAULTS.HCRST_RATE, "HCRST_RATE"),
  };

  await buildArtifacts(Boolean(args.skipBuild));
  checkArtifacts();

  const resSails = await loadSails(RES_IDL_PATH);
  const redeemSails = await loadSails(REDEEM_IDL_PATH);
  const smoke = Boolean(args.smoke && !args.noSmoke);

  console.log("[economy] prepared", {
    topUp: topUp.toString(),
    reserveTopUp: reserveTopUp.toString(),
    rates,
    smoke,
    skipBuild: Boolean(args.skipBuild),
    dryRun: Boolean(args.dryRun),
  });
  if (args.dryRun) return;

  const connection = await connect(args, timeoutMs);
  try {
    console.log("[connect] account", connection.accountAddress);
    const initialMinter = normalizeAddress(args.initialMinter || connection.accountAddress, "--initial-minter");
    const extraMinters = (args.addMinter ?? []).map((value) => normalizeAddress(value, "--add-minter"));
    const initialMinterActor = actorIdFromAddress(initialMinter);
    const extraMinterActors = extraMinters.map(actorIdFromAddress);

    const resCodeId = args.resProgram
      ? normalizeHex32(await connection.api.eth.router.programCodeId(normalizeAddress(args.resProgram, "--res-program")), "res program code id")
      : await ensureCodeValidated(connection.api, { name: "res-vmt", codeIdEnv: "DIGGER_RES_VMT_CODE_ID", wasmPath: RES_WASM_PATH }, args.resCodeId, timeoutMs);
    const redeemCodeId = args.redeemProgram
      ? normalizeHex32(await connection.api.eth.router.programCodeId(normalizeAddress(args.redeemProgram, "--redeem-program")), "redeem program code id")
      : await ensureCodeValidated(connection.api, { name: "redeem", codeIdEnv: "DIGGER_REDEEM_CODE_ID", wasmPath: REDEEM_WASM_PATH }, args.redeemCodeId, timeoutMs);

    const resProgram = args.resProgram
      ? normalizeAddress(args.resProgram, "--res-program")
      : await createProgram(connection.api, "res-vmt", resCodeId, topUp);
    const redeemProgram = args.redeemProgram
      ? normalizeAddress(args.redeemProgram, "--redeem-program")
      : await createProgram(connection.api, "redeem", redeemCodeId, topUp);

    if (!args.skipResInit) {
      const createRes = resSails.ctors.Create.encodePayload(ZERO_ACTOR, initialMinterActor) as Hex;
      await sendMirrorMessage(connection.api, resProgram, "res.create", createRes, 0n, promiseTimeoutMs);
    }

    if (!args.skipRedeemInit) {
      const createRedeem = redeemSails.ctors.Create.encodePayload(actorIdFromAddress(resProgram), rates.scrst, rates.bcrst, rates.hcrst) as Hex;
      await sendMirrorMessage(connection.api, redeemProgram, "redeem.create", createRedeem, 0n, promiseTimeoutMs);
    }

    if (!args.skipLink) {
      const setRedeem = resSails.services.Admin.functions.SetRedeemContract.encodePayload(actorIdFromAddress(redeemProgram)) as Hex;
      await sendMirrorMessage(connection.api, resProgram, "res.set_redeem_contract", setRedeem, 0n, promiseTimeoutMs);
    }

    for (let i = 0; i < extraMinters.length; i += 1) {
      const minter = extraMinters[i];
      const addMinter = resSails.services.Admin.functions.AddMinter.encodePayload(extraMinterActors[i]) as Hex;
      await sendMirrorMessage(connection.api, resProgram, `res.add_minter.${minter}`, addMinter, 0n, promiseTimeoutMs);
    }

    if (reserveTopUp > 0n) {
      const deposit = redeemSails.services.Redeem.functions.DepositReserve.encodePayload() as Hex;
      await sendMirrorMessage(connection.api, redeemProgram, "redeem.deposit_reserve", deposit, reserveTopUp, promiseTimeoutMs);
    }

    if (smoke) {
      if (initialMinter.toLowerCase() !== connection.accountAddress.toLowerCase() && !extraMinters.some((m) => m.toLowerCase() === connection.accountAddress.toLowerCase())) {
        throw new Error("--smoke requires signer to be configured as an initial or extra minter");
      }
      const mint = resSails.services.Vmt.functions.MintResources.encodePayload(actorIdFromAddress(connection.accountAddress), "1", "1", "1") as Hex;
      await sendMirrorMessage(connection.api, resProgram, "smoke.res.mint_resources", mint, 0n, promiseTimeoutMs);
      const redeem = redeemSails.services.Redeem.functions.Redeem.encodePayload("1", "1", "1") as Hex;
      await sendMirrorMessage(connection.api, redeemProgram, "smoke.redeem.redeem", redeem, 0n, promiseTimeoutMs);
    }

    const manifestPath = args.manifest || `deployments/digger-economy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const manifest = {
      deployedAt: new Date().toISOString(),
      account: connection.accountAddress,
      resVmt: {
        programId: resProgram,
        actorId: actorIdFromAddress(resProgram),
        codeId: resCodeId,
        initialMinter,
        initialMinterActor,
        extraMinters,
        extraMinterActors,
        redeemContract: redeemProgram,
        redeemContractActor: actorIdFromAddress(redeemProgram),
      },
      redeem: {
        programId: redeemProgram,
        actorId: actorIdFromAddress(redeemProgram),
        codeId: redeemCodeId,
        resContract: resProgram,
        resContractActor: actorIdFromAddress(resProgram),
        rates,
        reserveTopUp: reserveTopUp.toString(),
      },
      smoke,
    };
    await writeManifest(manifestPath, manifest);
    console.log("[economy] complete", manifest);
  } finally {
    await connection.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[economy] failed", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
