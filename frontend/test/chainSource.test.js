import assert from 'node:assert/strict';
import test from 'node:test';

import { ChainSource } from '../src/chain/source.js';

const OWNER = '0x0000000000000000000000001111111111111111';

function sourceForAgentSync({ previousActionSeq, latestActionSeq, lastRealtimeEventAt }) {
  const source = Object.create(ChainSource.prototype);
  source._program = {
    services: {
      World: {
        queries: {
          Agents: { decodeResult: () => [OWNER] },
          AgentOf: { decodeResult: () => [1, 3, 4, 1, 40, 0, 0, 0, 0, 0, 0, 10, latestActionSeq] },
          InventoryOf: { decodeResult: () => [0, 0, 0, 0, 0, 0] },
        },
      },
    },
  };
  source._q = {
    agents: () => 'agents',
    agentOf: () => 'agent-state',
    inventoryOf: () => 'inventory',
  };
  source._call = async (payload) => payload;
  source.s = { miners: [{ owner: OWNER, actionSeq: String(previousActionSeq) }] };
  source._lastRealtimeEventAt = lastRealtimeEventAt;
  source._mergeAgentRows = (rows) => { source.mergedRows = rows; };
  source._requestSnapshotReload = (reason) => { source.snapshotReason = reason; };
  return source;
}

test('chain source reloads the authoritative snapshot after an action arrives without realtime data', async () => {
  const source = sourceForAgentSync({
    previousActionSeq: 7,
    latestActionSeq: 8,
    lastRealtimeEventAt: Date.now() - 15_000,
  });

  await source._refreshAgentStates();

  assert.equal(source.mergedRows.length, 1);
  assert.match(source.snapshotReason, /action advanced without a realtime event/);
});

test('chain source keeps realtime animation when the stream is current', async () => {
  const source = sourceForAgentSync({
    previousActionSeq: 7,
    latestActionSeq: 8,
    lastRealtimeEventAt: Date.now(),
  });

  await source._refreshAgentStates();

  assert.equal(source.snapshotReason, undefined);
});

test('chain source includes the selected agent proxy executable balance in inspection details', async () => {
  const source = Object.create(ChainSource.prototype);
  source._program = {
    services: {
      World: {
        queries: {
          AgentOf: { decodeResult: () => [1, 3, 4, 1, 40, 0, 0, 0, 0, 0, 0, 10, 8] },
          InventoryOf: { decodeResult: () => [0, 0, 0, 0, 0, 0] },
          OwnerOf: { decodeResult: () => OWNER },
        },
      },
    },
  };
  source._q = {
    agentOf: () => 'agent-state',
    inventoryOf: () => 'inventory',
    ownerOf: () => 'owner',
  };
  source._call = async (payload) => payload;
  source._readExecutableBalance = async () => ({
    programId: '0x1111111111111111111111111111111111111111',
    executableBalance: 120_000_000_000_000n,
  });
  source.syncAgentDetail = (_owner, detail) => {
    source.syncedDetail = detail;
    return null;
  };

  const detail = await source.inspectAgent(OWNER);

  assert.equal(detail.proxyProgramId, '0x1111111111111111111111111111111111111111');
  assert.equal(detail.executableBalance, '120000000000000');
  assert.equal(source.syncedDetail.executableBalance, '120000000000000');
});
