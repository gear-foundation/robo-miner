import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_NAME_SPACE, generateAgentName } from '../src/modules/agentNames.js';
import { LeaderboardService } from '../src/modules/leaderboard/service.js';
import { normalizeDb } from '../src/db/jsonStore.js';

test('agent names have a large deterministic two-word namespace', () => {
  const seed = '0x1111111111111111111111111111111111111111';
  const name = generateAgentName(seed);

  assert.ok(AGENT_NAME_SPACE > 100_000);
  assert.equal(name, generateAgentName(seed));
  assert.match(name, /^[A-Z][A-Za-z]+ [A-Z][A-Za-z]+$/);
});

test('leaderboard rows include generated agent names', async () => {
  const ownerActor = '0x0000000000000000000000001111111111111111111111111111111111111111';
  const store = new MemoryStore({
    agentStats: [{
      id: `world:1:${ownerActor}`,
      worldId: 'world',
      sessionId: '1',
      ownerActor,
      seasonId: 'season-1',
      extracted: { scrst: 1, bcrst: 0, hcrst: 0 },
      banked: { scrst: 1, bcrst: 0, hcrst: 0 },
      minted: { scrst: 0, bcrst: 0, hcrst: 0 },
      updatedAt: '2026-06-22T00:00:00.000Z',
    }],
  });

  const rows = await new LeaderboardService({
    store,
    config: { diggerRentalSeason: 'season-1' },
  }).list();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentName, generateAgentName(ownerActor));
});

class MemoryStore {
  constructor(initial = {}) {
    this.db = normalizeDb(initial);
  }

  async read() {
    return structuredClone(this.db);
  }
}
