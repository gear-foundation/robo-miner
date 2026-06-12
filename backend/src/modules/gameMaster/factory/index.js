#!/usr/bin/env node
// World factory (registrar).
//
//   node src/modules/gameMaster/factory/index.js                 # fast dry-run demo
//   node src/modules/gameMaster/factory/index.js --duration 0    # dry-run forever
//   node src/modules/gameMaster/factory/index.js --real-timers   # real timers
//   node src/modules/gameMaster/factory/index.js --chain         # live testnet
//
// Chain mode needs DIGGER_ADMIN_KEY (+ funded WVARA) in backend/.env.
// The factory state machine is identical in both modes — only the driver differs.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadChainEnv } from './config.js';
import { loadConfig as loadBackendConfig } from '../../../config/index.js';
import { createDocumentStore, createStore } from '../../../db/store.js';
import { WorldRegistryService } from '../../worldRegistry/service.js';
import { createFactory } from './factory.js';
import { createDryRunDriver } from './drivers/dryRunDriver.js';
import { createRegistryPublisher } from './registry.js';
import { createDiscoveryServer } from './discovery.js';
import { createArchiveStore } from './archive.js';
import { WORLD } from './world.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../..'); // backend/src/modules/gameMaster/factory → repo root
const backendConfig = loadBackendConfig();
const documentStore = createDocumentStore(backendConfig);

// Durable factory state: live worlds keep the same programId/session across
// operator restarts; retired worlds survive for the lobby's PAST tab.
function stateFilePath(name) {
  const stateDir = process.env.GAMEMASTER_STATE_DIR || 'state';
  const dir = path.isAbsolute(stateDir) ? stateDir : path.resolve(ROOT, stateDir);
  return path.join(dir, name);
}
const liveFilePath = () => stateFilePath('factory-live.json');
const pastFilePath = () => stateFilePath('factory-past.json');
const registryFilePath = () => stateFilePath('gamemaster.json');
const RESTORABLE_LIVE = new Set([WORLD.OPEN, WORLD.ACTIVE, WORLD.FINISHED]);

async function readJson(file, fallback = null) {
  const doc = await documentStore?.read(documentIdFor(file), undefined);
  if (doc !== undefined) return doc;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, payload) {
  await documentStore?.write(documentIdFor(file), payload);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmp, file);
}

function documentIdFor(file) {
  return `factory:${path.basename(file, '.json')}`;
}

async function loadPast() {
  const data = await readJson(pastFilePath(), {});
  return Array.isArray(data?.worlds) ? data.worlds : [];
}
async function savePast(worlds) {
  await writeJson(pastFilePath(), { schemaVersion: 1, updatedAt: new Date().toISOString(), worlds });
}

function compactWorld(world) {
  return {
    id: world.id,
    status: world.status,
    programId: world.programId || null,
    seed: world.seed ?? null,
    mapHash: world.mapHash || null,
    sessionId: Number(world.sessionId || 0),
    agents: Number(world.agents || 0),
    owners: Array.isArray(world.owners) ? world.owners : [],
    createdAt: world.createdAt ?? Date.now(),
    openedAt: world.openedAt ?? null,
    lastJoinAt: world.lastJoinAt ?? null,
    startedAt: world.startedAt ?? null,
    finishedAt: world.finishedAt ?? null,
    archivedAt: world.archivedAt ?? null,
    archiveId: world.archiveId ?? null,
    archiveUrl: world.archiveUrl ?? null,
    eligibleManualStart: Boolean(world.eligibleManualStart),
    startReason: world.startReason || null,
  };
}

async function loadLive() {
  const live = await readJson(liveFilePath(), null);
  if (Array.isArray(live?.worlds)) {
    return live.worlds
      .map(compactWorld)
      .filter((world) => world.programId && RESTORABLE_LIVE.has(world.status));
  }

  // First run after this persistence patch: recover from the public registry we
  // were already writing, so existing live worlds do not disappear.
  const registry = await readJson(registryFilePath(), null);
  if (!Array.isArray(registry?.worlds)) return [];
  return registry.worlds
    .map(worldFromRegistryRecord)
    .filter(Boolean);
}

async function saveLive(worlds) {
  const active = worlds
    .filter((world) => world.programId && RESTORABLE_LIVE.has(world.status))
    .map(compactWorld);
  await writeJson(liveFilePath(), { schemaVersion: 1, updatedAt: new Date().toISOString(), worlds: active });
}

