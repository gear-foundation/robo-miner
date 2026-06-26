#!/usr/bin/env node
// Full-world executable-balance benchmark.
//
// Resets a DiggerWorld, registers deterministic test agents, starts the
// session, then mines with an omniscient planner that sees the current map.
// It logs phase balances and final burn separately from EVM top-ups.
//
//   node --env-file-if-exists=.env src/modules/gameMaster/sim/benchmark-world.js <worldProgramId> [agents] [maxActions]
//
// Env:
//   BENCHMARK_RESET=false          keep current map/agents instead of UploadMap
//   BENCHMARK_DELAY_MS=15          pause between injected actions
//   BENCHMARK_SETTLE_MS=30000      wait before final executable-balance read

import { keccak256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadChainEnv } from '../factory/config.js';
import { generateMap, randomSeed, gridHash } from '../genmap.js';
import { actorIdFromAddress, connectDiggerWorldChain } from '../../../chain/diggerWorld.js';

const WIDTH = 40;
const HEIGHT = 64;
const TILE = {
  EMPTY: 0,
  DIRT: 1,
  STONE: 2,
  CHEST: 3,
  LADDER: 4,
  SCRST: 10,
  BCRST: 11,
  HCRST: 12,
  SURFACE: 20,
};
const DIRS = [
  { name: 'up', value: 0, dx: 0, dy: -1 },
  { name: 'right', value: 1, dx: 1, dy: 0 },
  { name: 'down', value: 2, dx: 0, dy: 1 },
  { name: 'left', value: 3, dx: -1, dy: 0 },
];
const CURRENT = { name: 'current', value: 4, dx: 0, dy: 0 };
const RESOURCE_TILES = new Set([TILE.SCRST, TILE.BCRST, TILE.HCRST]);
const RESOURCE_NAME = { [TILE.SCRST]: 'SCRST', [TILE.BCRST]: 'BCRST', [TILE.HCRST]: 'HCRST' };
const RESOURCE_VALUE = { [TILE.SCRST]: 1, [TILE.BCRST]: 5, [TILE.HCRST]: 25 };
const ACTIVE = 1;
const DEAD = 3;

const world = process.argv[2];
const agentCount = Number(process.argv[3] || 10);
const maxActions = Number(process.argv[4] || process.env.BENCHMARK_MAX_ACTIONS || 6000);
const shouldReset = String(process.env.BENCHMARK_RESET || 'true') !== 'false';
const delayMs = Number(process.env.BENCHMARK_DELAY_MS || 15);
const settleMs = Number(process.env.BENCHMARK_SETTLE_MS || 30_000);
const timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS || 45_000);
const resourceCandidateLimit = Number(process.env.BENCHMARK_RESOURCE_CANDIDATES || 8);
const searchNodeLimit = Number(process.env.BENCHMARK_SEARCH_NODES || 5_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!world) {
  console.error('usage: benchmark-world.js <worldProgramId> [agents] [maxActions]');
  process.exit(1);
}

const env = loadChainEnv();
let control = await connectDiggerWorldChain(env);
const agents = [];

function idx(x, y) {
  return y * WIDTH + x;
}

function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT;
}

function tileAt(map, x, y) {
  return map[idx(x, y)] ?? -1;
}

function isResource(tile) {
  return RESOURCE_TILES.has(tile);
}

function isTraversable(tile) {
  return tile === TILE.EMPTY || tile === TILE.LADDER || tile === TILE.SURFACE;
}

function isSoftDrillable(tile) {
  return tile === TILE.DIRT;
}

function isWsDisconnect(error) {
  const message = String(error?.message || error || '');
  return message.includes('WebSocket') || message.includes('CONNECTION_CLOSED') || message.includes('closed unexpectedly');
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function reconnectControl() {
  try { control?.disconnect?.(); } catch {}
  control = await connectDiggerWorldChain(env);
}

async function query(payload, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTimeout(control.query(world, payload), timeoutMs, label);
    } catch (error) {
      lastError = error;
      if (!isWsDisconnect(error) || attempt === 2) break;
      await reconnectControl();
    }
  }
  throw lastError;
}

async function readMap() {
  return control.decode.mapSnapshot((await query(control.encode.mapSnapshot(), 'MapSnapshot')).payload).map(Number);
}

