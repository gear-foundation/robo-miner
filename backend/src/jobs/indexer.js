#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config/index.js';
import { JsonStore } from '../db/jsonStore.js';
import { loadContractIdls } from '../modules/indexer/idlRegistry.js';
import { programsFromConfig, VaraEthLiveReader } from '../modules/indexer/liveReader.js';
import { IndexerProjector } from '../modules/indexer/projector.js';
import { InjectedIngestService } from '../modules/indexer/injectedIngest.js';
import { SnapshotReader } from '../modules/indexer/snapshotReader.js';
import { createLogger, errorFields } from '../logger.js';

const logger = createLogger('indexer');

function usage() {
  console.log(`Usage:
  npm run indexer -- inspect-idl
  npm run indexer -- apply-events --file events.json
  npm run indexer -- ingest-injected --file injected-result.json
  npm run indexer -- live-once
  npm run indexer -- watch
  npm run indexer -- snapshot-once
  npm run indexer -- snapshot-watch

Commands:
  inspect-idl   Print services, events, and functions from generated contract IDLs.
  apply-events  Apply normalized events to backend DB.
  ingest-injected
                Apply frontend/agent submitted injected watch result.
  live-once     Read latest Vara.eth block outcome, decode configured program events, apply them.
  watch         Poll latest Vara.eth block and apply new configured program events.
  snapshot-once Read current contract state through Sails queries and apply projections.
  snapshot-watch
                Poll snapshots through Sails queries. Fallback for RPCs without block_outcome.

Normalized event shape:
  {
    "programType": "world|proxy|resVmt|redeem",
    "programId": "0x...",
    "service": "World",
    "event": "ResourceExtracted",
    "args": ["1", "0x0000...", 10, 12, 0, 3],
    "blockHash": "0x...",
    "messageId": "0x..."
  }
`);
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'inspect-idl' };
  const args = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`${arg} requires a value`);
      return args[i];
    };
    switch (arg) {
      case '--file':
        out.file = next();
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const config = loadConfig();
  switch (args.command) {
    case 'inspect-idl':
      console.log(JSON.stringify(await loadContractIdls(config.rootDir), null, 2));
      break;
    case 'apply-events': {
      if (!args.file) throw new Error('apply-events requires --file events.json');
      const events = JSON.parse(await readFile(args.file, 'utf8'));
      logger.info('apply_events.start', { file: args.file, count: Array.isArray(events) ? events.length : 1 });
      const projector = new IndexerProjector({
        store: new JsonStore(config.dbFile),
        config,
      });
      const results = await projector.applyEvents(Array.isArray(events) ? events : [events]);
      logger.info('apply_events.ok', { dbFile: config.dbFile, results });
      break;
    }
    case 'ingest-injected': {
      if (!args.file) throw new Error('ingest-injected requires --file injected-result.json');
      const payload = JSON.parse(await readFile(args.file, 'utf8'));
      logger.info('ingest_injected.start', { file: args.file });
      const service = new InjectedIngestService({
        store: new JsonStore(config.dbFile),
        config,
      });
      logger.info('ingest_injected.ok', { dbFile: config.dbFile, result: await service.ingest(payload) });
      break;
    }
    case 'live-once':
      await runLiveOnce(config);
      break;
    case 'watch':
      await runWatch(config);
      break;
    case 'snapshot-once':
      await runSnapshotOnce(config);
      break;
    case 'snapshot-watch':
      await runSnapshotWatch(config);
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function runSnapshotOnce(config) {
  const store = new JsonStore(config.dbFile);
  const reader = new SnapshotReader({ config: await addDbPrograms(config, store) });
  const projector = new IndexerProjector({ store, config });
  await reader.connect();
  try {
    const snapshots = await reader.readAll();
    const result = await projector.applySnapshots(snapshots);
    logger.info('snapshot.once.ok', {
      dbFile: config.dbFile,
      snapshots: snapshots.length,
      applied: result.applied,
      kinds: snapshots.map((snapshot) => snapshot.kind),
    });
  } finally {
    await reader.disconnect();
  }
}

async function runSnapshotWatch(config) {
  const store = new JsonStore(config.dbFile);
  const reader = new SnapshotReader({ config: await addDbPrograms(config, store) });
  const projector = new IndexerProjector({ store, config });
  await reader.connect();
  try {
    for (;;) {
      const snapshots = await reader.readAll();
      const result = await projector.applySnapshots(snapshots);
      logger.info('snapshot.watch.ok', {
        capturedAt: new Date().toISOString(),
        snapshots: snapshots.length,
        applied: result.applied,
        kinds: snapshots.map((snapshot) => snapshot.kind),
      });
      await sleep(config.indexerPollMs);
    }
  } finally {
    await reader.disconnect();
  }
}

async function runLiveOnce(config) {
  const store = new JsonStore(config.dbFile);
  const reader = new VaraEthLiveReader({ config: await addDbPrograms(config, store) });
  const projector = new IndexerProjector({ store, config });
  await reader.connect();
  try {
    const block = await reader.readBlock();
    const results = await projector.applyEvents(block.events);
    logger.info('live.once.ok', {
      dbFile: config.dbFile,
      block: block.block,
      outcomeError: block.outcomeError,
      decodedEvents: block.events.length,
      applied: results.filter((result) => result.applied).length,
      skipped: results.filter((result) => !result.applied).length,
    });
  } finally {
    await reader.disconnect();
  }
}

async function runWatch(config) {
  const store = new JsonStore(config.dbFile);
  const reader = new VaraEthLiveReader({ config: await addDbPrograms(config, store) });
  const projector = new IndexerProjector({ store, config });
  let lastHash = null;
  await reader.connect();
  try {
    for (;;) {
      const header = await reader.latestHeader();
      if (header.hash !== lastHash) {
        lastHash = header.hash;
        const block = await reader.readBlock(header.hash);
        const results = await projector.applyEvents(block.events);
        if (block.events.length > 0) {
          logger.info('live.watch.ok', {
            block: block.block,
            outcomeError: block.outcomeError,
            decodedEvents: block.events.length,
            applied: results.filter((result) => result.applied).length,
            skipped: results.filter((result) => !result.applied).length,
          });
        }
      }
      await sleep(config.indexerPollMs);
    }
  } finally {
    await reader.disconnect();
  }
}

async function addDbPrograms(config, store) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  logger.error('run.failed', errorFields(error));
  process.exit(1);
});
