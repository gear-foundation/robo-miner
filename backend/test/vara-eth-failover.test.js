import assert from 'node:assert/strict';
import test from 'node:test';

import { createFailoverVaraEthProvider } from '../src/chain/varaEth.js';

test('Vara.eth provider switches to the fallback after a primary connection failure', async () => {
  const calls = [];
  class FakeProvider {
    constructor(url) { this.url = url; }
    async connect() {
      calls.push(`connect:${this.url}`);
      if (this.url === 'wss://primary') throw new Error('connection failed');
    }
    async send(method) {
      calls.push(`send:${this.url}:${method}`);
      return 'ok';
    }
    async disconnect() {}
  }

  const provider = createFailoverVaraEthProvider(FakeProvider, ['wss://primary', 'wss://fallback'], {
    requestTimeoutMs: 50,
  });

  assert.equal(await provider.send('state_read', []), 'ok');
  assert.equal(provider.url, 'wss://fallback');
  assert.deepEqual(calls, [
    'connect:wss://primary',
    'connect:wss://fallback',
    'send:wss://fallback:state_read',
  ]);
});

test('Vara.eth provider switches to the fallback after a primary connection timeout', async () => {
  class FakeProvider {
    constructor(url) { this.url = url; }
    async connect() {
      if (this.url === 'wss://primary') await new Promise(() => {});
    }
    async send() { return this.url; }
    async disconnect() {}
  }

  const provider = createFailoverVaraEthProvider(FakeProvider, ['wss://primary', 'wss://fallback'], {
    requestTimeoutMs: 10,
  });

  assert.equal(await provider.send('state_read', []), 'wss://fallback');
  assert.equal(provider.url, 'wss://fallback');
});

test('Vara.eth provider does not hide non-network RPC errors by switching endpoints', async () => {
  const sends = [];
  class FakeProvider {
    constructor(url) { this.url = url; }
    async connect() {}
    async send() {
      sends.push(this.url);
      throw new Error('RpcError(-32602): Invalid params');
    }
    async disconnect() {}
  }

  const provider = createFailoverVaraEthProvider(FakeProvider, ['wss://primary', 'wss://fallback']);

  await assert.rejects(() => provider.send('state_read', []), /Invalid params/);
  assert.deepEqual(sends, ['wss://primary']);
  assert.equal(provider.url, 'wss://primary');
});
