#!/usr/bin/env node
// Reset a world: upload a fresh generated map (clears agents, new session →
// CREATED, registration open). Admin-signed.
//   node src/modules/gameMaster/sim/reset-world.js <worldProgramId>

import { loadChainEnv } from '../factory/config.js';
import { connectDiggerWorldChain } from '../../../chain/diggerWorld.js';
import { generateMap, randomSeed, gridHash } from '../genmap.js';

const env = loadChainEnv();
const world = process.argv[2];
if (!world) { console.error('usage: reset-world.js <worldProgramId>'); process.exit(1); }

const c = await connectDiggerWorldChain(env);

let map = null;
for (let i = 0; i < 6 && !map; i += 1) {
  const candidate = generateMap(randomSeed(), { contractSurface: env.contractSurface });
  if (candidate.valid) map = candidate;
}
if (!map) { console.error('could not generate a valid map'); process.exit(1); }

console.log(`[reset] uploading fresh map → ${world} seed=${map.seed} hash=${gridHash(map.map)}`);
await c.sendAdmin(world, c.encode.uploadMap(map.seed, map.map));
const s = c.decode.session((await c.query(world, c.encode.session())).payload).map(Number);
console.log(`[reset] done · session_id=${s[0]} status=${s[2]} (0=CREATED, agents cleared, registration open)`);

c.disconnect();
process.exit(0);