async function readSession() {
  return control.decode.session((await query(control.encode.session(), 'Session')).payload).map(Number);
}

async function readConfig() {
  return control.decode.config((await query(control.encode.config(), 'Config')).payload).map(Number);
}

async function readExecutableBalance() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTimeout(control.readExecutableBalance(world), timeoutMs, 'readExecutableBalance');
    } catch (error) {
      lastError = error;
      if (!isWsDisconnect(error) || attempt === 2) break;
      await reconnectControl();
    }
  }
  throw lastError;
}

function agentFromView(view) {
  const v = view.map(Number);
  return {
    status: v[0],
    x: v[1],
    y: v[2],
    hp: v[3],
    ladders: v[4],
    invScrst: v[5],
    invBcrst: v[6],
    invHcrst: v[7],
    bankedScrst: v[8],
    bankedBcrst: v[9],
    bankedHcrst: v[10],
    capacity: v[11],
    seq: v[12],
  };
}

function carried(agent) {
  return agent.invScrst + agent.invBcrst + agent.invHcrst;
}

async function connectAgent(index) {
  const key = keccak256(stringToBytes(`digger-agent:${world}:${index}`));
  const account = privateKeyToAccount(key);
  return {
    index,
    key,
    account,
    owner: actorIdFromAddress(account.address),
    conn: null,
    failures: 0,
  };
}

async function reconnectAgent(agent) {
  try { agent.conn?.disconnect?.(); } catch {}
  agent.conn = null;
}

async function ensureAgentConnection(agent) {
  if (!agent.conn) agent.conn = await connectDiggerWorldChain({ ...env, adminKey: agent.key });
  return agent.conn;
}

async function readAgent(agent) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reply = await withTimeout(
        control.query(world, control.encode.agentOf(agent.owner)),
        timeoutMs,
        `AgentOf agent-${agent.index}`,
      );
      return agentFromView(control.decode.agentOf(reply.payload));
    } catch (error) {
      lastError = error;
      if (!isWsDisconnect(error) || attempt === 2) break;
      await reconnectControl();
    }
  }
  throw lastError;
}

async function sendAction(agent, action) {
  let actualAction = action;
  if (action.fn === 'move' && action.dir?.name === 'up') {
    const [view, map] = await Promise.all([readAgent(agent), readMap()]);
    const target = targetFor(view.x, view.y, action.dir);
    if (target) {
      const currentTile = tileAt(map, view.x, view.y);
      const targetTile = tileAt(map, target.x, target.y);
      if (targetTile === TILE.SURFACE && currentTile !== TILE.LADDER) {
        if (currentTile === TILE.EMPTY) {
          actualAction = { fn: 'ladder', dir: CURRENT, target: { x: view.x, y: view.y } };
        }
      } else if (targetTile !== TILE.LADDER) {
        if (targetTile === TILE.EMPTY) actualAction = { fn: 'ladder', dir: action.dir, target };
      }
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const conn = await ensureAgentConnection(agent);
      let payload;
      if (actualAction.fn === 'move') payload = conn.encode.moveAgent(actualAction.dir.value);
      else if (actualAction.fn === 'drill') payload = conn.encode.drill(actualAction.dir.value);
      else if (actualAction.fn === 'ladder') payload = conn.encode.placeLadder(actualAction.dir.value);
      else if (actualAction.fn === 'surface') payload = conn.encode.surface();
      else if (actualAction.fn === 'trade') payload = conn.encode.tradeResourcesForLadders(actualAction.scrst, actualAction.bcrst, actualAction.hcrst);
      else throw new Error(`unknown action ${actualAction.fn}`);
      await withTimeout(conn.sendInjected(world, payload), timeoutMs, `agent-${agent.index} ${actionLabel(actualAction)}`);
      if (delayMs > 0) await sleep(delayMs);
      return;
    } catch (error) {
      lastError = error;
      if (!isWsDisconnect(error) || attempt === 2) break;
      await reconnectAgent(agent);
      await sleep(1000);
    }
  }
  throw lastError;
}

