#!/usr/bin/env tsx

import process from "node:process";

import {
  createVaraEthApi,
  WsVaraEthProvider,
  type StateTransition,
} from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";
import { config as loadEnv } from "dotenv";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  webSocket,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

import { ingestFreshOutcomeMessages } from "./leaderboard-ingest.js";
import { unwrapInjectedPromise } from "./injected-reply.js";

loadEnv({ quiet: true });

const OWNER = "0xee98b6381b0a6a18a4a4e6d74355b015319a6809" as Hex;
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

const DIRECTIONS = [
  { name: "up", value: 0, dx: 0, dy: -1 },
  { name: "right", value: 1, dx: 1, dy: 0 },
  { name: "down", value: 2, dx: 0, dy: 1 },
  { name: "left", value: 3, dx: -1, dy: 0 },
] as const;
const CURRENT_DIRECTION = { name: "current", value: 4, dx: 0, dy: 0 } as const;

type DirectionInfo = (typeof DIRECTIONS)[number] | typeof CURRENT_DIRECTION;
type ActionFunctionName =
  | "adminStartSession"
  | "adminResetMap"
  | "worldRegister"
  | "worldDrill"
  | "worldMoveAgent"
  | "worldPlaceLadder"
  | "worldSurface"
  | "worldMintResources";
type ResourceTile = typeof TILE_RESOURCE_SCRST | typeof TILE_RESOURCE_BCRST | typeof TILE_RESOURCE_HCRST;

const WORLD_HEADER_PREFIX = "0x474d0110c947eba8a499d9a7";
const ADMIN_HEADER_PREFIX = "0x474d01105acb75662050b164";
const sailsHeader = (prefix: string, route: number, entry = 1): Hex =>
  `${prefix}${route.toString(16).padStart(2, "0")}${entry.toString(16).padStart(4, "0")}` as Hex;

const SAILS_WORLD = {
  AgentOf: sailsHeader(WORLD_HEADER_PREFIX, 0),
  IsDug: sailsHeader(WORLD_HEADER_PREFIX, 6),
  MapSnapshot: sailsHeader(WORLD_HEADER_PREFIX, 7),
  Session: sailsHeader(WORLD_HEADER_PREFIX, 13),
} as const;

const SAILS_WORLD_EVENTS = {
  AgentDied: sailsHeader(WORLD_HEADER_PREFIX, 0),
  AgentExited: sailsHeader(WORLD_HEADER_PREFIX, 1),
  AgentMoved: sailsHeader(WORLD_HEADER_PREFIX, 2),
  AgentRegistered: sailsHeader(WORLD_HEADER_PREFIX, 3),
  AgentSpawned: sailsHeader(WORLD_HEADER_PREFIX, 4),
  AgentSurfaced: sailsHeader(WORLD_HEADER_PREFIX, 5),
  LadderPlaced: sailsHeader(WORLD_HEADER_PREFIX, 6),
  ResourceExtracted: sailsHeader(WORLD_HEADER_PREFIX, 7),
  ResourcesMinted: sailsHeader(WORLD_HEADER_PREFIX, 8),
  SessionStarted: sailsHeader(WORLD_HEADER_PREFIX, 9),
  StoneMoved: sailsHeader(WORLD_HEADER_PREFIX, 10),
  TileDrilled: sailsHeader(WORLD_HEADER_PREFIX, 11),
} as const;

const SAILS_ADMIN_EVENTS = {
  Killed: sailsHeader(ADMIN_HEADER_PREFIX, 0, 2),
  MapGenerated: sailsHeader(ADMIN_HEADER_PREFIX, 1, 2),
  ResourceVmtUpdated: sailsHeader(ADMIN_HEADER_PREFIX, 2, 2),
  SessionFinished: sailsHeader(ADMIN_HEADER_PREFIX, 3, 2),
  SessionStarted: sailsHeader(ADMIN_HEADER_PREFIX, 4, 2),
} as const;

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
] as const;

const SESSION_FIELD_ORDER = ["sessionId", "seed", "status", "actionSeq"] as const;

const ABI = parseAbi([
  "function adminStartSession(bool _callReply) returns (bytes32)",
  "function adminResetMap(bool _callReply, uint64 seed) returns (bytes32)",
  "function worldRegister(bool _callReply, address owner) returns (bytes32)",
  "function worldDrill(bool _callReply, uint32 direction) returns (bytes32)",
  "function worldMoveAgent(bool _callReply, uint32 direction) returns (bytes32)",
  "function worldPlaceLadder(bool _callReply, uint32 direction) returns (bytes32)",
  "function worldSurface(bool _callReply) returns (bytes32)",
  "function worldMintResources(bool _callReply) returns (bytes32)",
  "function replyOn_adminStartSession(bytes32 messageId, uint128[] reply)",
  "function replyOn_adminResetMap(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldRegister(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldDrill(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldMoveAgent(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldPlaceLadder(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldSurface(bytes32 messageId, uint128[] reply)",
  "function replyOn_worldMintResources(bytes32 messageId, uint128[] reply)",
  "function onErrorReply(bytes32 messageId, bytes payload, bytes4 replyCode)",
]);

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
  capacity: number;
  lastActionSeq: number;
};

type SessionView = {
  sessionId: number;
  seed: number;
  status: number;
  actionSeq: number;
};

type WorldEvent =
  | { name: "AgentDied"; sessionId: string; owner: Hex; x: number; y: number; tile: number }
  | { name: "AgentExited"; sessionId: string; owner: Hex }
  | { name: "AgentMoved"; sessionId: string; owner: Hex; fromX: number; fromY: number; toX: number; toY: number }
  | { name: "AgentRegistered"; sessionId: string; owner: Hex }
  | { name: "AgentSpawned"; sessionId: string; owner: Hex; x: number; y: number }
  | { name: "AgentSurfaced"; sessionId: string; owner: Hex; bankedScrst: number; bankedBcrst: number; bankedHcrst: number }
  | { name: "LadderPlaced"; sessionId: string; owner: Hex; x: number; y: number; laddersRemaining: number }
  | { name: "ResourceExtracted"; sessionId: string; owner: Hex; x: number; y: number; resource: number; carriedTotal: number }
  | { name: "ResourcesMinted"; sessionId: string; owner: Hex; scrst: number; bcrst: number; hcrst: number }
  | { name: "SessionStarted"; sessionId: string }
  | { name: "StoneMoved"; sessionId: string; owner: Hex; fromX: number; fromY: number; toX: number; toY: number }
  | { name: "TileDrilled"; sessionId: string; owner: Hex; x: number; y: number; oldTile: number; newTile: number };

type AdminEvent =
  | { name: "Killed"; inheritor: Hex }
  | { name: "MapGenerated"; sessionId: string; seed: string }
  | { name: "ResourceVmtUpdated"; previous: Hex; next: Hex }
  | { name: "SessionFinished"; sessionId: string }
  | { name: "SessionStarted"; sessionId: string };

type ResourcePlan = {
  path: DirectionInfo[];
  resourceDirection: DirectionInfo;
  resource: { x: number; y: number; tile: number };
  cost: number;
};

type ReturnSafety = {
  safe: boolean;
  reason: string;
  laddersNeeded: number;
  laddersAvailable: number;
  pathNames: string[];
};

type PlanSafety = ReturnSafety & {
  checkedActions: number;
  failedAction?: PlannedAction;
};

