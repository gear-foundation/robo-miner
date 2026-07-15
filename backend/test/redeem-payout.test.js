import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { RedeemPayoutService, typedData } from '../src/modules/redeemPayout/service.js';

const OWNER_KEY = '0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a8412f4603b6b78690d';
const REDEEM = '0x1111111111111111111111111111111111111111';
const VMT = '0x2222222222222222222222222222222222222222';

test('signed redeem burns RES once and pays WVARA once', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const calls = { burn: 0, transfer: 0 };
  let ownerBalance = 7n;
  const config = testConfig();
  const chain = {
    account: '0x3333333333333333333333333333333333333333',
    async readRedeemConfig() { return onChainConfig(config); },
    async readResBalances() { return { scrst: 10n, bcrst: 10n, hcrst: 10n }; },
    async readWvaraBalance(address) { return address === this.account ? 10_000n : ownerBalance; },
    async requestBackendRedeem(args) {
      calls.burn += 1;
      assert.equal(args.requestId.length, 66);
      return { status: 2n, txHash: '0xburn' };
    },
    async transferWvara(_owner, value) {
      calls.transfer += 1;
      ownerBalance += value;
      return { txHash: '0xpay' };
    },
    async disconnect() {},
  };
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const intent = {
    owner: account.address,
    scrst: 2n,
    bcrst: 1n,
    hcrst: 0n,
    minPayout: 50n,
    nonce: `0x${'ab'.repeat(32)}`,
    deadline: 1_300n,
  };
  const signature = await account.signTypedData(typedData(config, intent));
  const queued = await service.submit({ ...intent, signature });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.payout, '50');

  const confirmed = await service.processRequest(queued.requestId);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.burnTxHash, '0xburn');
  assert.equal(confirmed.payoutTxHash, '0xpay');
  assert.equal(calls.burn, 1);
  assert.equal(calls.transfer, 1);

  const duplicate = await service.submit({ ...intent, signature });
  assert.equal(duplicate.requestId, queued.requestId);
  const skipped = await service.processRequest(queued.requestId);
  assert.equal(skipped.skipped, true);
  assert.equal(calls.burn, 1);
  assert.equal(calls.transfer, 1);
});

test('invalid signature is rejected before persistence', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  const intent = {
    owner: '0x4444444444444444444444444444444444444444',
    scrst: 1n,
    bcrst: 0n,
    hcrst: 0n,
    minPayout: 10n,
    nonce: `0x${'cd'.repeat(32)}`,
    deadline: 1_300n,
  };
  const signature = await account.signTypedData(typedData(config, intent));
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => null, now: () => 1_000_000 });
  await assert.rejects(service.submit({ ...intent, signature }), /invalid redeem intent signature/);
  assert.equal((await store.read()).redeemPayouts.length, 0);
});

test('payout failure after burn retries payout without a second burn', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let transferAttempts = 0;
  let burnAttempts = 0;
  let ownerBalance = 0n;
  const chain = {
    account: '0x3333333333333333333333333333333333333333',
    async readRedeemConfig() { return onChainConfig(config); },
    async readResBalances() { return { scrst: 5n, bcrst: 0n, hcrst: 0n }; },
    async readWvaraBalance(address) { return address === this.account ? 10_000n : ownerBalance; },
    async requestBackendRedeem() { burnAttempts += 1; return { status: 2n, txHash: '0xburn' }; },
    async transferWvara(_owner, value) {
      transferAttempts += 1;
      if (transferAttempts === 1) throw new Error('temporary rpc failure');
      ownerBalance += value;
      return { txHash: '0xretry' };
    },
    async disconnect() {},
  };
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const intent = {
    owner: account.address,
    scrst: 1n,
    bcrst: 0n,
    hcrst: 0n,
    minPayout: 10n,
    nonce: `0x${'ef'.repeat(32)}`,
    deadline: 1_300n,
  };
  const signature = await account.signTypedData(typedData(config, intent));
  const queued = await service.submit({ ...intent, signature });
  assert.equal((await service.processRequest(queued.requestId)).status, 'payout_failed');
  assert.equal((await service.processRequest(queued.requestId)).status, 'confirmed');
  assert.equal(burnAttempts, 1);
  assert.equal(transferAttempts, 2);
});

