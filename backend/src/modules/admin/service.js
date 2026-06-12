import { SnapshotReader } from '../indexer/snapshotReader.js';

export class AdminService {
  constructor({ store, config, chainFactory, now = () => new Date(), logger = null }) {
    this.store = store;
    this.config = config;
    this.chainFactory = chainFactory;
    this.now = now;
    this.logger = logger;
  }

  async overview() {
    const db = await this.store.read();
    return {
      diggers: db.diggers.length,
      activeDiggers: db.diggers.filter((digger) => digger.status === 'active').length,
      rentalRequests: db.rentalRequests.length,
      failedRentalRequests: db.rentalRequests.filter((request) => request.status === 'failed').length,
      fuelGrants: db.fuelGrants.length,
      socialRewardSubmissions: db.socialRewardSubmissions.length,
      paidSocialRewardSubmissions: db.socialRewardSubmissions.filter((item) => ['confirmed', 'dry-run'].includes(item.status)).length,
      jobRuns: db.jobRuns.slice(-20),
    };
  }

  async rentalRequests({ status = null, limit = 100 } = {}) {
    const db = await this.store.read();
    return db.rentalRequests
      .filter((request) => !status || request.status === status)
      .slice(-limit)
      .reverse();
  }

  async fuelGrants({ programId = null, limit = 100 } = {}) {
    const db = await this.store.read();
    return db.fuelGrants
      .filter((grant) => !programId || normalizeKey(grant.programId) === normalizeKey(programId))
      .slice(-limit)
      .reverse();
  }

  async clearFailedRentalRequests() {
    return this.store.update((db) => {
      const before = db.rentalRequests.length;
      db.rentalRequests = db.rentalRequests.filter((request) => request.status !== 'failed');
      const removed = before - db.rentalRequests.length;
      db.jobRuns.push({
        id: `admin-clear-failed-rentals:${this.now().toISOString()}`,
        job: 'admin-clear-failed-rentals',
        mode: 'admin',
        removed,
        createdAt: this.now().toISOString(),
      });
      this.logger?.warn?.('rental.clear_failed', { removed });
      return { removed };
    });
  }

  async readRedeem(programId) {
    this.logger?.info?.('redeem.read.start', { programId });
    const reader = new SnapshotReader({
      config: this.config,
      programs: [{ programType: 'redeem', programId }],
    });
    await reader.connect();
    try {
      const snapshot = await reader.readRedeem(programId);
      const program = reader.sailsByType.get('redeem');
      const q = program.services.Redeem.queries;
      const [scrstRate, bcrstRate, hcrstRate, varaUnit, availableReserve] = await Promise.all([
        reader.query(programId, q.ScrstRate),
        reader.query(programId, q.BcrstRate),
        reader.query(programId, q.HcrstRate),
        q.VaraUnit ? reader.query(programId, q.VaraUnit) : Promise.resolve(null),
        reader.query(programId, q.AvailableReserve),
      ]);
      const result = {
        ...snapshot,
        rates: {
          scrst: String(scrstRate),
          bcrst: String(bcrstRate),
          hcrst: String(hcrstRate),
        },
        varaUnit: varaUnit === null ? null : String(varaUnit),
        availableReserve: String(availableReserve),
      };
      this.logger?.info?.('redeem.read.ok', {
        programId,
        availableReserve: result.availableReserve,
        totalRedeemed: result.totalRedeemed,
      });
      return result;
    } finally {
      await reader.disconnect();
    }
  }

  async depositRedeemReserve({ programId, amount, dryRun = true }) {
    this.logger?.info?.('redeem.deposit.start', {
      programId,
      amount: String(amount),
      dryRun,
    });
    if (dryRun) {
      return {
        status: 'dry-run',
        programId,
        amount: String(amount),
        action: 'Redeem.DepositReserve',
      };
    }
    const chain = await this.chainFactory();
    try {
      const receipt = await chain.depositRedeemReserve(programId, amount);
      const result = {
        status: receipt.status === 'reverted' || receipt.status === false ? 'failed' : 'confirmed',
        programId,
        amount: String(amount),
        txHash: receipt.transactionHash || receipt.hash || null,
      };
      this.logger?.info?.('redeem.deposit.ok', result);
      return result;
    } finally {
      await chain.disconnect?.();
    }
  }
}

function normalizeKey(value) {
  return String(value || '').toLowerCase();
}