type PlannedAction = {
  functionName: ActionFunctionName;
  direction?: DirectionInfo;
  target?: { x: number; y: number };
  tile?: number;
  seed?: bigint;
  reason: string;
  resource?: { x: number; y: number; tile: number };
  remainingPath: string[];
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseSeed(value: string | undefined, fallback: bigint, label: string): bigint {
  if (!value) return fallback;
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 2n ** 64n - 1n) throw new Error(`${label} must fit into u64`);
  return parsed;
}

function actorIdFromAddress(address: Hex): Hex {
  return `0x${"00".repeat(12)}${address.slice(2)}` as Hex;
}

function normalizeAddress(value: string): Hex {
  const normalized = value.toLowerCase();
  return normalized.length === 66 ? (`0x${normalized.slice(-40)}` as Hex) : (normalized as Hex);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

function byteArrayToHex(bytes: number[]): Hex {
  return `0x${bytes.map((byte) => Number(byte).toString(16).padStart(2, "0")).join("")}` as Hex;
}

function requireBytes(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (offset + length > bytes.length) throw new Error(`${label} payload ended unexpectedly`);
}

function readU32(bytes: Uint8Array, offset: number, label: string): number {
  requireBytes(bytes, offset, 4, label);
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  );
}

function readU64String(bytes: Uint8Array, offset: number, label: string): string {
  requireBytes(bytes, offset, 8, label);
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[offset + index]);
  }
  return value.toString();
}

function readActorId(bytes: Uint8Array, offset: number, label: string): Hex {
  requireBytes(bytes, offset, 32, label);
  return byteArrayToHex([...bytes.subarray(offset, offset + 32)]);
}

function stripEventHeader(payload: Hex, header: Hex): Uint8Array | null {
  const normalizedPayload = payload.toLowerCase();
  const normalizedHeader = header.toLowerCase();
  if (!normalizedPayload.startsWith(normalizedHeader)) return null;
  return hexToBytes(`0x${normalizedPayload.slice(normalizedHeader.length)}`);
}

function hexToUtf8Text(payload: Hex): string | undefined {
  try {
    const text = Buffer.from(payload.slice(2), "hex").toString("utf8").replace(/\0/g, "").trim();
    if (!text) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function readCompactLength(bytes: Uint8Array): { length: number; offset: number } {
  const mode = bytes[0] & 0b11;
  if (mode === 0) return { length: bytes[0] >> 2, offset: 1 };
  if (mode === 1) return { length: (bytes[0] | (bytes[1] << 8)) >> 2, offset: 2 };
  if (mode === 2) {
    return {
      length: ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 2),
      offset: 4,
    };
  }
  throw new Error("unsupported large compact length");
}

function decodeVecU32(payload: Hex, header: Hex): number[] {
  const bytes = hexToBytes(stripHeader(payload, header));
  const { length, offset } = readCompactLength(bytes);
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const start = offset + index * 4;
    values.push(
      bytes[start] |
        (bytes[start + 1] << 8) |
        (bytes[start + 2] << 16) |
        (bytes[start + 3] * 0x1000000),
    );
  }
  return values;
}

function decodeVecU128(payload: Hex, header: Hex): bigint[] {
  const bytes = hexToBytes(stripHeader(payload, header));
  const { length, offset } = readCompactLength(bytes);
  const values: bigint[] = [];
  for (let index = 0; index < length; index += 1) {
    const start = offset + index * 16;
    let value = 0n;
    for (let byte = 15; byte >= 0; byte -= 1) {
      value = (value << 8n) + BigInt(bytes[start + byte]);
    }
    values.push(value);
  }
  return values;
}

function stripHeader(payload: Hex, header: Hex): Hex {
  if (!payload.toLowerCase().startsWith(header.toLowerCase())) {
    throw new Error(`unexpected header ${payload.slice(0, 34)}`);
  }
  return `0x${payload.slice(header.length)}` as Hex;
}

function agentFromView(view: bigint[]): AgentView {
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
    capacity: Number(view[11]),
    lastActionSeq: Number(view[12]),
  };
}

function sessionFromView(view: bigint[]): SessionView {
  return {
    sessionId: Number(view[0]),
    seed: Number(view[1]),
    status: Number(view[2]),
    actionSeq: Number(view[3]),
  };
}

function tileAt(map: number[], x: number, y: number): number {
  return map[y * MAP_WIDTH + x] ?? TILE_EMPTY;
}

function indexOf(x: number, y: number): number {
  return y * MAP_WIDTH + x;
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT;
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

function isResource(tile: number): boolean {
  return tile === TILE_RESOURCE_SCRST || tile === TILE_RESOURCE_BCRST || tile === TILE_RESOURCE_HCRST;
}

function resourceTileName(tile: number | null | undefined): string {
  if (tile === TILE_RESOURCE_SCRST) return "SCRST";
  if (tile === TILE_RESOURCE_BCRST) return "BCRST";
  if (tile === TILE_RESOURCE_HCRST) return "HCRST/gold";
  return "any";
}

function parseResourceTile(value: string | undefined): ResourceTile | null {
  if (!value || value.toLowerCase() === "any") return null;
  const normalized = value.toLowerCase();
  if (normalized === "scrst" || normalized === "green") return TILE_RESOURCE_SCRST;
  if (normalized === "bcrst" || normalized === "blue") return TILE_RESOURCE_BCRST;
  if (normalized === "hcrst" || normalized === "gold" || normalized === "yellow") return TILE_RESOURCE_HCRST;
  throw new Error(`Unknown resource ${value}; use any, scrst, bcrst, hcrst, or gold`);
}

function isTraversable(tile: number): boolean {
  return tile === TILE_EMPTY || tile === TILE_SURFACE || tile === TILE_LADDER;
}

function carried(agent: AgentView): number {
  return agent.invScrst + agent.invBcrst + agent.invHcrst;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function targetPosition(x: number, y: number, direction: DirectionInfo): { x: number; y: number } | null {
  const target = { x: x + direction.dx, y: y + direction.dy };
  return inBounds(target.x, target.y) ? target : null;
}

function canMoveInto(map: number[], x: number, y: number, direction: DirectionInfo): boolean {
  const target = targetPosition(x, y, direction);
  if (!target) return false;

  const currentTile = tileAt(map, x, y);
  const targetTile = tileAt(map, target.x, target.y);
  if (isResource(targetTile)) return false;
  if (direction.name === "up" && currentTile !== TILE_LADDER && targetTile !== TILE_LADDER) return false;

  return isTraversable(targetTile) || targetTile === TILE_DIRT || targetTile === TILE_STONE || targetTile === TILE_CHEST;
}

function movementCost(tile: number): number {
  if (isTraversable(tile)) return 1;
  if (isDrillable(tile)) return 2;
  return Number.POSITIVE_INFINITY;
}

function findResourcePlans(agent: AgentView, map: number[], targetResource: ResourceTile | null): ResourcePlan[] {
  const cellCount = MAP_WIDTH * MAP_HEIGHT;
  const startIndex = indexOf(agent.x, agent.y);
  const distances = Array<number>(cellCount).fill(Number.POSITIVE_INFINITY);
  const previous = Array<{ from: number; direction: DirectionInfo } | null>(cellCount).fill(null);
  const queue = new Set<number>([startIndex]);

  distances[startIndex] = 0;

  while (queue.size > 0) {
    let currentIndex = -1;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const candidate of queue) {
      if (distances[candidate] < currentDistance) {
        currentIndex = candidate;
        currentDistance = distances[candidate];
      }
    }

    if (currentIndex < 0) break;
    queue.delete(currentIndex);

    const x = currentIndex % MAP_WIDTH;
    const y = Math.floor(currentIndex / MAP_WIDTH);
    for (const direction of DIRECTIONS) {
      if (!canMoveInto(map, x, y, direction)) continue;
      const target = targetPosition(x, y, direction);
      if (!target) continue;

      const targetIndex = indexOf(target.x, target.y);
      const nextDistance = currentDistance + movementCost(tileAt(map, target.x, target.y));
      if (nextDistance < distances[targetIndex]) {
        distances[targetIndex] = nextDistance;
        previous[targetIndex] = { from: currentIndex, direction };
        queue.add(targetIndex);
      }
    }
  }

  const plans: ResourcePlan[] = [];

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const tile = tileAt(map, x, y);
      if (!isResource(tile)) continue;
      if (targetResource !== null && tile !== targetResource) continue;

      for (const resourceDirection of DIRECTIONS) {
        const standX = x - resourceDirection.dx;
        const standY = y - resourceDirection.dy;
        if (!inBounds(standX, standY)) continue;

        const standIndex = indexOf(standX, standY);
        if (!Number.isFinite(distances[standIndex])) continue;

        const cost = distances[standIndex] + 1;
        const path = reconstructPath(previous, startIndex, standIndex);
        if (!path) continue;

        plans.push({
          path,
          resourceDirection,
          resource: { x, y, tile },
          cost,
        });
      }
    }
  }

  plans.sort((left, right) => left.cost - right.cost);
  return plans;
}