async function sendAdmin(payload, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withTimeout(control.sendAdmin(world, payload), timeoutMs * 2, label);
    } catch (error) {
      lastError = error;
      if (!isWsDisconnect(error) || attempt === 2) break;
      await reconnectControl();
    }
  }
  throw lastError;
}

function actionLabel(action) {
  if (!action) return 'none';
  const target = action.target ? `@${action.target.x},${action.target.y}` : '';
  if (action.fn === 'trade') return `trade ${action.scrst}/${action.bcrst}/${action.hcrst}`;
  return `${action.fn}:${action.dir?.name || 'current'}${target}`;
}

async function readStats() {
  const [session, config, map, eb] = await Promise.all([
    readSession(),
    readConfig(),
    readMap(),
    readExecutableBalance(),
  ]);
  const stats = {
    session,
    config,
    map,
    eb,
    active: 0,
    dead: 0,
    carried: [0, 0, 0],
    banked: [0, 0, 0],
    ladders: 0,
    left: { scrst: 0, bcrst: 0, hcrst: 0, total: 0 },
    resources: [],
  };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const tile = tileAt(map, x, y);
      if (!isResource(tile)) continue;
      stats.resources.push({ x, y, tile });
      if (tile === TILE.SCRST) stats.left.scrst += 1;
      else if (tile === TILE.BCRST) stats.left.bcrst += 1;
      else if (tile === TILE.HCRST) stats.left.hcrst += 1;
      stats.left.total += 1;
    }
  }
  for (const agent of agents) {
    const view = await readAgent(agent).catch(() => null);
    if (!view) continue;
    if (view.status === ACTIVE) stats.active += 1;
    if (view.status === DEAD) stats.dead += 1;
    stats.carried[0] += view.invScrst;
    stats.carried[1] += view.invBcrst;
    stats.carried[2] += view.invHcrst;
    stats.banked[0] += view.bankedScrst;
    stats.banked[1] += view.bankedBcrst;
    stats.banked[2] += view.bankedHcrst;
    stats.ladders += view.ladders;
  }
  return stats;
}

function toVara(value) {
  return Number(value) / 1e12;
}

function compact(stats) {
  return (
    `seq=${stats.session[3]} status=${stats.session[2]} active=${stats.active} dead=${stats.dead} ` +
    `left=${stats.left.total}(${stats.left.scrst}/${stats.left.bcrst}/${stats.left.hcrst}) ` +
    `carried=${stats.carried.join('/')} banked=${stats.banked.join('/')} ` +
    `ladders=${stats.ladders} eb=${toVara(stats.eb).toFixed(6)}`
  );
}

function targetFor(x, y, dir) {
  const target = { x: x + dir.dx, y: y + dir.dy };
  return inBounds(target.x, target.y) ? target : null;
}

function cloneSim(view, map) {
  return { view: { ...view }, map: map.slice() };
}

function applySimAction(sim, action) {
  if (action.fn === 'drill') {
    if (!action.target) return false;
    const tile = tileAt(sim.map, action.target.x, action.target.y);
    if (!isSoftDrillable(tile) && !isResource(tile)) return false;
    sim.map[idx(action.target.x, action.target.y)] = TILE.EMPTY;
    if (tile === TILE.SCRST) sim.view.invScrst += 1;
    else if (tile === TILE.BCRST) sim.view.invBcrst += 1;
    else if (tile === TILE.HCRST) sim.view.invHcrst += 1;
    return true;
  }
  if (action.fn === 'move') {
    if (!action.target) return false;
    sim.view.x = action.target.x;
    sim.view.y = action.target.y;
    return true;
  }
  if (action.fn === 'ladder') {
    if (!action.target || sim.view.ladders <= 0) return false;
    sim.map[idx(action.target.x, action.target.y)] = TILE.LADDER;
    sim.view.ladders -= 1;
    return true;
  }
  return true;
}

