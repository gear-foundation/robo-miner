#!/usr/bin/env node

import { createVaraEthChain } from '../chain/varaEth.js';
import { loadConfig } from '../config/index.js';
import { createStore } from '../db/store.js';
import { DiggerRentalService } from '../modules/diggerRental/service.js';
import { GameMasterLifecycleService } from '../modules/gameMaster/lifecycle.js';
import { programsFromConfig } from '../modules/indexer/liveReader.js';
import { IndexerProjector } from '../modules/indexer/projector.js';
import { SnapshotReader } from '../modules/indexer/snapshotReader.js';
import { WorldRegistryService } from '../modules/worldRegistry/service.js';
import { createLogger, errorFields } from '../logger.js';

const logger = createLogger('scheduler');

function usage() {
  console.log(`Usage:
  npm run scheduler
  npm run scheduler -- --once

Jobs:
  - world registry sync
  - snapshot projection
  - game master lifecycle
  - digger rental top-up

LP Bonus is intentionally not included.
`);
}

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const config = loadConfig();
  const store = createStore(config);
  const jobs = {
    registry: () => runRegistry({ store, config }),
    snapshot: () => runSnapshot({ store, config }),
    lifecycle: () => runLifecycle({ store, config }),
    rental: () => runRental({ store, config }),
  };

  if (args.once) {
    await runNamed('registry', jobs.registry);
    await runNamed('snapshot', jobs.snapshot);
    await runNamed('lifecycle', jobs.lifecycle);
    await runNamed('rental', jobs.rental);
    return;
  }

  logger.info('started', {
    scheduler: 'started',
    dbFile: config.dbFile,
    intervals: {
      registryMs: config.schedulerRegistryMs,
      snapshotMs: config.schedulerSnapshotMs,
      lifecycleMs: config.schedulerSnapshotMs,
      rentalMs: config.schedulerRentalMs,
    },
  });

  schedule('registry', jobs.registry, config.schedulerRegistryMs);
  schedule('snapshot', jobs.snapshot, config.schedulerSnapshotMs);
  schedule('lifecycle', jobs.lifecycle, config.schedulerSnapshotMs);
  schedule('rental', jobs.rental, config.schedulerRentalMs);
}

function schedule(name, fn, intervalMs) {
  runNamed(name, fn);
  setInterval(() => runNamed(name, fn), intervalMs);
}

async function runNamed(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    logger.info('job.ok', { job: name, status: 'ok', startedAt, finishedAt: new Date().toISOString(), result });
  } catch (error) {
    logger.error('job.failed', {
      job: name,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      ...errorFields(error),
    });
  }
}

async function runRegistry({ store, config }) {
  const manifest = await new WorldRegistryService({ store, config }).syncFromGameMaster();
  return { season: manifest.season?.id, active: manifest.active.length, worlds: manifest.worlds.length };
}

async function runSnapshot({ store, config }) {
  const db = await store.read();
  const worldProgramIds = db.worlds
    .filter((world) => world.programId)
    .map((world) => ({ programType: 'world', programId: world.programId }));
  const indexerConfig = {
    ...config,
    worldProgramIds,
    indexerPrograms: programsFromConfig({ ...config, worldProgramIds }),
  };
  if (indexerConfig.indexerPrograms.length === 0) return { skipped: true, reason: 'no_programs' };

  const reader = new SnapshotReader({ config: indexerConfig });
  const projector = new IndexerProjector({ store, config });
  await reader.connect();
  try {
    const snapshots = await reader.readAll();
    const result = await projector.applySnapshots(snapshots);
    return { snapshots: snapshots.length, applied: result.applied, kinds: snapshots.map((snapshot) => snapshot.kind) };
  } finally {
    await reader.disconnect();
  }
}

async function runLifecycle({ store, config }) {
  const dryRun = !config.adminKey;
  const service = new GameMasterLifecycleService({
    store,
    config,
    logger,
  });
  return service.run({ dryRun });
}

async function runRental({ store, config }) {
  const dryRun = config.diggerRentalMode !== 'live';
  const chain = dryRun ? null : await createVaraEthChain(config);
  try {
    const rental = new DiggerRentalService({ store, chain, config });
    const results = await rental.runDailyTopUp({ dryRun });
    return { mode: dryRun ? 'dry-run' : 'live', selected: results.length, results };
  } finally {
    await chain?.disconnect?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