function findNearestResourcePlan(agent: AgentView, map: number[], targetResource: ResourceTile | null): ResourcePlan | null {
  return findResourcePlans(agent, map, targetResource)[0] ?? null;
}

function reconstructPath(
  previous: Array<{ from: number; direction: DirectionInfo } | null>,
  startIndex: number,
  endIndex: number,
): DirectionInfo[] | null {
  const path: DirectionInfo[] = [];
  let cursor = endIndex;
  while (cursor !== startIndex) {
    const step = previous[cursor];
    if (!step) return null;
    path.push(step.direction);
    cursor = step.from;
  }
  path.reverse();
  return path;
}

function findSurfacePath(agent: AgentView, map: number[]): DirectionInfo[] | null {
  const startIndex = indexOf(agent.x, agent.y);
  const previous = Array<{ from: number; direction: DirectionInfo } | null>(MAP_WIDTH * MAP_HEIGHT).fill(null);
  const visited = new Set<number>([startIndex]);
  const queue = [startIndex];

  while (queue.length > 0) {
    const currentIndex = queue.shift();
    if (currentIndex === undefined) break;

    const x = currentIndex % MAP_WIDTH;
    const y = Math.floor(currentIndex / MAP_WIDTH);
    if (y === 0) return reconstructPath(previous, startIndex, currentIndex);

    for (const direction of DIRECTIONS) {
      const target = targetPosition(x, y, direction);
      if (!target) continue;
      if (!isTraversable(tileAt(map, target.x, target.y))) continue;

      const targetIndex = indexOf(target.x, target.y);
      if (visited.has(targetIndex)) continue;
      visited.add(targetIndex);
      previous[targetIndex] = { from: currentIndex, direction };
      queue.push(targetIndex);
    }
  }

  return null;
}

function requiredLaddersForPath(agent: AgentView, map: number[], path: DirectionInfo[]): number {
  let x = agent.x;
  let y = agent.y;
  let needed = 0;

  for (const direction of path) {
    const target = targetPosition(x, y, direction);
    if (!target) return Number.POSITIVE_INFINITY;

    const currentTile = tileAt(map, x, y);
    const targetTile = tileAt(map, target.x, target.y);
    if (direction.name === "up" && currentTile !== TILE_LADDER && targetTile !== TILE_LADDER) {
      needed += 1;
    }

    x = target.x;
    y = target.y;
  }

  return needed;
}

function surfaceReturnPlan(agent: AgentView, map: number[]) {
  const path = findSurfacePath(agent, map);
  if (!path) return null;

  return {
    path,
    pathNames: path.map((step) => step.name),
    laddersNeeded: requiredLaddersForPath(agent, map, path),
  };
}

function mapWithTile(map: number[], x: number, y: number, tile: number): number[] {
  const nextMap = [...map];
  nextMap[indexOf(x, y)] = tile;
  return nextMap;
}

function simulateActionForReturnSafety(
  agent: AgentView,
  map: number[],
  action: PlannedAction,
): { agent: AgentView; map: number[] } | null {
  if (action.functionName === "worldMoveAgent") {
    if (!action.target) return null;
    return { agent: { ...agent, x: action.target.x, y: action.target.y }, map };
  }

  if (action.functionName === "worldDrill") {
    if (!action.target) return null;
    const targetTile = tileAt(map, action.target.x, action.target.y);
    if (!isDrillable(targetTile)) return null;
    return { agent, map: mapWithTile(map, action.target.x, action.target.y, TILE_EMPTY) };
  }

  if (action.functionName === "worldPlaceLadder") {
    const target = action.target ?? { x: agent.x, y: agent.y };
    if (agent.ladders <= 0) return null;
    return {
      agent: { ...agent, ladders: agent.ladders - 1 },
      map: mapWithTile(map, target.x, target.y, TILE_LADDER),
    };
  }

  return { agent, map };
}

function returnSafetyAfterAction(agent: AgentView, map: number[], action: PlannedAction): ReturnSafety {
  const simulated = simulateActionForReturnSafety(agent, map, action);
  if (!simulated) {
    return {
      safe: false,
      reason: "action cannot be simulated",
      laddersNeeded: Number.POSITIVE_INFINITY,
      laddersAvailable: agent.ladders,
      pathNames: [] as string[],
    };
  }

  const returnPlan = surfaceReturnPlan(simulated.agent, simulated.map);
  if (!returnPlan) {
    return {
      safe: false,
      reason: "no open path back to surface after action",
      laddersNeeded: Number.POSITIVE_INFINITY,
      laddersAvailable: simulated.agent.ladders,
      pathNames: [] as string[],
    };
  }

  return {
    safe: returnPlan.laddersNeeded <= simulated.agent.ladders,
    reason: returnPlan.laddersNeeded <= simulated.agent.ladders ? "return path remains funded" : "return path needs more ladders",
    laddersNeeded: returnPlan.laddersNeeded,
    laddersAvailable: simulated.agent.ladders,
    pathNames: returnPlan.pathNames,
  };
}

function plannedActionForDirection(
  agent: AgentView,
  map: number[],
  direction: DirectionInfo,
  reason: string,
  resource?: { x: number; y: number; tile: number },
): PlannedAction | null {
  const target = targetPosition(agent.x, agent.y, direction);
  if (!target) return null;
  if (!canMoveInto(map, agent.x, agent.y, direction)) return null;

  const tile = tileAt(map, target.x, target.y);
  if (isDrillable(tile)) {
    return {
      functionName: "worldDrill",
      direction,
      target,
      tile,
      reason,
      resource,
      remainingPath: [],
    };
  }

  if (!isTraversable(tile)) return null;

  return {
    functionName: "worldMoveAgent",
    direction,
    target,
    tile,
    reason,
    resource,
    remainingPath: [],
  };
}

function failedPlanSafety(reason: string, agent: AgentView, failedAction?: PlannedAction): PlanSafety {
  return {
    safe: false,
    reason,
    laddersNeeded: Number.POSITIVE_INFINITY,
    laddersAvailable: agent.ladders,
    pathNames: [],
    checkedActions: 0,
    failedAction,
  };
}

