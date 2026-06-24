import assert from 'node:assert/strict';
import test from 'node:test';

import { createFactory } from '../src/modules/gameMaster/factory/factory.js';
import { WORLD } from '../src/modules/gameMaster/factory/world.js';

test('factory recycles an active world when the contract session is already finished', async () => {
  let now = 1000;
  const liveSnapshots = [];
  let recycled = false;
  const world = makeWorld({
    status: WORLD.ACTIVE,
    programId: '0x7da77d0df757daeb868c7378e8eb1fdd768952ab',
    seed: '177285300',
    mapHash: 'old-map',
    sessionId: 1,
    agents: 3,
    owners: ['0x01', '0x02', '0x03'],
    createdAt: now - 500,
    openedAt: now - 400,
    lastJoinAt: now - 350,
    startedAt: now - 300,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
    eligibleManualStart: false,
    startReason: 'manual',
  });

  const factory = createFactory({
    config: {
      poolSize: 1,
      baseWorlds: 0,
      lobbyMode: true,
      lobbyMin: 1,
      lobbyCap: 10,
      autoStartAtMin: true,
      lobbyTimeoutMs: 0,
      autoStartOnTimeout: false,
      sessionAutofinish: false,
      sessionMs: 30 * 60 * 1000,
      recycle: true,
      pastLimit: 50,
      tickMs: 5,
    },
    clock: () => {
      now += 100;
      return now;
    },
    log: () => {},
    initialLive: [world],
    driver: {
      async pollSession() {
        return { sessionId: 1, seed: 177285300, status: 2, actionSeq: 328 };
      },
      async archiveSnapshot() {
        return { archiveId: 'archive-w003', archiveUrl: '/archives/archive-w003', archivedAt: now };
      },
      async recycle() {
        recycled = true;
        return { seed: '987654321', mapHash: 'fresh-map', sessionId: 2 };
      },
      ensureBalance() {},
    },
    onLive: async (worlds) => {
      liveSnapshots.push(worlds.map((item) => ({ ...item })));
    },
    onPast: async () => {},
  });

  await factory.start();
  await waitFor(() => recycled);
  factory.stop();

  const [current] = factory.worlds();
  assert.equal(current.status, WORLD.OPEN);
  assert.equal(current.sessionId, 2);
  assert.equal(current.mapHash, 'fresh-map');
  assert.equal(current.agents, 0);
  assert.deepEqual(current.owners, []);
  assert.ok(liveSnapshots.some((snapshot) => snapshot.some((item) => item.status === WORLD.FINISHED)));
});

test('factory recycles a finished active world before provisioning a replacement', async () => {
  let now = 2000;
  let recycled = false;
  let provisioned = false;
  const worlds = [
    makeWorld({ id: 'w001', status: WORLD.OPEN, programId: '0x1111111111111111111111111111111111111111' }),
    makeWorld({ id: 'w002', status: WORLD.OPEN, programId: '0x2222222222222222222222222222222222222222' }),
    makeWorld({ id: 'w003', status: WORLD.ACTIVE, programId: '0x3333333333333333333333333333333333333333' }),
  ];

  const factory = createFactory({
    config: {
      poolSize: 6,
      baseWorlds: 3,
      lobbyMode: true,
      lobbyMin: 1,
      lobbyCap: 10,
      autoStartAtMin: true,
      lobbyTimeoutMs: 0,
      autoStartOnTimeout: false,
      sessionAutofinish: false,
      sessionMs: 30 * 60 * 1000,
      recycle: true,
      pastLimit: 50,
      tickMs: 5,
    },
    clock: () => {
      now += 100;
      return now;
    },
    log: () => {},
    initialLive: worlds,
    driver: {
      async pollAgents(world) {
        return world.owners || [];
      },
      async pollSession() {
        return { sessionId: 1, seed: 177285300, status: 2, actionSeq: 328 };
      },
      async archiveSnapshot() {
        return { archiveId: 'archive-w003', archiveUrl: '/archives/archive-w003', archivedAt: now };
      },
      async recycle() {
        recycled = true;
        return { seed: '987654321', mapHash: 'fresh-map', sessionId: 2 };
      },
      async provision() {
        provisioned = true;
        throw new Error('provision should not be called when recycle restores the base worlds');
      },
      ensureBalance() {},
    },
    onLive: async () => {},
    onPast: async () => {},
  });

  await factory.start();
  await waitFor(() => recycled);
  factory.stop();

  assert.equal(provisioned, false);
  assert.equal(factory.worlds().filter((world) => world.status === WORLD.OPEN).length, 3);
  assert.equal(factory.worlds().length, 4); // 3 live worlds + 1 archived snapshot
});

