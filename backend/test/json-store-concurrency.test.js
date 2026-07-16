import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/db/jsonStore.js';

test('JsonStore serializes concurrent updates without losing either write', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'robo-miner-json-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(path.join(dir, 'db.json'));

  await Promise.all([
    store.update(async (db) => {
      await new Promise((resolve) => setImmediate(resolve));
      db.jobRuns.push({ id: 'first' });
    }),
    store.update((db) => {
      db.jobRuns.push({ id: 'second' });
    }),
  ]);

  assert.deepEqual((await store.read()).jobRuns.map((run) => run.id), ['first', 'second']);
});

test('a rejected JsonStore update does not poison the update queue', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'robo-miner-json-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(path.join(dir, 'db.json'));

  await assert.rejects(store.update(() => { throw new Error('expected failure'); }), /expected failure/);
  await store.update((db) => { db.jobRuns.push({ id: 'recovered' }); });

  assert.equal((await store.read()).jobRuns[0].id, 'recovered');
});
