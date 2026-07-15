import { hashTypedData, verifyTypedData } from 'viem';
import { randomUUID } from 'node:crypto';

export const REDEEM_DOMAIN_NAME = 'Robo Miner Redeem';
export const REDEEM_DOMAIN_VERSION = '1';
export const REDEEM_PRIMARY_TYPE = 'RedeemIntent';
export const REDEEM_TYPES = {
  RedeemIntent: [
    { name: 'owner', type: 'address' },
    { name: 'scrst', type: 'uint256' },
    { name: 'bcrst', type: 'uint256' },
    { name: 'hcrst', type: 'uint256' },
    { name: 'minPayout', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const TERMINAL_STATUSES = new Set(['confirmed', 'failed', 'canceled']);
const MAX_U128 = (1n << 128n) - 1n;

export class RedeemPayoutService {
  constructor({ store, config, chainFactory, logger = null, now = Date.now }) {
    this.store = store;
    this.config = config;
    this.chainFactory = chainFactory;
    this.logger = logger;
    this.now = now;
  }

  publicConfig() {
    const redeemProgramId = this.config.redeemProgramIds?.[0] || '';
    return {
      enabled: this.isConfigured(),
      network: this.config.network,
      chainId: this.config.chainId,
      redeemProgramId,
      resVmtProgramId: this.config.resVmtProgramIds?.[0] || '',
      rates: stringifyAmounts(this.config.redeemRates),
      varaUnit: this.config.redeemUnit.toString(),
      requestTtlMs: this.config.redeemRequestTtlMs,
      domain: redeemProgramId ? redeemDomain(this.config) : null,
      primaryType: REDEEM_PRIMARY_TYPE,
      types: REDEEM_TYPES,
    };
  }

  async submit(input) {
    this.assertConfigured();
    const intent = normalizeIntent(input);
    const nowSeconds = BigInt(Math.floor(this.now() / 1000));
    if (intent.deadline <= nowSeconds) throw clientError('redeem intent has expired');
    if (intent.deadline > nowSeconds + BigInt(Math.ceil(this.config.redeemRequestTtlMs / 1000))) {
      throw clientError('redeem intent deadline is too far in the future');
    }
    const signature = normalizeSignature(input.signature);
    const typed = typedData(this.config, intent);
    const valid = await verifyTypedData({ ...typed, address: intent.owner, signature });
    if (!valid) throw clientError('invalid redeem intent signature', 401);
    const requestId = hashTypedData(typed).toLowerCase();
    const payout = payoutFor(intent, this.config);
    if (payout > MAX_U128) throw clientError('redeem payout exceeds contract u128 range');
    if (payout < intent.minPayout) throw clientError(`current payout ${payout} is below signed minimum ${intent.minPayout}`);
    const createdAt = new Date(this.now()).toISOString();
    let record;
    await this.store.update((db) => {
      const existing = db.redeemPayouts.find((item) => item.requestId === requestId);
      if (existing) {
        record = structuredClone(existing);
        return;
      }
      const nonceConflict = db.redeemPayouts.find((item) => item.owner === intent.owner && item.nonce === intent.nonce);
      if (nonceConflict) throw clientError(`redeem nonce was already used by request ${nonceConflict.requestId}`, 409);
      record = {
        requestId,
        owner: intent.owner,
        amounts: stringifyAmounts(intent),
        payout: payout.toString(),
        minPayout: intent.minPayout.toString(),
        nonce: intent.nonce,
        deadline: intent.deadline.toString(),
        status: 'queued',
        burnTxHash: null,
        payoutTxHash: null,
        wvaraBalanceBefore: null,
        error: null,
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        leaseUntil: null,
        leaseId: null,
      };
      db.redeemPayouts.push(record);
    });
    return publicRecord(record);
  }

  async get(requestId) {
    const id = normalizeBytes32(requestId, 'request id');
    const db = await this.store.read();
    const record = db.redeemPayouts.find((item) => item.requestId === id);
    return record ? publicRecord(record) : null;
  }

  async list({ owner = null, limit = 50 } = {}) {
    const normalizedOwner = owner ? normalizeAddress(owner) : null;
    const db = await this.store.read();
    return db.redeemPayouts
      .filter((item) => !normalizedOwner || item.owner === normalizedOwner)
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map(publicRecord);
  }

  async processPending({ limit = 10 } = {}) {
    if (!this.isConfigured()) return { skipped: true, reason: 'disabled' };
    const db = await this.store.read();
    const ids = db.redeemPayouts
      .filter((item) => !TERMINAL_STATUSES.has(item.status))
      .slice(0, limit)
      .map((item) => item.requestId);
    const results = [];
    for (const id of ids) results.push(await this.processRequest(id));
    return { selected: ids.length, results };
  }

  async processRequest(requestId) {
    this.assertConfigured();
    const claimed = await this.claim(requestId);
    if (!claimed) return { requestId, skipped: true, reason: 'leased_or_terminal' };
    const stopLeaseHeartbeat = this.startLeaseHeartbeat(requestId, claimed.leaseId);
    let chain = null;
    try {
      let record = claimed;
      if (record.status === 'queued') {
        if (BigInt(record.deadline) <= BigInt(Math.floor(this.now() / 1000))) {
          throw new Error('redeem intent expired before burn started');
        }
      }
      chain = await this.chainFactory();
      if (record.status === 'queued') {
        const [balances, treasuryBalance, chainConfig] = await Promise.all([
          chain.readResBalances(this.config.resVmtProgramIds[0], record.owner),
          chain.readWvaraBalance(chain.account),
          chain.readRedeemConfig(this.config.redeemProgramIds[0]),
        ]);
        assertMatchingRedeemConfig(this.config, chainConfig);
        assertEnoughRes(record, balances);
        if (treasuryBalance < BigInt(record.payout)) {
          throw new Error(`insufficient treasury WVARA: need ${record.payout}, balance ${treasuryBalance}`);
        }
        await this.patch(record.requestId, { status: 'burning', error: null }, claimed.leaseId);
        record = await this.getInternal(record.requestId);
      }
      if (record.status === 'burning') {
        const burn = await chain.requestBackendRedeem({
          programId: this.config.redeemProgramIds[0],
          requestId: record.requestId,
          owner: record.owner,
          ...record.amounts,
          timeoutMs: this.config.redeemBurnTimeoutMs,
        });
        record = await this.patch(record.requestId, {
          status: 'burned',
          burnTxHash: burn.txHash || record.burnTxHash,
          burnedAt: new Date(this.now()).toISOString(),
          error: null,
        }, claimed.leaseId);
      }

      if (record.payoutTxHash) {
        const receipt = await chain.readTransactionReceipt?.(record.payoutTxHash);
        if (receipt && receiptSucceeded(receipt)) {
          record = await this.patch(record.requestId, {
            status: 'confirmed',
            confirmedAt: new Date(this.now()).toISOString(),
            error: null,
          }, claimed.leaseId);
          return publicRecord(record);
        }
        if (!receipt) throw new Error(`WVARA payout transaction is still pending: ${record.payoutTxHash}`);
        record = await this.patch(record.requestId, { payoutTxHash: null, status: 'burned' }, claimed.leaseId);
      }

      const currentBalance = await chain.readWvaraBalance(record.owner);
      if (record.wvaraBalanceBefore != null && currentBalance >= BigInt(record.wvaraBalanceBefore) + BigInt(record.payout)) {
        record = await this.patch(record.requestId, {
          status: 'confirmed',
          confirmedAt: new Date(this.now()).toISOString(),
          error: null,
        }, claimed.leaseId);
        return publicRecord(record);
      }

      if (record.wvaraBalanceBefore == null) {
        record = await this.patch(record.requestId, {
          status: 'paying',
          wvaraBalanceBefore: currentBalance.toString(),
          error: null,
        }, claimed.leaseId);
      } else {
        record = await this.patch(record.requestId, { status: 'paying', error: null }, claimed.leaseId);
      }
      const transfer = await chain.transferWvara(record.owner, BigInt(record.payout), {
        onBroadcast: async (txHash) => {
          if (txHash) record = await this.patch(record.requestId, { payoutTxHash: txHash }, claimed.leaseId);
        },
      });
      if (transfer.receipt && !receiptSucceeded(transfer.receipt)) {
        throw new Error(`WVARA payout transaction reverted: ${transfer.txHash || record.payoutTxHash || 'unknown hash'}`);
      }
      record = await this.patch(record.requestId, {
        status: 'confirmed',
        payoutTxHash: transfer.txHash || null,
        confirmedAt: new Date(this.now()).toISOString(),
        error: null,
      }, claimed.leaseId);
      return publicRecord(record);
    } catch (error) {
      const latest = await this.getInternal(requestId);
      const burned = ['burned', 'paying', 'payout_failed'].includes(latest?.status) || Boolean(latest?.burnedAt);
      const burnUncertain = latest?.status === 'burning';
      const permanent = /insufficient (SCRST|BCRST|HCRST) balance|burn was canceled|expired before burn|config mismatch/i.test(error?.message || '');
      const exhausted = Number(latest?.attempts || 0) >= Number(this.config.redeemMaxAttempts || 5);
      const record = await this.patch(requestId, {
        status: burned ? 'payout_failed' : burnUncertain ? 'burning' : (permanent || exhausted ? 'failed' : 'queued'),
        error: error?.message || String(error),
      }, claimed.leaseId);
      this.logger?.error?.('redeem.process.failed', { requestId, status: record.status, error: record.error });
      return publicRecord(record);
    } finally {
      try {
        await chain?.disconnect?.();
      } catch (error) {
        this.logger?.warn?.('redeem.chain.disconnect.failed', { requestId, error: error?.message || String(error) });
      }
      stopLeaseHeartbeat();
      await this.release(requestId, claimed.leaseId);
    }
  }

  isConfigured() {
    return Boolean(
      this.config.redeemBackendEnabled
      && this.config.redeemTreasuryKey
      && this.config.redeemProgramIds?.[0]
      && this.config.resVmtProgramIds?.[0],
    );
  }

  assertConfigured() {
    if (!this.isConfigured()) throw clientError('backend redeem is not configured', 503);
  }

  async claim(requestId) {
    const id = normalizeBytes32(requestId, 'request id');
    const now = this.now();
    let claimed = null;
    await this.store.update((db) => {
      const record = db.redeemPayouts.find((item) => item.requestId === id);
      if (!record || TERMINAL_STATUSES.has(record.status)) return;
      if (record.leaseUntil && Date.parse(record.leaseUntil) > now) return;
      record.leaseId = randomUUID();
      record.leaseUntil = new Date(now + this.config.redeemLeaseMs).toISOString();
      record.attempts = Number(record.attempts || 0) + 1;
      record.updatedAt = new Date(now).toISOString();
      claimed = structuredClone(record);
    });
    return claimed;
  }

  startLeaseHeartbeat(requestId, leaseId) {
    let stopped = false;
    let timer = null;
    const intervalMs = Math.max(10, Math.floor(this.config.redeemLeaseMs / 3));
    const tick = async () => {
      if (stopped) return;
      try {
        await this.store.update((db) => {
          const record = db.redeemPayouts.find((item) => item.requestId === requestId);
          if (record?.leaseId === leaseId) {
            record.leaseUntil = new Date(this.now() + this.config.redeemLeaseMs).toISOString();
          }
        });
      } catch (error) {
        this.logger?.warn?.('redeem.lease.heartbeat.failed', { requestId, error: error?.message || String(error) });
      }
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    };
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  async release(requestId, leaseId) {
    await this.store.update((db) => {
      const record = db.redeemPayouts.find((item) => item.requestId === requestId);
      if (record?.leaseId === leaseId) {
        record.leaseUntil = null;
        record.leaseId = null;
      }
    });
  }

  async patch(requestId, fields, leaseId = null) {
    let result = null;
    await this.store.update((db) => {
      const record = db.redeemPayouts.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`redeem request not found: ${requestId}`);
      if (leaseId && record.leaseId !== leaseId) throw new Error(`redeem lease lost: ${requestId}`);
      Object.assign(record, fields, { updatedAt: new Date(this.now()).toISOString() });
      result = structuredClone(record);
    });
    return result;
  }

  async getInternal(requestId) {
    const db = await this.store.read();
    return db.redeemPayouts.find((item) => item.requestId === requestId) || null;
  }
}

export function redeemDomain(config) {
  return {
    name: REDEEM_DOMAIN_NAME,
    version: REDEEM_DOMAIN_VERSION,
    chainId: Number(config.chainId),
    verifyingContract: normalizeAddress(config.redeemProgramIds[0]),
  };
}

export function typedData(config, intent) {
  return {
    domain: redeemDomain(config),
    types: REDEEM_TYPES,
    primaryType: REDEEM_PRIMARY_TYPE,
    message: intent,
  };
}

function normalizeIntent(input) {
  const intent = {
    owner: normalizeAddress(input.owner),
    scrst: amount(input.scrst ?? input.amounts?.scrst, 'scrst'),
    bcrst: amount(input.bcrst ?? input.amounts?.bcrst, 'bcrst'),
    hcrst: amount(input.hcrst ?? input.amounts?.hcrst, 'hcrst'),
    minPayout: amount(input.minPayout, 'minPayout'),
    nonce: normalizeBytes32(input.nonce, 'nonce'),
    deadline: amount(input.deadline, 'deadline'),
  };
  if (intent.scrst + intent.bcrst + intent.hcrst === 0n) throw clientError('enter at least one RES amount');
  return intent;
}

function payoutFor(intent, config) {
  return (
    intent.scrst * config.redeemRates.scrst
    + intent.bcrst * config.redeemRates.bcrst
    + intent.hcrst * config.redeemRates.hcrst
  ) * config.redeemUnit;
}

function assertEnoughRes(record, balances) {
  for (const key of ['scrst', 'bcrst', 'hcrst']) {
    if (BigInt(balances[key]) < BigInt(record.amounts[key])) {
      throw new Error(`insufficient ${key.toUpperCase()} balance: need ${record.amounts[key]}, balance ${balances[key]}`);
    }
  }
}

function assertMatchingRedeemConfig(config, chainConfig) {
  const expected = {
    varaUnit: BigInt(config.redeemUnit),
    scrst: BigInt(config.redeemRates.scrst),
    bcrst: BigInt(config.redeemRates.bcrst),
    hcrst: BigInt(config.redeemRates.hcrst),
  };
  const actual = {
    varaUnit: BigInt(chainConfig.varaUnit),
    scrst: BigInt(chainConfig.rates.scrst),
    bcrst: BigInt(chainConfig.rates.bcrst),
    hcrst: BigInt(chainConfig.rates.hcrst),
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(`redeem ${key} config mismatch: backend ${expected[key]}, contract ${actual[key]}`);
    }
  }
}

function publicRecord(record) {
  if (!record) return null;
  const { signature: _signature, leaseUntil: _leaseUntil, leaseId: _leaseId, ...result } = structuredClone(record);
  return result;
}

function receiptSucceeded(receipt) {
  return receipt?.status === 'success' || receipt?.status === 1 || receipt?.status === 1n || receipt?.status === '0x1';
}

function stringifyAmounts(value) {
  return {
    scrst: BigInt(value.scrst).toString(),
    bcrst: BigInt(value.bcrst).toString(),
    hcrst: BigInt(value.hcrst).toString(),
  };
}

function amount(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw clientError(`${label} must be a non-negative integer`);
  const result = BigInt(text);
  if (label !== 'deadline' && result > MAX_U128) throw clientError(`${label} exceeds contract u128 range`);
  return result;
}

function normalizeAddress(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw clientError('owner must be a 20-byte address');
  return address;
}

function normalizeBytes32(value, label) {
  const hex = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw clientError(`${label} must be 32-byte hex`);
  return hex;
}

function normalizeSignature(value) {
  const signature = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(signature)) throw clientError('signature must be hex');
  return signature;
}

function clientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
