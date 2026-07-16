import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { SocialVerifierService } from '../src/modules/socialVerifier/service.js';
import { parseTweetUrl } from '../src/modules/socialVerifier/xService.js';

const VARA = 1_000_000_000_000n;
const OWNER = '0x766270abf5dde72d374b3120c8aedc651ee3f184';
const DIGGER = '0x1111111111111111111111111111111111111111';
const OTHER_DIGGER = '0x2222222222222222222222222222222222222222';

const CONFIG = {
  diggerRentalMode: 'dry-run',
  diggerRentalSeason: 'season-1',
  socialVerifierMode: 'live',
  socialXBearerToken: 'test-token',
  socialXSourceUsername: 'varanetwork',
  socialFuelGrantAmounts: {
    repost: 60n * VARA,
    quote: 120n * VARA,
  },
};

test('social repost verifier creates a dry-run fuel grant for owner digger', async () => {
  const store = new MemoryStore(seedDigger());
  const service = new SocialVerifierService({
    store,
    config: CONFIG,
    xVerifier: new FakeXVerifier('timurmedov'),
    now: fixedNow,
  });

  const result = await service.submitXTask({
    owner: OWNER,
    taskType: 'repost',
    tweetUrl: 'https://x.com/VaraNetwork/status/12345',
    xUsername: '@TimurMedov',
    dryRun: true,
  });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.weekKey, '2026-06-08');
  assert.equal(result.xUsername, 'timurmedov');
  assert.equal(result.amount, (60n * VARA).toString());

  const db = await store.read();
  assert.equal(db.socialRewardSubmissions.length, 1);
  assert.equal(db.fuelGrants.length, 1);
  assert.equal(db.fuelGrants[0].type, 'social-x');
  assert.equal(db.fuelGrants[0].programId, DIGGER);
  assert.equal(db.fuelGrants[0].amount, (60n * VARA).toString());
  assert.equal(db.fuelGrants[0].balanceBefore, null);
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
});

test('social verifier rejects duplicate weekly wallet task', async () => {
  const store = new MemoryStore(seedDigger());
  const service = new SocialVerifierService({
    store,
    config: CONFIG,
    xVerifier: new FakeXVerifier('timurmedov'),
    now: fixedNow,
  });

  await service.submitXTask({
    owner: OWNER,
    taskType: 'repost',
    tweetUrl: 'https://x.com/VaraNetwork/status/12345',
    xUsername: 'timurmedov',
    dryRun: true,
  });

  await assert.rejects(
    () => service.submitXTask({
      owner: OWNER,
      taskType: 'repost',
      tweetUrl: 'https://x.com/VaraNetwork/status/67890',
      xUsername: 'another_user',
      dryRun: true,
    }),
    (error) => error.statusCode === 409 && error.message === 'wallet_already_paid_for_task_this_week',
  );
});

test('social verifier live mode tops up executable balance through chain client', async () => {
  const observedBalance = 33n * VARA;
  const store = new MemoryStore(seedDigger({ executableBalance: '120000000000000' }));
  const calls = [];
  const service = new SocialVerifierService({
    store,
    config: { ...CONFIG, diggerRentalMode: 'live' },
    xVerifier: new FakeXVerifier('timurmedov'),
    now: fixedNow,
    chainFactory: async () => ({
      async readExecutableBalance(programId) {
        calls.push({ type: 'read', programId });
        return observedBalance;
      },
      async topUpExecutableBalance(programId, amount) {
        calls.push({ type: 'top-up', programId, amount });
        return { transactionHash: '0xtx', status: 'success' };
      },
      async disconnect() {},
    }),
  });

  const result = await service.submitXTask({
    owner: OWNER,
    taskType: 'quote',
    tweetUrl: 'https://x.com/timurmedov/status/12345',
    xUsername: 'timurmedov',
  });

  assert.equal(result.status, 'confirmed');
  assert.deepEqual(calls, [
    { type: 'read', programId: DIGGER },
    { type: 'top-up', programId: DIGGER, amount: 120n * VARA },
  ]);

  const db = await store.read();
  assert.equal(Object.hasOwn(db.diggers[0], 'executableBalance'), false);
  assert.equal(db.fuelGrants[0].balanceBefore, observedBalance.toString());
  assert.equal(db.fuelGrants[0].txHash, '0xtx');
});

test('parseTweetUrl accepts x.com status links and extracts username', () => {
  assert.deepEqual(parseTweetUrl('https://x.com/TimurMedov/status/123456789'), {
    tweetId: '123456789',
    username: 'timurmedov',
  });
});

function fixedNow() {
  return new Date('2026-06-11T12:00:00.000Z');
}

function seedDigger(overrides = {}) {
  return {
    diggers: [
      {
        id: DIGGER,
        programId: DIGGER,
        owner: OWNER,
        seasonId: 'season-1',
        status: 'active',
        executableBalance: '0',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
        ...overrides,
      },
      {
        id: OTHER_DIGGER,
        programId: OTHER_DIGGER,
        owner: '0x0000000000000000000000000000000000000001',
        seasonId: 'season-1',
        status: 'active',
        executableBalance: '0',
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      },
    ],
  };
}

class FakeXVerifier {
  constructor(username) {
    this.username = username;
  }

  async fetchTweet(tweetId) {
    return { tweet: { id: tweetId }, includedTweets: [], includedUsers: [] };
  }

  async verifyTask() {
    return this.username;
  }
}

class MemoryStore {
  constructor(initial = {}) {
    this.db = normalizeDb(initial);
  }

  async read() {
    return structuredClone(this.db);
  }

  async update(mutator) {
    const db = await this.read();
    const result = await mutator(db);
    this.db = normalizeDb(db);
    return result;
  }
}
