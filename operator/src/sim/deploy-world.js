#!/usr/bin/env node
// One-shot: validate the (rebuilt) digger-world code, create + fund a new program,
// Create(), and upload a fresh framed map. Prints the new program id.
//   node src/sim/deploy-world.js
// After: put the printed id in frontend/.env VITE_WORLD_PROGRAM_IDS + state/factory-programs.json.

import { connectChain } from '../chain/client.js';
import { loadChainEnv } from '../factory/config.js';
import { generateMap, randomSeed, gridHash } from '../genmap.js';

const env = loadChainEnv();
const c = await connectChain(env);

console.log('[deploy] validating code (rebuilt wasm) — may take a few minutes…');
const codeId = await c.ensureCodeValidated();
console.log('[deploy] code validated:', codeId);

console.log('[deploy] creating + funding program…');
const programId = await c.createProgram(codeId, BigInt(env.topUp));
console.log('[deploy] program created:', programId, '— initializing Create()…');
await c.sendAdmin(programId, c.encode.create());

let m = null;
for (let i = 0; i < 6 && !m; i += 1) {
  const cand = generateMap(randomSeed(), { contractSurface: env.contractSurface });
  if (cand.valid) m = cand;
}
if (!m) { console.error('[deploy] could not generate a valid map'); process.exit(1); }
console.log(`[deploy] uploading map seed=${m.seed} hash=${gridHash(m.map)}…`);
await c.sendAdmin(programId, c.encode.uploadMap(m.seed, m.map));

console.log('');
console.log('[deploy] ✅ NEW WORLD =', programId);
console.log('[deploy] codeId =', codeId);
c.disconnect();
process.exit(0);
