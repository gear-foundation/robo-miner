import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { createRegistryPublisher } from '../src/modules/gameMaster/factory/registry.js';
import { discoveryFromManifest } from '../src/modules/worldRegistry/discovery.js';
import { WorldRegistryService } from '../src/modules/worldRegistry/service.js';

const CONFIG = {
  network: 'mainnet',
  routerAddress: '0xrouter',
  varaEthWs: 'wss://vara',
  ethRpc: 'https://eth',
  diggerDailyExecTarget: 120000000000000n,
  diggerRentalSeason: 'season-1',
};

test('world registry manifest becomes agent match discovery feed', () => {
  const discovery = discoveryFromManifest({
    worlds: [
      {
        id: 'w001',
        status: 'waiting_agents',
        programId: '0x1111111111111111111111111111111111111111',
        agents: 2,
        minAgents: 8,
        targetAgents: 10,
        owners: ['0xowner'],
        seed: '42',
        mapHash: 'hash',
        sessionId: 3,
      },
      {
        id: 'w002',
        status: 'active',
        programId: '0x2222222222222222222222222222222222222222',
        agents: 8,
        minAgents: 8,
        targetAgents: 10,
        sessionId: 4,
      },
      {
        id: 'w003',
        status: 'finished',
        programId: '0x3333333333333333333333333333333333333333',
        agents: 10,
        minAgents: 8,
        targetAgents: 10,
        sessionId: 5,
      },
    ],
  }, CONFIG, () => new Date('2026-06-15T00:00:00.000Z'));

  assert.equal(discovery.updatedAt, '2026-06-15T00:00:00.000Z');
  assert.equal(discovery.register.network, 'mainnet');
  assert.equal(discovery.sessions.length, 3);
  assert.equal(discovery.matches.length, 2);
  assert.deepEqual(discovery.matches[0], {
    id: 'w001',
    worldId: 'w001',
    worldNumber: 1,
    worldCode: 'W001',
    worldLabel: 'World W001',
    sessionKey: 'w001-s3',
    programId: '0x1111111111111111111111111111111111111111',
    status: 'open',
    phase: 'open',
    joinable: true,
    canRegister: true,
    canPlay: false,
    agents: 2,
    activeAgents: 2,
    registeredAgents: 2,
    minAgents: 8,
    maxAgents: 10,
    slotsFree: 8,
    owners: ['0xowner'],
    seed: '42',
    mapHash: 'hash',
    sessionId: 3,
    startsAt: null,
    endsAt: null,
    sessionAutofinish: false,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
  });
  assert.equal(discovery.matches[1].id, 'w002');
  assert.equal(discovery.matches[1].worldCode, 'W002');
  assert.equal(discovery.matches[1].worldLabel, 'World W002');
  assert.equal(discovery.matches[1].status, 'active');
  assert.equal(discovery.matches[1].joinable, true);
  assert.equal(discovery.matches[1].canRegister, true);
  assert.equal(discovery.matches[1].canPlay, true);
  assert.equal(discovery.matches[1].slotsFree, 2);
  assert.equal(discovery.sessions[1].status, 'active');
  assert.equal(discovery.sessions[1].phase, 'active');
  assert.equal(discovery.sessions[1].joinable, true);
  assert.equal(discovery.sessions[1].canRegister, true);
  assert.equal(discovery.sessions[1].canPlay, true);
  assert.equal(discovery.sessions[2].status, 'archived');
  assert.equal(discovery.sessions[2].joinable, false);
});

