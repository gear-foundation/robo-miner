import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SnapshotReader } from '../indexer/snapshotReader.js';

export class AdminService {
  constructor({ store, config, chainFactory, documentStore = null, now = () => new Date(), logger = null }) {
    this.store = store;
    this.config = config;
    this.chainFactory = chainFactory;
    this.documentStore = documentStore;
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

  async resetNetworkState({ scope = 'all', confirm = '', restartFactory = true } = {}) {
    const network = String(this.config.network || '').toLowerCase();
    const namespace = String(this.config.databaseDocumentId || '').toLowerCase();
    if (!['testnet', 'mainnet'].includes(network) || namespace !== network) {
      throw httpError(403, 'network reset is only available for matching testnet/mainnet data namespaces');
    }
    if (confirm !== `reset-${network}`) {
      throw httpError(400, 'missing reset confirmation');
    }

    const normalizedScope = String(scope || 'all').toLowerCase();
    if (!['registry', 'factory', 'all'].includes(normalizedScope)) {
      throw httpError(400, 'invalid reset scope');
    }

    const now = this.now().toISOString();
    const requestId = `admin-${network}-reset:${now}`;
    const resetRegistry = normalizedScope === 'registry' || normalizedScope === 'all';
    const resetFactory = normalizedScope === 'factory' || normalizedScope === 'all';
    if (resetFactory && restartFactory !== true) {
      throw httpError(400, 'factory reset requires restartFactory=true');
    }
    const factoryDocuments = factoryDocumentIds(this.config);
    let deletedFactoryDocuments = [];
    let resetRequest = null;

    if (resetFactory) {
      resetRequest = {
        schemaVersion: 1,
        id: requestId,
        type: 'factory-reset-request',
        status: 'pending',
        network,
        scope: normalizedScope,
        restartFactory: Boolean(restartFactory),
        createdAt: now,
      };
      await this.writeFactoryResetRequest(resetRequest);
      deletedFactoryDocuments = await this.deleteFactoryDocuments(factoryDocuments);
    }

    if (resetRegistry) {
      await this.store.write({
        jobRuns: [{
          id: requestId,
          job: `admin-${network}-reset`,
          mode: 'admin',
          scope: normalizedScope,
          resetRegistry,
          resetFactory,
          createdAt: now,
        }],
      });
    }

    this.logger?.warn?.(`${network}.reset`, {
      scope: normalizedScope,
      resetRegistry,
      resetFactory,
      restartFactory: Boolean(restartFactory),
      deletedFactoryDocuments,
    });

    return {
      status: 'ok',
      network,
      scope: normalizedScope,
      resetRegistry,
      resetFactory,
      restartFactory: Boolean(restartFactory),
      deletedFactoryDocuments,
      factoryResetQueued: Boolean(resetRequest),
      resetRequestId: resetRequest?.id || null,
    };
  }

  async resetTestnetState(options = {}) {
    if (this.config.network !== 'testnet' || this.config.databaseDocumentId !== 'testnet') {
      throw httpError(403, 'testnet reset is only available for the testnet data namespace');
    }
    return this.resetNetworkState(options);
  }

  async deleteFactoryDocuments(ids) {
    if (this.documentStore?.deleteMany) {
      return this.documentStore.deleteMany(ids);
    }
    const removed = [];
    for (const file of factoryStateFiles(this.config)) {
      try {
        await rm(file, { force: true });
        removed.push(file);
      } catch {
        // rm({ force: true }) should not throw for missing files, but keep reset
        // best-effort for stores that do not expose document deletion.
      }
    }
    return removed;
  }

  async writeFactoryResetRequest(request) {
    const id = factoryResetDocumentId(this.config);
    if (this.documentStore?.write) {
      await this.documentStore.write(id, request);
      return id;
    }
    const file = path.join(this.config.stateDir, 'factory-reset-request.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(request, null, 2)}\n`);
    return file;
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

function factoryDocumentPrefix(config) {
  return config.storeBackend === 'postgres' && config.databaseDocumentId && config.databaseDocumentId !== 'main'
    ? `${config.databaseDocumentId}:`
    : '';
}

function factoryDocumentIds(config) {
  const prefix = factoryDocumentPrefix(config);
  return [
    `${prefix}factory:factory-live`,
    `${prefix}factory:factory-programs`,
    `${prefix}factory:factory-past`,
    `${prefix}factory:gamemaster`,
    `${prefix}factory:balance-keeper`,
  ];
}

function factoryResetDocumentId(config) {
  return `${factoryDocumentPrefix(config)}factory:factory-reset-request`;
}

function factoryStateFiles(config) {
  return [
    'factory-live.json',
    'factory-programs.json',
    'factory-past.json',
    'gamemaster.json',
  ].map((name) => path.join(config.stateDir, name));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
