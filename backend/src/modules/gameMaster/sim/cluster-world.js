#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadChainEnv } from '../factory/config.js';
import { actorIdFromAddress, connectDiggerWorldChain } from '../../../chain/diggerWorld.js';

const WORLD = process.argv[2] || process.env.ROBO_WORLD;
const AGENT_COUNT = Number(process.argv[3] || process.env.ROBO_CLUSTER_AGENTS || 10);
const OUTPUT_DIR = process.env.ROBO_OUTPUT_DIR || '/tmp';

const PLAN_ONLY = process.env.ROBO_CLUSTER_PLAN_ONLY === '1';
const MAX_CONFIRMED = Number(process.env.ROBO_CLUSTER_MAX_CONFIRMED || 500);
const MAX_SENDS = Number(process.env.ROBO_CLUSTER_MAX_SENDS || Math.ceil(MAX_CONFIRMED * 1.25));
const CONCURRENCY = Number(process.env.ROBO_CLUSTER_CONCURRENCY || 10);
const RETURN_LOAD = Number(process.env.ROBO_CLUSTER_RETURN_LOAD || 10);
const RECONCILE_EVERY = Number(process.env.ROBO_CLUSTER_RECONCILE_EVERY || 16);
const POLL_TIMEOUT_MS = Number(process.env.ROBO_CLUSTER_POLL_TIMEOUT_MS || 45_000);
const POLL_INTERVAL_MS = Number(process.env.ROBO_CLUSTER_POLL_INTERVAL_MS || 1_500);
const CALL_TIMEOUT_MS = Number(process.env.ROBO_CLUSTER_CALL_TIMEOUT_MS || 120_000);
const FAILURE_LIMIT = Number(process.env.ROBO_CLUSTER_FAILURE_LIMIT || 3);
const MIN_EXEC_BALANCE = BigInt(process.env.ROBO_MIN_EXEC_BALANCE || '5000000000000');
const MINT_AFTER_SURFACE = process.env.ROBO_MINT_AFTER_SURFACE === '1';
const FORCE_RETURN = process.env.ROBO_CLUSTER_FORCE_RETURN === '1';
const FINAL_RETURN = process.env.ROBO_CLUSTER_FINAL_RETURN !== '0';
const MIN_LADDERS_TO_MINE = Number(process.env.ROBO_CLUSTER_MIN_LADDERS_TO_MINE || 5);
const LADDER_BUFFER = Number(process.env.ROBO_CLUSTER_LADDER_BUFFER || 8);
const RESUPPLY_LADDER_TARGET = Number(process.env.ROBO_CLUSTER_RESUPPLY_LADDER_TARGET || (MIN_LADDERS_TO_MINE + LADDER_BUFFER));
const AUTO_LADDER_DESCENT = process.env.ROBO_CLUSTER_AUTO_LADDER_DESCENT !== '0';
const VALUE_WEIGHT = Number(process.env.ROBO_CLUSTER_VALUE_WEIGHT || 0.35);
const ACTION_COST_VARA = Number(process.env.ROBO_CLUSTER_ACTION_COST_VARA || 0.30);
const DEEPEN_FIRST_DEPTH = Number(process.env.ROBO_CLUSTER_DEEPEN_FIRST_DEPTH || 52);
const TARGET_RESOURCES = Number(process.env.ROBO_CLUSTER_TARGET_RESOURCES || 70);
const PLATEAU_CONFIRMED_LIMIT = Number(process.env.ROBO_CLUSTER_PLATEAU_CONFIRMED_LIMIT || 600);
const LOCAL_SWEEP_RADIUS = Number(process.env.ROBO_CLUSTER_LOCAL_SWEEP_RADIUS || 5);
const LOCAL_SWEEP_VERTICAL = Number(process.env.ROBO_CLUSTER_LOCAL_SWEEP_VERTICAL || 10);
const LOCAL_SWEEP_MAX_COST = Number(process.env.ROBO_CLUSTER_LOCAL_SWEEP_MAX_COST || 18);
const DESCENT_SWEEP_RADIUS = Number(process.env.ROBO_CLUSTER_DESCENT_SWEEP_RADIUS || 2);
const GLOBAL_SEARCH_MIN_DEPTH = Number(process.env.ROBO_CLUSTER_GLOBAL_SEARCH_MIN_DEPTH || Math.max(8, DEEPEN_FIRST_DEPTH - 6));
const BYPASS_MAX_RADIUS = Number(process.env.ROBO_CLUSTER_BYPASS_MAX_RADIUS || 10);
const AGENT_STALE_CARRY_ACTIONS = Number(process.env.ROBO_CLUSTER_AGENT_STALE_CARRY_ACTIONS || 120);
const OSCILLATION_WINDOW = Number(process.env.ROBO_CLUSTER_OSCILLATION_WINDOW || 8);
const DIAGNOSTIC_LOG = process.env.ROBO_CLUSTER_DIAGNOSTIC_LOG !== '0';
const PLANNED_MODE = process.env.ROBO_CLUSTER_PLANNED_MODE !== '0';
const PLANNED_LANE_RADIUS = Number(process.env.ROBO_CLUSTER_PLANNED_LANE_RADIUS || 6);
const PLANNED_DEEPEN_MARGIN = Number(process.env.ROBO_CLUSTER_PLANNED_DEEPEN_MARGIN || 1);
const PLANNED_MIN_LADDERS = Number(process.env.ROBO_CLUSTER_PLANNED_MIN_LADDERS || 8);
const MIN_LADDERS_FOR_NEW_RUN = Math.max(MIN_LADDERS_TO_MINE, PLANNED_MODE ? PLANNED_MIN_LADDERS : MIN_LADDERS_TO_MINE);

const WIDTH = 40;
const HEIGHT = 64;
const TILE = { EMPTY: 0, DIRT: 1, STONE: 2, CHEST: 3, LADDER: 4, SCRST: 10, BCRST: 11, HCRST: 12, SURFACE: 20 };
const DIR = {
  UP: { name: 'up', value: 0, dx: 0, dy: -1 },
  RIGHT: { name: 'right', value: 1, dx: 1, dy: 0 },
  DOWN: { name: 'down', value: 2, dx: 0, dy: 1 },
  LEFT: { name: 'left', value: 3, dx: -1, dy: 0 },
  CURRENT: { name: 'current', value: 4, dx: 0, dy: 0 },
};
const DIRECTIONS = [DIR.UP, DIR.RIGHT, DIR.DOWN, DIR.LEFT];
const RESOURCES = new Set([TILE.SCRST, TILE.BCRST, TILE.HCRST]);
const RESOURCE_UNITS = { [TILE.SCRST]: 1, [TILE.BCRST]: 5, [TILE.HCRST]: 25 };
const RESOURCE_VALUE = { [TILE.SCRST]: 6, [TILE.BCRST]: 30, [TILE.HCRST]: 150 };
const RESOURCE_NAME = { [TILE.SCRST]: 'SCRST', [TILE.BCRST]: 'BCRST', [TILE.HCRST]: 'HCRST' };

if (!WORLD) {
  console.error('usage: cluster-world.js <worldProgramId> [agents]');
  process.exit(1);
}

