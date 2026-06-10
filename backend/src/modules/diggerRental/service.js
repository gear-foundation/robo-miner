const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const LIVE_WORLD_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'active']);

export class DiggerRentalService {
  constructor({ store, chain, config, now = () => new Date(), logger = null }) {
    this.store = store;
    this.chain = chain;
    this.config = config;
    this.now = now;
    this.logger = logger;
  }

  async syncConfiguredDiggers(extraProgramIds = []) {
    const ids = [...new Set([...this.config.diggerProgramIds, ...extraProgramIds].map(normalizeAddress))];
    if (ids.length === 0) return [];

    return this.store.update((db) => {
      const touched = [];
      for (const programId of ids) {
        const existing = db.diggers.find((digger) => normalizeAddress(digger.programId) === programId);
        if (existing) {
          existing.status ||= 'active';
          existing.seasonId ||= this.config.diggerRentalSeason;
          existing.targetExecBalance ||= this.config.diggerDailyExecTarget.toString();
          existing.updatedAt = this.now().toISOString();
          touched.push(existing);
          continue;
        }
        const digger = {
          id: programId,
          programId,
          owner: null,
          seasonId: this.config.diggerRentalSeason,
          status: 'active',
          targetExecBalance: this.config.diggerDailyExecTarget.toString(),
          executableBalance: '0',
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        db.diggers.push(digger);
        touched.push(digger);
      }
      return touched;
    });
  }

  async requestDigger({
    owner,
    worldId,
    seasonId = null,
    dryRun = true,
    requestId = null,
    codeId = null,
    initialTopUp = null,
  }) {
    const normalizedOwner = normalizeAddress(owner);
    const normalizedWorldId = normalizeAddress(worldId);
    const now = this.now();
    const target = BigInt(initialTopUp ?? this.config.diggerDailyExecTarget);
    const resolvedSeasonId = seasonId || this.config.diggerRentalSeason;
    const resolvedCodeId = codeId || this.config.diggerProxyCodeId;
    if (!dryRun && !this.chain?.deployDigger) throw new Error('Chain client does not support digger deploy');

    const id = requestId || `rent:${resolvedSeasonId}:${normalizedOwner}:${normalizedWorldId}:${now.toISOString()}`;
    const existing = await this.findExistingActiveRental(normalizedOwner, normalizedWorldId, resolvedSeasonId);
    if (existing) {
      this.logger?.info?.('request.existing', {
        owner: normalizedOwner,
        worldId: normalizedWorldId,
        seasonId: resolvedSeasonId,
        programId: existing.programId,
      });
      return {
        status: 'existing',
        requestId: existing.requestId || null,
        programId: existing.programId,
        owner: existing.owner,
        worldId: existing.worldId,
        seasonId: existing.seasonId,
      };
    }

    const request = {
      id,
      type: 'digger-rental-request',
      owner: normalizedOwner,
      worldId: normalizedWorldId,
      seasonId: resolvedSeasonId,
      codeId: resolvedCodeId || null,
      targetExecBalance: target.toString(),
      status: dryRun ? 'dry-run' : 'pending',
      programId: null,
      createTxHash: null,
      topUpTxHash: null,
      initTxHash: null,
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    let deploy = {
      programId: dryRun ? plannedProgramId(id) : null,
      createTxHash: null,
      topUpTxHash: null,
      initTxHash: null,
    };

    try {
      if (!dryRun) {
        this.logger?.info?.('request.deploy.start', {
          owner: normalizedOwner,
          worldId: normalizedWorldId,
          seasonId: resolvedSeasonId,
          targetExecBalance: target.toString(),
          codeId: resolvedCodeId,
        });
        deploy = await this.chain.deployDigger({
          owner: normalizedOwner,
          worldId: normalizedWorldId,
          codeId: resolvedCodeId,
          initialTopUp: target,
        });
      }
      request.status = dryRun ? 'dry-run' : 'confirmed';
      request.programId = normalizeAddress(deploy.programId);
      request.createTxHash = deploy.createTxHash || deploy.txHash || null;
      request.topUpTxHash = deploy.topUpTxHash || null;
      request.initTxHash = deploy.initTxHash || null;
      request.updatedAt = this.now().toISOString();
      this.logger?.info?.('request.deploy.ok', {
        requestId: request.id,
        programId: request.programId,
        createTxHash: request.createTxHash,
        topUpTxHash: request.topUpTxHash,
        initTxHash: request.initTxHash,
        dryRun,
      });
    } catch (error) {
      request.status = 'failed';
      request.error = error.message;
      request.updatedAt = this.now().toISOString();
      await this.store.update((db) => {
        db.rentalRequests.push(request);
      });
      this.logger?.error?.('request.deploy.failed', {
        requestId: request.id,
        owner: normalizedOwner,
        worldId: normalizedWorldId,
        dryRun,
        error: error.message,
      });
      throw error;
    }

    await this.store.update((db) => {
      db.rentalRequests.push(request);
      const digger = {
        id: request.programId,
        requestId: request.id,
        programId: request.programId,
        owner: normalizedOwner,
        seasonId: resolvedSeasonId,
        worldId: normalizedWorldId,
        status: dryRun ? 'planned' : 'active',
        source: 'rental-request',
        codeId: resolvedCodeId || null,
        targetExecBalance: target.toString(),
        executableBalance: dryRun ? '0' : target.toString(),
        lastRefuelAt: request.updatedAt,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      };
      db.diggers.push(digger);
      db.fuelGrants.push({
        id: `${request.id}:initial-top-up`,
        idempotencyKey: `${request.id}:initial-top-up`,
        type: 'initial-rental',
        seasonId: resolvedSeasonId,
        diggerId: request.programId,
        programId: request.programId,
        targetExecBalance: target.toString(),
        balanceBefore: '0',
        amount: target.toString(),
        txHash: request.topUpTxHash || request.createTxHash,
        status: dryRun ? 'dry-run' : 'confirmed',
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      });
      db.jobRuns.push({
        id: `digger-rental-request:${request.id}`,
        job: 'digger-rental-request',
        mode: dryRun ? 'dry-run' : 'live',
        startedAt: request.createdAt,
        finishedAt: request.updatedAt,
        requestId: request.id,
        programId: request.programId,
      });
    });

    return {
      status: request.status,
      requestId: request.id,
      programId: request.programId,
      owner: normalizedOwner,
      worldId: normalizedWorldId,
      seasonId: resolvedSeasonId,
      targetExecBalance: target.toString(),
      createTxHash: request.createTxHash,
      topUpTxHash: request.topUpTxHash,
      initTxHash: request.initTxHash,
    };
  }

  async findExistingActiveRental(owner, worldId, seasonId) {
    const db = await this.store.read();
    return db.diggers.find((digger) => (
      digger.owner
      && digger.worldId
      && normalizeAddress(digger.owner) === owner
      && normalizeAddress(digger.worldId) === worldId
      && digger.seasonId === seasonId
      && ['active', 'planned'].includes(digger.status)
    )) || null;
  }

  async runDailyTopUp({ dryRun = true, diggerProgramIds = [], assumeBalance = null } = {}) {
    await this.syncConfiguredDiggers(diggerProgramIds);

    const db = await this.store.read();
    const selected = selectRentableDiggers(db, diggerProgramIds, this.config.diggerRentalSeason);
    const startedAt = this.now();
    const day = dayKey(startedAt);
    const results = [];

    for (const digger of selected) {
      const programId = normalizeAddress(digger.programId);
      const seasonId = digger.seasonId || this.config.diggerRentalSeason;
      const target = BigInt(digger.targetExecBalance || this.config.diggerDailyExecTarget);
      const idempotencyKey = `${seasonId}:${programId}:${day}:daily-rental`;

      const current = assumeBalance === null
        ? await this.readCurrentBalance(digger, dryRun)
        : BigInt(assumeBalance);
      const amount = current < target ? target - current : 0n;

      const existing = db.fuelGrants.find((grant) => (
        grant.idempotencyKey === idempotencyKey
        && grant.status !== 'failed'
        && grant.status !== 'dry-run'
      ));
      if (existing) {
        this.logger?.info?.('top_up.skip', { programId, reason: 'already_granted_today' });
        results.push({ programId, status: 'skipped', reason: 'already_granted_today', grant: existing });
        continue;
      }

      if (amount === 0n) {
        this.logger?.info?.('top_up.skip', {
          programId,
          reason: 'already_at_or_above_target',
          current: current.toString(),
          target: target.toString(),
        });
        results.push({ programId, status: 'skipped', reason: 'already_at_or_above_target', current: current.toString(), target: target.toString() });
        await this.updateDiggerBalance(programId, current);
        continue;
      }

      const grant = {
        id: idempotencyKey,
        idempotencyKey,
        type: 'daily-rental',
        seasonId,
        diggerId: digger.id || programId,
        programId,
        targetExecBalance: target.toString(),
        balanceBefore: current.toString(),
        amount: amount.toString(),
        txHash: null,
        status: dryRun ? 'dry-run' : 'pending',
        createdAt: startedAt.toISOString(),
        updatedAt: this.now().toISOString(),
      };

      if (!dryRun) {
        this.logger?.info?.('top_up.send', {
          programId,
          current: current.toString(),
          amount: amount.toString(),
          target: target.toString(),
        });
        const receipt = await this.chain.topUpExecutableBalance(programId, amount);
        grant.txHash = receipt.transactionHash || receipt.hash || null;
        grant.status = receipt.status === 'reverted' || receipt.status === false ? 'failed' : 'confirmed';
        grant.updatedAt = this.now().toISOString();
      }
      this.logger?.info?.('top_up.recorded', {
        programId,
        status: grant.status,
        amount: amount.toString(),
        txHash: grant.txHash,
        dryRun,
      });

      await this.store.update((nextDb) => {
        const nextDigger = nextDb.diggers.find((item) => normalizeAddress(item.programId) === programId);
        if (nextDigger) {
          nextDigger.executableBalance = dryRun ? current.toString() : target.toString();
          nextDigger.lastRefuelAt = grant.updatedAt;
          nextDigger.updatedAt = grant.updatedAt;
        }
        nextDb.fuelGrants.push(grant);
      });

      results.push({ programId, status: grant.status, amount: amount.toString(), target: target.toString(), current: current.toString(), txHash: grant.txHash });
    }

    await this.store.update((nextDb) => {
      nextDb.jobRuns.push({
        id: `digger-rental:${startedAt.toISOString()}`,
        job: 'digger-rental-top-up',
        mode: dryRun ? 'dry-run' : 'live',
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        selected: selected.length,
        results,
      });
    });

    return results;
  }

  async readCurrentBalance(digger, dryRun) {
    if (dryRun || !this.chain) return BigInt(digger.executableBalance || 0);
    return this.chain.readExecutableBalance(normalizeAddress(digger.programId));
  }

  async updateDiggerBalance(programId, balance) {
    await this.store.update((db) => {
      const digger = db.diggers.find((item) => normalizeAddress(item.programId) === programId);
      if (!digger) return;
      digger.executableBalance = balance.toString();
      digger.updatedAt = this.now().toISOString();
    });
  }
}

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!ADDRESS_RE.test(value)) throw new Error(`Invalid EVM address: ${address}`);
  return `0x${value.slice(2).toLowerCase()}`;
}

function selectRentableDiggers(db, diggerProgramIds, seasonId) {
  const requested = diggerProgramIds.map(normalizeAddress);
  const liveWorldIds = new Set(
    db.worlds
      .filter((world) => LIVE_WORLD_STATUSES.has(world.status))
      .map((world) => world.id),
  );
  return db.diggers
    .filter((digger) => digger.status === 'active')
    .filter((digger) => requested.length > 0 || !seasonId || digger.seasonId === seasonId)
    .filter((digger) => requested.length > 0 || !digger.worldId || liveWorldIds.has(digger.worldId))
    .filter((digger) => requested.length === 0 || requested.includes(normalizeAddress(digger.programId)));
}

function plannedProgramId(seed) {
  let hash = 0;
  for (const char of seed) hash = ((hash << 5) - hash + char.charCodeAt(0)) >>> 0;
  return `0x${hash.toString(16).padStart(40, '0')}`;
}
