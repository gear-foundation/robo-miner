#!/usr/bin/env node
// World factory (registrar).
//
//   node src/factory/index.js                 # fast dry-run demo (~25s, no chain)
//   node src/factory/index.js --duration 0    # dry-run forever (Ctrl-C to stop)
//   node src/factory/index.js --real-timers   # dry-run with real 5min / 30min timers
//   node src/factory/index.js --chain         # LIVE: deploy + run worlds on testnet
//
// Chain mode needs DIGGER_ADMIN_KEY (+ funded WVARA) in the env / operator/.env.
// The factory state machine is identical in both modes — only the driver differs.

import { loadConfig, loadChainEnv } from './config.js';
import { createFactory } from './factory.js';
import { createDryRunDriver } from './drivers/dryRunDriver.js';
import { createRegistryPublisher } from './registry.js';

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

if (useChain) {
  // Live: the contract owns cap=10 auto-start; we own provisioning, the pool,
  // the ≥1-open invariant, and the >=8 manual/idle start.
  config = loadConfig({ lobbyMode: true });
  chainEnv = loadChainEnv();
  const { createChainDriver } = await import('./drivers/chainDriver.js');
  driver = await createChainDriver({ env: chainEnv });
} else {
  config = loadConfig(
    realTimers
      ? {}
      : {
          // compressed demo timers so a full lobby→run→recycle cycle shows in seconds
          lobbyTimeoutMs: Number(process.env.FACTORY_LOBBY_TIMEOUT_MS) || 4000,
          sessionMs: Number(process.env.SESSION_MS) || 8000,
          tickMs: 400,
          poolSize: Number(process.env.FACTORY_POOL_SIZE) || 3,
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
});
console.log(`[factory] publishing worlds → ${publisher.file} (World Registry reads this)`);

const factory = createFactory({ driver, config, publish: publisher.publish });

process.on('SIGINT', () => {
  factory.stop();
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