test('broadcast payout hash is resumed by receipt without a duplicate transfer', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let transfers = 0;
  const chain = {
    account: '0x3333333333333333333333333333333333333333',
    async readRedeemConfig() { return onChainConfig(config); },
    async readResBalances() { return { scrst: 5n, bcrst: 0n, hcrst: 0n }; },
    async readWvaraBalance(address) { return address === this.account ? 10_000n : 0n; },
    async requestBackendRedeem() { return { status: 2n, txHash: '0xburn' }; },
    async transferWvara(_owner, _value, { onBroadcast }) {
      transfers += 1;
      await onBroadcast(`0x${'12'.repeat(32)}`);
      throw new Error('receipt rpc disconnected');
    },
    async readTransactionReceipt() { return { status: 'success' }; },
    async disconnect() {},
  };
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const intent = {
    owner: account.address,
    scrst: 1n,
    bcrst: 0n,
    hcrst: 0n,
    minPayout: 10n,
    nonce: `0x${'34'.repeat(32)}`,
    deadline: 1_300n,
  };
  const signature = await account.signTypedData(typedData(config, intent));
  const queued = await service.submit({ ...intent, signature });
  const pending = await service.processRequest(queued.requestId);
  assert.equal(pending.status, 'payout_failed');
  assert.equal(pending.payoutTxHash, `0x${'12'.repeat(32)}`);
  const confirmed = await service.processRequest(queued.requestId);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(transfers, 1);
});

test('minimum payout is signature-bound and protects the user from a lower rate', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => null, now: () => 1_000_000 });
  const intent = makeIntent(account.address, { minPayout: 11n, nonce: hex32('41') });
  const signature = await account.signTypedData(typedData(config, intent));

  await assert.rejects(service.submit({ ...intent, signature }), /below signed minimum/);
  await assert.rejects(service.submit({ ...intent, minPayout: 10n, signature }), /invalid redeem intent signature/);
  assert.equal((await store.read()).redeemPayouts.length, 0);
});

test('a nonce is idempotent for the same intent but cannot authorize another amount', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => null, now: () => 1_000_000 });
  const nonce = hex32('42');
  const firstIntent = makeIntent(account.address, { nonce });
  const firstSignature = await account.signTypedData(typedData(config, firstIntent));
  const first = await service.submit({ ...firstIntent, signature: firstSignature });
  assert.equal((await service.submit({ ...firstIntent, signature: firstSignature })).requestId, first.requestId);

  const conflictingIntent = makeIntent(account.address, { nonce, scrst: 2n, minPayout: 20n });
  const conflictingSignature = await account.signTypedData(typedData(config, conflictingIntent));
  await assert.rejects(
    service.submit({ ...conflictingIntent, signature: conflictingSignature }),
    (error) => error.statusCode === 409 && /nonce was already used/.test(error.message),
  );
});

test('expired and overlong intents are rejected, including expiry while queued', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let now = 1_000_000;
  let chainCalls = 0;
  const service = new RedeemPayoutService({
    store,
    config,
    chainFactory: async () => { chainCalls += 1; return { async disconnect() {} }; },
    now: () => now,
  });
  for (const [deadline, message] of [[1_000n, /expired/], [1_601n, /too far/]]) {
    const intent = makeIntent(account.address, { deadline, nonce: hex32(String(deadline)) });
    const signature = await account.signTypedData(typedData(config, intent));
    await assert.rejects(service.submit({ ...intent, signature }), message);
  }

  const queuedIntent = makeIntent(account.address, { deadline: 1_001n, nonce: hex32('43') });
  const queuedSignature = await account.signTypedData(typedData(config, queuedIntent));
  const queued = await service.submit({ ...queuedIntent, signature: queuedSignature });
  now = 1_002_000;
  const failed = await service.processRequest(queued.requestId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /expired before burn/);
  assert.equal(chainCalls, 0);
});

test('a crash after the on-chain burn resumes from burning without rechecking spent RES', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let resReads = 0;
  let burnRequests = 0;
  let transferCalls = 0;
  let ownerBalance = 0n;
  let burnedOnChain = false;
  const chain = standardChain(config, {
    async readResBalances() {
      resReads += 1;
      return { scrst: burnedOnChain ? 0n : 1n, bcrst: 0n, hcrst: 0n };
    },
    async requestBackendRedeem() {
      burnRequests += 1;
      if (!burnedOnChain) {
        burnedOnChain = true;
        throw new Error('rpc disconnected after burn receipt');
      }
      return { status: 2n, txHash: '0xrecovered-burn' };
    },
    async readWvaraBalance(address) { return address === this.account ? 10_000n : ownerBalance; },
    async transferWvara(_owner, value) { transferCalls += 1; ownerBalance += value; return { txHash: '0xrecovered-pay' }; },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('44') });

  assert.equal((await service.processRequest(queued.requestId)).status, 'burning');
  const recovered = await service.processRequest(queued.requestId);
  assert.equal(recovered.status, 'confirmed');
  assert.equal(resReads, 1);
  assert.equal(burnRequests, 2);
  assert.equal(transferCalls, 1);
});