function returnSafetyForResourcePlan(agent: AgentView, map: number[], plan: ResourcePlan): PlanSafety {
  let simulatedAgent = agent;
  let simulatedMap = map;
  let checkedActions = 0;

  const checkAndApply = (action: PlannedAction): PlanSafety | null => {
    const safety = returnSafetyAfterAction(simulatedAgent, simulatedMap, action);
    checkedActions += 1;
    if (!safety.safe) {
      return {
        ...safety,
        checkedActions,
        failedAction: action,
      };
    }

    const simulated = simulateActionForReturnSafety(simulatedAgent, simulatedMap, action);
    if (!simulated) {
      return {
        safe: false,
        reason: "action cannot be simulated",
        laddersNeeded: Number.POSITIVE_INFINITY,
        laddersAvailable: simulatedAgent.ladders,
        pathNames: [],
        checkedActions,
        failedAction: action,
      };
    }

    simulatedAgent = simulated.agent;
    simulatedMap = simulated.map;
    return null;
  };

  for (const direction of plan.path) {
    const firstAction = plannedActionForDirection(simulatedAgent, simulatedMap, direction, "validate path", plan.resource);
    if (!firstAction) return failedPlanSafety("path step cannot be planned", simulatedAgent);

    if (firstAction.functionName === "worldDrill") {
      const drillFailure = checkAndApply(firstAction);
      if (drillFailure) return drillFailure;
    }

    const moveAction = plannedActionForDirection(simulatedAgent, simulatedMap, direction, "validate movement", plan.resource);
    if (!moveAction || moveAction.functionName !== "worldMoveAgent") {
      return failedPlanSafety("path step cannot move after drilling", simulatedAgent, moveAction ?? undefined);
    }

    const moveFailure = checkAndApply(moveAction);
    if (moveFailure) return moveFailure;
  }

  const target = targetPosition(simulatedAgent.x, simulatedAgent.y, plan.resourceDirection);
  if (!target || target.x !== plan.resource.x || target.y !== plan.resource.y) {
    return failedPlanSafety("resource target changed during plan simulation", simulatedAgent);
  }

  const resourceTile = tileAt(simulatedMap, target.x, target.y);
  if (!isResource(resourceTile)) return failedPlanSafety("resource is no longer drillable", simulatedAgent);

  const resourceAction: PlannedAction = {
    functionName: "worldDrill",
    direction: plan.resourceDirection,
    target,
    tile: resourceTile,
    reason: "validate resource extraction",
    resource: plan.resource,
    remainingPath: [],
  };
  const resourceFailure = checkAndApply(resourceAction);
  if (resourceFailure) return resourceFailure;

  const finalReturn = surfaceReturnPlan(simulatedAgent, simulatedMap);
  if (!finalReturn) return failedPlanSafety("no open path back to surface after full plan", simulatedAgent);

  return {
    safe: finalReturn.laddersNeeded <= simulatedAgent.ladders,
    reason: finalReturn.laddersNeeded <= simulatedAgent.ladders
      ? "full route keeps a funded return path"
      : "full route needs more ladders than available",
    laddersNeeded: finalReturn.laddersNeeded,
    laddersAvailable: simulatedAgent.ladders,
    pathNames: finalReturn.pathNames,
    checkedActions,
  };
}

function findReturnSafeResourcePlan(
  agent: AgentView,
  map: number[],
  targetResource: ResourceTile | null,
): {
  plan: ResourcePlan;
  action: PlannedAction;
  actionSafety: ReturnSafety;
  planSafety: PlanSafety;
  skippedUnsafe: number;
} | null {
  let skippedUnsafe = 0;

  for (const plan of findResourcePlans(agent, map, targetResource)) {
    const planSafety = returnSafetyForResourcePlan(agent, map, plan);
    if (!planSafety.safe) {
      skippedUnsafe += 1;
      continue;
    }

    const action = chooseAction(agent, map, plan);
    const actionSafety = returnSafetyAfterAction(agent, map, action);
    if (actionSafety.safe) return { plan, action, actionSafety, planSafety, skippedUnsafe };
    skippedUnsafe += 1;
  }

  return null;
}

function chooseAction(agent: AgentView, map: number[], plan: ResourcePlan): PlannedAction {
  const direction = plan.path[0] ?? plan.resourceDirection;
  const target = targetPosition(agent.x, agent.y, direction);
  if (!target) throw new Error(`planned ${direction.name} target is outside map bounds`);

  const tile = tileAt(map, target.x, target.y);
  const functionName = isDrillable(tile) ? "worldDrill" : "worldMoveAgent";
  if (functionName === "worldMoveAgent" && !isTraversable(tile)) {
    throw new Error(`planned move target is not traversable: ${JSON.stringify({ target, tile })}`);
  }

  return {
    functionName,
    direction,
    target,
    tile,
    reason: isResource(tile) ? "extract resource" : functionName === "worldDrill" ? "open path" : "advance",
    resource: plan.resource,
    remainingPath: plan.path.map((step) => step.name),
  };
}

function isResourceExtractionAction(action: PlannedAction): boolean {
  return action.functionName === "worldDrill" && isResource(action.tile ?? TILE_EMPTY);
}

function chooseSurfaceAction(agent: AgentView, map: number[]): PlannedAction {
  if (agent.y === 0) {
    return {
      functionName: "worldSurface",
      reason: "bank carried resources on surface",
      remainingPath: [],
    };
  }

  const path = findSurfacePath(agent, map);
  if (!path || path.length === 0) {
    throw new Error(`no open path from ${agent.x},${agent.y} to surface`);
  }

  const direction = path[0];
  const target = targetPosition(agent.x, agent.y, direction);
  if (!target) throw new Error(`surface path target is outside map bounds`);

  const currentTile = tileAt(map, agent.x, agent.y);
  const targetTile = tileAt(map, target.x, target.y);
  if (direction.name === "up" && currentTile !== TILE_LADDER && targetTile !== TILE_LADDER) {
    return {
      functionName: "worldPlaceLadder",
      direction: CURRENT_DIRECTION,
      target: { x: agent.x, y: agent.y },
      tile: currentTile,
      reason: "place ladder before upward move",
      remainingPath: path.map((step) => step.name),
    };
  }

  return {
    functionName: "worldMoveAgent",
    direction,
    target,
    tile: targetTile,
    reason: "return to surface",
    remainingPath: path.map((step) => step.name),
  };
}

function resourceSummary(map: number[], targetResource: ResourceTile | null, agent?: AgentView) {
  const counts = {
    scrst: 0,
    bcrst: 0,
    hcrst: 0,
  };
  const targetTiles: Array<{ x: number; y: number; tile: number; name: string }> = [];
  const currentColumnTargetTiles: Array<{ x: number; y: number; tile: number; name: string }> = [];

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const tile = tileAt(map, x, y);
      if (tile === TILE_RESOURCE_SCRST) counts.scrst += 1;
      if (tile === TILE_RESOURCE_BCRST) counts.bcrst += 1;
      if (tile === TILE_RESOURCE_HCRST) counts.hcrst += 1;
      if (!isResource(tile)) continue;
      if (targetResource !== null && tile !== targetResource) continue;

      const entry = { x, y, tile, name: resourceTileName(tile) };
      targetTiles.push(entry);
      if (agent && x === agent.x) currentColumnTargetTiles.push(entry);
    }
  }

  return {
    counts,
    targetCount: targetTiles.length,
    targetSample: targetTiles.slice(0, 30),
    currentColumnTargetTiles,
    currentColumnTargetTilesAboveAgent: agent
      ? currentColumnTargetTiles.filter((tile) => tile.y < agent.y)
      : [],
    currentColumnTargetTilesBelowAgent: agent
      ? currentColumnTargetTiles.filter((tile) => tile.y > agent.y)
      : [],
  };
}

