#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  HttpVaraEthProvider,
  WsVaraEthProvider,
  type BlockHeader,
  type BlockRequestEvent,
  type IVaraEthProvider,
  type StateTransition,
} from "@vara-eth/api";
import {
  normalizeBlockEvent,
  normalizeStateTransition,
} from "@vara-eth/api/util";
import { config as loadEnv } from "dotenv";
import { SailsProgram } from "sails-js";
import { SailsIdlParser } from "sails-js/parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

const DEFAULTS = {
  VARA_ETH_RPC: "wss://vara-eth-validator-1.gear-tech.io",
  REQUEST_TIMEOUT_MS: "30000",
  POLL_MS: "3000",
} as const;

const IDL_PATH = path.join(ROOT, "target/wasm32-gear/release/digger_world.idl");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Hex = `0x${string}`;

type CliArgs = {
  block?: string;
  program?: string;
  varaRpc?: string;
  timeoutMs?: string;
  pollMs?: string;
  limit?: string;
  idl?: string;
  service?: string;
  event?: string;
  latest?: boolean;
  watch?: boolean;
  json?: boolean;
  raw?: boolean;
  includeRouter?: boolean;
  includeAllPrograms?: boolean;
  latestComputedOutcome?: boolean;
  eventsOnly?: boolean;
  noRequests?: boolean;
  noOutcome?: boolean;
  help?: boolean;
};

type Variant = {
  name: string;
  value: unknown;
};

type ReaderEvent = {
  kind: "request" | "program-event";
  source: "block_events" | "block_outcome";
  actorId?: string;
  messageId?: string;
  destination?: string;
  name: string;
  data: unknown;
  payload?: Hex;
  decode?: unknown;
};

type BlockResult = {
  block: {
    hash: string;
    height: number;
    timestamp: number;
    parentHash: string;
  };
  programId?: string;
  requests: ReaderEvent[];
  programEvents: ReaderEvent[];
  outcomeSource?: string;
  outcomeError?: string;
};

function printUsage() {
  console.log(`Usage:
  pnpm run events -- --latest
  pnpm run events -- --block <varaEthBlockHash>
  pnpm run events:watch
  pnpm run world-events

Options:
  --block, -b        Read events for an exact Vara.eth block hash.
  --latest          Read the latest synced/computed block. Default when no mode is given.
  --watch           Poll latest block and print new blocks.
  --program, -p     Digger Mirror address. Defaults to DIGGER_PROGRAM_ID.
  --vara-rpc        Vara.eth RPC endpoint. Defaults to VARA_ETH_RPC.
  --timeout-ms      JSON-RPC request timeout. Default ${DEFAULTS.REQUEST_TIMEOUT_MS}.
  --poll-ms         Watch poll interval. Default ${DEFAULTS.POLL_MS}.
  --limit           Max blocks to print in --watch mode. 0 means unlimited.
  --idl             Sails IDL path. Defaults to ${path.relative(ROOT, IDL_PATH)}.
  --service         Only print program events from this Sails service, e.g. World.
  --event           Only print this Sails event name, e.g. AgentMoved.
  --json            Print one JSON object per block.
  --raw             Include raw payload hex in decoded records.
  --include-router  Include all Router request events from block_events.
  --include-all-programs
                    Do not filter Mirror/outcome events by DIGGER_PROGRAM_ID.
  --latest-computed-outcome
                    Read block_outcome without a block hash: latest computed announce.
                    Useful for subscriptions when synced head is ahead of compute.
  --events-only     In watch mode, print only when filtered events are found.
  --no-requests     Skip block_events.
  --no-outcome      Skip block_outcome.

Environment:
  DIGGER_PROGRAM_ID Current Digger Mirror address.
  VARA_ETH_RPC      Vara.eth validator RPC.
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const mutableArgs = args as Record<string, string | boolean | undefined>;
  const aliases: Record<string, keyof CliArgs> = {
    b: "block",
    p: "program",
    h: "help",
  };
  const booleanFlags = new Set<keyof CliArgs>([
    "latest",
    "watch",
    "json",
    "raw",
    "includeRouter",
    "includeAllPrograms",
    "latestComputedOutcome",
    "eventsOnly",
    "noRequests",
    "noOutcome",
    "help",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (!arg.startsWith("-")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [flagPart, inlineValue] = arg.split("=", 2);
    const rawName = flagPart.replace(/^-+/, "");
    const camelName = rawName.replace(/-([a-z])/g, (_, char: string) =>
      char.toUpperCase(),
    );
    const name = aliases[camelName] ?? (camelName as keyof CliArgs);

    if (!isKnownArg(name)) {
      throw new Error(`Unknown option: ${flagPart}`);
    }

    if (booleanFlags.has(name)) {
      mutableArgs[name] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flagPart}`);
    }
    index += inlineValue === undefined ? 1 : 0;
    mutableArgs[name] = value;
  }

  return args;
}