test('world registry resolves duplicate live program ids and reports ties', async () => {
  const registry = new WorldRegistryService({
    store: new MemoryStore(),
    config: CONFIG,
    now: () => new Date('2026-06-15T00:00:00.000Z'),
  });
  await registry.syncWorldRecords([
    { id: 'older', status: 'active', programId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', startsAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z' },
    { id: 'newer', status: 'active', programId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', startsAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-03T00:00:00.000Z' },
    { id: 'tie-a', status: 'active', programId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', startsAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-03T00:00:00.000Z' },
    { id: 'tie-b', status: 'waiting_agents', programId: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', startsAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-03T00:00:00.000Z' },
  ]);
  const manifest = await registry.getManifest();
  assert.deepEqual(manifest.active.map((world) => world.id), ['newer']);
  assert.deepEqual(manifest.worlds.map((world) => world.id), ['newer']);
  assert.deepEqual(manifest.diagnostics.worldProgramCollisions, [
    { programId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resolution: 'kept_newest', keptWorldId: 'newer', droppedWorldIds: ['older'] },
    { programId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', resolution: 'omitted_tie', keptWorldId: null, droppedWorldIds: ['tie-a', 'tie-b'] },
  ]);
});

test('world registry seeds configured program ids into discovery when store is empty', async () => {
  const ids = [
    '0xb0860e1262e3677a65e24f821c8b6e4e5f5cd04b',
    '0xcd8abd56353212b1c7b7107c150fbea366eb8663',
    '0xe3edd24f8a5b123c390052c5177d15f2991db4af',
  ];
  const registry = new WorldRegistryService({
    store: new MemoryStore(),
    config: {
      ...CONFIG,
      worldProgramIds: ids,
      sessionMs: 1800000,
      factoryLobbyMin: 8,
      factoryLobbyCap: 10,
      factorySessionAutofinish: false,
    },
    now: () => new Date('2026-06-15T00:00:00.000Z'),
  });

  const manifest = await registry.getManifest();
  const discovery = discoveryFromManifest(manifest, CONFIG, () => new Date('2026-06-15T00:00:01.000Z'));

  assert.deepEqual(manifest.worlds.map((world) => world.programId), ids);
  assert.equal(manifest.active.length, 3);
  assert.equal(manifest.worlds[0].status, 'waiting_agents');
  assert.equal(discovery.matches.length, 3);
  assert.deepEqual(discovery.matches.map((match) => match.programId), ids);
  assert.equal(discovery.matches[0].status, 'open');
  assert.equal(discovery.matches[0].joinable, true);
  assert.equal(discovery.matches[0].minAgents, 8);
  assert.equal(discovery.matches[0].maxAgents, 10);
});

test('registry sync preserves current-chain counts for the same world session', async () => {
  const programId = '0x1111111111111111111111111111111111111111';
  const registry = new WorldRegistryService({
    store: new MemoryStore({
      worlds: [{
        id: 'w001',
        programId,
        sessionId: '7',
        status: 'active',
        agents: 3,
        activeAgents: 3,
        registeredAgents: 4,
        owners: ['0xa', '0xb', '0xc', '0xd'],
        activeOwners: ['0xa', '0xb', '0xc'],
        chainUpdatedAt: '2026-06-15T00:00:00.000Z',
      }],
    }),
    config: CONFIG,
    now: () => new Date('2026-06-15T00:01:00.000Z'),
  });

  await registry.syncWorldRecords([{
    id: 'w001',
    programId,
    sessionId: 7,
    status: 'waiting_agents',
    admission: { registeredAgents: ['0xa'] },
  }]);

  const manifest = await registry.getManifest();
  const world = manifest.worlds.find((item) => item.id === 'w001');
  assert.equal(world.status, 'active');
  assert.equal(world.agents, 3);
  assert.equal(world.activeAgents, 3);
  assert.equal(world.registeredAgents, 4);
  assert.deepEqual(world.owners, ['0xa', '0xb', '0xc', '0xd']);
});

test('factory publisher preserves session and archive metadata in registry', async () => {
  const store = new MemoryStore();
  const registry = new WorldRegistryService({
    store,
    config: {
      ...CONFIG,
      sessionMs: 1800000,
      factoryLobbyMin: 1,
      factoryLobbyCap: 10,
      factorySessionAutofinish: false,
    },
    now: () => new Date('2026-06-23T13:00:00.000Z'),
  });
  const publisher = createRegistryPublisher({
    cfg: {
      lobbyMin: 1,
      lobbyCap: 10,
      sessionMs: 1800000,
      sessionAutofinish: false,
    },
    env: {
      adminKey: '0xadmin',
      network: 'mainnet',
      router: '0xrouter',
    },
    now: () => Date.parse('2026-06-23T13:00:00.000Z'),
    worldRegistry: registry,
  });

  await publisher.publish([
    {
      id: 'w001',
      status: 'open',
      programId: '0x1111111111111111111111111111111111111111',
      seed: '42',
      mapHash: 'hash',
      sessionId: 6,
      agents: 0,
      owners: [],
      createdAt: Date.parse('2026-06-23T12:00:00.000Z'),
      openedAt: Date.parse('2026-06-23T12:30:00.000Z'),
    },
    {
      id: 'w001',
      status: 'archived',
      programId: '0x1111111111111111111111111111111111111111',
      seed: '41',
      mapHash: 'old-hash',
      sessionId: 5,
      agents: 3,
      owners: ['0xowner'],
      createdAt: Date.parse('2026-06-23T11:00:00.000Z'),
      openedAt: Date.parse('2026-06-23T11:05:00.000Z'),
      startedAt: Date.parse('2026-06-23T11:10:00.000Z'),
      finishedAt: Date.parse('2026-06-23T11:40:00.000Z'),
      archivedAt: Date.parse('2026-06-23T11:41:00.000Z'),
      archiveId: 'w001-s5',
      archiveUrl: '/archives/w001-s5',
    },
  ]);

  const manifest = await registry.getManifest();
  const live = manifest.active.find((world) => world.id === 'w001');
  const archived = manifest.past.find((world) => world.id === 'w001-s5');

  assert.equal(live.sessionId, 6);
  assert.equal(manifest.active.length, 1);
  assert.equal(live.minAgents, 1);
  assert.equal(live.sessionAutofinish, false);
  assert.equal(archived.worldId, 'w001');
  assert.equal(archived.sessionId, 5);
  assert.equal(archived.archiveId, 'w001-s5');
  assert.equal(archived.archiveUrl, '/archives/w001-s5');
  assert.equal(archived.archivedAt, '2026-06-23T11:41:00.000Z');
});

test('factory publisher gives stale archived worlds a non-colliding archive id', async () => {
  const store = new MemoryStore();
  const registry = new WorldRegistryService({
    store,
    config: {
      ...CONFIG,
      sessionMs: 1800000,
      factoryLobbyMin: 1,
      factoryLobbyCap: 10,
      factorySessionAutofinish: false,
    },
    now: () => new Date('2026-06-23T13:00:00.000Z'),
  });
  const publisher = createRegistryPublisher({
    cfg: {
      lobbyMin: 1,
      lobbyCap: 10,
      sessionMs: 1800000,
      sessionAutofinish: false,
    },
    env: {
      adminKey: '0xadmin',
      network: 'mainnet',
      router: '0xrouter',
    },
    now: () => Date.parse('2026-06-23T13:00:00.000Z'),
    worldRegistry: registry,
  });

  await publisher.publish([
    {
      id: 'w001',
      status: 'open',
      programId: '0x1111111111111111111111111111111111111111',
      seed: '42',
      mapHash: 'hash',
      sessionId: 2,
      agents: 0,
      owners: [],
      createdAt: Date.parse('2026-06-23T12:00:00.000Z'),
      openedAt: Date.parse('2026-06-23T12:30:00.000Z'),
    },
    {
      id: 'w001',
      status: 'archived',
      programId: '0x1111111111111111111111111111111111111111',
      seed: '41',
      mapHash: 'old-hash',
      sessionId: 1,
      agents: 10,
      owners: ['0xowner'],
      createdAt: Date.parse('2026-06-23T11:00:00.000Z'),
      openedAt: Date.parse('2026-06-23T11:05:00.000Z'),
      startedAt: Date.parse('2026-06-23T11:10:00.000Z'),
      finishedAt: Date.parse('2026-06-23T11:40:00.000Z'),
      archivedAt: Date.parse('2026-06-23T11:41:00.000Z'),
      archiveId: null,
      archiveUrl: null,
    },
  ]);

  const manifest = await registry.getManifest();
  const live = manifest.active.find((world) => world.id === 'w001');
  const archived = manifest.past.find((world) => world.id === 'w001-s1');

  assert.equal(manifest.active.length, 1);
  assert.equal(manifest.past.length, 1);
  assert.equal(live.status, 'waiting_agents');
  assert.equal(live.sessionId, 2);
  assert.equal(archived.worldId, 'w001');
  assert.equal(archived.archiveId, 'w001-s1');
  assert.equal(archived.archiveUrl, '/archives/w001-s1');
  assert.equal(archived.sessionId, 1);
});

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