const AGENTS = Array.from({ length: AGENT_COUNT }, (_, index) => {
  const key = keccak256(stringToBytes(`digger-agent:${WORLD}:${index}`));
  const account = privateKeyToAccount(key);
  const xBand = index / Math.max(1, AGENT_COUNT);
  const shaftX = 2 + ((index * 4) % WIDTH);
  return {
    label: `a${String(index + 1).padStart(2, '0')}`,
    cluster: xBand < 1 / 3 ? 'left' : xBand < 2 / 3 ? 'mid' : 'right',
    shaftX,
    key,
    account: account.address,
    owner: actorIdFromAddress(account.address),
    conn: null,
  };
}).map((agent) => ({
  ...agent,
  mode: 'mine',
  finalReturn: false,
  targetKey: null,
  missionShaftX: null,
  stopped: false,
  stopReason: '',
  sent: 0,
  confirmed: 0,
  proxyOnly: 0,
  failed: 0,
  surfaced: 0,
  minted: 0,
  mined: { scrst: 0, bcrst: 0, hcrst: 0 },
  latenciesMs: [],
  blacklist: new Set(),
  memory: [],
  bypassDir: null,
  forceReturn: false,
  lastMinedConfirmed: 0,
  recentPositions: [],
  diagnostics: {
    phaseCounts: {},
    loopBreaks: 0,
    forcedReturns: 0,
    bypassAbandoned: 0,
    staleCarryReturns: 0,
  },
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idx = (x, y) => y * WIDTH + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT;
const tileAt = (map, x, y) => (inBounds(x, y) ? map[idx(x, y)] : null);
const setTile = (map, x, y, tile) => {
  const next = map.slice();
  next[idx(x, y)] = tile;
  return next;
};
const carried = (agent) => agent.invScrst + agent.invBcrst + agent.invHcrst;
const banked = (agent) => agent.bankedScrst + agent.bankedBcrst + agent.bankedHcrst;
const resourceKey = (x, y) => `${x},${y}`;
const clusterOfX = (x) => (x < 14 ? 'left' : x < 27 ? 'mid' : 'right');
const isResource = (tile) => RESOURCES.has(tile);
const isTraversable = (tile) => tile === TILE.EMPTY || tile === TILE.LADDER || tile === TILE.SURFACE;
const isDrillablePath = (tile) => tile === TILE.DIRT;
const unsafeResource = (map, x, y) => tileAt(map, x, y - 1) === TILE.STONE;
const actionText = (action) => `${action.method}${action.args.length ? `(${action.args.join(',')})` : '()'}`;

function actionPhase(action) {
  const reason = action?.reason || '';
  if (!action) return 'none';
  if (action.method === 'Surface') return 'bank';
  if (action.method === 'TradeResourcesForLadders') return 'trade-ladders';
  if (action.method === 'MintResources') return 'mint';
  if (reason.includes('planned shaft') || reason.includes('planned target') || reason.includes('planned cluster')) return 'planned-route';
  if (reason.includes('return')) return 'return';
  if (reason.includes('mine adjacent') || reason.includes('local mine') || reason.includes('mine reserved')) return 'mine-resource';
  if (reason.includes('local route') || reason.includes('route to')) return 'route-resource';
  if (reason.includes('bypass') || reason.includes('sidestep')) return 'stone-bypass';
  if (reason.includes('deepen') || reason.includes('bootstrap')) return 'deepen-shaft';
  if (reason.includes('ladder')) return 'ladder';
  return 'other';
}

function positionKey(agent) {
  return `${agent.x},${agent.y}`;
}

function hasOscillation(positions) {
  if (positions.length < 4) return false;
  const last = positions.slice(-4);
  return last[0] === last[2] && last[1] === last[3] && last[0] !== last[1];
}

function resourceDepthSummary(map) {
  const summary = {
    total: resourceCounts(map),
    unsafe: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
    bands: {
      shallow: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
      mid: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
      deep: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
      bottom: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
    },
  };
  const add = (bucket, tile) => {
    const name = RESOURCE_NAME[tile].toLowerCase();
    bucket[name] += 1;
    bucket.total += 1;
  };
  for (const resource of resourceList(map)) {
    const band = resource.y < 20 ? 'shallow' : resource.y < 40 ? 'mid' : resource.y < 56 ? 'deep' : 'bottom';
    add(summary.bands[band], resource.tile);
    if (resource.unsafe) add(summary.unsafe, resource.tile);
  }
  return summary;
}

function resourceCoordinates(map) {
  return resourceList(map).map((resource) => ({
    x: resource.x,
    y: resource.y,
    tile: RESOURCE_NAME[resource.tile],
    unsafe: resource.unsafe,
  }));
}

function nearbyResources(map, agent, radius = 8, vertical = 14) {
  return resourceCoordinates(map)
    .filter((resource) => Math.abs(resource.x - agent.x) <= radius && Math.abs(resource.y - agent.y) <= vertical)
    .sort((a, b) => (Math.abs(a.x - agent.x) + Math.abs(a.y - agent.y)) - (Math.abs(b.x - agent.x) + Math.abs(b.y - agent.y)))
    .slice(0, 12);
}

function ladderValueFromTrade(scrst, bcrst, hcrst) {
  return scrst * 2 + bcrst * 4 + hcrst * 12;
}

function tradableLadders(agent) {
  return ladderValueFromTrade(agent.bankedScrst, agent.bankedBcrst, agent.bankedHcrst);
}

function tradeForLaddersAction(agent) {
  if (agent.y !== 0 || carried(agent) > 0 || agent.ladders >= RESUPPLY_LADDER_TARGET) return null;
  let need = Math.max(1, RESUPPLY_LADDER_TARGET - agent.ladders);
  let scrst = 0;
  let bcrst = 0;
  let hcrst = 0;

  const scrstLadders = Math.min(Math.floor(agent.bankedScrst / 5), need);
  if (scrstLadders > 0) {
    scrst = scrstLadders * 5;
    need -= scrstLadders;
  }
  const bcrstLadders = Math.min(agent.bankedBcrst, need);
  if (bcrstLadders > 0) {
    bcrst = bcrstLadders;
    need -= bcrstLadders;
  }
  const hcrstLadders = Math.min(agent.bankedHcrst, Math.ceil(need / 5));
  if (hcrstLadders > 0) hcrst = hcrstLadders;
  if (scrst === 0 && bcrst === 0 && hcrst === 0) return null;
  return {
    method: 'TradeResourcesForLadders',
    args: [scrst, bcrst, hcrst],
    fn: 'trade',
    dir: null,
    target: null,
    reason: `buy ${ladderValueFromTrade(scrst, bcrst, hcrst)} ladders for rescue`,
  };
}

function targetFor(agent, dir) {
  const x = agent.x + dir.dx;
  const y = agent.y + dir.dy;
  return inBounds(x, y) ? { x, y } : null;
}

function gravityTarget(map, x, y) {
  const start = tileAt(map, x, y);
  if (start === TILE.LADDER || start === TILE.SURFACE) return { x, y };
  let targetY = y;
  while (targetY + 1 < HEIGHT) {
    const below = tileAt(map, x, targetY + 1);
    if (below === TILE.EMPTY) {
      targetY += 1;
      continue;
    }
    if (below === TILE.LADDER) {
      targetY += 1;
      break;
    }
    break;
  }
  return { x, y: targetY };
}

function addResource(agent, tile) {
  if (tile === TILE.SCRST) agent.invScrst += 1;
  if (tile === TILE.BCRST) agent.invBcrst += 1;
  if (tile === TILE.HCRST) agent.invHcrst += 1;
}

function agentFromView(view) {
  const v = view.map(Number);
  return {
    status: v[0], x: v[1], y: v[2], hp: v[3], ladders: v[4],
    invScrst: v[5], invBcrst: v[6], invHcrst: v[7],
    bankedScrst: v[8], bankedBcrst: v[9], bankedHcrst: v[10],
    capacity: v[11], lastActionSeq: v[12],
  };
}

function agentSummary(agent) {
  return {
    status: agent.status,
    x: agent.x,
    y: agent.y,
    hp: agent.hp,
    ladders: agent.ladders,
    carried: [agent.invScrst, agent.invBcrst, agent.invHcrst],
    banked: [agent.bankedScrst, agent.bankedBcrst, agent.bankedHcrst],
    lastActionSeq: agent.lastActionSeq,
  };
}

function mapCounts(map) {
  return map.reduce((acc, tile) => {
    acc[tile] = (acc[tile] || 0) + 1;
    return acc;
  }, {});
}

function resourceCounts(map) {
  const counts = mapCounts(map);
  return {
    scrst: counts[TILE.SCRST] || 0,
    bcrst: counts[TILE.BCRST] || 0,
    hcrst: counts[TILE.HCRST] || 0,
    total: (counts[TILE.SCRST] || 0) + (counts[TILE.BCRST] || 0) + (counts[TILE.HCRST] || 0),
  };
}

function resourceList(map) {
  const out = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const tile = tileAt(map, x, y);
      if (isResource(tile)) {
        out.push({ x, y, tile, key: resourceKey(x, y), cluster: clusterOfX(x), unsafe: unsafeResource(map, x, y) });
      }
    }
  }
  return out;
}

function burn(before, after) {
  if (!before || !after || String(before).startsWith('error:') || String(after).startsWith('error:')) return null;
  return (BigInt(before) - BigInt(after)).toString();
}

function toVara(raw) {
  if (raw == null) return null;
  return Number(BigInt(raw)) / 1e12;
}

function latencyStats(values) {
  if (values.length === 0) return { count: 0, avgMs: null, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: values.length,
    avgMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
  };
}

function agentChanged(before, after) {
  return after.lastActionSeq > before.lastActionSeq ||
    after.status !== before.status ||
    after.x !== before.x ||
    after.y !== before.y ||
    after.hp !== before.hp ||
    after.ladders !== before.ladders ||
    carried(after) !== carried(before) ||
    banked(after) !== banked(before);
}

function minedDelta(before, after) {
  return {
    scrst: Math.max(0, after.invScrst - before.invScrst),
    bcrst: Math.max(0, after.invBcrst - before.invBcrst),
    hcrst: Math.max(0, after.invHcrst - before.invHcrst),
  };
}

function addMined(total, delta) {
  total.scrst += delta.scrst;
  total.bcrst += delta.bcrst;
  total.hcrst += delta.hcrst;
}

function actionForMove(map, agent, dir) {
  const target = targetFor(agent, dir);
  if (!target) return null;
  const current = tileAt(map, agent.x, agent.y);
  const tile = tileAt(map, target.x, target.y);
  if (dir.value === DIR.UP.value) {
    if (tile === TILE.EMPTY && agent.ladders > 0) {
      return { method: 'PlaceLadder', args: [DIR.UP.value], fn: 'placeLadder', target, dir, reason: 'build upward ladder' };
    }
    if (tile === TILE.SURFACE && current !== TILE.LADDER && agent.ladders > 0) {
      return { method: 'PlaceLadder', args: [DIR.CURRENT.value], fn: 'placeLadder', target: { x: agent.x, y: agent.y }, dir: DIR.CURRENT, reason: 'ladder underfoot before surface' };
    }
    if ((tile === TILE.LADDER || tile === TILE.SURFACE) && (current === TILE.LADDER || tile === TILE.LADDER || tile === TILE.SURFACE)) {
      return { method: 'MoveAgent', args: [DIR.UP.value], fn: 'move', target, dir, reason: 'climb' };
    }
    return null;
  }
  if (isTraversable(tile)) return { method: 'MoveAgent', args: [dir.value], fn: 'move', target, dir, reason: 'move through open path' };
  if (isDrillablePath(tile) && !unsafeResource(map, target.x, target.y)) {
    return { method: 'Drill', args: [dir.value], fn: 'drill', target, dir, reason: 'open dirt path' };
  }
  return null;
}

function applyAction(agent, map, action) {
  const nextAgent = { ...agent };
  let nextMap = map.slice();
  if (action.method === 'MoveAgent') {
    const target = targetFor(nextAgent, action.dir);
    if (!target || !isTraversable(tileAt(nextMap, target.x, target.y))) return null;
    const final = gravityTarget(nextMap, target.x, target.y);
    nextAgent.x = final.x;
    nextAgent.y = final.y;
    return { agent: nextAgent, map: nextMap };
  }
  if (action.method === 'Drill') {
    const target = targetFor(nextAgent, action.dir);
    if (!target) return null;
    const tile = tileAt(nextMap, target.x, target.y);
    if (tile === TILE.STONE || tile === TILE.CHEST || tile === TILE.EMPTY || tile === TILE.LADDER || tile === TILE.SURFACE) return null;
    if (unsafeResource(nextMap, target.x, target.y)) return null;
    if (isResource(tile)) addResource(nextAgent, tile);
    nextMap = setTile(nextMap, target.x, target.y, TILE.EMPTY);
    const final = gravityTarget(nextMap, nextAgent.x, nextAgent.y);
    nextAgent.x = final.x;
    nextAgent.y = final.y;
    return { agent: nextAgent, map: nextMap };
  }
  if (action.method === 'PlaceLadder') {
    const target = action.dir.value === DIR.CURRENT.value ? { x: nextAgent.x, y: nextAgent.y } : targetFor(nextAgent, action.dir);
    if (!target || tileAt(nextMap, target.x, target.y) !== TILE.EMPTY || nextAgent.ladders <= 0) return null;
    nextMap = setTile(nextMap, target.x, target.y, TILE.LADDER);
    nextAgent.ladders -= 1;
    return { agent: nextAgent, map: nextMap };
  }
  if (action.method === 'Surface') {
    if (nextAgent.y !== 0) return null;
    nextAgent.bankedScrst += nextAgent.invScrst;
    nextAgent.bankedBcrst += nextAgent.invBcrst;
    nextAgent.bankedHcrst += nextAgent.invHcrst;
    nextAgent.invScrst = 0;
    nextAgent.invBcrst = 0;
    nextAgent.invHcrst = 0;
    return { agent: nextAgent, map: nextMap };
  }
  if (action.method === 'TradeResourcesForLadders') {
    const [scrst, bcrst, hcrst] = action.args;
    if (nextAgent.y !== 0 || nextAgent.bankedScrst < scrst || nextAgent.bankedBcrst < bcrst || nextAgent.bankedHcrst < hcrst) return null;
    nextAgent.bankedScrst -= scrst;
    nextAgent.bankedBcrst -= bcrst;
    nextAgent.bankedHcrst -= hcrst;
    nextAgent.ladders += ladderValueFromTrade(scrst, bcrst, hcrst);
    return { agent: nextAgent, map: nextMap };
  }
  if (action.method === 'MintResources') return { agent: nextAgent, map: nextMap };
  return null;
}

function actionPlausible(agent, map, action) {
  if (!action || agent.status !== 1 || agent.hp <= 0) return false;
  if (action.method === 'Surface') return agent.y === 0 && carried(agent) > 0;
  if (action.method === 'MintResources') return banked(agent) > 0;
  if (action.method === 'TradeResourcesForLadders') {
    const [scrst, bcrst, hcrst] = action.args;
    return agent.y === 0 && carried(agent) === 0 && agent.bankedScrst >= scrst && agent.bankedBcrst >= bcrst && agent.bankedHcrst >= hcrst;
  }
  const target = action.dir.value === DIR.CURRENT.value ? { x: agent.x, y: agent.y } : targetFor(agent, action.dir);
  if (!target) return false;
  const tile = tileAt(map, target.x, target.y);
  if (action.method === 'MoveAgent') return isTraversable(tile);
  if (action.method === 'PlaceLadder') return tile === TILE.EMPTY && agent.ladders > 0;
  if (action.method === 'Drill') return (tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y);
  return false;
}

function bestFirstActionToSurface(agent, map) {
  if (agent.y === 0) return carried(agent) > 0 ? { method: 'Surface', args: [], fn: 'surface', target: null, dir: null, reason: 'bank carried load' } : null;
  const current = tileAt(map, agent.x, agent.y);
  if (current === TILE.EMPTY && agent.ladders > 0) {
    return { method: 'PlaceLadder', args: [DIR.CURRENT.value], fn: 'placeLadder', target: { x: agent.x, y: agent.y }, dir: DIR.CURRENT, reason: 'anchor return shaft' };
  }
  const planned = firstReturnActionToSurface(agent, map);
  if (planned) return { ...planned, reason: planned.reason || 'planned return path' };
  const directUp = returnActionForDirection(map, agent, DIR.UP, { allowDrill: true });
  return directUp ? { ...directUp, reason: 'return upward fallback' } : null;
}

function returnActionForDirection(map, agent, dir, { allowDrill = true } = {}) {
  const target = targetFor(agent, dir);
  if (!target) return null;
  const tile = tileAt(map, target.x, target.y);
  if (dir.value === DIR.UP.value) {
    if (tile === TILE.LADDER || tile === TILE.SURFACE) {
      return { method: 'MoveAgent', args: [DIR.UP.value], fn: 'move', target, dir };
    }
    if (tile === TILE.EMPTY && agent.ladders > 0) {
      return { method: 'PlaceLadder', args: [DIR.UP.value], fn: 'placeLadder', target, dir };
    }
    if (allowDrill && (tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y)) {
      return { method: 'Drill', args: [DIR.UP.value], fn: 'drill', target, dir };
    }
    return null;
  }
  if (isTraversable(tile)) return { method: 'MoveAgent', args: [dir.value], fn: 'move', target, dir };
  if (allowDrill && (tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y)) {
    return { method: 'Drill', args: [dir.value], fn: 'drill', target, dir };
  }
  return null;
}

function returnTransition(map, agent, action) {
  if (!action) return null;
  if (action.method === 'MoveAgent') {
    const final = gravityTarget(map, action.target.x, action.target.y);
    return { x: final.x, y: final.y };
  }
  if (action.method === 'PlaceLadder' && action.dir.value === DIR.UP.value) return action.target;
  if (action.method === 'Drill') {
    if (action.dir.value === DIR.UP.value) return action.target;
    const final = gravityTarget(map, action.target.x, action.target.y);
    return { x: final.x, y: final.y };
  }
  return { x: agent.x, y: agent.y };
}

function firstReturnActionToSurface(agent, map) {
  const cells = WIDTH * HEIGHT;
  const start = idx(agent.x, agent.y);
  const dist = new Array(cells).fill(Number.POSITIVE_INFINITY);
  const first = new Array(cells).fill(null);
  const visited = new Set();
  dist[start] = 0;

  for (;;) {
    let currentIndex = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < cells; i += 1) {
      if (!visited.has(i) && dist[i] < best) {
        best = dist[i];
        currentIndex = i;
      }
    }
    if (currentIndex < 0) break;
    const x = currentIndex % WIDTH;
    const y = Math.floor(currentIndex / WIDTH);
    if (y === 0) break;
    visited.add(currentIndex);
    const virtualAgent = { ...agent, x, y };

    for (const dir of DIRECTIONS) {
      const action = returnActionForDirection(map, virtualAgent, dir, { allowDrill: true });
      if (!action) continue;
      const next = returnTransition(map, virtualAgent, action);
      if (!next || !inBounds(next.x, next.y)) continue;
      const ni = idx(next.x, next.y);
      const verticalBias = dir.value === DIR.UP.value ? -1 : dir.value === DIR.DOWN.value ? 16 : 3;
      const methodCost = action.method === 'MoveAgent' ? 1 : action.method === 'PlaceLadder' ? 4 : 14;
      const nextCost = dist[currentIndex] + methodCost + verticalBias + Math.max(0, next.y - y) * 8;
      if (nextCost < dist[ni]) {
        dist[ni] = nextCost;
        first[ni] = currentIndex === start ? action : first[currentIndex];
      }
    }
  }

  let bestSurface = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let x = 0; x < WIDTH; x += 1) {
    const surfaceIndex = idx(x, 0);
    if (dist[surfaceIndex] < best) {
      best = dist[surfaceIndex];
      bestSurface = surfaceIndex;
    }
  }
  return bestSurface >= 0 ? first[bestSurface] : null;
}