function isKnownArg(name: keyof CliArgs | string): name is keyof CliArgs {
  return [
    "block",
    "program",
    "varaRpc",
    "timeoutMs",
    "pollMs",
    "limit",
    "idl",
    "service",
    "event",
    "latest",
    "watch",
    "json",
    "raw",
    "includeRouter",
    "includeAllPrograms",
    "latestComputedOutcome",
    "eventsOnly",
    "noRequests",
    "noOutcome",
    "help",
  ].includes(name);
}

function normalizeHex(value: string): Hex {
  const hex = value.trim().toLowerCase();
  return (hex.startsWith("0x") ? hex : `0x${hex}`) as Hex;
}

function normalizeActorAddress(value: string): string {
  const hex = normalizeHex(value);
  return hex.length === 66 ? (`0x${hex.slice(-40)}` as Hex) : hex;
}

function isZeroAddress(value: string): boolean {
  return normalizeActorAddress(value) === ZERO_ADDRESS;
}

function compactAddress(value: string): string {
  const hex = normalizeHex(value);
  if (hex.length <= 18) {
    return hex;
  }
  return `${hex.slice(0, 10)}...${hex.slice(-6)}`;
}

function numberArrayToHex(bytes: number[]): Hex {
  return `0x${bytes
    .map((byte) => {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`Invalid byte in payload: ${byte}`);
      }
      return byte.toString(16).padStart(2, "0");
    })
    .join("")}` as Hex;
}

function getVariant(value: unknown): Variant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length !== 1) {
    return null;
  }

  const [name, variantValue] = entries[0];
  return { name, value: variantValue };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got ${value}`);
  }
  return parsed;
}

function createProvider(rpcUrl: string, timeoutMs: number): IVaraEthProvider {
  if (rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://")) {
    return new HttpVaraEthProvider(rpcUrl as `http://${string}`, {
      requestTimeout: timeoutMs,
    });
  }

  return new WsVaraEthProvider(rpcUrl, {
    autoConnect: false,
    requestTimeout: timeoutMs,
  });
}

async function loadSails(idlPath: string): Promise<SailsProgram> {
  const idl = await readFile(idlPath, "utf8");
  const parser = new SailsIdlParser();
  await parser.init();
  return new SailsProgram(parser.parse(idl));
}

async function readHeader(
  provider: IVaraEthProvider,
  timeoutMs: number,
  blockHash?: string,
): Promise<BlockHeader> {
  const params = blockHash ? [normalizeHex(blockHash)] : [];
  const response = await provider.send<[string, Omit<BlockHeader, "hash">]>(
    "block_header",
    params,
    { timeout: timeoutMs },
  );

  return {
    hash: normalizeHex(response[0]),
    ...response[1],
  };
}

async function readBlockEvents(
  provider: IVaraEthProvider,
  timeoutMs: number,
  blockHash: string,
): Promise<BlockRequestEvent[]> {
  const events = await provider.send<BlockRequestEvent[]>(
    "block_events",
    [normalizeHex(blockHash)],
    { timeout: timeoutMs },
  );
  events.forEach(normalizeBlockEvent);
  return events;
}

async function readBlockOutcome(
  provider: IVaraEthProvider,
  timeoutMs: number,
  blockHash?: string,
): Promise<StateTransition[]> {
  const parameters = blockHash ? [normalizeHex(blockHash)] : [];
  const transitions = await provider.send<StateTransition[]>(
    "block_outcome",
    parameters,
    { timeout: timeoutMs },
  );
  transitions.forEach(normalizeStateTransition);
  return transitions;
}

function decodeCall(sails: SailsProgram, payload: Hex): unknown {
  const decoded = sails.decodeCall(payload);
  if (
    decoded.kind === "call" &&
    (decoded.entry.kind === "command" || decoded.entry.kind === "query")
  ) {
    return {
      service: decoded.entry.service,
      function: decoded.entry.fn,
      args: decoded.args,
    };
  }

  return {
    kind: "unknown",
    reason: decoded.kind === "unknown" ? decoded.reason : "entry-mismatch",
    detail:
      decoded.kind === "unknown"
        ? decoded.detail
        : `unexpected entry kind: ${decoded.entry.kind}`,
  };
}

function decodeProgramEvent(sails: SailsProgram, payload: Hex): unknown {
  const decoded = sails.decodeEvent(payload);
  if (decoded.kind === "event" && decoded.entry.kind === "event") {
    return {
      service: decoded.entry.service,
      event: decoded.entry.event,
      data: decoded.data,
    };
  }

  return {
    kind: "unknown",
    reason: decoded.kind === "unknown" ? decoded.reason : "entry-mismatch",
    detail:
      decoded.kind === "unknown"
        ? decoded.detail
        : `unexpected entry kind: ${decoded.entry.kind}`,
  };
}