function ms(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function worldFromRegistryRecord(record) {
  if (!record?.id || !record?.programId) return null;
  const status = {
    deployed: WORLD.OPEN,
    waiting_agents: WORLD.OPEN,
    active: WORLD.ACTIVE,
    finished: WORLD.FINISHED,
  }[record.status];
  if (!status) return null;
  const owners = Array.isArray(record.admission?.registeredAgents)
    ? record.admission.registeredAgents
    : [];
  const openedAt = ms(record.chain?.startedAt) || ms(record.startsAt);
  return compactWorld({
    id: record.id,
    status,
    programId: record.programId,
    seed: record.seed ?? null,
    mapHash: record.map?.hash || null,
    sessionId: Number(record.sessionId || 0),
    agents: owners.length,
    owners,
    createdAt: ms(record.createdAt) || Date.now(),
    openedAt,
    lastJoinAt: openedAt,
    startedAt: ms(record.chain?.startedAt),
    finishedAt: ms(record.chain?.finishedAt),
    eligibleManualStart: false,
    startReason: null,
  });
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const useChain = process.argv.includes('--chain');
const realTimers = process.argv.includes('--real-timers');
const durationMs = Number(argValue('--duration', useChain ? '0' : '25000')); // 0 = run forever

let driver;
let config;
let chainEnv = {};
const initialLive = useChain ? await loadLive() : [];
const reservedProgramIds = initialLive.map((world) => world.programId).filter(Boolean);

if (useChain) {
  // Live: the contract owns cap=10 auto-start; we own provisioning, the pool,
  // the ≥1-open invariant, and the >=8 manual/idle start.
  config = loadConfig({ lobbyMode: true });
  chainEnv = loadChainEnv();
  const { createChainDriver } = await import('./drivers/chainDriver.js');
  driver = await createChainDriver({ env: chainEnv, reservedProgramIds, documentStore });
} else {
  config = loadConfig(
    realTimers
      ? {}
      : {
          // compressed demo timers so a full lobby→run→recycle cycle shows in seconds
          lobbyTimeoutMs: Number(process.env.FACTORY_LOBBY_TIMEOUT_MS) || 4000,
          sessionMs: Number(process.env.SESSION_MS) || 8000,
          tickMs: 400,
          poolSize: process.env.FACTORY_POOL_MAX != null
            ? Number(process.env.FACTORY_POOL_MAX)
            : (Number(process.env.FACTORY_POOL_SIZE) || 3),
          minOpenWorlds: Number(process.env.FACTORY_MIN_OPEN) || 1,
          autoStartOnTimeout: true, // demo progresses without a human clicking start
        },
  );
  driver = createDryRunDriver();
}

const publisher = createRegistryPublisher({
  cfg: config,
  env: chainEnv,
  stateDir: process.env.GAMEMASTER_STATE_DIR || 'state',
  worldRegistry: createWorldRegistry(),
});
const archives = createArchiveStore({
  root: ROOT,
  stateDir: process.env.GAMEMASTER_STATE_DIR || 'state',
  cfg: config,
});
console.log(`[factory] publishing worlds → ${publisher.file} (World Registry reads this)`);

const initialPast = useChain ? await loadPast() : [];
if (initialLive.length) console.log(`[factory] restored ${initialLive.length} live world(s) → CURRENT tab`);
if (initialPast.length) console.log(`[factory] restored ${initialPast.length} past world(s) → PAST tab`);
const factory = createFactory({
  driver,
  config,
  publish: publisher.publish,
  initialLive,
  initialPast,
  onLive: useChain ? saveLive : null,
  onPast: useChain ? savePast : null,
  onArchive: async (world) => {
    if (typeof driver.archiveSnapshot !== 'function') return null;
    const snapshot = await driver.archiveSnapshot(world);
    return archives.save(world, snapshot);
  },
});

// Agent-facing discovery: the single address agents scan for current matches.
const discovery = createDiscoveryServer({
  factory,
  env: chainEnv,
  cfg: config,
  archives,
  port: Number(process.env.DISCOVERY_PORT || 8780),
});
try {
  await discovery.start();
} catch (error) {
  driver.disconnect?.();
  console.error(`[factory] ${error?.message || error}`);
  process.exit(1);
}

process.on('SIGINT', () => {
  factory.stop();
  discovery.stop();
  driver.disconnect?.();
  console.log('\n[factory] stopped (SIGINT)');
  process.exit(0);
});

await factory.start();

if (durationMs > 0) {
  setTimeout(() => {
    factory.stop();
    driver.disconnect?.();
    console.log(`\n[factory] demo done after ${durationMs}ms · final worlds:`);
    for (const world of factory.snapshot()) {
      console.log(
        `  ${world.id} ${String(world.status).padEnd(12)} agents=${world.agents} ` +
          `session=${world.sessionId} program=${world.programId} start=${world.startReason || '-'}`,
      );
    }
    process.exit(0);
  }, durationMs);
}

function createWorldRegistry() {
  if (backendConfig.storeBackend !== 'postgres') return null;
  return new WorldRegistryService({
    store: createStore(backendConfig),
    config: backendConfig,
  });
}
