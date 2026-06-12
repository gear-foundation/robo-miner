#!/usr/bin/env node

import { loadConfig } from '../config/index.js';
import { JsonStore } from '../db/jsonStore.js';
import { PostgresStore } from '../db/postgresStore.js';
import { createLogger, errorFields } from '../logger.js';

const logger = createLogger('db-migrate');

function usage() {
  console.log(`Usage:
  DATABASE_URL=postgres://... npm run db:migrate-json-to-postgres
  npm run db:migrate-json-to-postgres -- --source state/backend.json

Options:
  --source <file>  Source JSON DB file. Default BACKEND_DB_FILE.
  --force          Overwrite the Postgres document even when it already has data.
`);
}

function parseArgs(argv) {
  const out = { force: false };
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
      case '--force':
        out.force = true;
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
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');

  const source = new JsonStore(args.source || config.dbFile);
  const target = new PostgresStore({
    connectionString: config.databaseUrl,
    documentId: config.databaseDocumentId,
    schema: config.databaseSchema,
  });

  const [sourceDb, targetDb] = await Promise.all([source.read(), target.read()]);
  const targetHasData = [
    'seasons',
    'worlds',
    'diggers',
    'rentalRequests',
    'fuelGrants',
    'socialRewardSubmissions',
    'chainEvents',
    'agentStats',
    'economyStats',
    'jobRuns',
  ].some((key) => targetDb[key]?.length > 0);

  if (targetHasData && !args.force) {
    throw new Error('Postgres document already has data; pass --force to overwrite it');
  }

  await target.write(sourceDb);
  logger.info('migrate.ok', {
    source: args.source || config.dbFile,
    documentId: config.databaseDocumentId,
    counts: Object.fromEntries(Object.entries(sourceDb).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
  });
}

main().catch((error) => {
  logger.error('migrate.failed', errorFields(error));
  process.exit(1);
});
