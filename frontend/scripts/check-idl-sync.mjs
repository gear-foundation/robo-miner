import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js/parser';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

const idlPairs = [
  ['world', 'contracts/target/wasm32-gear/release/digger_world.idl', 'frontend/src/chain/world.idl'],
  ['digger_res_vmt', 'contracts/target/wasm32-gear/release/digger_res_vmt.idl', 'frontend/src/chain/digger_res_vmt.idl'],
  ['digger_redeem', 'contracts/target/wasm32-gear/release/digger_redeem.idl', 'frontend/src/chain/digger_redeem.idl'],
];

function readSnapshot(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n').trim();
}

const mismatches = [];
const parser = new SailsIdlParser();
await parser.init();

for (const [name, contractPath, frontendPath] of idlPairs) {
  const contractIdl = readSnapshot(contractPath);
  const frontendIdl = readSnapshot(frontendPath);

  if (contractIdl !== frontendIdl) {
    mismatches.push(`${name}: ${frontendPath} differs from ${contractPath}`);
  }

  try {
    new SailsProgram(parser.parse(frontendIdl));
  } catch (error) {
    mismatches.push(`${name}: ${frontendPath} failed to parse: ${error?.message || String(error)}`);
  }
}

if (mismatches.length > 0) {
  console.error('Frontend IDL snapshots are out of sync:');
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch}`);
  }
  console.error('\nRefresh snapshots from contracts/target/wasm32-gear/release before building the frontend.');
  process.exit(1);
}

console.log('Frontend IDL snapshots match contract release IDLs.');