function collectRequestEvents(
  events: BlockRequestEvent[],
  sails: SailsProgram,
  programId: string | undefined,
  args: CliArgs,
): ReaderEvent[] {
  const result: ReaderEvent[] = [];

  for (const event of events) {
    const outer = getVariant(event);
    if (!outer) {
      continue;
    }

    if (outer.name === "Router") {
      const router = getVariant(outer.value);
      if (!router) {
        continue;
      }

      const data = asRecord(router.value);
      const actorId =
        typeof data.actorId === "string"
          ? normalizeActorAddress(data.actorId)
          : undefined;
      const isCurrentProgram = programId && actorId === programId;

      if (!args.includeRouter && !isCurrentProgram) {
        continue;
      }

      result.push({
        kind: "request",
        source: "block_events",
        actorId,
        name: `Router.${router.name}`,
        data: jsonSafe(router.value),
      });
      continue;
    }

    if (outer.name !== "Mirror") {
      continue;
    }

    const mirror = asRecord(outer.value);
    const actorId =
      typeof mirror.actorId === "string"
        ? normalizeActorAddress(mirror.actorId)
        : undefined;

    if (!args.includeAllPrograms && programId && actorId !== programId) {
      continue;
    }

    const mirrorEvent = getVariant(mirror.event);
    if (!mirrorEvent) {
      continue;
    }

    const data = asRecord(mirrorEvent.value);
    let payload: Hex | undefined;
    let decode: unknown;
    if (Array.isArray(data.payload)) {
      payload = numberArrayToHex(data.payload);
      decode = decodeCall(sails, payload);
    }

    result.push({
      kind: "request",
      source: "block_events",
      actorId,
      name: `Mirror.${mirrorEvent.name}`,
      data: jsonSafe(mirrorEvent.value),
      ...(payload && args.raw ? { payload } : {}),
      ...(decode ? { decode: jsonSafe(decode) } : {}),
    });
  }

  return result;
}

function collectProgramEvents(
  transitions: StateTransition[],
  sails: SailsProgram,
  programId: string | undefined,
  args: CliArgs,
): ReaderEvent[] {
  const result: ReaderEvent[] = [];

  for (const transition of transitions) {
    const actorId = normalizeActorAddress(transition.actorId);
    if (!args.includeAllPrograms && programId && actorId !== programId) {
      continue;
    }

    for (const message of transition.messages ?? []) {
      const destination = normalizeActorAddress(message.destination);
      if (!isZeroAddress(destination)) {
        continue;
      }

      const payload = numberArrayToHex(message.payload);
      const decoded = decodeProgramEvent(sails, payload);
      const decodedRecord = asRecord(decoded);
      const service =
        typeof decodedRecord.service === "string" ? decodedRecord.service : "Unknown";
      const eventName =
        typeof decodedRecord.event === "string" ? decodedRecord.event : "Undecoded";
      if (
        args.service &&
        service.toLowerCase() !== args.service.toLowerCase()
      ) {
        continue;
      }
      if (args.event && eventName.toLowerCase() !== args.event.toLowerCase()) {
        continue;
      }

      const data = "data" in decodedRecord ? decodedRecord.data : decoded;

      result.push({
        kind: "program-event",
        source: "block_outcome",
        actorId,
        messageId: message.id,
        destination,
        name: `${service}.${eventName}`,
        data: jsonSafe(data),
        ...(args.raw ? { payload } : {}),
      });
    }
  }

  return result;
}

