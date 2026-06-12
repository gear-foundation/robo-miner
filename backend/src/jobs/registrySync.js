#!/usr/bin/env node

import { loadConfig } from '../config/index.js';
import { createStore } from '../db/store.js';
import { WorldRegistryService } from '../modules/worldRegistry/service.js';
import { createLogger, errorFields } from '../logger.js';

const logger = createLogger('registry-sync');

function usage() {
  console.log(`Usage:
  npm run registry:sync
  npm run registry:sync -- --source state/gamemaster.json

Options:
  --source <file>  gamemaster registry file. Default <BACKEND_STATE_DIR>/gamemaster.json.
  --help           Show this help.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case '--source':
        out.source = next();
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
  const service = new WorldRegistryService({
    store: createStore(config),
    config,
  });
  logger.info('run.start', { source: args.source || null, dbFile: config.dbFile });
  const manifest = await service.syncFromGameMaster({ registryFile: args.source || null });
  logger.info('run.ok', {
    dbFile: config.dbFile,
    season: manifest.season,
    active: manifest.active.length,
    past: manifest.past.length,
    worlds: manifest.worlds.length,
  });
}

main().catch((error) => {
  logger.error('run.failed', errorFields(error));
  process.exit(1);
});