function transitionActions(map, x, y, dir) {
  const target = targetFor(x, y, dir);
  if (!target) return null;
  const current = tileAt(map, x, y);
  const targetTile = tileAt(map, target.x, target.y);
  if (targetTile === TILE.STONE || targetTile === TILE.CHEST || isResource(targetTile)) return null;
  if (!isTraversable(targetTile) && !isSoftDrillable(targetTile)) return null;

  const actions = [];
  if (isSoftDrillable(targetTile)) actions.push({ fn: 'drill', dir, target });

  if (dir.name === 'up') {
    if (targetTile === TILE.SURFACE) {
      if (current !== TILE.LADDER) actions.push({ fn: 'ladder', dir: CURRENT, target: { x, y } });
    } else if (targetTile !== TILE.LADDER) {
      actions.push({ fn: 'ladder', dir, target });
    }
  }
  actions.push({ fn: 'move', dir, target });
  return actions;
}

function findPath(view, map, goal, options = {}) {
  const maxLadders = Math.max(0, view.ladders);
  const startKey = `${view.x},${view.y},${maxLadders}`;
  const queue = [{ x: view.x, y: view.y, ladders: maxLadders, cost: 0, key: startKey }];
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    if (cur.cost !== dist.get(cur.key)) continue;
    if (goal(cur.x, cur.y)) {
      const chunks = [];
      let key = cur.key;
      while (key !== startKey) {
        const entry = prev.get(key);
        if (!entry) return null;
        chunks.push(entry.actions);
        key = entry.from;
      }
      return chunks.reverse().flat();
    }

    for (const dir of DIRS) {
      const actions = transitionActions(map, cur.x, cur.y, dir);
      if (!actions) continue;
      const target = actions.at(-1)?.target;
      if (!target) continue;

      let ladders = cur.ladders;
      let blocked = false;
      for (const action of actions) {
        if (action.fn === 'ladder') {
          ladders -= 1;
          if (ladders < 0) blocked = true;
        }
        if (action.fn === 'drill' && !options.allowDirt) blocked = true;
      }
      if (blocked) continue;

      const tile = tileAt(map, target.x, target.y);
      const cost =
        cur.cost +
        actions.length +
        (tile === TILE.DIRT ? 1 : 0) +
        (dir.name === 'up' ? 0.2 : 0);
      const key = `${target.x},${target.y},${ladders}`;
      if (cost >= (dist.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      dist.set(key, cost);
      prev.set(key, { from: cur.key, actions });
      queue.push({ x: target.x, y: target.y, ladders, cost, key });
    }
  }
  return null;
}

function reconstructActions(prev, startKey, targetKey) {
  const chunks = [];
  let key = targetKey;
  while (key !== startKey) {
    const entry = prev.get(key);
    if (!entry) return null;
    chunks.push(entry.actions);
    key = entry.from;
  }
  return chunks.reverse().flat();
}

function simulateActions(view, map, actions) {
  const sim = cloneSim(view, map);
  for (const action of actions) {
    if (!applySimAction(sim, action)) return null;
  }
  return sim;
}

function adjacentResourceAction(view, map) {
  const candidates = [];
  for (const dir of DIRS) {
    const target = targetFor(view.x, view.y, dir);
    if (!target) continue;
    const tile = tileAt(map, target.x, target.y);
    if (!isResource(tile)) continue;
    candidates.push({
      fn: 'drill',
      dir,
      target: { ...target, tile },
      score: -RESOURCE_VALUE[tile] * 50 + target.y,
    });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

function findBestMinePlan(view, map, resources, claimed) {
  const maxLadders = Math.max(0, view.ladders);
  const startKey = `${view.x},${view.y},${maxLadders}`;
  const queue = [{ x: view.x, y: view.y, ladders: maxLadders, cost: 0, key: startKey }];
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const candidates = [];
  let explored = 0;
  const maxCandidates = Math.max(1, resourceCandidateLimit);
  const resourceSet = new Set(resources.map((resource) => `${resource.x},${resource.y}`));

  while (queue.length > 0 && candidates.length < maxCandidates && explored < searchNodeLimit) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    if (cur.cost !== dist.get(cur.key)) continue;
    explored += 1;

    for (const dir of DIRS) {
      const target = targetFor(cur.x, cur.y, dir);
      if (!target) continue;
      const tile = tileAt(map, target.x, target.y);
      const resourceKey = `${target.x},${target.y}`;
      if (isResource(tile) && resourceSet.has(resourceKey) && !claimed.has(resourceKey)) {
        const path = reconstructActions(prev, startKey, cur.key) || [];
        const drill = { fn: 'drill', dir, target: { ...target, tile } };
        const afterPath = simulateActions(view, map, path);
        if (!afterPath || carried(afterPath.view) >= afterPath.view.capacity) continue;
        const afterDrill = simulateActions(afterPath.view, afterPath.map, [drill]);
        if (!afterDrill) continue;
        const bankPath = findPath(afterDrill.view, afterDrill.map, (x, y) => y === 0, { allowDirt: true });
        if (!bankPath) continue;
        candidates.push({
          actions: path.length > 0 ? path : [drill],
          resource: { x: target.x, y: target.y, tile },
          score: cur.cost + bankPath.length * 0.25 + target.y * 0.03 - RESOURCE_VALUE[tile] * 12,
          fullPathLength: path.length + 1 + bankPath.length,
        });
      }
    }

    for (const dir of DIRS) {
      const actions = transitionActions(map, cur.x, cur.y, dir);
      if (!actions) continue;
      const target = actions.at(-1)?.target;
      if (!target) continue;
      let ladders = cur.ladders;
      let blocked = false;
      for (const action of actions) {
        if (action.fn === 'ladder') {
          ladders -= 1;
          if (ladders < 0) blocked = true;
        }
      }
      if (blocked) continue;

      const tile = tileAt(map, target.x, target.y);
      const cost =
        cur.cost +
        actions.length +
        (tile === TILE.DIRT ? 1 : 0) +
        target.y * 0.002 -
        (tile === TILE.LADDER ? 0.5 : 0);
      const key = `${target.x},${target.y},${ladders}`;
      if (cost >= (dist.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      dist.set(key, cost);
      prev.set(key, { from: cur.key, actions });
      queue.push({ x: target.x, y: target.y, ladders, cost, key });
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.fullPathLength - b.fullPathLength);
  return candidates[0] || null;
}

function tradeAction(view) {
  if (view.y !== 0 || view.ladders >= 45) return null;
  if (view.bankedHcrst > 0) return { fn: 'trade', scrst: 0, bcrst: 0, hcrst: 1 };
  if (view.bankedBcrst > 0) return { fn: 'trade', scrst: 0, bcrst: 1, hcrst: 0 };
  if (view.bankedScrst >= 5) return { fn: 'trade', scrst: 5, bcrst: 0, hcrst: 0 };
  return null;
}

function chooseTask(view, map, stats, claimed) {
  if (view.status !== ACTIVE) return null;
  if (view.y === 0 && carried(view) > 0) return { action: { fn: 'surface' }, kind: 'surface', priority: -1000 };

  const trade = tradeAction(view);
  if (trade) return { action: trade, kind: 'trade', priority: -800 };

  const load = carried(view);
  const highValueLoad = view.invBcrst > 0 || view.invHcrst > 0;
  const shouldBank =
    (stats.left.total === 0 && load > 0) ||
    load >= view.capacity ||
    load >= Math.max(1, Math.floor(view.capacity * 0.8)) ||
    (highValueLoad && load >= Math.max(1, Math.ceil(view.capacity * 0.5)));

  if (shouldBank) {
    const path = findPath(view, map, (x, y) => y === 0, { allowDirt: true });
    if (path?.length) return { action: path[0], kind: 'bank', priority: -700 };
    return null;
  }

  if (load < view.capacity) {
    const adjacent = adjacentResourceAction(view, map);
    if (adjacent && !claimed.has(`${adjacent.target.x},${adjacent.target.y}`)) {
      return { action: adjacent, kind: 'mine-adjacent', priority: -600 };
    }
  }

  const plan = findBestMinePlan(view, map, stats.resources, claimed);
  if (plan?.actions?.length) {
    return {
      action: plan.actions[0],
      kind: 'mine',
      resource: plan.resource,
      priority: plan.score,
      fullPathLength: plan.fullPathLength,
    };
  }

  if (load > 0) {
    const path = findPath(view, map, (x, y) => y === 0, { allowDirt: true });
    if (path?.length) return { action: path[0], kind: 'bank-fallback', priority: -100 };
  }
  return null;
}

function countResources(map) {
  const out = { scrst: 0, bcrst: 0, hcrst: 0, total: 0 };
  for (const tile of map) {
    if (tile === TILE.SCRST) out.scrst += 1;
    else if (tile === TILE.BCRST) out.bcrst += 1;
    else if (tile === TILE.HCRST) out.hcrst += 1;
  }
  out.total = out.scrst + out.bcrst + out.hcrst;
  return out;
}

async function resetWorld() {
  let generated = null;
  for (let attempt = 0; attempt < 8 && !generated; attempt += 1) {
    const candidate = generateMap(randomSeed(), { contractSurface: env.contractSurface });
    if (candidate.valid) generated = candidate;
  }
  if (!generated) throw new Error('could not generate a valid map');
  console.log(
    `[benchmark] reset UploadMap seed=${generated.seed} hash=${gridHash(generated.map)} ` +
    `resources=${JSON.stringify(countResources(generated.map))} chest=${generated.counts[TILE.CHEST] || 0}`,
  );
  await sendAdmin(control.encode.uploadMap(generated.seed, generated.map), 'UploadMap');
  return generated;
}

async function ensureAgentsRegistered() {
  for (let index = 0; index < agentCount; index += 1) {
    const agent = await connectAgent(index);
    agents.push(agent);
  }
  for (const agent of agents) {
    let conn = null;
    try {
      conn = await connectDiggerWorldChain({ ...env, adminKey: agent.key });
      await withTimeout(
        conn.sendInjected(world, conn.encode.register(agent.owner)),
        timeoutMs,
        `register agent-${agent.index}`,
      );
      console.log(`[benchmark] registered agent-${agent.index} ${agent.account.address}`);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('already registered') || message.includes('registered')) {
        console.log(`[benchmark] agent-${agent.index} already registered`);
      } else {
        throw error;
      }
    } finally {
      try { conn?.disconnect?.(); } catch {}
    }
  }
}

async function ensureStarted() {
  let session = await readSession();
  if (Number(session[2]) === 1) return session;
  console.log('[benchmark] StartSession');
  await sendAdmin(control.encode.startSession(), 'StartSession');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    session = await readSession();
    if (Number(session[2]) === 1) return session;
    await sleep(1000);
  }
  throw new Error(`session did not become active: ${JSON.stringify(session)}`);
}

const phaseBalances = [];
async function markPhase(name) {
  const stats = await readStats();
  phaseBalances.push({ name, eb: stats.eb, seq: stats.session[3], left: stats.left.total, banked: stats.banked });
  console.log(`[benchmark] ${name}: ${compact(stats)}`);
  return stats;
}

async function main() {
  console.log(`[benchmark] world=${world} agents=${agentCount} maxActions=${maxActions} reset=${shouldReset}`);
  await markPhase('before');
  if (shouldReset) {
    await resetWorld();
    await sleep(2000);
    await markPhase('after-reset');
  }

  await ensureAgentsRegistered();
  await sleep(1000);
  await ensureStarted();
  await sleep(3000);
  let stats = await markPhase('after-register-start');
  const mineStart = stats;
  const startEb = mineStart.eb;
  const startSeq = mineStart.session[3];
  const startResources = mineStart.left.total;
  const counters = {
    actions: 0,
    failures: 0,
    nullTasks: 0,
    mined: 0,
    surfaced: 0,
    trades: 0,
    dead: 0,
  };
  let lastLeft = stats.left.total;
  let lastBanked = stats.banked.join('/');
  let stagnantRounds = 0;

  while (counters.actions < maxActions) {
    stats = await readStats();
    if (stats.left.total === 0 && stats.carried.every((value) => value === 0)) break;
    if (stats.active <= 0) break;

    const map = stats.map;
    const views = await Promise.all(agents.map((agent) => readAgent(agent).catch(() => null)));
    const claimed = new Set();
    const ordered = agents
      .map((agent, index) => ({ agent, view: views[index] }))
      .filter((item) => item.view?.status === ACTIVE)
      .sort((a, b) => {
        const aCarry = carried(a.view);
        const bCarry = carried(b.view);
        const aFullness = aCarry / Math.max(1, a.view.capacity);
        const bFullness = bCarry / Math.max(1, b.view.capacity);
        return bFullness - aFullness || b.view.y - a.view.y || a.agent.index - b.agent.index;
      });
    let selected = null;
    for (const item of ordered) {
      const task = chooseTask(item.view, map, stats, claimed);
      if (!task) {
        counters.nullTasks += 1;
        continue;
      }
      if (task.resource) claimed.add(`${task.resource.x},${task.resource.y}`);
      selected = { ...item, task };
      break;
    }

    if (!selected) {
      stagnantRounds += 1;
      console.log(`[benchmark] no tasks round=${stagnantRounds} ${compact(stats)}`);
      if (stagnantRounds >= 5) break;
      await sleep(1000);
      continue;
    }
    stagnantRounds = 0;

    // Re-read the chain after every action. This makes the benchmark slower than
    // blind batching, but prevents stale-map duplicate drills and keeps the gas
    // sample about real game actions rather than failed retries.
    for (const item of [selected]) {
      if (counters.actions >= maxActions) break;
      try {
        await sendAction(item.agent, item.task.action);
        counters.actions += 1;
        if (item.task.action.fn === 'surface') counters.surfaced += 1;
        if (item.task.action.fn === 'trade') counters.trades += 1;
        const next = await readStats();
        if (next.left.total < lastLeft) {
          counters.mined += lastLeft - next.left.total;
          lastLeft = next.left.total;
          console.log(
            `[benchmark] mined=${counters.mined}/${startResources} ` +
            `agent-${item.agent.index} ${actionLabel(item.task.action)} ${compact(next)}`,
          );
        }
        if (next.banked.join('/') !== lastBanked) {
          lastBanked = next.banked.join('/');
          console.log(`[benchmark] banked agent-${item.agent.index} ${compact(next)}`);
        }
        if (next.dead > counters.dead) {
          counters.dead = next.dead;
          console.log(`[benchmark] death-count=${counters.dead} ${compact(next)}`);
        }
        if (counters.actions % 50 === 0) {
          console.log(`[benchmark] actions=${counters.actions} failures=${counters.failures} null=${counters.nullTasks} ${compact(next)}`);
        }
      } catch (error) {
        counters.failures += 1;
        item.agent.failures += 1;
        console.warn(
          `[benchmark] fail agent-${item.agent.index} ${actionLabel(item.task.action)}: ` +
          `${String(error?.message || error).slice(0, 220)}`,
        );
      }
    }
  }

  stats = await markPhase('after-actions');
  if (settleMs > 0) {
    console.log(`[benchmark] waiting ${settleMs}ms before final executable-balance read`);
    await sleep(settleMs);
    stats = await markPhase('final-settled');
  }

  const spent = startEb - stats.eb;
  const seqDelta = BigInt(stats.session[3] - startSeq);
  const minedTotal = startResources - stats.left.total;
  const phaseReport = phaseBalances.map((phase, index) => {
    const prev = index > 0 ? phaseBalances[index - 1] : null;
    return {
      name: phase.name,
      seq: phase.seq,
      eb: phase.eb.toString(),
      ebVara: toVara(phase.eb),
      deltaFromPrevVara: prev ? toVara(prev.eb - phase.eb) : 0,
      left: phase.left,
      banked: phase.banked,
    };
  });

  console.log('[benchmark] report');
  console.log(JSON.stringify({
    world,
    counters,
    startSeq,
    endSeq: stats.session[3],
    actionSeqDelta: seqDelta.toString(),
    startResources,
    minedTotal,
    left: stats.left,
    carried: stats.carried,
    banked: stats.banked,
    executableBalance: {
      start: startEb.toString(),
      final: stats.eb.toString(),
      spent: spent.toString(),
      startVara: toVara(startEb),
      finalVara: toVara(stats.eb),
      spentVara: toVara(spent),
      avgVaraPerActionSeq: seqDelta > 0n ? toVara(spent) / Number(seqDelta) : null,
      avgVaraPerInjectedAction: counters.actions > 0 ? toVara(spent) / counters.actions : null,
      projectedFullWorldVara: minedTotal > 0 ? toVara(spent) * (startResources / minedTotal) : null,
    },
    phases: phaseReport,
  }, null, 2));
}

try {
  await main();
} finally {
  for (const agent of agents) {
    try { agent.conn?.disconnect?.(); } catch {}
  }
  try { control?.disconnect?.(); } catch {}
}
