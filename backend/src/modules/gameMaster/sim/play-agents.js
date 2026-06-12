#!/usr/bin/env node
// Drive the registered agents so chain activity (and thus frontend updates) flows
// steadily. Each round every agent digs — mostly DOWN (drill breaks the tile and
// gravity drops it), and every 5th round sideways (drill + step) so they branch
// and it looks alive. On this contract MoveAgent only enters an already-dug tile,
// so digging needs Drill first.
//
//   node src/modules/gameMaster/sim/play-agents.js <worldProgramId> [rounds] [--forever] [--agents N] [--delay ms]
// Defaults: first pool program, 8 rounds, 10 agents, 400ms between rounds.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainEnv } from '../factory/config.js';
import { connectDiggerWorldChain } from '../../../chain/diggerWorld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../..');
const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

async function firstPoolProgram() {
  try {
    const pool = JSON.parse(await readFile(path.resolve(ROOT, 'state/factory-programs.json'), 'utf8'));
    return pool.programs?.[0] || '';
  } catch {
    return '';
  }
}

const env = loadChainEnv();
const world = argv.find((a) => a.startsWith('0x')) || process.env.DIGGER_PROGRAM_ID || (await firstPoolProgram());
const forever = argv.includes('--forever');
const rounds = forever ? Infinity : Number(argv.find((a) => /^\d+$/.test(a)) || 8);
const agentCount = Number(flag('--agents', 10));
const delay = Number(flag('--delay', 400));
if (!world) { console.error('no world program id (arg, DIGGER_PROGRAM_ID, or state/factory-programs.json)'); process.exit(1); }

const { keccak256, stringToBytes } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

console.log(`[play] world ${world} · ${agentCount} agents · ${forever ? 'forever' : rounds + ' rounds'} · delay ${delay}ms`);

// One connection per agent — its key signs its own actions.
const agents = [];
for (let i = 0; i < agentCount; i += 1) {
  const key = keccak256(stringToBytes(`digger-agent:${world}:${i}`));
  const account = privateKeyToAccount(key);
  const conn = await connectDiggerWorldChain({ ...env, adminKey: key });
  agents.push({ i, address: account.address, conn });
}
const session = agents[0].conn.decode.session((await agents[0].conn.query(world, agents[0].conn.encode.session())).payload);
console.log(`[play] session status=${Number(session[2])} (1=ACTIVE); driving`);

let running = true;
process.on('SIGINT', () => { running = false; });

let r = 0;
while (running && r < rounds) {
  const lateral = r % 5 === 4; // every 5th round: branch sideways
  const results = await Promise.all(
    agents.map(async (a) => {
      const dir = lateral ? (a.i % 2 ? DIR.RIGHT : DIR.LEFT) : DIR.DOWN;
      try {
        await a.conn.sendInjected(world, a.conn.encode.drill(dir));
        if (lateral) {
          // step into the freshly dug side tile (gravity then pulls down)
          try { await a.conn.sendInjected(world, a.conn.encode.moveAgent(dir)); } catch { /* blocked */ }
        }
        return true;
      } catch {
        return false; // stone / boundary / inactive
      }
    }),
  );
  r += 1;
  console.log(`[play] round ${r}${forever ? '' : '/' + rounds} (${lateral ? 'side' : 'down'}): ${results.filter(Boolean).length}/${agentCount} acted`);
  await sleep(delay);
}

for (const a of agents) a.conn.disconnect?.();
console.log('[play] stopped');
process.exit(0);