function decodeWorldEvent(payload: Hex) {
  for (const [name, header] of Object.entries(SAILS_WORLD_EVENTS)) {
    const bytes = stripEventHeader(payload, header as Hex);
    if (!bytes) continue;

    const label = `World.${name}`;
    const sessionId = readU64String(bytes, 0, label);
    if (name === "SessionStarted") {
      return {
        source: "block_outcome zero-destination message",
        header,
        decodeRule: "Sails World event payload = header + u64 sessionId",
        fields: { name, sessionId } satisfies WorldEvent,
      };
    }

    const owner = readActorId(bytes, 8, label);
    let offset = 40;
    const nextU32 = () => {
      const value = readU32(bytes, offset, label);
      offset += 4;
      return value;
    };

    let fields: WorldEvent | null = null;
    switch (name) {
      case "AgentDied":
        fields = { name, sessionId, owner, x: nextU32(), y: nextU32(), tile: nextU32() };
        break;
      case "AgentExited":
        fields = { name, sessionId, owner };
        break;
      case "AgentMoved":
        fields = { name, sessionId, owner, fromX: nextU32(), fromY: nextU32(), toX: nextU32(), toY: nextU32() };
        break;
      case "AgentRegistered":
        fields = { name, sessionId, owner };
        break;
      case "AgentSpawned":
        fields = { name, sessionId, owner, x: nextU32(), y: nextU32() };
        break;
      case "AgentSurfaced":
        fields = { name, sessionId, owner, bankedScrst: nextU32(), bankedBcrst: nextU32(), bankedHcrst: nextU32() };
        break;
      case "LadderPlaced":
        fields = { name, sessionId, owner, x: nextU32(), y: nextU32(), laddersRemaining: nextU32() };
        break;
      case "ResourceExtracted":
        fields = { name, sessionId, owner, x: nextU32(), y: nextU32(), resource: nextU32(), carriedTotal: nextU32() };
        break;
      case "ResourcesMinted":
        fields = { name, sessionId, owner, scrst: nextU32(), bcrst: nextU32(), hcrst: nextU32() };
        break;
      case "StoneMoved":
        fields = { name, sessionId, owner, fromX: nextU32(), fromY: nextU32(), toX: nextU32(), toY: nextU32() };
        break;
      case "TileDrilled":
        fields = { name, sessionId, owner, x: nextU32(), y: nextU32(), oldTile: nextU32(), newTile: nextU32() };
        break;
      default:
        fields = null;
    }

    if (!fields) return null;
    return {
      source: "block_outcome zero-destination message",
      header,
      decodeRule: "Sails World event payload = header + u64 sessionId + [u8;32] owner + event-specific u32 fields",
      fields,
    };
  }
  return null;
}

function decodeAdminEvent(payload: Hex) {
  for (const [name, header] of Object.entries(SAILS_ADMIN_EVENTS)) {
    const bytes = stripEventHeader(payload, header as Hex);
    if (!bytes) continue;

    const label = `Admin.${name}`;
    let fields: AdminEvent | null = null;
    switch (name) {
      case "Killed":
        fields = { name, inheritor: readActorId(bytes, 0, label) };
        break;
      case "MapGenerated":
        fields = { name, sessionId: readU64String(bytes, 0, label), seed: readU64String(bytes, 8, label) };
        break;
      case "ResourceVmtUpdated":
        fields = { name, previous: readActorId(bytes, 0, label), next: readActorId(bytes, 32, label) };
        break;
      case "SessionFinished":
      case "SessionStarted": {
        const sessionId = readU64String(bytes, 0, label);
        fields = { name, sessionId };
        break;
      }
      default:
        fields = null;
    }

    if (!fields) return null;
    return {
      source: "block_outcome zero-destination message",
      header,
      decodeRule: "Sails Admin event payload = header + event-specific u64 fields",
      fields,
    };
  }
  return null;
}

function decodeProgramEvent(payload: Hex) {
  return decodeWorldEvent(payload) ?? decodeAdminEvent(payload);
}

async function readSession(api: Awaited<ReturnType<typeof createVaraEthApi>>, programId: Hex): Promise<SessionView> {
  const reply = await api.call.program.calculateReplyForHandle(OWNER, programId, SAILS_WORLD.Session, 0n);
  return sessionFromView(decodeVecU128(reply.payload, SAILS_WORLD.Session));
}

async function readAgent(api: Awaited<ReturnType<typeof createVaraEthApi>>, programId: Hex): Promise<AgentView> {
  const ownerActor = actorIdFromAddress(OWNER);
  const reply = await api.call.program.calculateReplyForHandle(
    OWNER,
    programId,
    `${SAILS_WORLD.AgentOf}${ownerActor.slice(2)}` as Hex,
    0n,
  );
  return agentFromView(decodeVecU128(reply.payload, SAILS_WORLD.AgentOf));
}

async function readAgentAndMap(api: Awaited<ReturnType<typeof createVaraEthApi>>, programId: Hex) {
  const [agentReply, mapReply] = await Promise.all([
    readAgent(api, programId),
    api.call.program.calculateReplyForHandle(OWNER, programId, SAILS_WORLD.MapSnapshot, 0n),
  ]);

  return {
    agent: agentReply,
    map: decodeVecU32(mapReply.payload, SAILS_WORLD.MapSnapshot),
  };
}

async function waitForSessionActive(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  programId: Hex,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let latest = await readSession(api, programId);
  while (Date.now() - startedAt < timeoutMs) {
    if (latest.status === SESSION_ACTIVE) return { session: latest, synced: true, reason: "session active" };
    await sleep(2_000);
    latest = await readSession(api, programId);
  }
  return { session: latest, synced: false, reason: "timeout" };
}

async function waitForSessionSeed(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  programId: Hex,
  seed: bigint,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  const expectedSeed = Number(seed);
  let latest = await readSession(api, programId);
  while (Date.now() - startedAt < timeoutMs) {
    if (latest.seed === expectedSeed && latest.actionSeq === 0) {
      return { session: latest, synced: true, reason: "seed/actionSeq matched" };
    }
    await sleep(2_000);
    latest = await readSession(api, programId);
  }
  return { session: latest, synced: false, reason: "timeout" };
}

async function waitForRegisteredAgent(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  programId: Hex,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastError: string | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return { agent: await readAgent(api, programId), synced: true, reason: "agent registered" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(2_000);
    }
  }
  throw new Error(`Timed out waiting for registered agent${lastError ? `: ${lastError}` : ""}`);
}

