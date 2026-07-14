import assert from 'node:assert/strict';
import test from 'node:test';

import { actorIdValueToHex, verifyDiggerReady } from '../src/chain/varaEth.js';

const OWNER = '0x766270abf5dde72d374b3120c8aedc651ee3f184';
const WORLD = '0x936b5395876648772d37e22da57ba37c4e586df2';
const PROGRAM = '0x7777777777777777777777777777777777777777';

const toActor = (address) => `0x${'00'.repeat(12)}${address.slice(2)}`;
const bytesToHex = (value) => `0x${Buffer.from(value).toString('hex')}`;

test('verifyDiggerReady decodes Owner and World queries before declaring a proxy ready', async () => {
  const ownerActor = toActor(OWNER);
  const worldActor = toActor(WORLD);
  const sails = {
    services: {
      Digger: {
        queries: {
          Owner: {
            encodePayload: () => 'owner',
            decodeResult: (payload) => Uint8Array.from(Buffer.from(payload.slice(2), 'hex')),
          },
          World: {
            encodePayload: () => 'world',
            decodeResult: (payload) => Uint8Array.from(Buffer.from(payload.slice(2), 'hex')),
          },
        },
      },
    },
  };
  const api = {
    call: {
      program: {
        async calculateReplyForHandle(_account, programId, payload) {
          assert.equal(programId, PROGRAM);
          const actor = payload === 'owner' ? ownerActor : worldActor;
          return { code: '0x00', payload: actor };
        },
      },
    },
  };

  const ready = await verifyDiggerReady({
    api,
    accountAddress: OWNER,
    programId: PROGRAM,
    owner: OWNER,
    worldId: WORLD,
    sails,
    bytesToHex,
    timeoutMs: 10,
  });

  assert.deepEqual(ready, { programId: PROGRAM, owner: ownerActor, worldId: worldActor });
  assert.equal(actorIdValueToHex(Uint8Array.from(Buffer.from(ownerActor.slice(2), 'hex')), bytesToHex), ownerActor);
});
