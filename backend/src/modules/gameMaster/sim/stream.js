#!/usr/bin/env node
// Event-driven agent stream. Drives N agents and pushes each action's confirmed
// result into the backend ingest/event bus. A tiny local SSE remains available as
// a fallback/manual tap, but the intended path is:
//   confirmed injected tx -> POST /api/ingest/injected -> GET /api/events SSE.
// Reads come from the Vara.eth node only (no Ethereum).
//   node src/modules/gameMaster/sim/stream.js <worldProgramId> [agents] [port]

import http from 'node:http';
import { loadChainEnv } from '../factory/config.js';
import { actorIdFromAddress, connectDiggerWorldChain } from '../../../chain/diggerWorld.js';
import { decideAction, agentFromView, carried, createAgentProfile, TILE, MAP_WIDTH } from './agent-brain.js';
import { inferDeathCause, inferStoneMoves, isAgentDead } from './event-recovery.js';

const env = loadChainEnv();
const world = process.argv[2];
const agentCount = Number(process.argv[3] || 10);
const port = Number(process.argv[4] || process.env.STREAM_PORT || 8799);
const ingestUrl = process.env.SIM_INGEST_URL
  || process.env.DIGGER_INGEST_URL
  || process.env.INGEST_URL
  || 'http://localhost:8787/api/ingest/injected';
const ingestEnabled = ingestUrl && !['0', 'false', 'none'].includes(String(ingestUrl).toLowerCase());
const actionReplyTimeoutMs = Number(process.env.STREAM_ACTION_REPLY_TIMEOUT_MS || 20000);
const actionRecoverPolls = Number(process.env.STREAM_ACTION_RECOVER_POLLS || 10);
const actionRecoverPollMs = Number(process.env.STREAM_ACTION_RECOVER_POLL_MS || 1000);
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!world) { console.error('usage: stream.js <worldProgramId> [agents] [port]'); process.exit(1); }

const { keccak256, stringToBytes } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

// ── SSE server ──────────────────────────────────────────────────────────────
const clients = new Set();
const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', world })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ world, agents: agentCount, clients: clients.size }));
  }
});
function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
}
server.listen(port, () => console.log(`[stream] SSE on http://localhost:${port}/events · world ${world}`));
if (ingestEnabled) console.log(`[stream] backend ingest → ${ingestUrl}`);
else console.log('[stream] backend ingest disabled; local SSE only');

// ── shared world map (read once, kept in sync as agents act + periodic resync) ─
async function readMap() {
  const conn = agents[0]?.conn;
  return conn.decode.mapSnapshot((await conn.query(world, conn.encode.mapSnapshot())).payload).map(Number);
}

async function readSession() {
  const conn = agents[0]?.conn;
  return conn.decode.session((await conn.query(world, conn.encode.session())).payload).map(Number);
}

async function readAgent(a) {
  return agentFromView(a.conn.decode.agentOf((await a.conn.query(world, a.conn.encode.agentOf(a.owner))).payload));
}

// ── agents ──────────────────────────────────────────────────────────────────
const agents = [];
for (let i = 0; i < agentCount; i += 1) {
  const key = keccak256(stringToBytes(`digger-agent:${world}:${i}`));
  const account = privateKeyToAccount(key);
  const conn = await connectDiggerWorldChain({ ...env, adminKey: key });
  const owner = actorIdFromAddress(account.address);
  const agent = agentFromView(conn.decode.agentOf((await conn.query(world, conn.encode.agentOf(owner))).payload));
  const profile = createAgentProfile(i);
  agents.push({ i, owner, conn, agent, state: { mode: 'mine', profile } });
}
let map = await readMap();
let session = await readSession();
console.log(`[stream] driving ${agents.length} independent agents (status: ${agents.map((a) => a.agent.status).join('')})`);
console.log(`[stream] profiles: ${agents.map((a) => `${a.i}:${a.state.profile.name}`).join(', ')}`);
console.log(`[stream] session=${session[0]} seed=${session[1]} status=${session[2]} actionSeq=${session[3]}`);

let running = true;
process.on('SIGINT', () => { running = false; try { server.close(); } catch {} process.exit(0); });

const isResourceTile = (t) => t === TILE.SCRST || t === TILE.BCRST || t === TILE.HCRST;
const eventSource = 'skill-agent-stream';