function firstActionsFrom(agent, map) {
  const cells = WIDTH * HEIGHT;
  const start = idx(agent.x, agent.y);
  const dist = new Array(cells).fill(Number.POSITIVE_INFINITY);
  const first = new Array(cells).fill(null);
  const visited = new Set();
  dist[start] = 0;

  for (;;) {
    let currentIndex = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < cells; i += 1) {
      if (!visited.has(i) && dist[i] < best) {
        best = dist[i];
        currentIndex = i;
      }
    }
    if (currentIndex < 0) break;
    visited.add(currentIndex);
    const x = currentIndex % WIDTH;
    const y = Math.floor(currentIndex / WIDTH);
    const virtualAgent = { ...agent, x, y };

    for (const dir of DIRECTIONS) {
      const action = actionForMove(map, virtualAgent, dir);
      if (!action) continue;
      const applied = applyAction(virtualAgent, map, action);
      if (!applied) continue;
      const ni = idx(applied.agent.x, applied.agent.y);
      const actionCost = action.method === 'Drill' || action.method === 'PlaceLadder' ? 2 : 1;
      const nextCost = dist[currentIndex] + actionCost;
      if (nextCost < dist[ni]) {
        dist[ni] = nextCost;
        first[ni] = currentIndex === start ? action : first[currentIndex];
      }
    }
  }
  return { dist, first };
}

function reservedTargetsFor(exceptLabel) {
  return new Set(AGENTS.filter((agent) => agent.label !== exceptLabel && agent.targetKey).map((agent) => agent.targetKey));
}

function shaftBonus(map, x, y) {
  let score = 0;
  for (let yy = y; yy >= 0; yy -= 1) {
    const tile = tileAt(map, x, yy);
    if (tile === TILE.LADDER) score += 2;
    else if (tile === TILE.EMPTY || tile === TILE.SURFACE) score += 1;
    else if (tile === TILE.DIRT || isResource(tile)) score += 0.15;
    else break;
  }
  return Math.min(45, score);
}

function plannedShaftXs() {
  const shafts = new Set(AGENTS.map((agent) => agent.shaftX));
  for (let x = 2; x < WIDTH; x += 4) shafts.add(x);
  return [...shafts].filter((x) => x >= 0 && x < WIDTH).sort((a, b) => a - b);
}

function nearestPlannedShaftX(x) {
  return plannedShaftXs().reduce((best, candidate) => (
    Math.abs(candidate - x) < Math.abs(best - x) ? candidate : best
  ), plannedShaftXs()[0]);
}

