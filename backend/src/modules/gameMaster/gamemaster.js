#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMap, gridHash, randomSeed } from './genmap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const DEFAULTS = {
  stateDir: process.env.GAMEMASTER_STATE_DIR || 'state',
  cadenceMs: Number(process.env.GAMEMASTER_WORLD_INTERVAL_MS || 30 * 60 * 1000),
  sessionMs: Number(process.env.SESSION_MS || 30 * 60 * 1000),
  minAgents: Number(process.env.GAMEMASTER_MIN_AGENTS || 10),
  targetAgents: Number(process.env.GAMEMASTER_TARGET_AGENTS || 10),
  contractSurface: Number(process.env.CONTRACT_SURFACE_Y || 1),
  deployMode: process.env.GAMEMASTER_DEPLOY_MODE || 'dry-run',
  network: process.env.CHAIN_NETWORK || 'mainnet',
  router: process.env.ROUTER_ADDRESS || '',
  programId: process.env.WORLD_PROGRAM_ID || '',
  topUp: process.env.DIGGER_TOP_UP || '100000000000000',
};

const ACTIVE_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'active']);
const PAST_STATUSES = new Set(['finished', 'archived']);

function usage() {
  console.log(`Usage:
  npm run gamemaster -- create [--count 3] [--seed 123] [--starts-at ISO]
  npm run gamemaster -- list
  npm run gamemaster -- finish <worldId>
  npm run gamemaster -- manifest
  npm run gamemaster -- run

Options:
  --state-dir <dir>       Registry/artifacts dir. Default GAMEMASTER_STATE_DIR or state.
  --count <n>             Number of worlds to prepare. Default 1.
  --cadence-ms <ms>       World cadence. Default 30 min.
  --session-ms <ms>       Session length. Default 30 min.
  --min-agents <n>        Agents needed before the operator treats a world as populated.
  --target-agents <n>     Desired agent count for UI/ops.
  --contract-surface <y>  Raw contract surface row. Default 1.
  --deploy-mode <mode>    dry-run | reuse-program | new-program. MVP writes dry-run records.
  --program <0x...>       Existing world program id for reuse-program records.
  --manifest <file>       Public worlds manifest path. Default <state-dir>/worlds.json.
`);
}

