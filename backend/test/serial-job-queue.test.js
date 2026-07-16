import assert from 'node:assert/strict';
import test from 'node:test';

import { SerialJobQueue } from '../src/jobs/serialJobQueue.js';

test('SerialJobQueue runs different scheduler jobs sequentially', async () => {
  const events = [];
  let finishFirst;
  const firstBlocked = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const queue = new SerialJobQueue();

  queue.enqueue('snapshot', async () => {
    events.push('snapshot:start');
    await firstBlocked;
    events.push('snapshot:end');
  });
  queue.enqueue('redeem', async () => {
    events.push('redeem:start');
    events.push('redeem:end');
  });

  await Promise.resolve();
  assert.deepEqual(events, ['snapshot:start']);
  finishFirst();
  await queue.idle();
  assert.deepEqual(events, ['snapshot:start', 'snapshot:end', 'redeem:start', 'redeem:end']);
});

test('SerialJobQueue coalesces a duplicate tick while that job is running or queued', async () => {
  const skipped = [];
  let finish;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  let executions = 0;
  const queue = new SerialJobQueue({ onSkipped: (name) => skipped.push(name) });
  const job = async () => {
    executions += 1;
    await blocked;
  };

  assert.equal(queue.enqueue('snapshot', job), true);
  assert.equal(queue.enqueue('snapshot', job), false);
  await Promise.resolve();
  assert.equal(queue.enqueue('snapshot', job), false);
  assert.deepEqual(skipped, ['snapshot', 'snapshot']);

  finish();
  await queue.idle();
  assert.equal(executions, 1);
});