function resourceByKey(map, key) {
  if (!key) return null;
  const [x, y] = key.split(',').map(Number);
  if (!inBounds(x, y)) return null;
  const tile = tileAt(map, x, y);
  if (!isResource(tile) || unsafeResource(map, x, y)) return null;
  return { x, y, tile, key, cluster: clusterOfX(x), unsafe: false };
}

function choosePlannedTarget(agentConfig, agent, map) {
  const sticky = resourceByKey(map, agentConfig.targetKey);
  if (sticky && !agentConfig.blacklist.has(sticky.key)) {
    agentConfig.missionShaftX ??= nearestPlannedShaftX(sticky.x);
    return sticky;
  }

  agentConfig.targetKey = null;
  agentConfig.missionShaftX = null;
  const reservations = reservedTargetsFor(agentConfig.label);
  const resources = resourceList(map).filter((resource) =>
    !resource.unsafe &&
    !reservations.has(resource.key) &&
    !agentConfig.blacklist.has(resource.key)
  );
  if (resources.length === 0) return null;

  const laneRadii = [PLANNED_LANE_RADIUS, PLANNED_LANE_RADIUS * 2, WIDTH];
  let selected = null;
  for (const radius of laneRadii) {
    const candidates = resources
      .map((resource) => {
        const missionShaftX = nearestPlannedShaftX(resource.x);
        const distanceFromLane = Math.abs(resource.x - missionShaftX);
        if (distanceFromLane > radius) return null;
        const surfaceTravel = agent.y === 0
          ? Math.abs(agent.x - missionShaftX)
          : Math.abs(agent.x - resource.x) + Math.max(0, resource.y - agent.y);
        const sharedShaft = shaftBonus(map, missionShaftX, Math.max(1, Math.min(resource.y, HEIGHT - 1)));
        const valueUnits = RESOURCE_UNITS[resource.tile] || 1;
        const clusterPenalty = resource.cluster === agentConfig.cluster ? 0 : 10;
        const depthBias = resource.y >= 48 ? -5 : resource.y >= 32 ? -2 : resource.y * 0.04;
        const lanePenalty = distanceFromLane * 3.5;
        const score = lanePenalty + surfaceTravel * 0.55 + clusterPenalty + depthBias - valueUnits * 12 - sharedShaft * 0.25;
        return { resource, missionShaftX, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    if (candidates[0]) {
      selected = candidates[0];
      break;
    }
  }
  if (!selected) return null;

  agentConfig.targetKey = selected.resource.key;
  agentConfig.missionShaftX = selected.missionShaftX;
  return selected.resource;
}

function surfaceMoveToMissionShaft(agentConfig, agent, map) {
  if (agent.y !== 0 || agentConfig.missionShaftX == null || agent.x === agentConfig.missionShaftX) return null;
  const dir = agent.x < agentConfig.missionShaftX ? DIR.RIGHT : DIR.LEFT;
  const action = actionForMove(map, agent, dir);
  if (!action) return null;
  return {
    ...action,
    reason: `move to planned shaft x=${agentConfig.missionShaftX}`,
  };
}

function lateralMoveTowardX(agent, map, targetX, reason) {
  if (targetX == null || agent.x === targetX) return null;
  const primary = agent.x < targetX ? DIR.RIGHT : DIR.LEFT;
  const secondary = primary.value === DIR.RIGHT.value ? DIR.LEFT : DIR.RIGHT;
  for (const dir of [primary, secondary]) {
    const next = targetFor(agent, dir);
    if (!next) continue;
    if (dir === secondary && Math.abs(next.x - targetX) >= Math.abs(agent.x - targetX)) continue;
    const tile = tileAt(map, next.x, next.y);
    if (tile === TILE.STONE || tile === TILE.CHEST) continue;
    const action = actionForMove(map, agent, dir);
    if (action) return { ...action, reason };
  }
  return null;
}

function actionToSpecificResource(agentConfig, agent, map, resource, reasonPrefix = 'planned target') {
  const { dist, first } = firstActionsFrom(agent, map);
  const candidates = [];
  for (const dir of DIRECTIONS) {
    const standX = resource.x - dir.dx;
    const standY = resource.y - dir.dy;
    if (!inBounds(standX, standY)) continue;
    const standIndex = idx(standX, standY);
    if (!Number.isFinite(dist[standIndex])) continue;
    const firstAction = first[standIndex];
    if (!firstAction && (agent.x !== standX || agent.y !== standY)) continue;
    const lateralPenalty = agentConfig.missionShaftX == null ? 0 : Math.abs(standX - agentConfig.missionShaftX) * 0.4;
    const upPenalty = Math.max(0, agent.y - standY) * 1.5;
    candidates.push({
      stand: { x: standX, y: standY },
      drillDir: dir,
      firstAction,
      cost: dist[standIndex] + lateralPenalty + upPenalty,
    });
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const chosen = candidates[0];
  if (!chosen) {
    agentConfig.blacklist.add(resource.key);
    agentConfig.targetKey = null;
    agentConfig.missionShaftX = null;
    return null;
  }
  if (agent.x === chosen.stand.x && agent.y === chosen.stand.y) {
    return {
      method: 'Drill',
      args: [chosen.drillDir.value],
      fn: 'drill',
      dir: chosen.drillDir,
      target: { x: resource.x, y: resource.y },
      reason: `${reasonPrefix} mine ${RESOURCE_NAME[resource.tile]} ${resource.key}`,
      resource,
    };
  }
  return {
    ...chosen.firstAction,
    reason: `${reasonPrefix} route ${RESOURCE_NAME[resource.tile]} ${resource.key} via shaft x=${agentConfig.missionShaftX}`,
    resource,
  };
}

function choosePlannedAction(agentConfig, agent, map) {
  if (!PLANNED_MODE || carried(agent) >= Math.min(RETURN_LOAD, agent.capacity)) return null;
  const target = choosePlannedTarget(agentConfig, agent, map);
  if (!target) return null;

  const surfaceMove = surfaceMoveToMissionShaft(agentConfig, agent, map);
  if (surfaceMove) return { ...surfaceMove, resource: target };

  const adjacent = adjacentResourceAction(agent, map);
  if (adjacent) return { ...adjacent, reason: `planned cluster ${adjacent.reason}`, resource: target };

  const targetDepth = Math.max(1, target.y - PLANNED_DEEPEN_MARGIN);
  if (agent.y < targetDepth) {
    const anchor = anchorDescentLadderAction(agent, map);
    if (anchor) return { ...anchor, reason: `planned shaft ladder toward ${target.key}`, resource: target };
    const bootstrap = bootstrapDescentAction(agent, map);
    if (bootstrap) return { ...bootstrap, reason: `planned shaft bootstrap toward ${target.key}`, resource: target };
    const local = chooseLocalResourceAction(agentConfig, agent, map, {
      radius: Math.max(2, Math.floor(PLANNED_LANE_RADIUS / 2)),
      vertical: 4,
      maxCost: 8,
    });
    if (local) {
      agentConfig.targetKey = target.key;
      agentConfig.missionShaftX = nearestPlannedShaftX(target.x);
      return { ...local, reason: `planned cluster ${local.reason || 'local pickup'}`, resource: target };
    }
    const lateral = lateralMoveTowardX(
      agent,
      map,
      agentConfig.missionShaftX,
      `planned shaft lateral align x=${agentConfig.missionShaftX} for ${target.key}`,
    );
    if (lateral) return { ...lateral, resource: target };
    const deepen = deepenShaftAction(agent, map);
    if (deepen) return { ...deepen, reason: `planned shaft deepen to y=${targetDepth} for ${target.key}`, resource: target };
    const sidestep = sidestepBlockedShaftAction(agentConfig, agent, map);
    if (sidestep) return { ...sidestep, reason: `planned shaft ${sidestep.reason || 'sidestep'} for ${target.key}`, resource: target };
    return carried(agent) > 0 ? bestFirstActionToSurface(agent, map) : null;
  }

  const localCluster = chooseLocalResourceAction(agentConfig, agent, map, {
    radius: PLANNED_LANE_RADIUS,
    vertical: 8,
    maxCost: 14,
  });
  if (localCluster) return { ...localCluster, reason: `planned cluster ${localCluster.reason || 'local route'}`, resource: target };

  return actionToSpecificResource(agentConfig, agent, map, target);
}

function chooseResourceAction(agentConfig, agent, map) {
  const resources = resourceList(map).filter((resource) => !resource.unsafe);
  if (resources.length === 0) return null;
  if (agentConfig.targetKey && !resources.some((resource) => resource.key === agentConfig.targetKey)) {
    agentConfig.targetKey = null;
  }

  const reservations = reservedTargetsFor(agentConfig.label);
  const { dist, first } = firstActionsFrom(agent, map);
  const candidates = [];
  for (const resource of resources) {
    if (reservations.has(resource.key)) continue;
    for (const dir of DIRECTIONS) {
      const standX = resource.x - dir.dx;
      const standY = resource.y - dir.dy;
      if (!inBounds(standX, standY)) continue;
      const standIndex = idx(standX, standY);
      if (!Number.isFinite(dist[standIndex])) continue;
      if (agentConfig.blacklist.has(resource.key)) continue;
      const clusterPenalty = resource.cluster === agentConfig.cluster ? 0 : 28;
      const targetStickiness = resource.key === agentConfig.targetKey ? -30 : 0;
      const valueBonus = Math.min(700, (RESOURCE_VALUE[resource.tile] / Math.max(0.01, ACTION_COST_VARA)) * VALUE_WEIGHT);
      const depthPenalty = resource.y * 0.04;
      const sharedShaftBonus = shaftBonus(map, standX, standY);
      const score = dist[standIndex] + clusterPenalty + depthPenalty - valueBonus - sharedShaftBonus + targetStickiness;
      candidates.push({ resource, stand: { x: standX, y: standY }, drillDir: dir, score, cost: dist[standIndex], firstAction: first[standIndex] });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.cost - b.cost);
  const chosen = candidates[0];
  if (!chosen) return null;
  agentConfig.targetKey = chosen.resource.key;
  if (agent.x === chosen.stand.x && agent.y === chosen.stand.y) {
    return {
      method: 'Drill',
      args: [chosen.drillDir.value],
      fn: 'drill',
      dir: chosen.drillDir,
      target: { x: chosen.resource.x, y: chosen.resource.y },
      reason: `mine reserved ${RESOURCE_NAME[chosen.resource.tile]} ${chosen.resource.key}`,
      resource: chosen.resource,
    };
  }
  return {
    ...chosen.firstAction,
    reason: `route to ${RESOURCE_NAME[chosen.resource.tile]} ${chosen.resource.key} cluster=${chosen.resource.cluster}`,
    resource: chosen.resource,
  };
}

function chooseLocalResourceAction(agentConfig, agent, map, {
  radius = LOCAL_SWEEP_RADIUS,
  vertical = LOCAL_SWEEP_VERTICAL,
  maxCost = LOCAL_SWEEP_MAX_COST,
} = {}) {
  const resources = resourceList(map).filter((resource) => {
    if (resource.unsafe || agentConfig.blacklist.has(resource.key)) return false;
    if (Math.abs(resource.x - agent.x) > radius) return false;
    if (resource.y < Math.max(1, agent.y - vertical)) return false;
    if (resource.y > Math.min(HEIGHT - 1, agent.y + vertical)) return false;
    return true;
  });
  if (resources.length === 0) return null;

  const reservations = reservedTargetsFor(agentConfig.label);
  const { dist, first } = firstActionsFrom(agent, map);
  const candidates = [];
  for (const resource of resources) {
    if (reservations.has(resource.key)) continue;
    for (const dir of DIRECTIONS) {
      const standX = resource.x - dir.dx;
      const standY = resource.y - dir.dy;
      if (!inBounds(standX, standY)) continue;
      const standIndex = idx(standX, standY);
      if (!Number.isFinite(dist[standIndex]) || dist[standIndex] > maxCost) continue;
      const firstAction = first[standIndex];
      if (!firstAction && (agent.x !== standX || agent.y !== standY)) continue;
      const horizontal = Math.abs(resource.x - agent.x);
      const upward = Math.max(0, agent.y - resource.y);
      const valueUnits = RESOURCE_UNITS[resource.tile] || 1;
      const shaftPenalty = Math.abs(resource.x - agentConfig.shaftX) * 0.35;
      const score = dist[standIndex] + horizontal * 1.6 + upward * 1.1 + shaftPenalty - valueUnits * 3.5;
      candidates.push({ resource, stand: { x: standX, y: standY }, drillDir: dir, score, cost: dist[standIndex], firstAction });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.cost - b.cost);
  const chosen = candidates[0];
  if (!chosen) return null;
  agentConfig.targetKey = chosen.resource.key;
  if (agent.x === chosen.stand.x && agent.y === chosen.stand.y) {
    return {
      method: 'Drill',
      args: [chosen.drillDir.value],
      fn: 'drill',
      dir: chosen.drillDir,
      target: { x: chosen.resource.x, y: chosen.resource.y },
      reason: `local mine ${RESOURCE_NAME[chosen.resource.tile]} ${chosen.resource.key}`,
      resource: chosen.resource,
    };
  }
  return {
    ...chosen.firstAction,
    reason: `local route to ${RESOURCE_NAME[chosen.resource.tile]} ${chosen.resource.key}`,
    resource: chosen.resource,
  };
}

function adjacentResourceAction(agent, map) {
  const candidates = [];
  for (const dir of DIRECTIONS) {
    const target = targetFor(agent, dir);
    if (!target) continue;
    const tile = tileAt(map, target.x, target.y);
    if (!isResource(tile) || unsafeResource(map, target.x, target.y)) continue;
    candidates.push({
      method: 'Drill',
      args: [dir.value],
      fn: 'drill',
      dir,
      target,
      score: -RESOURCE_VALUE[tile] + target.y * 0.1,
      reason: `mine adjacent ${RESOURCE_NAME[tile]} ${resourceKey(target.x, target.y)}`,
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

function bootstrapDescentAction(agent, map) {
  if (agent.y !== 0 || carried(agent) > 0) return null;
  const target = targetFor(agent, DIR.DOWN);
  if (!target) return null;
  const tile = tileAt(map, target.x, target.y);
  if (isTraversable(tile)) {
    return { method: 'MoveAgent', args: [DIR.DOWN.value], fn: 'move', dir: DIR.DOWN, target, reason: 'bootstrap descent through open shaft' };
  }
  if ((tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y)) {
    return { method: 'Drill', args: [DIR.DOWN.value], fn: 'drill', dir: DIR.DOWN, target, reason: 'bootstrap descent shaft' };
  }
  return null;
}

function anchorDescentLadderAction(agent, map) {
  if (!AUTO_LADDER_DESCENT || agent.y <= 0 || agent.ladders <= LADDER_BUFFER) return null;
  const current = tileAt(map, agent.x, agent.y);
  if (current !== TILE.EMPTY) return null;
  const above = tileAt(map, agent.x, agent.y - 1);
  const below = tileAt(map, agent.x, agent.y + 1);
  const verticalShaft = above === TILE.SURFACE || above === TILE.LADDER || above === TILE.EMPTY;
  const usefulBelow = below === TILE.DIRT || isResource(below) || isTraversable(below);
  if (!verticalShaft || !usefulBelow) return null;
  return {
    method: 'PlaceLadder',
    args: [DIR.CURRENT.value],
    fn: 'placeLadder',
    dir: DIR.CURRENT,
    target: { x: agent.x, y: agent.y },
    reason: 'anchor shared descent ladder',
  };
}

function deepenShaftAction(agent, map) {
  if (agent.y <= 0 || carried(agent) >= Math.min(RETURN_LOAD, agent.capacity) || agent.ladders <= LADDER_BUFFER) return null;
  const target = targetFor(agent, DIR.DOWN);
  if (!target) return null;
  const tile = tileAt(map, target.x, target.y);
  if (isTraversable(tile)) {
    return {
      method: 'MoveAgent',
      args: [DIR.DOWN.value],
      fn: 'move',
      dir: DIR.DOWN,
      target,
      reason: 'deepen shared shaft through open cell',
    };
  }
  if ((tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y)) {
    return {
      method: 'Drill',
      args: [DIR.DOWN.value],
      fn: 'drill',
      dir: DIR.DOWN,
      target,
      reason: 'deepen shared shaft',
    };
  }
  return null;
}

function bypassDirection(agentConfig, agent, map) {
  const candidates = [];
  for (const sign of [-1, 1]) {
    for (let offset = 1; offset <= BYPASS_MAX_RADIUS; offset += 1) {
      const x = agent.x + sign * offset;
      if (!inBounds(x, agent.y)) break;
      const tile = tileAt(map, x, agent.y);
      if (tile === TILE.STONE || tile === TILE.CHEST) break;
      const below = tileAt(map, x, agent.y + 1);
      if (below !== TILE.STONE) {
        const continuing = agentConfig.bypassDir === sign ? -2 : 0;
        const shaftPenalty = Math.abs(x - agentConfig.shaftX) * 0.15;
        candidates.push({ sign, offset, score: offset + shaftPenalty + continuing });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.offset - b.offset);
  if (candidates[0]) return candidates[0].sign;
  return agentConfig.bypassDir || (agent.x <= agentConfig.shaftX ? 1 : -1);
}

function sidestepBlockedShaftAction(agentConfig, agent, map) {
  if (agent.y <= 0 || agent.y >= DEEPEN_FIRST_DEPTH || carried(agent) >= Math.min(RETURN_LOAD, agent.capacity)) return null;
  if (agent.ladders <= LADDER_BUFFER) return null;
  const below = targetFor(agent, DIR.DOWN);
  if (!below || tileAt(map, below.x, below.y) !== TILE.STONE) return null;

  const preferredSign = bypassDirection(agentConfig, agent, map);
  const dirs = preferredSign > 0 ? [DIR.RIGHT, DIR.LEFT] : [DIR.LEFT, DIR.RIGHT];
  for (const dir of dirs) {
    const sign = dir.value === DIR.RIGHT.value ? 1 : -1;
    if (agentConfig.bypassDir && sign !== agentConfig.bypassDir) continue;
    const target = targetFor(agent, dir);
    if (!target) continue;
    const tile = tileAt(map, target.x, target.y);
    if (tile === TILE.STONE || tile === TILE.CHEST) continue;
    if (isTraversable(tile)) {
      agentConfig.bypassDir = sign;
      return {
        method: 'MoveAgent',
        args: [dir.value],
        fn: 'move',
        dir,
        target,
        reason: `sidestep blocked shaft dir=${sign > 0 ? 'right' : 'left'}`,
      };
    }
    if ((tile === TILE.DIRT || isResource(tile)) && !unsafeResource(map, target.x, target.y)) {
      agentConfig.bypassDir = sign;
      return {
        method: 'Drill',
        args: [dir.value],
        fn: 'drill',
        dir,
        target,
        reason: `open bypass around shaft stone dir=${sign > 0 ? 'right' : 'left'}`,
      };
    }
  }
  agentConfig.bypassDir = null;
  return null;
}

function chooseAction(agentConfig, agent, map) {
  if (!agent || agent.status !== 1 || agent.hp <= 0) {
    agentConfig.stopped = true;
    agentConfig.stopReason = agent ? `not active status=${agent.status}` : 'missing agent state';
    return null;
  }

  if (agentConfig.forceReturn) {
    if (carried(agent) > 0 || agentConfig.mode === 'return') {
      agentConfig.mode = 'return';
      agentConfig.targetKey = null;
      const action = bestFirstActionToSurface(agent, map);
      if (action) return { ...action, reason: action.reason || 'forced return after local loop' };
    }
    agentConfig.forceReturn = false;
    agentConfig.bypassDir = null;
  }

  if (!agentConfig.finalReturn && carried(agent) === 0 && tradableLadders(agent) > 0 && agent.ladders < RESUPPLY_LADDER_TARGET) {
    agentConfig.mode = 'return';
    agentConfig.targetKey = null;
    if (agent.y === 0) {
      const trade = tradeForLaddersAction(agent);
      if (trade) return { ...trade, reason: `${trade.reason}; resupply before next run` };
    }
    const action = bestFirstActionToSurface(agent, map);
    if (action) return { ...action, reason: action.reason || 'return for ladder resupply' };
  }

  if (FORCE_RETURN) {
    if (carried(agent) > 0 || agentConfig.mode === 'return') {
      agentConfig.mode = 'return';
      agentConfig.targetKey = null;
      return bestFirstActionToSurface(agent, map);
    }
    agentConfig.stopped = true;
    agentConfig.stopReason = 'force-return: no carried load';
    return null;
  }

  if (agentConfig.finalReturn) {
    if (carried(agent) > 0 || agentConfig.mode === 'return') {
      agentConfig.mode = 'return';
      agentConfig.targetKey = null;
      const action = bestFirstActionToSurface(agent, map);
      if (action) return { ...action, reason: action.reason || 'final return' };
    }
    agentConfig.stopped = true;
    agentConfig.stopReason = 'final return complete';
    return null;
  }

  if (carried(agent) >= Math.min(RETURN_LOAD, agent.capacity) || (agentConfig.mode === 'return' && carried(agent) > 0)) {
    agentConfig.mode = 'return';
    agentConfig.targetKey = null;
    const action = bestFirstActionToSurface(agent, map);
    if (action) return action;
  }

  if (agent.y === 0 && carried(agent) > 0) return { method: 'Surface', args: [], fn: 'surface', reason: 'bank carried resources' };
  const ladderTrade = tradeForLaddersAction(agent);
  if (ladderTrade) return ladderTrade;
  if (agent.y === 0 && MINT_AFTER_SURFACE && banked(agent) > 0) return { method: 'MintResources', args: [], fn: 'mint', reason: 'mint banked resources' };
  if (agent.y === 0 && carried(agent) === 0 && agent.ladders < MIN_LADDERS_FOR_NEW_RUN) {
    agentConfig.stopped = true;
    agentConfig.stopReason = `low ladders for new mining run: ${agent.ladders}/${MIN_LADDERS_FOR_NEW_RUN}`;
    return null;
  }

  agentConfig.mode = 'mine';
  if (tileAt(map, agent.x, agent.y + 1) !== TILE.STONE) agentConfig.bypassDir = null;
  const planned = choosePlannedAction(agentConfig, agent, map);
  if (planned) return planned;
  if (PLANNED_MODE && agentConfig.targetKey) {
    if (carried(agent) > 0) {
      agentConfig.mode = 'return';
      return bestFirstActionToSurface(agent, map);
    }
    return null;
  }
  const anchor = anchorDescentLadderAction(agent, map);
  if (anchor) return anchor;
  const bootstrap = bootstrapDescentAction(agent, map);
  if (bootstrap) return bootstrap;
  const adjacent = adjacentResourceAction(agent, map);
  if (adjacent) return adjacent;
  const descentSweep = chooseLocalResourceAction(agentConfig, agent, map, {
    radius: DESCENT_SWEEP_RADIUS,
    vertical: 3,
    maxCost: 7,
  });
  if (descentSweep) return descentSweep;
  if (agentConfig.targetKey) {
    const stickyMining = chooseResourceAction(agentConfig, agent, map);
    if (stickyMining) return { ...stickyMining, reason: `continue ${stickyMining.reason || 'target route'}` };
  }
  if (agent.y > 0 && agent.y < DEEPEN_FIRST_DEPTH) {
    const deepen = deepenShaftAction(agent, map);
    if (deepen) return deepen;
    const sidestep = sidestepBlockedShaftAction(agentConfig, agent, map);
    if (sidestep) return sidestep;
  }
  const localMining = chooseLocalResourceAction(agentConfig, agent, map);
  if (localMining) return localMining;
  const allowGlobalSearch = agent.y >= GLOBAL_SEARCH_MIN_DEPTH ||
    (carried(agent) === 0 && agent.ladders >= RESUPPLY_LADDER_TARGET);
  const mining = allowGlobalSearch ? chooseResourceAction(agentConfig, agent, map) : null;
  if (mining) return mining;
  const deepen = deepenShaftAction(agent, map);
  if (deepen) return deepen;
  if (carried(agent) > 0) {
    agentConfig.mode = 'return';
    return bestFirstActionToSurface(agent, map);
  }
  return null;
}

let control = null;

async function readSession() {
  const reply = await control.query(WORLD, control.encode.session());
  return control.decode.session(reply.payload).map(Number);
}

async function readMap() {
  const reply = await control.query(WORLD, control.encode.mapSnapshot());
  return control.decode.mapSnapshot(reply.payload).map(Number);
}

async function readAgent(owner) {
  const reply = await control.query(WORLD, control.encode.agentOf(owner));
  return agentFromView(control.decode.agentOf(reply.payload));
}

async function readAgents() {
  const entries = await Promise.all(AGENTS.map(async (agent) => [agent.label, await readAgent(agent.owner)]));
  return Object.fromEntries(entries);
}

async function createReadControl() {
  return connectDiggerWorldChain(loadChainEnv());
}

async function readExecutableBalanceSafe(control, programId) {
  try {
    return (await control.readExecutableBalance(programId)).toString();
  } catch (error) {
    return `error:${error.message}`;
  }
}

async function readExecutableBalances() {
  return {};
}

async function agentConnection(agent) {
  if (!agent.conn) agent.conn = await connectDiggerWorldChain({ ...loadChainEnv(), adminKey: agent.key });
  return agent.conn;
}

async function callProxy(agent, action) {
  const started = Date.now();
  const conn = await agentConnection(agent);
  let payload;
  if (action.method === 'MoveAgent') payload = conn.encode.moveAgent(action.args[0]);
  else if (action.method === 'Drill') payload = conn.encode.drill(action.args[0]);
  else if (action.method === 'PlaceLadder') payload = conn.encode.placeLadder(action.args[0]);
  else if (action.method === 'Surface') payload = conn.encode.surface();
  else if (action.method === 'TradeResourcesForLadders') payload = conn.encode.tradeResourcesForLadders(...action.args);
  else if (action.method === 'MintResources') payload = conn.encode.mintResources();
  else throw new Error(`unsupported action ${action.method}`);
  const result = await Promise.race([
    conn.sendInjected(WORLD, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`call timeout after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)),
  ]);
  return { ms: Date.now() - started, result };
}

async function waitForWorldChange(owner, before) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = before;
  while (Date.now() < deadline) {
    const current = await readAgent(owner);
    last = current;
    if (agentChanged(before, current)) return current;
    await sleep(POLL_INTERVAL_MS);
  }
  const error = new Error(`proxy-only/no world confirmation within ${POLL_TIMEOUT_MS}ms`);
  error.last = last;
  throw error;
}

async function writeReport(base, report) {
  const json = JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
  await writeFile(`${base}.json`, json);
  const before = report.before.resources;
  const after = report.after.resources;
  const lines = [
    '# Cluster miner run',
    '',
    `World: \`${WORLD}\``,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    '',
    '## Summary',
    '',
    `- Plan only: ${report.planOnly}`,
    `- Confirmed actions: ${report.summary.confirmed}`,
    `- Proxy-only/timeouts: ${report.summary.proxyOnly}`,
    `- Failed calls: ${report.summary.failed}`,
    `- Stop reason: ${report.summary.stopReason || 'limits/no active agents'}`,
    `- Session actionSeq: ${report.before.session[3]} -> ${report.after.session[3]}`,
    `- Resources left: ${before.total} (${before.scrst}/${before.bcrst}/${before.hcrst}) -> ${after.total} (${after.scrst}/${after.bcrst}/${after.hcrst})`,
    `- Resources removed: ${before.total - after.total}`,
    `- Carried after: ${report.after.carried.join('/')}`,
    `- Banked after: ${report.after.banked.join('/')}`,
    `- Diagnostic events: ${report.diagnostics?.events ?? 0}`,
    `- Throughput: ${report.summary.confirmedPerMinute ?? 'n/a'} confirmed/min`,
    `- Proxy burn: ${report.summary.proxyBurnVara ?? 'n/a'} wVARA`,
    `- World burn: ${report.summary.worldBurnVara ?? 'n/a'} wVARA`,
    '',
    '## Agents',
    '',
    '| Agent | Cluster | Confirmed | Mined | Final x,y | Carried | Banked | Target | Stop reason |',
    '| --- | --- | ---: | --- | --- | --- | --- | --- | --- |',
  ];
  for (const agent of report.agents) {
    lines.push(`| ${agent.label} | ${agent.cluster} | ${agent.confirmed} | ${agent.mined.scrst}/${agent.mined.bcrst}/${agent.mined.hcrst} | ${agent.final.x},${agent.final.y} | ${agent.final.carried.join('/')} | ${agent.final.banked.join('/')} | ${agent.targetKey || ''} | ${agent.stopReason || ''} |`);
  }
  lines.push(
    '',
    '## Diagnostics',
    '',
    `- Remaining resources by depth: ${JSON.stringify(report.diagnostics?.remainingResources?.bands || {})}`,
    `- Unsafe remaining resources: ${JSON.stringify(report.diagnostics?.remainingResources?.unsafe || {})}`,
  );
  await writeFile(`${base}.md`, `${lines.join('\n')}\n`);
}

async function main() {
  const startedAt = new Date().toISOString();
  const wallStarted = Date.now();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const reportBase = path.join(OUTPUT_DIR, `cluster-miner-${startedAt.replace(/[:.]/g, '-')}`);
  control = await createReadControl();

  let localMap = await readMap();
  let localSession = await readSession();
  let localAgents = await readAgents();
  const initialMap = localMap.slice();
  const initialSession = localSession.slice();
  const initialAgents = Object.fromEntries(Object.entries(localAgents).map(([label, agent]) => [label, { ...agent }]));
  const initialBalances = PLAN_ONLY ? {} : await readExecutableBalances();
  const initialWorldBalance = PLAN_ONLY ? null : await readExecutableBalanceSafe(control, WORLD);
  const initialResourceTotal = resourceCounts(initialMap).total;

  let sent = 0;
  let confirmed = 0;
  let proxyOnly = 0;
  let failed = 0;
  let lastReconcile = 0;
  let lastResourceTotal = initialResourceTotal;
  let lastResourceChangeConfirmed = 0;
  let stopReason = '';
  let reconcilePromise = null;
  const log = [];

  function diagnosticEvent(event) {
    if (!DIAGNOSTIC_LOG) return;
    log.push({ type: 'diagnostic', confirmed, ...event });
    if (event.severity !== 'debug') {
      console.log(`[cluster:diag] confirmed=${confirmed} ${event.label || ''} ${event.kind}: ${event.message}`);
    }
  }

  function noteResourceProgress(source) {
    const current = resourceCounts(localMap).total;
    if (current < lastResourceTotal) {
      log.push({
        type: 'resource-progress',
        source,
        confirmed,
        before: lastResourceTotal,
        after: current,
        removed: initialResourceTotal - current,
      });
      lastResourceChangeConfirmed = confirmed;
    }
    lastResourceTotal = current;
  }

  function globalStopReason() {
    const current = resourceCounts(localMap).total;
    const removed = initialResourceTotal - current;
    if (TARGET_RESOURCES > 0 && removed >= TARGET_RESOURCES) {
      return `target resources mined: ${removed}/${TARGET_RESOURCES}`;
    }
    if (PLATEAU_CONFIRMED_LIMIT > 0 && confirmed > 0 && confirmed - lastResourceChangeConfirmed >= PLATEAU_CONFIRMED_LIMIT) {
      return `resource plateau: no mined resources for ${confirmed - lastResourceChangeConfirmed} confirmed actions`;
    }
    return '';
  }

  function recordActionDiagnostics(agentConfig, before, after, action, delta, source) {
    const phase = actionPhase(action);
    agentConfig.diagnostics.phaseCounts[phase] = (agentConfig.diagnostics.phaseCounts[phase] || 0) + 1;
    const mined = delta.scrst + delta.bcrst + delta.hcrst;
    if (mined > 0) {
      agentConfig.lastMinedConfirmed = agentConfig.confirmed;
      agentConfig.forceReturn = false;
      agentConfig.bypassDir = null;
    }
    if (action.method === 'Surface') {
      agentConfig.forceReturn = false;
      agentConfig.bypassDir = null;
      agentConfig.recentPositions = [];
    }

    agentConfig.recentPositions.push(positionKey(after));
    while (agentConfig.recentPositions.length > OSCILLATION_WINDOW) agentConfig.recentPositions.shift();

    if (hasOscillation(agentConfig.recentPositions)) {
      agentConfig.diagnostics.loopBreaks += 1;
      if (phase === 'stone-bypass') agentConfig.diagnostics.bypassAbandoned += 1;
      agentConfig.bypassDir = null;
      if (action.resource?.key) {
        agentConfig.blacklist.add(action.resource.key);
        agentConfig.targetKey = null;
      }
      if (carried(after) > 0) {
        agentConfig.forceReturn = true;
        agentConfig.diagnostics.forcedReturns += 1;
      } else {
        agentConfig.blacklist.add(`${phase}:${positionKey(after)}:${actionText(action)}`);
      }
      diagnosticEvent({
        kind: 'loop-break',
        label: agentConfig.label,
        severity: 'warn',
        source,
        phase,
        action: actionText(action),
        targetKey: action.resource?.key || agentConfig.targetKey || null,
        message: `oscillation at ${agentConfig.recentPositions.slice(-4).join(' -> ')}; ${carried(after) > 0 ? 'forcing return' : 'blacklisting target/action'}`,
        before: agentSummary(before),
        after: agentSummary(after),
      });
    }

    const staleCarry = carried(after) > 0 &&
      !agentConfig.finalReturn &&
      phase !== 'return' &&
      phase !== 'bank' &&
      agentConfig.confirmed - agentConfig.lastMinedConfirmed >= AGENT_STALE_CARRY_ACTIONS;
    if (staleCarry) {
      agentConfig.forceReturn = true;
      agentConfig.bypassDir = null;
      agentConfig.diagnostics.forcedReturns += 1;
      agentConfig.diagnostics.staleCarryReturns += 1;
      diagnosticEvent({
        kind: 'stale-carry-return',
        label: agentConfig.label,
        severity: 'warn',
        source,
        phase,
        action: actionText(action),
        message: `carrying ${carried(after)} resources for ${agentConfig.confirmed - agentConfig.lastMinedConfirmed} actions without mining; forcing return`,
        before: agentSummary(before),
        after: agentSummary(after),
      });
    }

    return { phase, mined };
  }

  async function reconcile(reason) {
    if (!reconcilePromise) {
      reconcilePromise = (async () => {
        localSession = await readSession();
        localMap = await readMap();
        localAgents = await readAgents();
        for (const agent of AGENTS) {
          if (agent.targetKey && tileAt(localMap, ...agent.targetKey.split(',').map(Number)) !== undefined) {
            const [x, y] = agent.targetKey.split(',').map(Number);
            if (!isResource(tileAt(localMap, x, y))) agent.targetKey = null;
          }
        }
        lastReconcile = confirmed;
        noteResourceProgress(`reconcile:${reason}`);
        log.push({ type: 'reconcile', reason, confirmed, resources: resourceCounts(localMap) });
      })().finally(() => {
        reconcilePromise = null;
      });
    }
    await reconcilePromise;
  }

  async function runPlanOnly() {
    for (;;) {
      stopReason = globalStopReason();
      if (stopReason) break;
      let progressed = false;
      for (const agentConfig of AGENTS.slice(0, CONCURRENCY)) {
        if (confirmed >= MAX_CONFIRMED || sent >= MAX_SENDS) break;
        const before = localAgents[agentConfig.label];
        const action = chooseAction(agentConfig, before, localMap);
        if (!action || !actionPlausible(before, localMap, action)) continue;
        const applied = applyAction(before, localMap, action);
        if (!applied) continue;
        sent += 1;
        confirmed += 1;
        agentConfig.sent += 1;
        agentConfig.confirmed += 1;
        addMined(agentConfig.mined, minedDelta(before, applied.agent));
        localAgents[agentConfig.label] = applied.agent;
        localMap = applied.map;
        noteResourceProgress(`plan:${agentConfig.label}`);
        const delta = minedDelta(before, applied.agent);
        const diagnostic = recordActionDiagnostics(agentConfig, before, applied.agent, action, delta, 'plan');
        log.push({ type: 'plan-action', label: agentConfig.label, action: actionText(action), phase: diagnostic.phase, reason: action.reason, before: agentSummary(before), after: agentSummary(applied.agent) });
        progressed = true;
      }
      if (!progressed || confirmed >= MAX_CONFIRMED || sent >= MAX_SENDS) break;
    }
  }

  async function agentLoop(agentConfig) {
    while (!PLAN_ONLY && !agentConfig.stopped && confirmed < MAX_CONFIRMED && sent < MAX_SENDS) {
      if (!agentConfig.finalReturn) {
        stopReason = globalStopReason();
        if (stopReason) {
          agentConfig.stopped = true;
          agentConfig.stopReason = stopReason;
          return;
        }
      }
      if (localSession[2] !== 1) {
        agentConfig.stopped = true;
        agentConfig.stopReason = `session status=${localSession[2]}`;
        return;
      }
      if (confirmed - lastReconcile >= RECONCILE_EVERY) await reconcile('periodic');
      let before = localAgents[agentConfig.label];
      if (!before || before.status !== 1 || before.hp <= 0) {
        agentConfig.stopped = true;
        agentConfig.stopReason = before ? `not active status=${before.status}` : 'missing agent state';
        return;
      }
      let action = chooseAction(agentConfig, before, localMap);
      if (!action || !actionPlausible(before, localMap, action)) {
        await reconcile(`no-action:${agentConfig.label}`);
        before = localAgents[agentConfig.label];
        action = chooseAction(agentConfig, before, localMap);
      }
      if (!action || !actionPlausible(before, localMap, action)) {
        diagnosticEvent({
          kind: 'no-action',
          label: agentConfig.label,
          severity: 'warn',
          message: 'no plausible action after reconcile',
          agent: before ? agentSummary(before) : null,
          nearbyResources: before ? nearbyResources(localMap, before) : [],
          remainingResources: resourceDepthSummary(localMap),
        });
        agentConfig.stopped = true;
        agentConfig.stopReason = 'no plausible cluster action';
        return;
      }

      const entry = {
        type: 'action',
        label: agentConfig.label,
        action: actionText(action),
        phase: actionPhase(action),
        reason: action.reason,
        targetKey: agentConfig.targetKey,
        before: agentSummary(before),
        ok: false,
      };
      sent += 1;
      agentConfig.sent += 1;
      const started = Date.now();
      try {
        entry.directResult = (await callProxy(agentConfig, action)).result;
        const after = await waitForWorldChange(agentConfig.owner, before);
        const latency = Date.now() - started;
        entry.ok = true;
        entry.confirmMs = latency;
        entry.after = agentSummary(after);
        confirmed += 1;
        agentConfig.confirmed += 1;
        agentConfig.latenciesMs.push(latency);
        const delta = minedDelta(before, after);
        addMined(agentConfig.mined, delta);
        if (action.method === 'Surface') {
          agentConfig.surfaced += 1;
          agentConfig.mode = 'mine';
          agentConfig.targetKey = null;
        }
        if (action.method === 'MintResources') agentConfig.minted += 1;
        const applied = applyAction(before, localMap, action);
        localAgents[agentConfig.label] = after;
        if (applied) {
          localMap = applied.map;
          noteResourceProgress(`live:${agentConfig.label}`);
        }
        const diagnostic = recordActionDiagnostics(agentConfig, before, after, action, delta, 'live');
        entry.phase = diagnostic.phase;
        if (confirmed % 20 === 0 || confirmed === 1 || action.method === 'Drill' || action.method === 'Surface') {
          console.log(`[cluster] confirmed=${confirmed} sent=${sent} ${agentConfig.label}:${entry.action} ${entry.reason || ''} ms=${latency}`);
        }
      } catch (error) {
        entry.error = error.message;
        try {
          const after = await waitForWorldChange(agentConfig.owner, before);
          const latency = Date.now() - started;
          entry.ok = true;
          entry.recoveredAfterWriteError = true;
          entry.confirmMs = latency;
          entry.after = agentSummary(after);
          confirmed += 1;
          agentConfig.confirmed += 1;
          agentConfig.latenciesMs.push(latency);
          const delta = minedDelta(before, after);
          addMined(agentConfig.mined, delta);
          localAgents[agentConfig.label] = after;
          const applied = applyAction(before, localMap, action);
          if (applied) {
            localMap = applied.map;
            noteResourceProgress(`live-recovered:${agentConfig.label}`);
          }
          const diagnostic = recordActionDiagnostics(agentConfig, before, after, action, delta, 'live-recovered');
          entry.phase = diagnostic.phase;
        } catch (confirmError) {
          if (confirmError.message.includes('proxy-only/no world confirmation')) {
            proxyOnly += 1;
            agentConfig.proxyOnly += 1;
            agentConfig.blacklist.add(`${before.x},${before.y}:${actionText(action)}`);
          } else {
            failed += 1;
            agentConfig.failed += 1;
          }
          entry.confirmAfterError = confirmError.message;
          await reconcile(`error:${agentConfig.label}`);
          if (agentConfig.proxyOnly + agentConfig.failed >= FAILURE_LIMIT) {
            agentConfig.stopped = true;
            agentConfig.stopReason = `failure limit after ${actionText(action)}`;
          }
        }
      } finally {
        log.push(entry);
      }
    }
  }

  async function runFinalReturn() {
    if (PLAN_ONLY || !FINAL_RETURN || confirmed >= MAX_CONFIRMED || sent >= MAX_SENDS) return false;
    await reconcile('final-return-start');
    const returning = [];
    for (const agentConfig of AGENTS) {
      const agent = localAgents[agentConfig.label];
      if (agent?.status === 1 && agent.hp > 0 && carried(agent) > 0) {
        agentConfig.mode = 'return';
        agentConfig.finalReturn = true;
        agentConfig.stopped = false;
        agentConfig.stopReason = '';
        agentConfig.targetKey = null;
        returning.push(agentConfig);
      }
    }
    if (returning.length === 0) return false;
    console.log(`[cluster] final-return agents=${returning.map((agent) => agent.label).join(',')}`);
    await Promise.all(returning.slice(0, Math.max(1, Math.min(CONCURRENCY, returning.length))).map(agentLoop));
    await reconcile('final-return-end');
    return true;
  }

  console.log(`[cluster] world=${WORLD} planOnly=${PLAN_ONLY} session=${initialSession.join('/')} resources=${JSON.stringify(resourceCounts(initialMap))}`);
  if (PLAN_ONLY) await runPlanOnly();
  else await Promise.all(AGENTS.slice(0, Math.max(1, Math.min(CONCURRENCY, AGENTS.length))).map(agentLoop));

  stopReason ||= globalStopReason();
  await runFinalReturn();

  if (!PLAN_ONLY) await reconcile('final');
  const finalMap = localMap.slice();
  const finalSession = localSession.slice();
  const finalAgents = localAgents;
  const finalBalances = PLAN_ONLY ? {} : await readExecutableBalances();
  const finalWorldBalance = PLAN_ONLY ? null : await readExecutableBalanceSafe(control, WORLD);
  const proxyBurnRaw = PLAN_ONLY ? null : Object.fromEntries(AGENTS.map((agent) => [agent.label, burn(initialBalances[agent.label], finalBalances[agent.label])]));
  const proxyBurnTotalRaw = proxyBurnRaw ? Object.values(proxyBurnRaw).filter(Boolean).reduce((sum, value) => sum + BigInt(value), 0n).toString() : null;
  const worldBurnRaw = PLAN_ONLY ? null : burn(initialWorldBalance, finalWorldBalance);
  const wallMs = Date.now() - wallStarted;
  const allLatencies = AGENTS.flatMap((agent) => agent.latenciesMs);

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    world: WORLD,
    planOnly: PLAN_ONLY,
    parameters: {
      MAX_CONFIRMED,
      MAX_SENDS,
      CONCURRENCY,
      RETURN_LOAD,
      RECONCILE_EVERY,
      FORCE_RETURN,
      FINAL_RETURN,
      MIN_LADDERS_TO_MINE,
      MIN_LADDERS_FOR_NEW_RUN,
      LADDER_BUFFER,
      RESUPPLY_LADDER_TARGET,
      AUTO_LADDER_DESCENT,
      VALUE_WEIGHT,
      ACTION_COST_VARA,
      DEEPEN_FIRST_DEPTH,
      TARGET_RESOURCES,
      PLATEAU_CONFIRMED_LIMIT,
      LOCAL_SWEEP_RADIUS,
      LOCAL_SWEEP_VERTICAL,
      LOCAL_SWEEP_MAX_COST,
      DESCENT_SWEEP_RADIUS,
      GLOBAL_SEARCH_MIN_DEPTH,
      RESOURCE_VALUE,
      BYPASS_MAX_RADIUS,
      AGENT_STALE_CARRY_ACTIONS,
      OSCILLATION_WINDOW,
      DIAGNOSTIC_LOG,
      PLANNED_MODE,
      PLANNED_LANE_RADIUS,
      PLANNED_DEEPEN_MARGIN,
      PLANNED_MIN_LADDERS,
    },
    mode: 'local-direct-world',
    before: {
      session: initialSession,
      resources: resourceCounts(initialMap),
      agents: Object.fromEntries(Object.entries(initialAgents).map(([label, agent]) => [label, agentSummary(agent)])),
      balances: initialBalances,
      worldExecutableBalance: initialWorldBalance,
    },
    after: {
      session: finalSession,
      resources: resourceCounts(finalMap),
      agents: Object.fromEntries(Object.entries(finalAgents).map(([label, agent]) => [label, agentSummary(agent)])),
      carried: Object.values(finalAgents).reduce((sum, agent) => {
        sum[0] += agent.invScrst; sum[1] += agent.invBcrst; sum[2] += agent.invHcrst; return sum;
      }, [0, 0, 0]),
      banked: Object.values(finalAgents).reduce((sum, agent) => {
        sum[0] += agent.bankedScrst; sum[1] += agent.bankedBcrst; sum[2] += agent.bankedHcrst; return sum;
      }, [0, 0, 0]),
      balances: finalBalances,
      worldExecutableBalance: finalWorldBalance,
    },
    summary: {
      sent,
      confirmed,
      proxyOnly,
      failed,
      actionSeqDelta: finalSession[3] - initialSession[3],
      stopReason,
      wallMs,
      confirmedPerMinute: wallMs > 0 ? Number((confirmed / (wallMs / 60_000)).toFixed(2)) : null,
      latency: latencyStats(allLatencies),
      proxyBurnRaw: proxyBurnTotalRaw,
      proxyBurnVara: toVara(proxyBurnTotalRaw),
      worldBurnRaw,
      worldBurnVara: toVara(worldBurnRaw),
    },
    agents: AGENTS.map((agent) => ({
      label: agent.label,
      cluster: agent.cluster,
      shaftX: agent.shaftX,
      missionShaftX: agent.missionShaftX,
      confirmed: agent.confirmed,
      proxyOnly: agent.proxyOnly,
      failed: agent.failed,
      surfaced: agent.surfaced,
      minted: agent.minted,
      mined: agent.mined,
      latency: latencyStats(agent.latenciesMs),
      targetKey: agent.targetKey,
      final: agentSummary(finalAgents[agent.label]),
      initialBalance: initialBalances[agent.label],
      finalBalance: finalBalances[agent.label],
      proxyBurnRaw: proxyBurnRaw?.[agent.label] ?? null,
      stopReason: agent.stopReason,
      diagnostics: agent.diagnostics,
    })),
    diagnostics: {
      events: log.filter((entry) => entry.type === 'diagnostic').length,
      remainingResources: resourceDepthSummary(finalMap),
      remainingResourceCoordinates: resourceCoordinates(finalMap),
      phaseCounts: AGENTS.reduce((acc, agent) => {
        for (const [phase, count] of Object.entries(agent.diagnostics.phaseCounts)) {
          acc[phase] = (acc[phase] || 0) + count;
        }
        return acc;
      }, {}),
      loopBreaks: AGENTS.reduce((sum, agent) => sum + agent.diagnostics.loopBreaks, 0),
      forcedReturns: AGENTS.reduce((sum, agent) => sum + agent.diagnostics.forcedReturns, 0),
      staleCarryReturns: AGENTS.reduce((sum, agent) => sum + agent.diagnostics.staleCarryReturns, 0),
      bypassAbandoned: AGENTS.reduce((sum, agent) => sum + agent.diagnostics.bypassAbandoned, 0),
    },
    log,
  };

  await writeReport(reportBase, report);
  console.log(`[cluster] final confirmed=${confirmed} proxyOnly=${proxyOnly} failed=${failed} seqDelta=${report.summary.actionSeqDelta}`);
  console.log(`[cluster] resources ${report.before.resources.total}->${report.after.resources.total} report=${reportBase}.md`);
  control.disconnect?.();
  for (const agent of AGENTS) agent.conn?.disconnect?.();
}

await main();
