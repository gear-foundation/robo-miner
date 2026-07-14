import assert from 'node:assert/strict';
import test from 'node:test';
import { BestStateWatcherSupervisor } from '../src/jobs/bestStateWatcherSupervisor.js';

test('best-state supervisor retries an initial startup failure and avoids duplicate starts', async () => {
  const timers = [];
  const logs = [];
  const reader = {
    programs: [{ programType: 'world', programId: '0x1' }],
    subscriptions: new Map([['world:0x1', {}]]),
    async addPrograms(programs) { return programs; },
  };
  let starts = 0;
  const supervisor = new BestStateWatcherSupervisor({
    startReader: async () => {
      starts += 1;
      if (starts === 1) throw new Error('temporary startup failure');
      return reader;
    },
    retryBaseMs: 10,
    retryMaxMs: 40,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, fields) => logs.push({ level: 'error', event, fields }),
    },
  });

  const first = await supervisor.ensureStarted();
  assert.equal(first, null);
  assert.equal(starts, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 10);

  timers.shift().callback();
  const [second, same] = await Promise.all([
    supervisor.ensureStarted(),
    supervisor.ensureStarted(),
  ]);

  assert.equal(second, reader);
  assert.equal(same, reader);
  assert.equal(starts, 2);
  assert.equal(supervisor.reader, reader);
  assert.ok(logs.some((entry) => entry.event === 'best_state.start.failed'));
  assert.ok(logs.some((entry) => entry.event === 'best_state.start.retry_scheduled'));
  assert.ok(logs.some((entry) => entry.event === 'best_state.supervisor.ready'));
});

test('best-state supervisor caps exponential retry delay', async () => {
  const delays = [];
  const callbacks = [];
  const supervisor = new BestStateWatcherSupervisor({
    startReader: async () => { throw new Error('still unavailable'); },
    retryBaseMs: 10,
    retryMaxMs: 20,
    setTimer: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return { callback };
    },
    clearTimer: () => {},
  });

  await supervisor.ensureStarted();
  callbacks.shift()();
  await supervisor.starting;
  callbacks.shift()();
  await supervisor.starting;

  assert.deepEqual(delays, [10, 20, 20]);
  await supervisor.stop();
});
