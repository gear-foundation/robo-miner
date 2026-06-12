#!/usr/bin/env node
// Event-driven agent stream. Drives N agents and pushes each action's result —
// decoded from the injected-tx RECEIPT (the only per-action signal this API
// exposes; there is no block_outcome / event subscription) — to SSE clients, so
// the frontend animates smoothly with no snapshot polling. Reads come from the
// Vara.eth node only (no Ethereum).
//   node src/sim/stream.js <worldProgramId> [agents] [port]

import http from 'node:http';
import { loadChainEnv } from '../factory/config.js';
import { connectChain, actorIdFromAddress } from '../chain/client.js';
import { decideAction, agentFromView, carried, TILE, MAP_WIDTH } from './agent-brain.js';

const env = loadChainEnv();
const world = process.argv[2];
const agentCount = Number(process.argv[3] || 10);
const port = Number(process.argv[4] || process.env.STREAM_PORT || 8799);
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

// ── shared world map (read once, kept in sync as agents act + periodic resync) ─
async function readMap() {
  const conn = agents[0]?.conn;
  return conn.decode.mapSnapshot((await conn.query(world, conn.encode.mapSnapshot())).payload).map(Number);
}

// ── agents ──────────────────────────────────────────────────────────────────
const agents = [];
for (let i = 0; i < agentCount; i += 1) {
  const key = keccak256(stringToBytes(`digger-agent:${world}:${i}`));
  const account = privateKeyToAccount(key);
  const conn = await connectChain({ ...env, adminKey: key });
  const owner = actorIdFromAddress(account.address);
  const agent = agentFromView(conn.decode.agentOf((await conn.query(world, conn.encode.agentOf(owner))).payload));
  agents.push({ i, owner, conn, agent, state: { mode: 'mine' } });
}
let map = await readMap();
console.log(`[stream] driving ${agents.length} agents (status: ${agents.map((a) => a.agent.status).join('')})`);

let running = true;
process.on('SIGINT', () => { running = false; try { server.close(); } catch {} process.exit(0); });

const isResourceTile = (t) => t === TILE.SCRST || t === TILE.BCRST || t === TILE.HCRST;

// Execute one planned action: send the injected tx, decode the resulting agent
// view from the receipt, broadcast the matching event(s), and fold the effect
// into the shared local map. Returns false if the tx was rejected.
async function sendAction(a, action) {
  const c = a.conn;
  const before = a.agent;
  let reply;
  let fn;
  if (action.fn === 'drill') { reply = await c.sendInjected(world, c.encode.drill(action.dir.value)); fn = 'Drill'; }
  else if (action.fn === 'move') { reply = await c.sendInjected(world, c.encode.moveAgent(action.dir.value)); fn = 'MoveAgent'; }
  else if (action.fn === 'placeLadder') { reply = await c.sendInjected(world, c.encode.placeLadder(action.dir.value)); fn = 'PlaceLadder'; }
  else if (action.fn === 'surface') { reply = await c.sendInjected(world, c.encode.surface()); fn = 'Surface'; }
  else return false;

  const after = agentFromView(c.decode.actionView(fn, reply.payload));
  const owner = a.owner;
  const moved = after.x !== before.x || after.y !== before.y;

  if (action.fn === 'drill') {
    const { x, y } = action.target;
    const oldTile = map[y * MAP_WIDTH + x];
    map[y * MAP_WIDTH + x] = TILE.EMPTY;
    broadcast({ type: 'dug', owner, x, y, block: oldTile });
    if (isResourceTile(oldTile) && carried(after) > carried(before)) {
      broadcast({ type: 'resource_extracted', owner, x, y, amount: carried(after) - carried(before) });
    }
    if (moved) broadcast({ type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
  } else if (action.fn === 'move') {
    if (moved) broadcast({ type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
  } else if (action.fn === 'placeLadder') {
    const { x, y } = action.target;
    map[y * MAP_WIDTH + x] = TILE.LADDER;
    broadcast({ type: 'ladder_placed', owner, x, y, laddersRemaining: after.ladders });
    if (moved) broadcast({ type: 'moved', owner, fromX: before.x, fromY: before.y, x: after.x, y: after.y });
  } else if (action.fn === 'surface') {
    broadcast({ type: 'surfaced', owner, x: after.x, y: after.y, amount: carried(before) });
  }

  a.agent = after;
  return true;
}

// Each agent runs its OWN loop at its OWN pace (desynced, steady event stream).
// STREAM_AGENT_DELAY_MS is the bot's think-time between actions (on top of the
// ~1s injected-tx latency). A rejected action (out-of-bounds / race) is retried
// next tick from fresh state.
const AGENT_DELAY = Number(process.env.STREAM_AGENT_DELAY_MS || 500);
let emitted = 0;

async function driveAgent(a) {
  await sleep((a.i * 137) % 700); // phase offset so agents don't fire in unison
  while (running) {
    if (a.agent.status === 1) {
      const { action, mode } = decideAction(a.agent, map, a.state);
      a.state.mode = mode;
      if (action) {
        try { if (await sendAction(a, action)) emitted += 1; }
        catch { /* rejected / race — re-plan next tick from fresh state */ }
      }
    }
    await sleep(AGENT_DELAY);
  }
}

agents.forEach((a) => { driveAgent(a).catch(() => {}); });

// Heartbeat + periodic map resync (absorbs other agents' edits + gravity drift).
let ticks = 0;
while (running) {
  await sleep(3000);
  ticks += 1;
  if (ticks % 3 === 0) { try { map = await readMap(); } catch {} }
  const modes = agents.reduce((m, a) => { m[a.state.mode] = (m[a.state.mode] || 0) + 1; return m; }, {});
  console.log(`[stream] emitted ~${emitted}; clients=${clients.size}; modes=${JSON.stringify(modes)}; delay=${AGENT_DELAY}ms`);
}
