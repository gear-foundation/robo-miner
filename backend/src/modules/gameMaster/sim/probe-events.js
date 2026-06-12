#!/usr/bin/env node
// Probe (read-events style): prime at the latest block, register a fresh agent,
// then walk every NEW block via block_header/parentHash and read block_outcome
// per hash (raw provider.send) — decoding the world's events. Confirms the
// event-driven path works (the frontend just used a non-existent api helper).
//   node src/modules/gameMaster/sim/probe-events.js <worldProgramId>

import { loadChainEnv } from '../factory/config.js';
import { connectChain, actorIdFromAddress } from '../chain/client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = loadChainEnv();
const world = process.argv[2];
if (!world) { console.error('usage: probe-events.js <worldProgramId>'); process.exit(1); }

const { keccak256, stringToBytes } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');
const key = keccak256(stringToBytes(`probe-agent:${world}:${Math.floor(Math.random() * 1e9)}`));
const owner = actorIdFromAddress(privateKeyToAccount(key).address);
const c = await connectChain({ ...env, adminKey: key });

async function header(hash) {
  const resp = await c.provider.send('block_header', hash ? [hash] : [], { timeout: 15000 });
  const rest = (Array.isArray(resp) ? resp[1] : resp) || {};
  return { hash: Array.isArray(resp) ? resp[0] : resp.hash, height: rest.height, parentHash: rest.parentHash ?? rest.parent_hash };
}
async function outcome(hash) {
  const ts = (await c.provider.send('block_outcome', [hash], { timeout: 20000 })) || [];
  for (const t of ts) if (t && t.actorId == null && t.actor_id) t.actorId = t.actor_id;
  return ts;
}

let last = (await header()).hash;
console.log(`[probe] primed at ${last.slice(0, 10)}; registering fresh agent…`);
try { await c.sendInjected(world, c.encode.register(owner)); console.log('[probe] register ok'); }
catch (e) { console.log('[probe] register err:', e.message); }

let found = 0;
let blocksScanned = 0;
for (let i = 0; i < 30 && found < 5; i += 1) {
  const latest = await header();
  if (latest.hash !== last) {
    const chain = [];
    let cur = latest;
    for (let j = 0; j < 25 && cur && cur.hash !== last; j += 1) {
      chain.push(cur);
      if (!cur.parentHash) break;
      try { cur = await header(cur.parentHash); } catch { break; }
    }
    for (const h of chain.reverse()) {
      blocksScanned += 1;
      let ts = [];
      try { ts = await outcome(h.hash); } catch (e) { console.log('[probe] outcome err:', e.message); continue; }
      for (const t of ts) {
        for (const m of t.messages || []) {
          const p = m.payload;
          const hex = typeof p === 'string' ? p : (p ? `0x${Buffer.from(p).toString('hex')}` : null);
          if (!hex || hex === '0x') continue;
          try {
            const d = c.sails.decodeEvent(hex);
            if (d?.kind === 'event' && d.entry?.kind === 'event') {
              console.log(`[probe] EVENT ${d.entry.service}.${d.entry.event} dest=${m.destination} data=${JSON.stringify(d.data, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
              found += 1;
            }
          } catch {}
        }
      }
    }
    last = latest.hash;
  }
  await sleep(300);
}
console.log(`[probe] summary: blocksScanned=${blocksScanned} decodedEvents=${found}`);
c.disconnect();
process.exit(0);