test('uncertain burn is never made terminal by retry exhaustion', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = { ...testConfig(), redeemMaxAttempts: 1 };
  const chain = standardChain(config, {
    async requestBackendRedeem() { throw new Error('rpc unavailable'); },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('45') });
  assert.equal((await service.processRequest(queued.requestId)).status, 'burning');
  assert.equal((await service.processRequest(queued.requestId)).status, 'burning');
});

test('preflight blocks burn for insufficient RES, treasury, or mismatched contract rates', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  for (const scenario of ['res', 'treasury', 'rates']) {
    const store = memoryStore();
    const config = testConfig();
    let burns = 0;
    const chain = standardChain(config, {
      async readResBalances() { return scenario === 'res' ? { scrst: 0n, bcrst: 0n, hcrst: 0n } : { scrst: 1n, bcrst: 0n, hcrst: 0n }; },
      async readWvaraBalance(address) { return address === this.account && scenario === 'treasury' ? 0n : 10_000n; },
      async readRedeemConfig() {
        return scenario === 'rates'
          ? { varaUnit: 1n, rates: { scrst: 9n, bcrst: 30n, hcrst: 150n } }
          : onChainConfig(config);
      },
      async requestBackendRedeem() { burns += 1; return { status: 2n }; },
    });
    const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
    const queued = await signedSubmit(service, config, account, { nonce: hex32(`5${scenario.length}`) });
    const result = await service.processRequest(queued.requestId);
    assert.equal(burns, 0);
    if (scenario === 'treasury') assert.equal(result.status, 'queued');
    else assert.equal(result.status, 'failed');
  }
});

test('lease allows only one worker to burn and pay a request', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let burns = 0;
  let transfers = 0;
  const chain = standardChain(config, {
    async requestBackendRedeem() { burns += 1; await new Promise((resolve) => setImmediate(resolve)); return { status: 2n }; },
    async transferWvara() { transfers += 1; return { txHash: '0xpay' }; },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('47') });
  const [first, second] = await Promise.all([service.processRequest(queued.requestId), service.processRequest(queued.requestId)]);
  assert.equal([first, second].filter((value) => value.status === 'confirmed').length, 1);
  assert.equal([first, second].filter((value) => value.skipped).length, 1);
  assert.equal(burns, 1);
  assert.equal(transfers, 1);
});

test('lease heartbeat prevents takeover while a slow burn is still running', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const config = { ...testConfig(), redeemLeaseMs: 30, redeemRequestTtlMs: 600_000 };
  let burns = 0;
  let transfers = 0;
  const chain = standardChain(config, {
    async requestBackendRedeem() {
      burns += 1;
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { status: 2n };
    },
    async transferWvara() { transfers += 1; return { txHash: '0xpay' }; },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain });
  const queued = await signedSubmit(service, config, account, {
    nonce: hex32('4f'),
    deadline: BigInt(nowSeconds + 300),
  });
  const first = service.processRequest(queued.requestId);
  await new Promise((resolve) => setTimeout(resolve, 55));
  const second = await service.processRequest(queued.requestId);
  assert.equal(second.skipped, true);
  assert.equal((await first).status, 'confirmed');
  assert.equal(burns, 1);
  assert.equal(transfers, 1);
});

test('disconnect failure does not undo success or leave the request leased', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  const chain = standardChain(config, {
    async disconnect() { throw new Error('socket already closed'); },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('50') });
  assert.equal((await service.processRequest(queued.requestId)).status, 'confirmed');
  const record = (await store.read()).redeemPayouts[0];
  assert.equal(record.leaseId, null);
  assert.equal(record.leaseUntil, null);
});