function parseArgs(argv) {
  const out = {
    command: 'create',
    positionals: [],
    count: 1,
    stateDir: DEFAULTS.stateDir,
    cadenceMs: DEFAULTS.cadenceMs,
    sessionMs: DEFAULTS.sessionMs,
    minAgents: DEFAULTS.minAgents,
    targetAgents: DEFAULTS.targetAgents,
    contractSurface: DEFAULTS.contractSurface,
    deployMode: DEFAULTS.deployMode,
    programId: DEFAULTS.programId,
    topUp: DEFAULTS.topUp,
    network: DEFAULTS.network,
    router: DEFAULTS.router,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) out.command = args.shift();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`${arg} requires a value`);
      return args[i];
    };
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--count':
      case '-n':
        out.count = positiveInt(next(), '--count');
        break;
      case '--seed':
        out.seed = Number(next());
        break;
      case '--starts-at':
        out.startsAt = next();
        break;
      case '--state-dir':
        out.stateDir = next();
        break;
      case '--manifest':
        out.manifest = next();
        break;
      case '--cadence-ms':
        out.cadenceMs = positiveInt(next(), '--cadence-ms');
        break;
      case '--session-ms':
        out.sessionMs = positiveInt(next(), '--session-ms');
        break;
      case '--min-agents':
        out.minAgents = positiveInt(next(), '--min-agents');
        break;
      case '--target-agents':
        out.targetAgents = positiveInt(next(), '--target-agents');
        break;
      case '--contract-surface':
        out.contractSurface = positiveInt(next(), '--contract-surface');
        break;
      case '--deploy-mode':
        out.deployMode = next();
        break;
      case '--program':
        out.programId = next();
        break;
      case '--top-up':
        out.topUp = next();
        break;
      default:
        out.positionals.push(arg);
        break;
    }
  }

  if (!['dry-run', 'reuse-program', 'new-program'].includes(out.deployMode)) {
    throw new Error('--deploy-mode must be dry-run, reuse-program, or new-program');
  }
  if (out.seed != null && !Number.isFinite(out.seed)) throw new Error('--seed must be a number');
  return out;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function statePaths(args) {
  const stateDir = path.resolve(ROOT, args.stateDir);
  return {
    stateDir,
    registry: path.join(stateDir, 'gamemaster.json'),
    manifest: path.resolve(ROOT, args.manifest || path.join(args.stateDir, 'worlds.json')),
    worldsDir: path.join(stateDir, 'worlds'),
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

async function loadRegistry(paths) {
  return readJson(paths.registry, {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    worlds: [],
  });
}

function rel(file) {
  return path.relative(ROOT, file);
}

function worldIdFor(seed, startsAt) {
  return `world-${startsAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${seed}`;
}

function scheduleAt(args, index) {
  const base = args.startsAt ? Date.parse(args.startsAt) : Date.now();
  if (!Number.isFinite(base)) throw new Error('--starts-at must be a valid date');
  return new Date(base + index * args.cadenceMs);
}

function makeWorldRecord(args, paths, map, startsAt) {
  const id = worldIdFor(map.seed, startsAt.toISOString());
  const dir = path.join(paths.worldsDir, id);
  const endsAt = new Date(startsAt.getTime() + args.sessionMs);
  return {
    schemaVersion: 1,
    id,
    status: 'map_ready',
    deployMode: args.deployMode,
    programId: args.deployMode === 'reuse-program' ? args.programId || null : null,
    seed: String(map.seed),
    network: args.network,
    router: args.router || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    sessionMs: args.sessionMs,
    cadenceMs: args.cadenceMs,
    admission: {
      minAgents: args.minAgents,
      targetAgents: args.targetAgents,
      registeredAgents: [],
    },
    funding: {
      topUp: String(args.topUp),
      fundedAt: null,
    },
    map: {
      width: map.width,
      height: map.height,
      renderSurface: map.surface,
      contractSurface: map.contractSurface,
      hash: gridHash(map.map),
      counts: map.counts,
      valid: map.valid,
      warnings: map.warnings,
    },
    paths: {
      map: rel(path.join(dir, 'map.json')),
      snapshot: rel(path.join(dir, 'snapshot.json')),
      events: rel(path.join(dir, 'events.json')),
    },
    chain: {
      deployedAt: null,
      startedAt: null,
      finishedAt: null,
      lastScannedBlock: null,
    },
  };
}

async function writeWorldArtifacts(world, paths, map) {
  const dir = path.join(paths.worldsDir, world.id);
  const mapArtifact = {
    schemaVersion: 1,
    worldId: world.id,
    seed: world.seed,
    width: map.width,
    height: map.height,
    contractSurface: map.contractSurface,
    renderSurface: map.surface,
    hash: world.map.hash,
    counts: map.counts,
    valid: map.valid,
    warnings: map.warnings,
    tiles: map.map,
    renderMap: map.renderMap,
  };
  const snapshotArtifact = {
    schemaVersion: 1,
    worldId: world.id,
    kind: 'initial',
    capturedAt: new Date().toISOString(),
    status: world.status,
    programId: world.programId,
    seed: world.seed,
    mapHash: world.map.hash,
    width: map.width,
    height: map.height,
    contractSurface: map.contractSurface,
    tiles: map.map,
    agents: [],
  };
  await writeJson(path.join(dir, 'map.json'), mapArtifact);
  await writeJson(path.join(dir, 'snapshot.json'), snapshotArtifact);
  await writeJson(path.join(dir, 'events.json'), []);
}

function manifestFrom(registry) {
  const worlds = [...registry.worlds].sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
  const pick = (world) => ({
    id: world.id,
    status: world.status,
    deployMode: world.deployMode,
    programId: world.programId,
    seed: world.seed,
    network: world.network,
    startsAt: world.startsAt,
    endsAt: world.endsAt,
    sessionMs: world.sessionMs,
    agents: world.admission?.registeredAgents?.length || 0,
    minAgents: world.admission?.minAgents || 0,
    targetAgents: world.admission?.targetAgents || 0,
    mapHash: world.map?.hash,
    map: world.paths?.map,
    snapshot: world.paths?.snapshot,
    events: world.paths?.events,
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    active: worlds.filter((w) => ACTIVE_STATUSES.has(w.status)).map(pick),
    past: worlds.filter((w) => PAST_STATUSES.has(w.status)).map(pick),
    planned: worlds.filter((w) => w.status === 'planned').map(pick),
    worlds: worlds.map(pick),
  };
}

async function saveRegistry(paths, registry) {
  registry.updatedAt = new Date().toISOString();
  await writeJson(paths.registry, registry);
  await writeJson(paths.manifest, manifestFrom(registry));
}

async function createWorlds(args) {
  const paths = statePaths(args);
  const registry = await loadRegistry(paths);
  const created = [];

  for (let i = 0; i < args.count; i += 1) {
    const seed = args.seed != null ? (args.seed + i) >>> 0 : randomSeed();
    const map = generateMap(seed, { contractSurface: args.contractSurface });
    if (!map.valid) {
      throw new Error(`generated invalid map seed=${map.seed}: ${map.warnings.join('; ')}`);
    }
    const startsAt = scheduleAt(args, i);
    const world = makeWorldRecord(args, paths, map, startsAt);
    if (registry.worlds.some((existing) => existing.id === world.id)) {
      throw new Error(`world ${world.id} already exists; use another seed or --starts-at`);
    }
    await writeWorldArtifacts(world, paths, map);
    registry.worlds.push(world);
    created.push(world);
  }

  await saveRegistry(paths, registry);
  for (const world of created) {
    console.log(
      `[gamemaster] ${world.id} ${world.status} seed=${world.seed} hash=${world.map.hash} ` +
      `starts=${world.startsAt} map=${world.paths.map}`,
    );
  }
  console.log(`[gamemaster] manifest ${rel(paths.manifest)}`);
}

async function listWorlds(args) {
  const paths = statePaths(args);
  const registry = await loadRegistry(paths);
  if (!registry.worlds.length) {
    console.log('[gamemaster] no worlds yet');
    return;
  }
  for (const world of registry.worlds) {
    const program = world.programId ? ` ${world.programId}` : '';
    console.log(`${world.status.padEnd(14)} ${world.id} seed=${world.seed} starts=${world.startsAt}${program}`);
  }
}

async function markFinished(args) {
  const id = args.positionals[0];
  if (!id) throw new Error('finish requires <worldId>');
  const paths = statePaths(args);
  const registry = await loadRegistry(paths);
  const world = registry.worlds.find((w) => w.id === id);
  if (!world) throw new Error(`unknown world ${id}`);
  world.status = 'finished';
  world.updatedAt = new Date().toISOString();
  world.chain = { ...(world.chain || {}), finishedAt: new Date().toISOString() };
  await updateSnapshotStatus(world, 'finished');
  await saveRegistry(paths, registry);
  console.log(`[gamemaster] finished ${id}`);
}

async function updateSnapshotStatus(world, status) {
  if (!world.paths?.snapshot) return;
  const snapshotPath = path.resolve(ROOT, world.paths.snapshot);
  const snapshot = await readJson(snapshotPath, null);
  if (!snapshot) return;
  snapshot.status = status;
  snapshot.capturedAt = new Date().toISOString();
  snapshot.programId = world.programId;
  await writeJson(snapshotPath, snapshot);
}

async function rewriteManifest(args) {
  const paths = statePaths(args);
  const registry = await loadRegistry(paths);
  await saveRegistry(paths, registry);
  console.log(`[gamemaster] manifest ${rel(paths.manifest)}`);
}

async function runLoop(args) {
  console.log(`[gamemaster] run loop cadence=${Math.round(args.cadenceMs / 60000)}m deployMode=${args.deployMode}`);
  for (;;) {
    await createWorlds({ ...args, count: 1, startsAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, args.cadenceMs));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  switch (args.command) {
    case 'create':
      await createWorlds(args);
      break;
    case 'list':
      await listWorlds(args);
      break;
    case 'finish':
      await markFinished(args);
      break;
    case 'manifest':
      await rewriteManifest(args);
      break;
    case 'run':
      await runLoop(args);
      break;
    default:
      throw new Error(`unknown command ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
