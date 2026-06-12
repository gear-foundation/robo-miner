#!/usr/bin/env node
// Register N agents into a DiggerWorld so the lobby fills (the contract
// auto-starts the session at 10). Each agent is a distinct ephemeral key →
// distinct on-chain caller; registration is injected (gasless), so the keys
// need no funds — the world program's executable balance pays.
//
//   node src/modules/gameMaster/sim/register-agents.js [worldProgramId] [count]
// Defaults: first program in <GAMEMASTER_STATE_DIR>/factory-programs.json, count 10.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainEnv } from '../factory/config.js';
import { actorIdFromAddress, connectDiggerWorldChain } from '../../../chain/diggerWorld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../..');

function stateFilePath(name) {
  const stateDir = process.env.GAMEMASTER_STATE_DIR || 'state';
  const dir = path.isAbsolute(stateDir) ? stateDir : path.resolve(ROOT, stateDir);
  return path.join(dir, name);
}

async function firstPoolProgram() {
  try {
    const pool = JSON.parse(await readFile(stateFilePath('factory-programs.json'), 'utf8'));
    return pool.programs?.[0] || '';
  } catch {
    return '';
  }
}

const env = loadChainEnv();
const worldId = process.argv[2] || process.env.DIGGER_PROGRAM_ID || (await firstPoolProgram());
const count = Number(process.argv[3] || 10);
if (!worldId) {
  console.error('no world program id (pass as arg, set DIGGER_PROGRAM_ID, or have <GAMEMASTER_STATE_DIR>/factory-programs.json)');
  process.exit(1);
}

const { keccak256, stringToBytes } = await import('viem');
const { privateKeyToAccount } = await import('viem/accounts');

const admin = await connectDiggerWorldChain(env);

async function agentCount() {
  const reply = await admin.query(worldId, admin.encode.agents());
  const arr = admin.decode.agents(reply.payload);
  return Array.isArray(arr) ? arr.length : 0;
}
async function sessionStatus() {
  const reply = await admin.query(worldId, admin.encode.session());
  return Number(admin.decode.session(reply.payload)[2]);
}

console.log(`[sim] world ${worldId} · target ${count} agents`);
console.log(`[sim] start: agents=${await agentCount()} status=${await sessionStatus()}`);

for (let i = 0; i < count; i += 1) {
  const key = keccak256(stringToBytes(`digger-agent:${worldId}:${i}`));
  const account = privateKeyToAccount(key);
  const owner = actorIdFromAddress(account.address);
  let agent = null;
  try {
    agent = await connectDiggerWorldChain({ ...env, adminKey: key });
    await agent.sendInjected(worldId, agent.encode.register(owner));
    console.log(`[sim] agent ${i + 1}/${count} ${account.address} → registered`);
  } catch (error) {
    console.log(`[sim] agent ${i + 1}/${count} ${account.address} → ${error?.message || error}`);
  } finally {
    agent?.disconnect?.();
  }
  console.log(`[sim]   agents=${await agentCount()}/10  status=${await sessionStatus()}`);
}

console.log(`[sim] done · agents=${await agentCount()} status=${await sessionStatus()} (status 1 = ACTIVE → auto-started)`);
admin.disconnect();
process.exit(0);