test('reverted payout receipt clears the hash and retries the WVARA transfer', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  let transfers = 0;
  const broadcastHash = hex32('48');
  const chain = standardChain(config, {
    async transferWvara(_owner, _value, { onBroadcast }) {
      transfers += 1;
      if (transfers === 1) {
        await onBroadcast(broadcastHash);
        throw new Error('lost receipt');
      }
      return { txHash: hex32('49') };
    },
    async readTransactionReceipt() { return { status: 'reverted' }; },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('4a') });
  assert.equal((await service.processRequest(queued.requestId)).status, 'payout_failed');
  assert.equal((await service.processRequest(queued.requestId)).status, 'confirmed');
  assert.equal(transfers, 2);
});

test('a transfer returning a reverted receipt is never marked confirmed', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const store = memoryStore();
  const config = testConfig();
  const chain = standardChain(config, {
    async transferWvara() { return { txHash: hex32('4d'), receipt: { status: 'reverted' } }; },
  });
  const service = new RedeemPayoutService({ store, config, chainFactory: async () => chain, now: () => 1_000_000 });
  const queued = await signedSubmit(service, config, account, { nonce: hex32('4e') });
  const result = await service.processRequest(queued.requestId);
  assert.equal(result.status, 'payout_failed');
  assert.match(result.error, /transaction reverted/);
});

test('configuration and u128 guards reject unsafe submissions', async () => {
  const account = privateKeyToAccount(OWNER_KEY);
  const disabledConfig = { ...testConfig(), redeemBackendEnabled: false };
  const disabled = new RedeemPayoutService({ store: memoryStore(), config: disabledConfig, chainFactory: async () => null });
  const disabledIntent = makeIntent(account.address, { nonce: hex32('4b') });
  const disabledSignature = await account.signTypedData(typedData(disabledConfig, disabledIntent));
  await assert.rejects(disabled.submit({ ...disabledIntent, signature: disabledSignature }), (error) => error.statusCode === 503);

  const config = testConfig();
  const service = new RedeemPayoutService({ store: memoryStore(), config, chainFactory: async () => null, now: () => 1_000_000 });
  const overflowIntent = makeIntent(account.address, { scrst: (1n << 128n) - 1n, minPayout: 0n, nonce: hex32('4c') });
  const overflowSignature = await account.signTypedData(typedData(config, overflowIntent));
  await assert.rejects(service.submit({ ...overflowIntent, signature: overflowSignature }), /payout exceeds contract u128 range/);
});

function testConfig() {
  return {
    network: 'mainnet',
    chainId: 1,
    redeemBackendEnabled: true,
    redeemTreasuryKey: '0xtreasury',
    redeemProgramIds: [REDEEM],
    resVmtProgramIds: [VMT],
    redeemRates: { scrst: 10n, bcrst: 30n, hcrst: 150n },
    redeemUnit: 1n,
    redeemRequestTtlMs: 600_000,
    redeemBurnTimeoutMs: 10_000,
    redeemLeaseMs: 10_000,
  };
}

function makeIntent(owner, overrides = {}) {
  return {
    owner,
    scrst: 1n,
    bcrst: 0n,
    hcrst: 0n,
    minPayout: 10n,
    nonce: hex32('40'),
    deadline: 1_300n,
    ...overrides,
  };
}

async function signedSubmit(service, config, account, overrides = {}) {
  const intent = makeIntent(account.address, overrides);
  const signature = await account.signTypedData(typedData(config, intent));
  return service.submit({ ...intent, signature });
}

function standardChain(config, overrides = {}) {
  return {
    account: '0x3333333333333333333333333333333333333333',
    async readRedeemConfig() { return onChainConfig(config); },
    async readResBalances() { return { scrst: 10n, bcrst: 10n, hcrst: 10n }; },
    async readWvaraBalance() { return 10_000n; },
    async requestBackendRedeem() { return { status: 2n, txHash: '0xburn' }; },
    async transferWvara() { return { txHash: '0xpay' }; },
    async disconnect() {},
    ...overrides,
  };
}

function hex32(seed) {
  const hex = Buffer.from(String(seed)).toString('hex') || '00';
  return `0x${hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64)}`;
}

function memoryStore() {
  let db = { redeemPayouts: [] };
  let updateQueue = Promise.resolve();
  return {
    async read() { return structuredClone(db); },
    async update(mutator) {
      const operation = updateQueue.then(async () => {
        const next = structuredClone(db);
        const result = await mutator(next);
        db = next;
        return result;
      });
      updateQueue = operation.catch(() => undefined);
      return operation;
    },
  };
}

function onChainConfig(config) {
  return {
    varaUnit: config.redeemUnit,
    rates: { ...config.redeemRates },
  };
}
