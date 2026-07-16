#!/usr/bin/env node

import { createVaraEthChain } from '../chain/varaEth.js';
import { loadConfig } from '../config/index.js';
import { createStore } from '../db/store.js';
import { DiggerRentalService } from '../modules/diggerRental/service.js';
import { GameMasterLifecycleService } from '../modules/gameMaster/lifecycle.js';
import { WorldBalanceService } from '../modules/gameMaster/worldBalance.js';
import { BestStateEventReader } from '../modules/indexer/bestStateReader.js';
import { programsFromConfig } from '../modules/indexer/liveReader.js';
import { IndexerProjector } from '../modules/indexer/projector.js';
import { SnapshotReader } from '../modules/indexer/snapshotReader.js';
import { RedeemPayoutService } from '../modules/redeemPayout/service.js';
import { WorldRegistryService } from '../modules/worldRegistry/service.js';
import { createLogger, errorFields } from '../logger.js';
import { BestStateWatcherSupervisor } from './bestStateWatcherSupervisor.js';
import { SerialJobQueue } from './serialJobQueue.js';

const logger = createLogger('scheduler');

function usage() {
  console.log(`Usage:
  npm run scheduler
  npm run scheduler -- --once

Jobs:
  - world registry sync
  - best-state event projection
  - snapshot projection
  - game master lifecycle
  - world executable balance top-up
  - queued digger rental deploys
  - digger rental top-up
  - backend RES burn and WVARA payout

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
  const bestStateSupervisor = new BestStateWatcherSupervisor({
    startReader: () => startBestStateWatcher({ store, config }),
    logger,
    retryBaseMs: Math.max(1_000, config.wsReconnectDelay || 5_000),
    retryMaxMs: 60_000,
  });
  const jobs = {
    registry: () => runRegistry({ store, config, bestStateSupervisor }),
    snapshot: () => runSnapshot({ store, config }),
    lifecycle: () => runLifecycle({ store, config }),
    worldBalance: () => runWorldBalance({ store, config }),
    rental: () => runRental({ store, config }),
    redeemPayout: () => runRedeemPayout({ store, config }),
  };

  if (args.once) {
    await runNamed('registry', jobs.registry);
    await runNamed('snapshot', jobs.snapshot);
    await runNamed('lifecycle', jobs.lifecycle);
    await runNamed('world-balance', jobs.worldBalance);
    await runNamed('rental', jobs.rental);
    await runNamed('redeem-payout', jobs.redeemPayout);
    return;
  }

  logger.info('started', {
    scheduler: 'started',
    dbFile: config.dbFile,
    intervals: {
      registryMs: config.schedulerRegistryMs,
      bestState: true,
      snapshotMs: config.schedulerSnapshotMs,
      lifecycleMs: config.schedulerSnapshotMs,
      worldBalanceMs: config.balanceCheckMs,
      rentalMs: config.schedulerRentalMs,
      redeemPayoutMs: config.redeemWorkerIntervalMs,
    },
  });

  await runNamed('registry', jobs.registry);
  await bestStateSupervisor.ensureStarted();

  const queue = new SerialJobQueue({
    onSkipped: (name) => logger.warn('job.skipped', { job: name, reason: 'previous_run_still_active_or_queued' }),
  });
  schedule(queue, 'registry', jobs.registry, config.schedulerRegistryMs, false);
  schedule(queue, 'snapshot', jobs.snapshot, config.schedulerSnapshotMs);
  schedule(queue, 'lifecycle', jobs.lifecycle, config.schedulerSnapshotMs);
  schedule(queue, 'world-balance', jobs.worldBalance, config.balanceCheckMs);
  schedule(queue, 'rental', jobs.rental, config.schedulerRentalMs);
  schedule(queue, 'redeem-payout', jobs.redeemPayout, config.redeemWorkerIntervalMs);
}

function schedule(queue, name, fn, intervalMs, immediate = true) {
  const enqueue = () => queue.enqueue(name, () => runNamed(name, fn));
  if (immediate) enqueue();
  setInterval(enqueue, intervalMs);
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

async function runRegistry({ store, config, bestStateSupervisor = null }) {
  const manifest = await new WorldRegistryService({ store, config }).syncFromGameMaster();
  const addedPrograms = bestStateSupervisor
    ? await bestStateSupervisor.addPrograms((await buildIndexerConfig({ store, config })).indexerPrograms)
    : [];
  return {
    season: manifest.season?.id,
    active: manifest.active.length,
    worlds: manifest.worlds.length,
    bestStateProgramsAdded: addedPrograms.length,
  };
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

async function startBestStateWatcher({ store, config }) {
  const indexerConfig = await buildIndexerConfig({ store, config });
  if (indexerConfig.indexerPrograms.length === 0) {
    logger.warn('best_state.skipped', { reason: 'no_programs' });
    return null;
  }

  const projector = new IndexerProjector({ store, config });
  const reader = new BestStateEventReader({
    config: indexerConfig,
    logger,
    onEvents: async (events) => {
      const results = await projector.applyEvents(events);
      logger.info('best_state.events.ok', {
        decodedEvents: events.length,
        applied: results.filter((result) => result.applied).length,
        skipped: results.filter((result) => !result.applied).length,
      });
    },
  });
  await reader.start();
  logger.info('best_state.started', {
    programs: reader.programs.map((program) => ({
      type: program.programType,
      id: program.programId,
    })),
  });
  return reader;
}

async function buildIndexerConfig({ store, config }) {
  const db = await store.read();
  const worldProgramIds = db.worlds
    .filter((world) => world.programId)
    .map((world) => ({ programType: 'world', programId: world.programId }));
  return {
    ...config,
    worldProgramIds,
    indexerPrograms: programsFromConfig({ ...config, worldProgramIds }),
  };
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

async function runWorldBalance({ store, config }) {
  const dryRun = !config.adminKey;
  const chain = dryRun ? null : await createVaraEthChain(config);
  try {
    const service = new WorldBalanceService({ store, chain, config });
    const results = await service.run({ dryRun });
    return { mode: dryRun ? 'dry-run' : 'live', selected: results.length, results };
  } finally {
    await chain?.disconnect?.();
  }
}

async function runRental({ store, config }) {
  const dryRun = config.diggerRentalMode !== 'live';
  const chain = dryRun ? null : await createVaraEthChain(config);
  try {
    const rental = new DiggerRentalService({ store, chain, config });
    const queued = dryRun ? [] : await rental.processQueuedDiggerRequests();
    const results = await rental.runDailyTopUp({ dryRun });
    return {
      mode: dryRun ? 'dry-run' : 'live',
      queued: queued.length,
      queuedResults: queued,
      selected: results.length,
      results,
    };
  } finally {
    await chain?.disconnect?.();
  }
}

async function runRedeemPayout({ store, config }) {
  const service = new RedeemPayoutService({
    store,
    config,
    chainFactory: () => createVaraEthChain({ ...config, adminKey: config.redeemTreasuryKey }, { logger: createLogger('redeem-chain') }),
    logger: createLogger('redeem'),
  });
  return service.processPending();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
