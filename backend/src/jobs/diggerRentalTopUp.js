#!/usr/bin/env node

import { loadConfig } from '../config/index.js';
import { createVaraEthChain } from '../chain/varaEth.js';
import { JsonStore } from '../db/jsonStore.js';
import { DiggerRentalService } from '../modules/diggerRental/service.js';
import { createLogger, errorFields } from '../logger.js';

const logger = createLogger('rental-top-up');

function usage() {
  console.log(`Usage:
  npm run rental:top-up
  npm run rental:top-up -- --digger 0x... --assume-balance 0
  npm run rental:top-up -- --live

Options:
  --digger <0x...>          Limit run to one digger program. Can be repeated.
  --assume-balance <value>  Dry-run with a specific current executable balance.
  --dry-run                Do not send chain txs. Default unless DIGGER_RENTAL_MODE=live.
  --live                   Send live top-up txs.
  --help                   Show this help.
`);
}

function parseArgs(argv) {
  const out = { diggers: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--digger':
        out.diggers.push(next());
        break;
      case '--assume-balance':
        out.assumeBalance = next();
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--live':
        out.dryRun = false;
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
  const dryRun = args.dryRun ?? config.diggerRentalMode !== 'live';
  const store = new JsonStore(config.dbFile);
  const chain = dryRun ? null : await createVaraEthChain(config);
  const service = new DiggerRentalService({ store, chain, config, logger });

  try {
    logger.info('run.start', {
      mode: dryRun ? 'dry-run' : 'live',
      target: config.diggerDailyExecTarget.toString(),
      diggers: args.diggers,
      assumeBalance: args.assumeBalance ?? null,
    });
    const results = await service.runDailyTopUp({
      dryRun,
      diggerProgramIds: args.diggers,
      assumeBalance: args.assumeBalance ?? null,
    });

    logger.info('run.ok', {
      mode: dryRun ? 'dry-run' : 'live',
      target: config.diggerDailyExecTarget.toString(),
      dbFile: config.dbFile,
      results,
    });
  } finally {
    await chain?.disconnect?.();
  }
}

main().catch((error) => {
  logger.error('run.failed', errorFields(error));
  process.exit(1);
});