async function waitForSyncedActionState(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  programId: Hex,
  before: AgentView,
  action: PlannedAction,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let latest = await readAgentAndMap(api, programId);

  while (Date.now() - startedAt < timeoutMs) {
    const seqAdvanced = latest.agent.lastActionSeq > before.lastActionSeq;
    const surfaced =
      action.functionName === "worldSurface" &&
      (latest.agent.status === 2 ||
        latest.agent.bankedScrst > before.bankedScrst ||
        latest.agent.bankedBcrst > before.bankedBcrst ||
        latest.agent.bankedHcrst > before.bankedHcrst);

    const targetTile = action.target ? tileAt(latest.map, action.target.x, action.target.y) : undefined;
    const movedToTarget = action.target &&
      action.functionName === "worldMoveAgent" &&
      latest.agent.x === action.target.x &&
      latest.agent.y === action.target.y;
    const targetOpened = action.functionName === "worldDrill" && targetTile === TILE_EMPTY;
    const ladderPlaced = action.functionName === "worldPlaceLadder" && targetTile === TILE_LADDER;
    const inventoryChanged = carried(latest.agent) > carried(before);
    const actionSynced =
      action.functionName === "worldSurface"
        ? seqAdvanced && surfaced
        : action.functionName === "worldMoveAgent"
          ? seqAdvanced && movedToTarget
          : action.functionName === "worldDrill"
            ? seqAdvanced && (targetOpened || inventoryChanged)
            : action.functionName === "worldPlaceLadder"
              ? seqAdvanced && ladderPlaced
              : seqAdvanced;

    if (actionSynced) {
      return {
        ...latest,
        synced: true,
        reason: surfaced
          ? "agent surfaced"
          : movedToTarget
            ? "agent reached target"
            : targetOpened
              ? "target opened"
              : ladderPlaced
                ? "ladder placed"
                : inventoryChanged
                  ? "inventory changed"
                  : "seq advanced",
      };
    }

    await sleep(2_000);
    latest = await readAgentAndMap(api, programId);
  }

  return { ...latest, synced: false, reason: "timeout" };
}

async function primeSeenMessages(
  provider: WsVaraEthProvider,
  programId: Hex,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const transitions = await provider.send<StateTransition[]>("block_outcome", [], { timeout: 30_000 });
  for (const transition of transitions) {
    if (normalizeAddress(transition.actorId) !== programId) continue;
    for (const message of transition.messages ?? []) seen.add(message.id);
  }
  return seen;
}

async function watchFreshOutcomeMessages(
  provider: WsVaraEthProvider,
  programId: Hex,
  seen: Set<string>,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  const found: unknown[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    const transitions = await provider.send<StateTransition[]>("block_outcome", [], { timeout: 30_000 });
    for (const transition of transitions) {
      if (normalizeAddress(transition.actorId) !== programId) continue;
      for (const message of transition.messages ?? []) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const destination = normalizeAddress(message.destination);
        const payload = byteArrayToHex(message.payload);
        const decodedEvent = destination === "0x0000000000000000000000000000000000000000"
          ? decodeProgramEvent(payload)
          : null;
        found.push({
          id: message.id,
          destination,
          payloadPrefix: payload.slice(0, 90),
          payloadBytes: (payload.length - 2) / 2,
          decodedEvent,
          replyDetails: message.replyDetails,
        });
      }
    }
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return found;
}

function decodePromisePayload(payload: Hex) {
  try {
    const decoded = decodeFunctionData({ abi: ABI, data: payload });
    const rawArgs = decoded.args as readonly unknown[];
    const reply = rawArgs[1];
    const agent = Array.isArray(reply) && reply.length >= 13
      ? agentFromView(reply.map((value) => BigInt(String(value))))
      : undefined;
    const session = Array.isArray(reply) &&
      reply.length === 4 &&
      (decoded.functionName === "replyOn_adminStartSession" || decoded.functionName === "replyOn_adminResetMap")
      ? sessionFromView(reply.map((value) => BigInt(String(value))))
      : undefined;
    const errorPayload = typeof reply === "string" && reply.startsWith("0x") ? hexToUtf8Text(reply as Hex) : undefined;

    return {
      source: "sendAndWaitForPromise reply payload",
      decodeRule: "Solidity ABI callback data; Digger reply callbacks carry uint128[] AgentView or SessionView",
      functionName: decoded.functionName,
      messageId: typeof rawArgs[0] === "string" ? rawArgs[0] : undefined,
      rawArgs: rawArgs.map((arg) => Array.isArray(arg) ? arg.map(String) : typeof arg === "bigint" ? arg.toString() : arg),
      rawAgentVector: Array.isArray(reply) ? reply.map(String) : undefined,
      agentFieldOrder: agent ? AGENT_FIELD_ORDER : undefined,
      agent,
      rawSessionVector: session ? (reply as unknown[]).map(String) : undefined,
      sessionFieldOrder: session ? SESSION_FIELD_ORDER : undefined,
      session,
      errorPayload,
    };
  } catch (error) {
    return {
      source: "sendAndWaitForPromise reply payload",
      decodeRule: "Tried Solidity ABI callback decode; if it is a panic payload, decode bytes as UTF-8 text",
      decodeError: error instanceof Error ? error.message : String(error),
      payload,
      text: hexToUtf8Text(payload),
    };
  }
}

