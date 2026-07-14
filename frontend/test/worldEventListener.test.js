import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorldBestStateListener,
  calculateWorldReply,
  ensureVaraEthProviderConnected,
} from '../src/chain/worldEventListener.js';

const PROGRAM_ID = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function programWithEvents() {
  return {
    services: {
      World: {
        events: {
          AgentRegistered: {
            decode: (payload) => {
              if (payload !== 'registered') throw new Error('not registered');
              return [3, OWNER];
            },
          },
          AgentSpawned: {
            decode: (payload) => {
              if (payload !== 'spawned') throw new Error('not spawned');
              return [3, OWNER, 7, 0];
            },
          },
          TileDrilled: {
            decode: (payload) => {
              if (payload !== 'drilled') throw new Error('not drilled');
              return [3, OWNER, 7, 4, 1, 0];
            },
          },
        },
      },
    },
  };
}

function bestState(messages, mbHash = '0xblock') {
  return {
    method: 'program_subscription',
    params: { result: { mbHash, messages } },
  };
}

test('best-state listener reconnects and delivers registration plus digging events once', async () => {
  FakeWebSocket.instances = [];
  const events = [];
  const subscriptions = [];
  const timers = [];
  const listener = new WorldBestStateListener({
    program: programWithEvents(),
    programId: PROGRAM_ID,
    config: { varaEthWs: 'wss://example.test' },
    WebSocketCtor: FakeWebSocket,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (id) => { timers[id].cleared = true; },
    onEvent: (event) => events.push(event),
    onSubscribed: (state) => subscriptions.push(state),
  });

  await listener.start();
  const first = FakeWebSocket.instances[0];
  first.open();
  assert.deepEqual(first.sent, [{ jsonrpc: '2.0', id: 1, method: 'program_subscribeBestState', params: [PROGRAM_ID] }]);
  first.receive({ jsonrpc: '2.0', id: 1, result: 5980674656729392 });

  const messages = [
    { id: 'registered-message', destination: ZERO, payload: 'registered' },
    { id: 'spawned-message', destination: ZERO, payload: 'spawned' },
    { id: 'drilled-message', destination: ZERO, payload: 'drilled' },
  ];
  first.receive(bestState(messages));
  first.receive(bestState(messages));
  assert.deepEqual(events.map((event) => event.type), ['registered', 'spawned', 'dug']);
  assert.deepEqual(subscriptions, [{ reconnected: false }]);

  first.close();
  timers.find((timer) => timer.ms === 1500 && !timer.cleared).fn();
  const second = FakeWebSocket.instances[1];
  second.open();
  second.receive({ jsonrpc: '2.0', id: 2, result: 5980674656729393 });
  assert.deepEqual(subscriptions, [{ reconnected: false }, { reconnected: true }]);
  listener.stop();
});

test('best-state listener reconnects when subscription acknowledgement is missing', async () => {
  FakeWebSocket.instances = [];
  const errors = [];
  const timers = [];
  const listener = new WorldBestStateListener({
    program: programWithEvents(),
    programId: PROGRAM_ID,
    config: { varaEthWs: 'wss://example.test' },
    WebSocketCtor: FakeWebSocket,
    subscriptionAckMs: 10,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (id) => { timers[id].cleared = true; },
    onError: (error) => errors.push(error.message),
  });

  await listener.start();
  const first = FakeWebSocket.instances[0];
  first.open();
  timers.find((timer) => timer.ms === 10 && !timer.cleared).fn();

  assert.equal(first.readyState, FakeWebSocket.CLOSED);
  assert.match(errors[0], /acknowledgement timed out/i);
  assert.equal(timers.some((timer) => timer.ms === 1500 && !timer.cleared), true);
  listener.stop();
});

test('Vara.eth reads wait for a disconnected provider and retry one dropped connection', async () => {
  const provider = {
    connectionState: 'disconnected',
    connectCalls: 0,
    async connect() {
      this.connectCalls += 1;
      this.connectionState = 'connected';
    },
  };
  await ensureVaraEthProviderConnected(provider);
  assert.equal(provider.connectCalls, 1);

  let calls = 0;
  const api = {
    call: {
      program: {
        async calculateReplyForHandle() {
          calls += 1;
          if (calls === 1) {
            provider.connectionState = 'disconnected';
            throw new Error('WebSocket connection closed unexpectedly. Call connect() to reconnect.');
          }
          return { payload: 'ok' };
        },
      },
    },
  };
  const reply = await calculateWorldReply({
    api,
    provider,
    source: ZERO,
    programId: PROGRAM_ID,
    payload: 'payload',
  });
  assert.equal(reply.payload, 'ok');
  assert.equal(calls, 2);
  assert.equal(provider.connectCalls, 2);
});
