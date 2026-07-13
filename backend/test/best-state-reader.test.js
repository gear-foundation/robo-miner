import assert from 'node:assert/strict';
import test from 'node:test';
import { BestStateEventReader } from '../src/modules/indexer/bestStateReader.js';
import { decodeProgramEvent } from '../src/modules/indexer/liveReader.js';

test('best-state reader decodes zero-destination program events once', () => {
  const programId = '0x000000000000000000000000000000000000dEaD';
  const reader = new BestStateEventReader({
    config: { rootDir: process.cwd(), varaEthWs: 'ws://example.invalid' },
    programs: [{ programType: 'world', programId }],
  });
  reader.sailsByType.set('world', {
    decodeEvent() {
      return {
        kind: 'event',
        entry: { kind: 'event', service: 'World', event: 'AgentMoved' },
        data: ['7', '0x0000000000000000000000000000000000000001', 1, 2, 1, 3],
      };
    },
  });

  const sub = { program: reader.programs[0] };
  const bestState = { mbHash: '0xabc', messages: [] };
  const message = {
    id: '0xmessage',
    destination: '0x0000000000000000000000000000000000000000',
    payload: [1, 2, 3],
  };

  const event = reader.decodeMessage(sub, message, bestState, 0);
  assert.equal(event.source, 'vara-eth-best-state');
  assert.equal(event.programType, 'world');
  assert.equal(event.programId, programId.toLowerCase());
  assert.equal(event.service, 'World');
  assert.equal(event.event, 'AgentMoved');
  assert.deepEqual(event.args, ['7', '0x0000000000000000000000000000000000000001', 1, 2, 1, 3]);

  assert.equal(reader.decodeMessage(sub, message, bestState, 0), null);
});

test('program event decoder supports sails-js builds without decodeEvent helper', () => {
  const decoded = decodeProgramEvent({
    services: {
      World: {
        events: {
          AgentMoved: {
            decode(payload) {
              assert.equal(payload, '0x010203');
              return ['7', '0xowner', 1, 2, 1, 3];
            },
          },
        },
      },
    },
  }, '0x010203');

  assert.deepEqual(decoded, {
    service: 'World',
    event: 'AgentMoved',
    data: ['7', '0xowner', 1, 2, 1, 3],
  });
});

test('best-state reader subscribes to worlds discovered after startup', async () => {
  const first = '0x0000000000000000000000000000000000000001';
  const second = '0x0000000000000000000000000000000000000002';
  const reader = new BestStateEventReader({
    config: { rootDir: process.cwd(), varaEthWs: 'ws://example.invalid' },
    programs: [{ programType: 'world', programId: first }],
  });
  const started = [];
  reader.started = true;
  reader.loadSails = async () => {};
  reader.startProgram = (program) => started.push(program.programId);

  const added = await reader.addPrograms([
    { programType: 'world', programId: first },
    { programType: 'world', programId: second },
  ]);

  assert.deepEqual(added.map((program) => program.programId), [second]);
  assert.deepEqual(started, [second]);
  assert.equal(reader.programs.length, 2);
});
