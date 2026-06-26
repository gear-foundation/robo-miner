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
const AUTO_LADDER_DESCENT = process.env.ROBO_CLUSTER_AUTO_LADDER_DESCENT !== '0';
const VALUE_WEIGHT = Number(process.env.ROBO_CLUSTER_VALUE_WEIGHT || 0.35);
const ACTION_COST_VARA = Number(process.env.ROBO_CLUSTER_ACTION_COST_VARA || 0.30);
const DEEPEN_FIRST_DEPTH = Number(process.env.ROBO_CLUSTER_DEEPEN_FIRST_DEPTH || 52);

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
const RESOURCE_VALUE = { [TILE.SCRST]: 66, [TILE.BCRST]: 330, [TILE.HCRST]: 1650 };
const RESOURCE_NAME = { [TILE.SCRST]: 'SCRST', [TILE.BCRST]: 'BCRST', [TILE.HCRST]: 'HCRST' };

if (!WORLD) {
  console.error('usage: cluster-world.js <worldProgramId> [agents]');
  process.exit(1);
}

const AGENTS = Array.from({ length: AGENT_COUNT }, (_, index) => {
  const key = keccak256(stringToBytes(`digger-agent:${WORLD}:${index}`));
  const account = privateKeyToAccount(key);
  const xBand = index / Math.max(1, AGENT_COUNT);
  return {
    label: `a${String(index + 1).padStart(2, '0')}`,
    cluster: xBand < 1 / 3 ? 'left' : xBand < 2 / 3 ? 'mid' : 'right',
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

function ladderValueFromTrade(scrst, bcrst, hcrst) {
  return Math.floor(scrst / 5) + bcrst + hcrst * 5;
}

function tradeForLaddersAction(agent) {
  if (agent.y !== 0 || carried(agent) > 0 || agent.ladders >= MIN_LADDERS_TO_MINE) return null;
  let need = Math.max(1, MIN_LADDERS_TO_MINE + LADDER_BUFFER - agent.ladders);
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

function chooseAction(agentConfig, agent, map) {
  if (!agent || agent.status !== 1 || agent.hp <= 0) {
    agentConfig.stopped = true;
    agentConfig.stopReason = agent ? `not active status=${agent.status}` : 'missing agent state';
    return null;
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
  if (agent.y === 0 && carried(agent) === 0 && agent.ladders < MIN_LADDERS_TO_MINE) {
    agentConfig.stopped = true;
    agentConfig.stopReason = `low ladders for new mining run: ${agent.ladders}`;
    return null;
  }

  agentConfig.mode = 'mine';
  const anchor = anchorDescentLadderAction(agent, map);
  if (anchor) return anchor;
  const bootstrap = bootstrapDescentAction(agent, map);
  if (bootstrap) return bootstrap;
  const adjacent = adjacentResourceAction(agent, map);
  if (adjacent) return adjacent;
  if (agent.y > 0 && agent.y < DEEPEN_FIRST_DEPTH) {
    const deepen = deepenShaftAction(agent, map);
    if (deepen) return deepen;
  }
  const mining = chooseResourceAction(agentConfig, agent, map);
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
    `- Session actionSeq: ${report.before.session[3]} -> ${report.after.session[3]}`,
    `- Resources left: ${before.total} (${before.scrst}/${before.bcrst}/${before.hcrst}) -> ${after.total} (${after.scrst}/${after.bcrst}/${after.hcrst})`,
    `- Resources removed: ${before.total - after.total}`,
    `- Carried after: ${report.after.carried.join('/')}`,
    `- Banked after: ${report.after.banked.join('/')}`,
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

  let sent = 0;
  let confirmed = 0;
  let proxyOnly = 0;
  let failed = 0;
  let lastReconcile = 0;
  let reconcilePromise = null;
  const log = [];

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
        log.push({ type: 'reconcile', reason, confirmed, resources: resourceCounts(localMap) });
      })().finally(() => {
        reconcilePromise = null;
      });
    }
    await reconcilePromise;
  }

  async function runPlanOnly() {
    for (;;) {
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
        log.push({ type: 'plan-action', label: agentConfig.label, action: actionText(action), reason: action.reason, before: agentSummary(before), after: agentSummary(applied.agent) });
        progressed = true;
      }
      if (!progressed || confirmed >= MAX_CONFIRMED || sent >= MAX_SENDS) break;
    }
  }

  async function agentLoop(agentConfig) {
    while (!PLAN_ONLY && !agentConfig.stopped && confirmed < MAX_CONFIRMED && sent < MAX_SENDS) {
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
        agentConfig.stopped = true;
        agentConfig.stopReason = 'no plausible cluster action';
        return;
      }

      const entry = {
        type: 'action',
        label: agentConfig.label,
        action: actionText(action),
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
        addMined(agentConfig.mined, minedDelta(before, after));
        if (action.method === 'Surface') {
          agentConfig.surfaced += 1;
          agentConfig.mode = 'mine';
          agentConfig.targetKey = null;
        }
        if (action.method === 'MintResources') agentConfig.minted += 1;
        const applied = applyAction(before, localMap, action);
        localAgents[agentConfig.label] = after;
        if (applied) localMap = applied.map;
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
          addMined(agentConfig.mined, minedDelta(before, after));
          localAgents[agentConfig.label] = after;
          const applied = applyAction(before, localMap, action);
          if (applied) localMap = applied.map;
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
      LADDER_BUFFER,
      AUTO_LADDER_DESCENT,
      VALUE_WEIGHT,
      ACTION_COST_VARA,
      RESOURCE_VALUE,
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
    })),
    log,
  };

  await writeReport(reportBase, report);
  console.log(`[cluster] final confirmed=${confirmed} proxyOnly=${proxyOnly} failed=${failed} seqDelta=${report.summary.actionSeqDelta}`);
  console.log(`[cluster] resources ${report.before.resources.total}->${report.after.resources.total} report=${reportBase}.md`);
  control.disconnect?.();
  for (const agent of AGENTS) agent.conn?.disconnect?.();
}

await main();
