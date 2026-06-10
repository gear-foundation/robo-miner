#!/usr/bin/env node

import { loadConfig } from '../config/index.js';
import { JsonStore } from '../db/jsonStore.js';
import { DiggerRegistryService } from '../modules/diggerRegistry/service.js';

function usage() {
  console.log(`Usage:
  npm run digger:registry -- sync-env
  npm run digger:registry -- register --program 0x... [--owner 0x...] [--world world-id] [--season season-1]
  npm run digger:registry -- list [--season season-1] [--world world-id] [--owner 0x...] [--status active]

Commands:
  sync-env  Register comma-separated DIGGER_PROGRAM_IDS from .env.
  register  Register or update one digger record.
  list      Print digger records from backend DB.
`);
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'list' };
  const args = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`${arg} requires a value`);
      return args[i];
    };
    switch (arg) {
      case '--program':
        out.programId = next();
        break;
      case '--owner':
        out.owner = next();
        break;
      case '--world':
        out.worldId = next();
        break;
      case '--season':
        out.seasonId = next();
        break;
      case '--status':
        out.status = next();
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
  const service = new DiggerRegistryService({
    store: new JsonStore(config.dbFile),
    config,
  });

  switch (args.command) {
    case 'sync-env':
      console.log(JSON.stringify({ dbFile: config.dbFile, diggers: await service.syncFromConfig() }, null, 2));
      break;
    case 'register':
      if (!args.programId) throw new Error('register requires --program 0x...');
      console.log(JSON.stringify({
        dbFile: config.dbFile,
        digger: await service.register({
          programId: args.programId,
          owner: args.owner || null,
          worldId: args.worldId || null,
          seasonId: args.seasonId || null,
          status: args.status || 'active',
        }),
      }, null, 2));
      break;
    case 'list':
      console.log(JSON.stringify({
        dbFile: config.dbFile,
        diggers: await service.list({
          seasonId: args.seasonId || null,
          worldId: args.worldId || null,
          owner: args.owner || null,
          status: args.status || null,
        }),
      }, null, 2));
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