test('factory keeps a base of worlds and grows one-at-a-time only when all are full, capped at poolSize', async () => {
  let now = 1000;
  const config = {
    poolSize: 6,
    baseWorlds: 3,
    lobbyMode: true,
    lobbyMin: 10,
    lobbyCap: 10, // a world auto-starts (→ ACTIVE) the moment its lobby is full
    autoStartAtMin: true,
    lobbyTimeoutMs: 0,
    autoStartOnTimeout: false,
    sessionAutofinish: false,
    sessionMs: 0,
    recycle: true,
    pastLimit: 50,
    tickMs: 5,
  };
  let provisionCount = 0;
  const full = new Set(); // programIds whose lobby reports full → auto-start to ACTIVE
  const factory = createFactory({
    config,
    clock: () => (now += 50),
    log: () => {},
    initialLive: [],
    initialPast: [],
    onLive: async () => {},
    onPast: async () => {},
    driver: {
      async provision() {
        provisionCount += 1;
        return { programId: `0xprog${provisionCount}` };
      },
      async loadMap() {
        return { seed: '1', mapHash: 'h', sessionId: 1 };
      },
      async openLobby() {},
      async start() {},
      async pollAgents(world) {
        return full.has(world.programId)
          ? Array.from({ length: config.lobbyCap }, (_, i) => `0xowner${i}`)
          : [];
      },
      async pollSession() {
        return { sessionId: 1, seed: 1, status: 1, actionSeq: 0 }; // stays ACTIVE, never finishes
      },
      ensureBalance() {},
    },
  });

  const open = () => factory.worlds().filter((w) => w.status === WORLD.OPEN);
  const fillEveryWorld = () => factory.worlds().forEach((w) => w.programId && full.add(w.programId));

  await factory.start();
  try {
    // Base of 3 — and crucially NOT an eager fill to the cap of 6.
    await waitFor(() => open().length === 3);
    await sleep(80);
    assert.equal(provisionCount, 3, 'should stand up exactly the base, never eagerly fill to poolSize');
    assert.equal(open().length, 3);

    // Fill all worlds → all go ACTIVE → no open lobby left → exactly ONE more opens.
    for (const target of [4, 5, 6]) {
      fillEveryWorld();
      await waitFor(() => provisionCount === target);
      await sleep(40);
      assert.equal(provisionCount, target, 'grows one world at a time, not in bursts');
      assert.equal(open().length, 1, 'the freshly opened world is the only open lobby');
    }

    // At the cap: even with every world full, no 7th program is ever created.
    fillEveryWorld();
    await sleep(80);
    assert.equal(provisionCount, 6, 'hard cap at poolSize — no runaway creation');
    assert.equal(factory.worlds().filter((w) => w.status === WORLD.ACTIVE).length, 6);
  } finally {
    factory.stop();
  }
});

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for factory state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeWorld(overrides = {}) {
  return {
    id: 'w003',
    status: WORLD.ACTIVE,
    programId: '0x3333333333333333333333333333333333333333',
    seed: '177285300',
    mapHash: 'old-map',
    sessionId: 1,
    agents: 0,
    owners: [],
    createdAt: 1000,
    openedAt: 1100,
    lastJoinAt: 1100,
    startedAt: 1200,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
    eligibleManualStart: false,
    startReason: null,
    ...overrides,
  };
}