function makeMessageId(owner, before, after, fn) {
  return `${owner}:${before.lastActionSeq}->${after.lastActionSeq}:${fn}`;
}

function worldEvent(name, args, messageId) {
  return {
    source: eventSource,
    programType: 'world',
    programId: world,
    service: 'World',
    event: name,
    args,
    messageId,
  };
}

async function postWorldEvents(messageId, events) {
  if (!ingestEnabled || events.length === 0) return;
  const response = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageId, events }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`ingest ${response.status}: ${text || response.statusText}`);
  }
}

function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.code = 'ACTION_REPLY_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function recoverTimedOutAction(a, before, fn) {
  for (let i = 0; i < actionRecoverPolls; i += 1) {
    await sleep(actionRecoverPollMs);
    const after = await readAgent(a);
    if (after.lastActionSeq > before.lastActionSeq) {
      return after;
    }
  }
  const error = new Error(`${fn} reply timed out and AgentOf did not advance`);
  error.code = 'ACTION_REPLY_TIMEOUT';
  throw error;
}

// Execute one planned action: send the injected tx, decode the resulting agent
// view from the receipt, publish the matching event(s), and fold the effect into
// the shared local map. Returns false if the tx was rejected.
async function sendAction(a, action) {
  const c = a.conn;
  const before = a.agent;
  const beforeMap = map.slice();
  let reply;
  let fn;
  if (action.fn === 'drill') { reply = c.sendInjected(world, c.encode.drill(action.dir.value)); fn = 'Drill'; }
  else if (action.fn === 'move') { reply = c.sendInjected(world, c.encode.moveAgent(action.dir.value)); fn = 'MoveAgent'; }
  else if (action.fn === 'placeLadder') { reply = c.sendInjected(world, c.encode.placeLadder(action.dir.value)); fn = 'PlaceLadder'; }
  else if (action.fn === 'surface') { reply = c.sendInjected(world, c.encode.surface()); fn = 'Surface'; }
  else return false;

  let after = null;
  try {
    const confirmed = await withTimeout(reply, actionReplyTimeoutMs, `${fn} agent-${a.i}`);
    after = agentFromView(c.decode.actionView(fn, confirmed.payload));
  } catch (error) {
    if (error?.code !== 'ACTION_REPLY_TIMEOUT') throw error;
    after = await recoverTimedOutAction(a, before, fn);
    a.recovered = (a.recovered || 0) + 1;
  }
  const owner = a.owner;
  const moved = after.x !== before.x || after.y !== before.y;
  const died = !isAgentDead(before) && isAgentDead(after);
  const sessionId = session[0];
  const messageId = makeMessageId(owner, before, after, fn);
  const backendEvents = [];
  const localEvents = [];
  const emit = (name, args, local) => {
    backendEvents.push(worldEvent(name, args, messageId));
    localEvents.push(local);
  };

  if (action.fn === 'drill') {
    const { x, y } = action.target;
    const oldTile = beforeMap[y * MAP_WIDTH + x];
    let afterMap = null;
    try {
      afterMap = await readMap();
      map = afterMap;
    } catch {
      afterMap = beforeMap.slice();
      afterMap[y * MAP_WIDTH + x] = TILE.EMPTY;
      map = afterMap;
    }
    const stoneMoves = inferStoneMoves(beforeMap, afterMap, {
      width: MAP_WIDTH,
      drilledTarget: { x, y },
      columns: [x],
      stoneTile: TILE.STONE,
    });
    emit('TileDrilled', [sessionId, owner, x, y, oldTile, TILE.EMPTY], { type: 'dug', owner, x, y, block: oldTile, newBlock: TILE.EMPTY });
    if (isResourceTile(oldTile) && carried(after) > carried(before)) {
      emit('ResourceExtracted', [sessionId, owner, x, y, oldTile, carried(after)], {
        type: 'resource_extracted',
        owner,
        x,
        y,
        block: oldTile,
        amount: carried(after) - carried(before),
      });
    }
    for (const fall of stoneMoves) {
      emit('StoneMoved', [sessionId, owner, fall.fromX, fall.fromY, fall.x, fall.y], {
        type: 'stone_moved',
        owner,
        fromX: fall.fromX,
        fromY: fall.fromY,
        x: fall.x,
        y: fall.y,
      });
    }
    if (moved && !died) emit('AgentMoved', [sessionId, owner, before.x, before.y, after.x, after.y], { type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
    if (died) {
      const cause = inferDeathCause({ action, beforeMap, after, stoneMoves, width: MAP_WIDTH, tiles: TILE });
      emit('AgentDied', [sessionId, owner, after.x, after.y, cause], { type: 'death', owner, x: after.x, y: after.y, cause });
    }
  } else if (action.fn === 'move') {
    if (died) {
      const cause = inferDeathCause({ action, beforeMap, after, width: MAP_WIDTH, tiles: TILE });
      emit('AgentDied', [sessionId, owner, after.x, after.y, cause], { type: 'death', owner, x: after.x, y: after.y, cause });
    } else if (moved) emit('AgentMoved', [sessionId, owner, before.x, before.y, after.x, after.y], { type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
  } else if (action.fn === 'placeLadder') {
    const { x, y } = action.target;
    map[y * MAP_WIDTH + x] = TILE.LADDER;
    emit('LadderPlaced', [sessionId, owner, x, y, after.ladders], { type: 'ladder_placed', owner, x, y, laddersRemaining: after.ladders });
    if (moved) emit('AgentMoved', [sessionId, owner, before.x, before.y, after.x, after.y], { type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
  } else if (action.fn === 'surface') {
    emit('AgentSurfaced', [sessionId, owner, after.bankedScrst, after.bankedBcrst, after.bankedHcrst], {
      type: 'surfaced',
      owner,
      x: after.x,
      y: after.y,
      amount: carried(before),
      banked: { scrst: after.bankedScrst, bcrst: after.bankedBcrst, hcrst: after.bankedHcrst },
    });
  }

  await postWorldEvents(messageId, backendEvents);
  localEvents.forEach(broadcast);
  a.agent = after;
  return true;
}

// Each agent runs its OWN loop at its OWN pace (desynced, steady event stream).
// STREAM_AGENT_DELAY_MS is an optional demo throttle after a confirmed reply.
// Smoothness belongs in the frontend playback queue, so the default is no extra
// wait beyond confirmation. A rejected action (out-of-bounds / race) triggers
// an immediate state refresh, then the agent re-plans on the next tick.
const AGENT_DELAY = Number(process.env.STREAM_AGENT_DELAY_MS || 0);
let emitted = 0;
let failures = 0;
let nullActions = 0;

async function driveAgent(a) {
  await sleep((a.i * 137) % 700); // phase offset so agents don't fire in unison
  while (running) {
    if (a.agent.status === 1) {
      const { action, mode } = decideAction(a.agent, map, a.state);
      a.state.mode = mode;
      if (action) {
        try { if (await sendAction(a, action)) emitted += 1; }
        catch (error) {
          failures += 1;
          const message = error?.message || String(error);
          if (failures <= 12 || failures % 25 === 0) {
            console.warn(`[stream] agent-${a.i} ${action.fn} failed: ${message}`);
          }
          try {
            a.agent = await readAgent(a);
            map = await readMap();
          } catch {
            // If the node is temporarily unavailable, the periodic resync below
            // will catch up. The agent simply waits for the next tick.
          }
        }
      } else {
        nullActions += 1;
      }
    }
    await sleep(AGENT_DELAY);
  }
}

agents.forEach((a) => { driveAgent(a).catch(() => {}); });

// Heartbeat + periodic map resync for the test brain's full-map planning. This
// is not a frontend animation source; spectators still move from emitted events.
let ticks = 0;
while (running) {
  await sleep(3000);
  ticks += 1;
  if (ticks % 3 === 0) {
    try {
      map = await readMap();
      session = await readSession();
    } catch {}
  }
  const modes = agents.reduce((m, a) => { m[a.state.mode] = (m[a.state.mode] || 0) + 1; return m; }, {});
  const recovered = agents.reduce((sum, a) => sum + (a.recovered || 0), 0);
  console.log(`[stream] emitted ~${emitted}; recovered=${recovered}; failures=${failures}; null=${nullActions}; clients=${clients.size}; modes=${JSON.stringify(modes)}; delay=${AGENT_DELAY}ms`);
}
