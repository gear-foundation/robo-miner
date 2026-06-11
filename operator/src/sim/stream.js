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

// ── agents ──────────────────────────────────────────────────────────────────
const agents = [];
for (let i = 0; i < agentCount; i += 1) {
  const key = keccak256(stringToBytes(`digger-agent:${world}:${i}`));
  const account = privateKeyToAccount(key);
  const conn = await connectChain({ ...env, adminKey: key });
  const owner = actorIdFromAddress(account.address);
  const v = conn.decode.agentOf((await conn.query(world, conn.encode.agentOf(owner))).payload).map(Number);
  agents.push({ i, owner, conn, x: v[1], y: v[2], status: v[0] });
}
console.log(`[stream] driving ${agents.length} agents (status: ${agents.map((a) => a.status).join('')})`);

// ── drive loop: continuous digging ───────────────────────────────────────────
// Each agent digs straight down while there is room below; once it hits the
// floor (or stone) it sweeps sideways along the open space, bouncing off the
// walls. So no agent ever permanently stalls at a boundary and the event stream
// keeps flowing — whenever a spectator connects, things are moving. (Failed
// actions surface as a contract "panic" via #[export(unwrap_result)]; we treat
// them as "blocked, try another direction".)
const MAP_W = 40;
const MAP_H = 64;
const flip = (dir) => (dir === DIR.LEFT ? DIR.RIGHT : DIR.LEFT);
const sideTarget = (a, dir) => (dir === DIR.LEFT ? [a.x - 1, a.y] : [a.x + 1, a.y]);

let running = true;
process.on('SIGINT', () => { running = false; try { server.close(); } catch {} process.exit(0); });

// Drill straight down; broadcast the dug tile + any gravity fall. true on success.
async function tryDrillDown(a) {
  const tx = a.x;
  const ty = a.y + 1;
  try {
    const reply = await a.conn.sendInjected(world, a.conn.encode.drill(DIR.DOWN));
    const v = a.conn.decode.actionView('Drill', reply.payload).map(Number);
    broadcast({ type: 'dug', owner: a.owner, x: tx, y: ty, block: 1 });
    if (v[1] !== a.x || v[2] !== a.y) broadcast({ type: 'moved', owner: a.owner, fromX: a.x, fromY: a.y, x: v[1], y: v[2] });
    a.x = v[1]; a.y = v[2]; a.status = v[0];
    return true;
  } catch { return false; }
}

// Sweep one tile sideways: open the tile if it is dirt, then step into it.
// Returns false if that direction is blocked (wall / stone / out of bounds).
async function trySweep(a, dir) {
  const [tx, ty] = sideTarget(a, dir);
  try {
    const reply = await a.conn.sendInjected(world, a.conn.encode.drill(dir));
    const v = a.conn.decode.actionView('Drill', reply.payload).map(Number);
    broadcast({ type: 'dug', owner: a.owner, x: tx, y: ty, block: 1 });
    if (v[1] !== a.x || v[2] !== a.y) broadcast({ type: 'moved', owner: a.owner, fromX: a.x, fromY: a.y, x: v[1], y: v[2] });
    a.x = v[1]; a.y = v[2]; a.status = v[0];
  } catch (e) {
    // "tile is already open" → just walk into it; anything else → blocked.
    if (!/already open/i.test(String(e?.message || e))) return false;
  }
  try {
    const r2 = await a.conn.sendInjected(world, a.conn.encode.moveAgent(dir));
    const v2 = a.conn.decode.actionView('MoveAgent', r2.payload).map(Number);
    if (v2[1] !== a.x || v2[2] !== a.y) broadcast({ type: 'moved', owner: a.owner, fromX: a.x, fromY: a.y, x: v2[1], y: v2[2] });
    a.x = v2[1]; a.y = v2[2]; a.status = v2[0];
    return true;
  } catch { return false; }
}

// One step of an agent's behaviour: dig straight down while there is room
// below, else sweep sideways along the floor bouncing off the walls. true if it acted.
async function stepAgent(a) {
  if (a.dir == null) a.dir = a.i % 2 ? DIR.RIGHT : DIR.LEFT;
  if (a.y < MAP_H - 1 && await tryDrillDown(a)) return true;
  if (a.dir === DIR.LEFT && a.x <= 0) a.dir = DIR.RIGHT;
  else if (a.dir === DIR.RIGHT && a.x >= MAP_W - 1) a.dir = DIR.LEFT;
  if (await trySweep(a, a.dir)) return true;
  a.dir = flip(a.dir); // that way was blocked → try the other
  return trySweep(a, a.dir);
}

// Each agent runs its OWN loop at its OWN pace, so actions are NOT synchronized:
// events arrive as a steady spread-out stream instead of lock-step bursts, and
// one slow tx no longer stalls the others. STREAM_AGENT_DELAY_MS is the bot's
// think-time between its own actions (on top of the ~1s injected-tx latency).
const AGENT_DELAY = Number(process.env.STREAM_AGENT_DELAY_MS || 500);
let emitted = 0;

async function driveAgent(a) {
  await sleep((a.i * 137) % 700); // phase offset so agents don't fire in unison
  while (running) {
    if (a.status === 1 && await stepAgent(a)) emitted += 1;
    await sleep(AGENT_DELAY);
  }
}

agents.forEach((a) => { driveAgent(a).catch(() => {}); });
while (running) {
  await sleep(3000);
  console.log(`[stream] emitted ~${emitted}; clients=${clients.size}; delay=${AGENT_DELAY}ms`);
}
