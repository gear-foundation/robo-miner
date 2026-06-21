import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDb } from '../src/db/jsonStore.js';
import { discoveryFromManifest } from '../src/modules/worldRegistry/discovery.js';
import { WorldRegistryService } from '../src/modules/worldRegistry/service.js';

const CONFIG = {
  network: 'hoodi',
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
  assert.equal(discovery.register.network, 'hoodi');
  assert.equal(discovery.sessions.length, 3);
  assert.equal(discovery.matches.length, 1);
  assert.deepEqual(discovery.matches[0], {
    id: 'w001',
    sessionKey: 'w001-s3',
    programId: '0x1111111111111111111111111111111111111111',
    status: 'open',
    phase: 'open',
    joinable: true,
    canRegister: true,
    canPlay: false,
    agents: 2,
    minAgents: 8,
    maxAgents: 10,
    slotsFree: 8,
    owners: ['0xowner'],
    seed: '42',
    mapHash: 'hash',
    sessionId: 3,
    startsAt: null,
    endsAt: null,
    finishedAt: null,
    archivedAt: null,
    archiveId: null,
    archiveUrl: null,
  });
  assert.equal(discovery.sessions[1].status, 'active');
  assert.equal(discovery.sessions[1].phase, 'active');
  assert.equal(discovery.sessions[1].joinable, false);
  assert.equal(discovery.sessions[1].canRegister, false);
  assert.equal(discovery.sessions[1].canPlay, true);
  assert.equal(discovery.sessions[2].status, 'archived');
  assert.equal(discovery.sessions[2].joinable, false);
});

test('world registry seeds configured program ids into discovery when store is empty', async () => {
  const ids = [
    '0xdb0069475ed6d5fc3d9547e467de059a7cafc3ae',
    '0x13bf8eb61a871b60d0d8cc1c3ad4ac8a7a58289d',
    '0xc843a4bc6e64126079a956b4e166bed4ed52875f',
  ];
  const registry = new WorldRegistryService({
    store: new MemoryStore(),
    config: {
      ...CONFIG,
      worldProgramIds: ids,
      sessionMs: 1800000,
      factoryLobbyMin: 8,
      factoryLobbyCap: 10,
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