async function sendInjectedAction(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  provider: WsVaraEthProvider,
  programId: Hex,
  action: PlannedAction,
  eventTimeoutMs: number,
  owner: Hex,
) {
  const payload = action.functionName === "adminResetMap"
    ? encodeFunctionData({ abi: ABI, functionName: action.functionName, args: [true, action.seed ?? 42n] })
    : action.functionName === "worldRegister"
      ? encodeFunctionData({ abi: ABI, functionName: action.functionName, args: [true, owner] })
      : action.functionName === "adminStartSession" ||
      action.functionName === "worldSurface"
      ? encodeFunctionData({ abi: ABI, functionName: action.functionName, args: [true] })
      : encodeFunctionData({
        abi: ABI,
        functionName: action.functionName,
        args: [true, action.direction?.value ?? CURRENT_DIRECTION.value],
      });
  const seen = await primeSeenMessages(provider, programId);
  const watcher = watchFreshOutcomeMessages(provider, programId, seen, eventTimeoutMs);

  console.log(JSON.stringify({
    plan: {
      action: action.functionName,
      direction: action.direction?.name,
      target: action.target,
      tile: action.tile,
      seed: action.seed?.toString(),
      reason: action.reason,
      resource: action.resource,
      remainingPath: action.remainingPath,
    },
    payload,
  }));

  const tx = await api.createInjectedTransaction({ destination: programId, payload, value: 0n });
  const recipient = tx.setDefaultValidator();
  console.log(JSON.stringify({ prepared: { recipient, messageId: tx.messageId, txHash: tx.txHash } }));

  const rawReply = await tx.sendAndWaitForPromise();
  const reply = unwrapInjectedPromise(rawReply, "agent-step");
  if (!reply) throw new Error("agent-step did not return an injected promise");
  const decodedPayload = decodePromisePayload(reply.payload);
  console.log(JSON.stringify({
    promise: {
      txHash: reply.txHash,
      code: bytesToHex(reply.code.toBytes()),
      success: reply.code.isSuccess,
      reason: reply.code.reason,
      payload: decodedPayload,
      replyHash: reply.replyHash,
    },
  }));

  const freshMessages = await watcher;
  const ingest = await ingestFreshOutcomeMessages(freshMessages, {
    programId,
    txHash: reply.txHash,
    messageId: tx.messageId,
  }).catch((error) => ({
    skipped: true as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
  console.log(JSON.stringify({ leaderboardIngest: ingest }));

  return {
    reply,
    decodedPayload,
    freshMessages,
    leaderboardIngest: ingest,
  };
}

async function main() {
  let mode: "mine" | "surface" = hasArg("--surface") ? "surface" : "mine";
  const untilResource = hasArg("--until-resource");
  const untilLaddersEmpty = hasArg("--until-ladders-empty") || hasArg("--mine-gold-until-ladders-empty");
  const surfaceAfterResource = hasArg("--surface-after-resource");
  const statusOnly = hasArg("--status-only") || hasArg("--read-state");
  const resetMap = hasArg("--reset-map") || hasArg("--reset-session");
  const resetSeed = parseSeed(argValue("--seed") || process.env.DIGGER_SEED, 42n, "--seed");
  const targetResource = parseResourceTile(
    argValue("--target-resource") || argValue("--resource") || (hasArg("--gold") ? "gold" : undefined),
  );
  const collectAnyResource =
    hasArg("--collect-any-resource") ||
    hasArg("--opportunistic-resources") ||
    (untilLaddersEmpty && !hasArg("--target-only"));
  const plannerResource = collectAnyResource ? null : targetResource;
  const maxSteps = parsePositiveInt(argValue("--max-steps"), untilLaddersEmpty ? 300 : untilResource ? 80 : 1, "--max-steps");
  const eventTimeoutMs = parsePositiveInt(
    argValue("--event-timeout-ms") || process.env.DIGGER_EVENT_TIMEOUT_MS,
    90_000,
    "--event-timeout-ms",
  );
  const stateTimeoutMs = parsePositiveInt(
    argValue("--state-timeout-ms") || process.env.DIGGER_STATE_TIMEOUT_MS,
    120_000,
    "--state-timeout-ms",
  );
  const programId = requireEnv("DIGGER_PROGRAM_ID") as Hex;
  const privateKey = requireEnv("PRIVATE_KEY") as Hex;
  const ethRpc = requireEnv("ETHEREUM_RPC");
  const router = requireEnv("ROUTER_ADDRESS") as Hex;
  const varaRpc = process.env.DIGGER_INJECTED_RPC || "wss://validator-1-eth.vara.network";

  const provider = new WsVaraEthProvider(varaRpc, { requestTimeout: 60_000 });
  const account = privateKeyToAccount(privateKey, { nonceManager });
  const publicClient = createPublicClient({ transport: webSocket(ethRpc) });
  const walletClient = createWalletClient({ transport: webSocket(ethRpc), account });
  const api = await createVaraEthApi(provider, publicClient, router, walletClientToSigner(walletClient));

  try {
    let session = await readSession(api, programId);
    console.log(JSON.stringify({ sessionStart: session }));
    if (statusOnly) {
      try {
        const { agent, map } = await readAgentAndMap(api, programId);
        const safePlan = untilLaddersEmpty ? findReturnSafeResourcePlan(agent, map, plannerResource) : null;
        const plan = safePlan?.plan ?? findNearestResourcePlan(agent, map, plannerResource);
        const nextMineAction = safePlan?.action ?? (plan ? chooseAction(agent, map, plan) : null);
        const returnPlan = surfaceReturnPlan(agent, map);
        let nextSurfaceAction: PlannedAction | null = null;
        let surfaceError: string | undefined;
        try {
          nextSurfaceAction = carried(agent) > 0 || mode === "surface"
            ? chooseSurfaceAction(agent, map)
            : null;
        } catch (error) {
          surfaceError = error instanceof Error ? error.message : String(error);
        }

        console.log(JSON.stringify({
          statusOnly: true,
          programId,
          session,
          agent,
          carried: carried(agent),
          requestedTargetResource: resourceTileName(targetResource),
          plannerResourceFilter: resourceTileName(plannerResource),
          collectAnyResource,
          resources: resourceSummary(map, plannerResource, agent),
          surfaceReturn: returnPlan
            ? {
                laddersNeeded: returnPlan.laddersNeeded,
                laddersAvailable: agent.ladders,
                canReturn: returnPlan.laddersNeeded <= agent.ladders,
                path: returnPlan.pathNames,
              }
            : null,
          minePlan: plan
            ? {
                nearestResource: { ...plan.resource, name: resourceTileName(plan.resource.tile) },
                estimatedCost: plan.cost,
                path: plan.path.map((step) => step.name),
                resourceDirection: plan.resourceDirection.name,
                skippedUnsafePlans: safePlan?.skippedUnsafe ?? 0,
                nextActionSafety: safePlan?.actionSafety,
                fullPlanSafety: safePlan?.planSafety,
                nextAction: nextMineAction,
              }
            : null,
          surfacePlan: nextSurfaceAction || surfaceError
            ? { nextAction: nextSurfaceAction, error: surfaceError }
            : null,
        }, null, 2));
      } catch (error) {
        console.log(JSON.stringify({
          statusOnly: true,
          programId,
          session,
          agentState: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        }, null, 2));
      }
      return;
    }

    if (resetMap) {
      const action: PlannedAction = {
        functionName: "adminResetMap",
        seed: resetSeed,
        reason: "reset stuck session before a fresh mining run",
        remainingPath: [],
      };
      const result = await sendInjectedAction(api, provider, programId, action, eventTimeoutMs, account.address);
      const synced = await waitForSessionSeed(api, programId, resetSeed, stateTimeoutMs);
      session = synced.session;
      console.log(JSON.stringify({
        readiness: "map-reset",
        stateSync: { synced: synced.synced, reason: synced.reason },
        session,
        freshOutcomeMessages: result.freshMessages,
      }, null, 2));
    }

    if (session.status !== SESSION_ACTIVE) {
      const action: PlannedAction = {
        functionName: "adminStartSession",
        reason: "start active session before mining",
        remainingPath: [],
      };
      const result = await sendInjectedAction(api, provider, programId, action, eventTimeoutMs, account.address);
      const synced = await waitForSessionActive(api, programId, stateTimeoutMs);
      session = synced.session;
      console.log(JSON.stringify({
        readiness: "session",
        stateSync: { synced: synced.synced, reason: synced.reason },
        session,
        freshOutcomeMessages: result.freshMessages,
      }, null, 2));
    }

    try {
      await readAgent(api, programId);
    } catch (error) {
      console.log(JSON.stringify({
        agentRegistration: "needed",
        reason: error instanceof Error ? error.message : String(error),
      }));
      const action: PlannedAction = {
        functionName: "worldRegister",
        reason: "register mining agent",
        remainingPath: [],
      };
      const result = await sendInjectedAction(api, provider, programId, action, eventTimeoutMs, account.address);
      const synced = await waitForRegisteredAgent(api, programId, stateTimeoutMs);
      console.log(JSON.stringify({
        readiness: "agent",
        stateSync: { synced: synced.synced, reason: synced.reason },
        agent: synced.agent,
        freshOutcomeMessages: result.freshMessages,
      }, null, 2));
    }

    let { agent, map } = await readAgentAndMap(api, programId);
    const initialCarried = carried(agent);
    console.log(JSON.stringify({
      decoder: {
        actionPayload: "Injected tx payload is Solidity ABI calldata for worldDrill(bool,uint32) or worldMoveAgent(bool,uint32)",
        replyPayload: {
          source: "tx.sendAndWaitForPromise()",
          callbacks: [
            "replyOn_adminStartSession(bytes32,uint128[])",
            "replyOn_adminResetMap(bytes32,uint128[])",
            "replyOn_worldRegister(bytes32,uint128[])",
            "replyOn_worldDrill(bytes32,uint128[])",
            "replyOn_worldMoveAgent(bytes32,uint128[])",
            "replyOn_worldPlaceLadder(bytes32,uint128[])",
            "replyOn_worldSurface(bytes32,uint128[])",
          ],
          agentFieldOrder: AGENT_FIELD_ORDER,
          sessionFieldOrder: SESSION_FIELD_ORDER,
        },
        eventPayload: {
          source: "Vara.eth provider block_outcome, messages with zero destination",
          worldEventHeaders: SAILS_WORLD_EVENTS,
          adminEventHeaders: SAILS_ADMIN_EVENTS,
          layout: "World: header + u64 sessionId + [u8;32] owner + event-specific u32 fields; Admin: header + u64 fields",
        },
      },
    }, null, 2));
    console.log(JSON.stringify({
      start: {
        agent,
        carried: initialCarried,
        requestedTargetResource: resourceTileName(targetResource),
        plannerResourceFilter: resourceTileName(plannerResource),
        collectAnyResource,
        mode: mode === "surface"
          ? "surface"
          : untilLaddersEmpty
            ? "mine-target-and-bank-until-ladders-empty"
            : untilResource
              ? "until-resource"
              : "single-step",
        maxSteps,
      },
    }));

    for (let step = 1; step <= maxSteps; step += 1) {
      if (agent.status !== AGENT_ACTIVE) {
        console.log(JSON.stringify({ stop: "agent is not active", agent }));
        break;
      }

      if (untilLaddersEmpty && mode === "mine") {
        const returnPlan = surfaceReturnPlan(agent, map);
        if (agent.y > 0 && !returnPlan) {
          console.log(JSON.stringify({ stop: "no open path back to surface", agent }, null, 2));
          break;
        }

        if (returnPlan && returnPlan.laddersNeeded > agent.ladders) {
          console.log(JSON.stringify({
            stop: "return to surface requires more ladders than available",
            agent,
            carried: carried(agent),
            surfaceReturn: {
              laddersNeeded: returnPlan.laddersNeeded,
              laddersAvailable: agent.ladders,
              path: returnPlan.pathNames,
            },
          }, null, 2));
          break;
        }

        if (
          carried(agent) > 0 &&
          (agent.y === 0 || carried(agent) >= agent.capacity || (returnPlan && returnPlan.laddersNeeded >= agent.ladders))
        ) {
          mode = "surface";
        }
      }

      if (mode === "surface") {
        const returnPlan = untilLaddersEmpty && agent.y > 0 ? surfaceReturnPlan(agent, map) : null;
        if (untilLaddersEmpty && agent.y > 0 && (!returnPlan || returnPlan.laddersNeeded > agent.ladders)) {
          console.log(JSON.stringify({
            stop: "cannot reach surface with available ladders",
            agent,
            carried: carried(agent),
            surfaceReturn: returnPlan
              ? {
                  laddersNeeded: returnPlan.laddersNeeded,
                  laddersAvailable: agent.ladders,
                  path: returnPlan.pathNames,
                }
              : null,
          }, null, 2));
          break;
        }

        const before = agent;
        const action = chooseSurfaceAction(agent, map);
        console.log(JSON.stringify({
          step,
          before: { x: before.x, y: before.y, seq: before.lastActionSeq, carried: carried(before), bankedScrst: before.bankedScrst },
          surfacePath: action.remainingPath,
        }));

        const result = await sendInjectedAction(api, provider, programId, action, eventTimeoutMs, account.address);
        const replyAgent = "agent" in result.decodedPayload ? result.decodedPayload.agent : undefined;
        const synced = await waitForSyncedActionState(api, programId, before, action, stateTimeoutMs);
        agent = synced.agent;
        map = synced.map;

        console.log(JSON.stringify({
          replyAgent,
          stateSync: { synced: synced.synced, reason: synced.reason },
          after: {
            status: agent.status,
            x: agent.x,
            y: agent.y,
            seq: agent.lastActionSeq,
            carried: carried(agent),
            inventory: { scrst: agent.invScrst, bcrst: agent.invBcrst, hcrst: agent.invHcrst },
            banked: { scrst: agent.bankedScrst, bcrst: agent.bankedBcrst, hcrst: agent.bankedHcrst },
            ladders: agent.ladders,
          },
          freshOutcomeMessages: result.freshMessages,
        }, null, 2));

        if (agent.y === 0 && carried(agent) === 0) {
          if (untilLaddersEmpty) {
            mode = "mine";
            console.log(JSON.stringify({
              cycle: "banked resources on surface; resuming mining",
              targetResource: resourceTileName(targetResource),
              ladders: agent.ladders,
              banked: { scrst: agent.bankedScrst, bcrst: agent.bankedBcrst, hcrst: agent.bankedHcrst },
            }, null, 2));
            continue;
          }
          console.log(JSON.stringify({ surfaced: true, finalAgent: agent }, null, 2));
          break;
        }
        continue;
      }

      if (untilResource && carried(agent) > initialCarried) {
        console.log(JSON.stringify({ stop: "resource already extracted", agent }));
        break;
      }

      const safePlan = untilLaddersEmpty ? findReturnSafeResourcePlan(agent, map, plannerResource) : null;
      const plan = safePlan?.plan ?? findNearestResourcePlan(agent, map, plannerResource);
      if (!plan) {
        console.log(JSON.stringify({
          stop: untilLaddersEmpty ? "no return-safe reachable resource" : "no reachable resource",
          plannerResourceFilter: resourceTileName(plannerResource),
          agent,
        }));
        break;
      }

      const before = agent;
      const carriedBeforeAction = carried(before);
      const action = safePlan?.action ?? chooseAction(agent, map, plan);
      const safety = untilLaddersEmpty ? (safePlan?.actionSafety ?? returnSafetyAfterAction(agent, map, action)) : null;
      if (untilLaddersEmpty && safety && !safety.safe) {
        console.log(JSON.stringify({
          stop: "planned action would break return path",
          agent,
          plannedAction: action,
          surfaceReturn: {
            reason: safety.reason,
            laddersNeeded: safety.laddersNeeded,
            laddersAvailable: safety.laddersAvailable,
            path: safety.pathNames,
          },
        }, null, 2));
        break;
      }

      console.log(JSON.stringify({
        step,
        before: { x: before.x, y: before.y, seq: before.lastActionSeq, carried: carried(before) },
        nearestResource: { ...plan.resource, name: resourceTileName(plan.resource.tile) },
        estimatedCost: plan.cost,
        skippedUnsafePlans: safePlan?.skippedUnsafe ?? 0,
        actionSafety: safety,
        fullPlanSafety: safePlan?.planSafety,
      }));

      const result = await sendInjectedAction(api, provider, programId, action, eventTimeoutMs, account.address);
      const replyAgent = "agent" in result.decodedPayload ? result.decodedPayload.agent : undefined;
      const synced = await waitForSyncedActionState(api, programId, before, action, stateTimeoutMs);
      agent = synced.agent;
      map = synced.map;

      console.log(JSON.stringify({
        replyAgent,
        stateSync: { synced: synced.synced, reason: synced.reason },
        after: { x: agent.x, y: agent.y, seq: agent.lastActionSeq, carried: carried(agent), inventory: {
          scrst: agent.invScrst,
          bcrst: agent.invBcrst,
          hcrst: agent.invHcrst,
        }, banked: {
          scrst: agent.bankedScrst,
          bcrst: agent.bankedBcrst,
          hcrst: agent.bankedHcrst,
        }, ladders: agent.ladders },
        freshOutcomeMessages: result.freshMessages,
      }, null, 2));

      if (!untilResource && !untilLaddersEmpty) break;
      if (carried(agent) > carriedBeforeAction) {
        const verified = await readAgentAndMap(api, programId);
        agent = verified.agent;
        map = verified.map;
        console.log(JSON.stringify({
          resourceExtracted: true,
          finalAgent: agent,
          carriedBefore: carriedBeforeAction,
          carriedAfter: carried(agent),
        }, null, 2));
        if (surfaceAfterResource || (untilLaddersEmpty && carried(agent) >= agent.capacity)) {
          mode = "surface";
          continue;
        }
        if (!untilLaddersEmpty) break;
      }
    }
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}).then(() => {
  process.exit(0);
});
