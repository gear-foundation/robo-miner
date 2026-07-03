#!/usr/bin/env node
// Fill every currently open factory lobby to the 10-agent cap. Intended for a
// testnet/production smoke where the factory is already running elsewhere:
//
//   FACTORY_DISCOVERY_URL=https://... CHAIN_NETWORK=testnet npm run sim:fill-factory
//   CHAIN_NETWORK=testnet npm run sim:fill-factory -- --worlds 0xabc...,0xdef...
//
// This script never starts or controls the factory. It only sends direct
// injected World.Register(owner) calls with deterministic ephemeral keys; it is
// an operator smoke tool, not the normal rented-DiggerProxy player flow.

import { loadChainEnv } from '../factory/config.js';
import { actorIdFromAddress, connectDiggerWorldChain } from '../../../chain/diggerWorld.js';

const SESSION_CREATED = 0;
const SESSION_ACTIVE = 1;
const SESSION_FINISHED = 2;
const DEFAULT_LOBBY_CAP = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = {
    discovery: process.env.FACTORY_DISCOVERY_URL || process.env.DIGGER_BACKEND_URL || process.env.BACKEND_URL || '',
    worlds: [],
    dryRun: false,
    allowMainnet: false,
    noWait: false,
    waitMs: Number(process.env.FACTORY_SMOKE_WAIT_MS || 180_000),
    pollMs: Number(process.env.FACTORY_SMOKE_POLL_MS || 6_000),
    maxKeyAttempts: Number(process.env.FACTORY_SMOKE_MAX_KEY_ATTEMPTS || 80),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--discovery') out.discovery = next();
    else if (arg === '--worlds') out.worlds = splitList(next());
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--allow-mainnet') out.allowMainnet = true;
    else if (arg === '--no-wait') out.noWait = true;
    else if (arg === '--wait-ms') out.waitMs = Number(next());
    else if (arg === '--poll-ms') out.pollMs = Number(next());
    else if (arg === '--max-key-attempts') out.maxKeyAttempts = Number(next());
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function usage() {
  return [
    'Usage:',
    '  FACTORY_DISCOVERY_URL=https://... CHAIN_NETWORK=testnet npm run sim:fill-factory',
    '  CHAIN_NETWORK=testnet npm run sim:fill-factory -- --worlds 0xabc...,0xdef...',
    '',
    'Options:',
    '  --discovery <url>       Existing factory/backend discovery URL. Defaults to FACTORY_DISCOVERY_URL, DIGGER_BACKEND_URL, BACKEND_URL, or network port.',
    '  --worlds <ids>          Comma-separated world program ids; skips discovery target selection.',
    '  --dry-run              Print intended registrations without sending writes.',
    '  --no-wait              Only fill worlds; do not poll discovery for the factory-created replacement.',
    '  --wait-ms <ms>         Time to wait for a new open world after filling all targets.',
    '  --poll-ms <ms>         Discovery polling interval while waiting.',
    '  --allow-mainnet        Required if CHAIN_NETWORK resolves to mainnet.',
  ].join('\n');
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchSessions(discovery) {
  const base = discovery.replace(/\/$/, '');
  const body = await fetchJson(`${base}/sessions`);
  return Array.isArray(body.sessions) ? body.sessions : [];
}

function joinableTargets(sessions, explicitWorlds) {
  if (explicitWorlds.length > 0) {
    return explicitWorlds.map((programId, index) => ({
      id: `explicit-${index + 1}`,
      programId,
      status: 'open',
      maxAgents: DEFAULT_LOBBY_CAP,
      agents: 0,
      slotsFree: DEFAULT_LOBBY_CAP,
    }));
  }
  return sessions
    .filter((session) =>
      session?.programId &&
      session.status === 'open' &&
      session.canRegister !== false &&
      Number(session.slotsFree ?? 1) > 0)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

function deterministicKeySeed(programId, index) {
  return `factory-fill:${programId.toLowerCase()}:${index}`;
}

async function readAgents(chain, programId) {
  const reply = await chain.query(programId, chain.encode.agents());
  const agents = chain.decode.agents(reply.payload);
  return Array.isArray(agents) ? agents.map(String) : [];
}

async function readSession(chain, programId) {
  const reply = await chain.query(programId, chain.encode.session());
  const arr = chain.decode.session(reply.payload).map((value) => Number(value));
  return { sessionId: arr[0], seed: arr[1], status: arr[2], actionSeq: arr[3] };
}

async function registerUntilFull({ env, programId, cap, maxKeyAttempts, dryRun }) {
  const { keccak256, stringToBytes } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  let reader = null;
  try {
    reader = await connectDiggerWorldChain(env);
    let session = await readSession(reader, programId);
    let agents = await readAgents(reader, programId);
    console.log(`[fill] ${programId} start agents=${agents.length}/${cap} status=${session.status}`);

    if (![SESSION_CREATED, SESSION_ACTIVE].includes(session.status)) {
      console.log(`[fill] ${programId} skip: session is not open for registration`);
      return { programId, before: agents.length, after: agents.length, status: session.status, registered: 0 };
    }

    const before = agents.length;
    const seen = new Set(agents.map((item) => item.toLowerCase()));
    let registered = 0;
    for (let keyIndex = 0; agents.length < cap && keyIndex < maxKeyAttempts; keyIndex += 1) {
      const key = keccak256(stringToBytes(deterministicKeySeed(programId, keyIndex)));
      const account = privateKeyToAccount(key);
      const callerActor = actorIdFromAddress(account.address);
      if (seen.has(callerActor.toLowerCase())) continue;

      if (dryRun) {
        console.log(`[fill] dry-run register ${account.address} -> ${programId}`);
        seen.add(callerActor.toLowerCase());
        agents.push(callerActor);
        registered += 1;
        continue;
      }

      let agent = null;
      try {
        agent = await connectDiggerWorldChain({ ...env, adminKey: key });
        await agent.sendInjected(programId, agent.encode.register(callerActor));
        registered += 1;
        console.log(`[fill]   + ${account.address} (${agents.length + 1}/${cap})`);
      } catch (error) {
        console.log(`[fill]   ! ${account.address}: ${error?.message || error}`);
      } finally {
        agent?.disconnect?.();
      }

      agents = await readAgents(reader, programId);
      session = await readSession(reader, programId);
      for (const owner of agents) seen.add(String(owner).toLowerCase());
      console.log(`[fill]   now agents=${agents.length}/${cap} status=${session.status}`);
      if (session.status === SESSION_FINISHED) break;
    }

    if (agents.length < cap) {
      throw new Error(
        `${programId} stopped at agents=${agents.length}/${cap}, status=${session.status}; ` +
        `increase --max-key-attempts or inspect registration errors`,
      );
    }
    return { programId, before, after: agents.length, status: session.status, registered };
  } finally {
    reader?.disconnect?.();
  }
}

async function waitForFreshOpenWorld({ discovery, initialProgramIds, waitMs, pollMs }) {
  if (!discovery) return null;
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const sessions = await fetchSessions(discovery);
    const fresh = sessions.find((session) =>
      session?.programId &&
      session.status === 'open' &&
      session.canRegister !== false &&
      !initialProgramIds.has(String(session.programId).toLowerCase()));
    const summary = sessions
      .map((session) => `${session.id}:${session.status}:${session.agents}/${session.maxAgents}`)
      .join(' ');
    console.log(`[fill] factory poll ${summary || '(no sessions)'}`);
    if (fresh) return fresh;
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting ${waitMs}ms for factory to publish a fresh open world`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const env = loadChainEnv();
  if (!args.discovery) args.discovery = `http://localhost:${env.discoveryPort || 8780}`;
  if (env.network === 'mainnet' && !args.allowMainnet) {
    throw new Error('refusing to run on mainnet without --allow-mainnet');
  }
  if (!Number.isFinite(args.waitMs) || args.waitMs < 0) throw new Error('--wait-ms must be a non-negative number');
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) throw new Error('--poll-ms must be a positive number');

  console.log(`[fill] network=${env.network} discovery=${args.discovery} dryRun=${args.dryRun}`);

  const sessions = args.worlds.length > 0 ? [] : await fetchSessions(args.discovery);
  const targets = joinableTargets(sessions, args.worlds);
  if (targets.length === 0) {
    throw new Error('no open joinable worlds found; check the existing factory/backend /sessions endpoint');
  }
  console.log(`[fill] targets: ${targets.map((target) => `${target.id}:${target.programId}`).join(', ')}`);

  const initialProgramIds = new Set(
    (sessions.length > 0 ? sessions : targets)
      .map((session) => String(session.programId || '').toLowerCase())
      .filter(Boolean),
  );

  const results = [];
  for (const target of targets) {
    const cap = Number(target.maxAgents || target.capAgents || DEFAULT_LOBBY_CAP);
    results.push(await registerUntilFull({
      env,
      programId: target.programId,
      cap,
      maxKeyAttempts: args.maxKeyAttempts,
      dryRun: args.dryRun,
    }));
  }

  console.log('[fill] registration summary:');
  for (const result of results) {
    console.log(
      `[fill]   ${result.programId} registered=${result.registered} ` +
      `agents=${result.after} status=${result.status}`,
    );
  }

  if (args.dryRun || args.noWait) return;
  const fresh = await waitForFreshOpenWorld({
    discovery: args.discovery,
    initialProgramIds,
    waitMs: args.waitMs,
    pollMs: args.pollMs,
  });
  if (fresh) {
    console.log(`[fill] OK: factory published fresh open world ${fresh.id} ${fresh.programId}`);
  }
}

main().catch((error) => {
  console.error(`[fill] ${error?.message || error}`);
  process.exit(1);
});