async function readBlock(
  provider: IVaraEthProvider,
  sails: SailsProgram,
  args: CliArgs,
  timeoutMs: number,
  blockHash?: string,
): Promise<BlockResult> {
  const header = await readHeader(provider, timeoutMs, blockHash);
  const programId = args.program
    ? normalizeActorAddress(args.program)
    : process.env.DIGGER_PROGRAM_ID
      ? normalizeActorAddress(process.env.DIGGER_PROGRAM_ID)
      : undefined;

  if (!programId && !args.includeAllPrograms) {
    throw new Error(
      "DIGGER_PROGRAM_ID is required unless --include-all-programs is passed",
    );
  }

  const requests = args.noRequests
    ? []
    : collectRequestEvents(
        await readBlockEvents(provider, timeoutMs, header.hash),
        sails,
        programId,
        args,
      );

  let programEvents: ReaderEvent[] = [];
  let outcomeError: string | undefined;
  const outcomeSource = args.latestComputedOutcome
    ? "latest-computed"
    : `block:${header.hash}`;
  if (!args.noOutcome) {
    try {
      programEvents = collectProgramEvents(
        await readBlockOutcome(
          provider,
          timeoutMs,
          args.latestComputedOutcome ? undefined : header.hash,
        ),
        sails,
        programId,
        args,
      );
    } catch (error) {
      outcomeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    block: {
      hash: header.hash,
      height: header.height,
      timestamp: header.timestamp,
      parentHash: header.parentHash,
    },
    programId,
    requests,
    programEvents,
    outcomeSource,
    ...(outcomeError ? { outcomeError } : {}),
  };
}

function timestampLabel(timestamp: number): string {
  const millis = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const iso = Number.isFinite(millis) ? new Date(millis).toISOString() : "n/a";
  return `${timestamp} (${iso})`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(jsonSafe(value), null, 2);
}

function printHuman(result: BlockResult) {
  console.log(
    `Block ${result.block.hash} height=${result.block.height} timestamp=${timestampLabel(
      result.block.timestamp,
    )}`,
  );
  if (result.programId) {
    console.log(`Program ${result.programId}`);
  }
  if (result.outcomeSource) {
    console.log(`Outcome ${result.outcomeSource}`);
  }

  printEventGroup("Requests", result.requests);
  printEventGroup("Program events", result.programEvents);

  if (result.outcomeError) {
    console.log(`Outcome unavailable: ${result.outcomeError}`);
  }
}

function printEventGroup(title: string, events: ReaderEvent[]) {
  if (events.length === 0) {
    console.log(`${title}: none`);
    return;
  }

  console.log(`${title}:`);
  for (const event of events) {
    const actor = event.actorId ? ` actor=${compactAddress(event.actorId)}` : "";
    const message = event.messageId
      ? ` msg=${compactAddress(event.messageId)}`
      : "";
    console.log(`- ${event.name}${actor}${message}`);
    console.log(`  data=${formatJson(event.data)}`);
    if (event.decode) {
      console.log(`  decode=${formatJson(event.decode)}`);
    }
    if (event.payload) {
      console.log(`  payload=${event.payload}`);
    }
  }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return numberArrayToHex([...value]);
  }

  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }

  if (typeof value === "object") {
    const object: Record<string, unknown> = {};
    for (const [key, objectValue] of Object.entries(value)) {
      object[key] = jsonSafe(objectValue);
    }
    return object;
  }

  return String(value);
}

function printJson(result: BlockResult) {
  console.log(JSON.stringify(jsonSafe(result)));
}

function dedupeProgramEvents(
  events: ReaderEvent[],
  seen: Set<string>,
): ReaderEvent[] {
  return events.filter((event) => {
    const key =
      event.messageId ??
      `${event.actorId ?? ""}:${event.name}:${JSON.stringify(event.data)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasPrintableEvents(result: BlockResult): boolean {
  return result.requests.length > 0 || result.programEvents.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.block && args.watch) {
    throw new Error("--block and --watch cannot be used together");
  }

  const timeoutMs = parseNumber(
    args.timeoutMs ?? process.env.DIGGER_QUERY_TIMEOUT_MS,
    Number(DEFAULTS.REQUEST_TIMEOUT_MS),
  );
  const pollMs = parseNumber(args.pollMs, Number(DEFAULTS.POLL_MS));
  const limit = parseNumber(args.limit, 0);
  const rpcUrl =
    args.varaRpc ?? process.env.VARA_ETH_RPC ?? DEFAULTS.VARA_ETH_RPC;
  const idlPath = args.idl ? path.resolve(args.idl) : IDL_PATH;

  const provider = createProvider(rpcUrl, timeoutMs);
  await provider.connect();

  try {
    const sails = await loadSails(idlPath);

    if (args.watch) {
      let inspected = 0;
      let lastHash: string | undefined;
      const seenProgramEventKeys = new Set<string>();
      while (limit === 0 || inspected < limit) {
        const header = await readHeader(provider, timeoutMs);
        if (args.latestComputedOutcome || header.hash !== lastHash) {
          lastHash = header.hash;
          const result = await readBlock(
            provider,
            sails,
            args,
            timeoutMs,
            header.hash,
          );
          result.programEvents = dedupeProgramEvents(
            result.programEvents,
            seenProgramEventKeys,
          );
          if (!args.eventsOnly || hasPrintableEvents(result)) {
            args.json ? printJson(result) : printHuman(result);
          }
          inspected += 1;
        }
        if (limit === 0 || inspected < limit) {
          await sleep(pollMs);
        }
      }
      return;
    }

    const result = await readBlock(
      provider,
      sails,
      args,
      timeoutMs,
      args.block,
    );
    args.json ? printJson(result) : printHuman(result);
  } finally {
    await provider.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
