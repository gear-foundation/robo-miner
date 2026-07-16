import { generateAgentName } from '../agentNames.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/i;
const LIVE_WORLD_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'active']);
const EXISTING_RENTAL_STATUSES = new Set(['active', 'planned', 'registered']);
const FINISHED_AGENT_STATUSES = new Set(['dead', 'exited']);

export class DiggerSessionLockedError extends Error {
  constructor({ worldId, seasonId, sessionId, status }) {
    super('digger_already_used_in_current_session');
    this.name = 'DiggerSessionLockedError';
    this.statusCode = 409;
    this.worldId = worldId;
    this.seasonId = seasonId;
    this.sessionId = sessionId;
    this.diggerStatus = status;
  }
}

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
          delete existing.executableBalance;
          delete existing.executableBalanceObservedAt;
          existing.updatedAt = this.now().toISOString();
          touched.push(existing);
          continue;
        }
        const digger = {
          id: programId,
          programId,
          agentName: generateAgentName(programId),
          owner: null,
          seasonId: this.config.diggerRentalSeason,
          status: 'active',
          targetExecBalance: this.config.diggerDailyExecTarget.toString(),
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
    if (!dryRun && (!this.chain?.deployDigger || !this.chain?.verifyDiggerReady)) throw new Error('Chain client does not support verified digger deploy');

    const id = requestId || `rent:${resolvedSeasonId}:${normalizedOwner}:${normalizedWorldId}:${now.toISOString()}`;
    const conflict = await this.findRentalConflict(normalizedOwner, normalizedWorldId, resolvedSeasonId);
    if (conflict?.kind === 'session_locked') {
      throw new DiggerSessionLockedError({
        worldId: normalizedWorldId,
        seasonId: resolvedSeasonId,
        sessionId: conflict.sessionId,
        status: conflict.digger.status,
      });
    }
    if (conflict?.kind === 'existing') {
      const { digger: existing } = conflict;
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
        agentName: existing.agentName || generateAgentName(existing.programId),
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
        await this.chain.verifyDiggerReady({
          programId: deploy.programId,
          owner: normalizedOwner,
          worldId: normalizedWorldId,
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
        agentName: generateAgentName(request.programId),
        owner: normalizedOwner,
        seasonId: resolvedSeasonId,
        worldId: normalizedWorldId,
        status: dryRun ? 'planned' : 'active',
        source: 'rental-request',
        codeId: resolvedCodeId || null,
        targetExecBalance: target.toString(),
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
      agentName: generateAgentName(request.programId),
      owner: normalizedOwner,
      worldId: normalizedWorldId,
      seasonId: resolvedSeasonId,
      targetExecBalance: target.toString(),
      createTxHash: request.createTxHash,
      topUpTxHash: request.topUpTxHash,
      initTxHash: request.initTxHash,
    };
  }

  async enqueueDiggerRequest({
    owner,
    worldId,
    seasonId = null,
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

    const conflict = await this.findRentalConflict(normalizedOwner, normalizedWorldId, resolvedSeasonId);
    if (conflict?.kind === 'session_locked') {
      throw new DiggerSessionLockedError({
        worldId: normalizedWorldId,
        seasonId: resolvedSeasonId,
        sessionId: conflict.sessionId,
        status: conflict.digger.status,
      });
    }
    if (conflict?.kind === 'existing') {
      const { digger: existing } = conflict;
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
        agentName: existing.agentName || generateAgentName(existing.programId),
        owner: existing.owner,
        worldId: existing.worldId,
        seasonId: existing.seasonId,
      };
    }

    const pending = await this.findPendingRentalRequest(normalizedOwner, normalizedWorldId, resolvedSeasonId);
    if (pending) {
      this.logger?.info?.('request.pending_existing', {
        requestId: pending.id,
        owner: normalizedOwner,
        worldId: normalizedWorldId,
        seasonId: resolvedSeasonId,
      });
      return {
        status: pending.status,
        requestId: pending.id,
        programId: pending.programId || null,
        agentName: pending.programId ? generateAgentName(pending.programId) : null,
        owner: normalizedOwner,
        worldId: normalizedWorldId,
        seasonId: resolvedSeasonId,
        targetExecBalance: pending.targetExecBalance || target.toString(),
      };
    }

    const id = requestId || `rent:${resolvedSeasonId}:${normalizedOwner}:${normalizedWorldId}:${now.toISOString()}`;
    const request = {
      id,
      type: 'digger-rental-request',
      owner: normalizedOwner,
      worldId: normalizedWorldId,
      seasonId: resolvedSeasonId,
      codeId: resolvedCodeId || null,
      targetExecBalance: target.toString(),
      status: 'pending',
      programId: null,
      createTxHash: null,
      topUpTxHash: null,
      initTxHash: null,
      error: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await this.store.update((db) => {
      db.rentalRequests.push(request);
      db.jobRuns.push({
        id: `digger-rental-request:${request.id}`,
        job: 'digger-rental-request',
        mode: 'live',
        status: 'pending',
        startedAt: request.createdAt,
        finishedAt: null,
        requestId: request.id,
        programId: null,
      });
    });

    return {
      status: request.status,
      requestId: request.id,
      programId: null,
      agentName: null,
      owner: normalizedOwner,
      worldId: normalizedWorldId,
      seasonId: resolvedSeasonId,
      targetExecBalance: target.toString(),
    };
  }

  async processQueuedDiggerRequest(requestId) {
    if (!this.chain?.deployDigger || !this.chain?.verifyDiggerReady) throw new Error('Chain client does not support verified digger deploy');

    const request = await this.markRequestRunning(requestId);
    if (!request) {
      this.logger?.warn?.('request.queue.missing', { requestId });
      return null;
    }
    if (request.status !== 'running') {
      this.logger?.info?.('request.queue.skip', { requestId, status: request.status });
      return request;
    }

    try {
      let deploy;
      if (request.processingMode === 'reconcile') {
        this.logger?.info?.('request.reconcile.start', {
          requestId,
          programId: request.programId,
          owner: request.owner,
          worldId: request.worldId,
          seasonId: request.seasonId,
        });
        deploy = {
          programId: request.programId,
          createTxHash: request.createTxHash || null,
          topUpTxHash: request.topUpTxHash || null,
          initTxHash: request.initTxHash || null,
        };
      } else {
        this.logger?.info?.('request.deploy.start', {
          requestId,
          owner: request.owner,
          worldId: request.worldId,
          seasonId: request.seasonId,
          targetExecBalance: request.targetExecBalance,
          codeId: request.codeId,
        });
        deploy = await this.chain.deployDigger({
          owner: request.owner,
          worldId: request.worldId,
          codeId: request.codeId,
          initialTopUp: BigInt(request.targetExecBalance),
          onProgress: (progress) => this.recordRequestProgress(requestId, progress),
        });
      }
      await this.chain.verifyDiggerReady({
        programId: deploy.programId,
        owner: request.owner,
        worldId: request.worldId,
      });
      const confirmed = await this.confirmQueuedDiggerRequest(requestId, deploy);
      this.logger?.info?.(request.processingMode === 'reconcile' ? 'request.reconcile.ok' : 'request.deploy.ok', {
        requestId,
        programId: confirmed.programId,
        createTxHash: confirmed.createTxHash,
        topUpTxHash: confirmed.topUpTxHash,
        initTxHash: confirmed.initTxHash,
        dryRun: false,
      });
      return confirmed;
    } catch (error) {
      const failedAt = this.now().toISOString();
      await this.store.update((db) => {
        const liveRequest = db.rentalRequests.find((item) => item.id === requestId);
        if (liveRequest) {
          liveRequest.status = liveRequest.createTxHash ? 'confirmation_pending' : 'failed';
          liveRequest.error = error.message;
          liveRequest.updatedAt = failedAt;
        }
        const jobRun = db.jobRuns.find((item) => item.id === `digger-rental-request:${requestId}`);
        if (jobRun) {
          jobRun.status = 'failed';
          jobRun.finishedAt = failedAt;
          jobRun.error = error.message;
        }
      });
      this.logger?.error?.(request.processingMode === 'reconcile' ? 'request.reconcile.failed' : 'request.deploy.failed', {
        requestId,
        programId: request.programId || null,
        owner: request.owner,
        worldId: request.worldId,
        dryRun: false,
        error: error.message,
      });
      throw error;
    }
  }

  async processQueuedDiggerRequests({ limit = 10 } = {}) {
    if (!this.chain?.deployDigger || !this.chain?.verifyDiggerReady) throw new Error('Chain client does not support verified digger deploy');

    const db = await this.store.read();
    const queued = db.rentalRequests
      .filter((request) => (
        request.status === 'pending'
        || (request.status === 'confirmation_pending' && request.programId)
      ))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .slice(0, limit);
    const results = [];

    for (const request of queued) {
      try {
        const result = await this.processQueuedDiggerRequest(request.id);
        results.push({
          requestId: request.id,
          status: result?.status || 'skipped',
          programId: result?.programId || null,
        });
      } catch (error) {
        const latest = (await this.store.read()).rentalRequests.find((item) => item.id === request.id);
        results.push({
          requestId: request.id,
          status: latest?.status || 'failed',
          error: error.message,
        });
      }
    }

    return results;
  }

  async findRentalConflict(owner, worldId, seasonId) {
    const db = await this.store.read();
    const sessionId = currentWorldSessionId(db, worldId);
    for (const digger of db.diggers) {
      if (
        !digger.owner
        || !digger.worldId
        || digger.seasonId !== seasonId
        || normalizeStoredAddress(digger.owner) !== owner
        || normalizeStoredAddress(digger.worldId) !== worldId
      ) continue;

      const diggerSessionId = sessionIdForDigger(db, digger, worldId, seasonId);
      const isCurrentSession = sessionId === null || diggerSessionId === null || diggerSessionId === sessionId;

      if (EXISTING_RENTAL_STATUSES.has(digger.status)) {
        if (digger.status === 'planned' || isCurrentSession) return { kind: 'existing', digger };
        continue;
      }
      if (FINISHED_AGENT_STATUSES.has(digger.status) && isCurrentSession) {
        return { kind: 'session_locked', digger, sessionId };
      }
    }
    return null;
  }

  async findPendingRentalRequest(owner, worldId, seasonId) {
    const db = await this.store.read();
    return db.rentalRequests.find((request) => (
      request.owner
      && request.worldId
      && request.seasonId === seasonId
      && ['pending', 'running', 'confirmation_pending'].includes(request.status)
      && normalizeStoredAddress(request.owner) === owner
      && normalizeStoredAddress(request.worldId) === worldId
    )) || null;
  }

  async markRequestRunning(requestId) {
    return this.store.update((db) => {
      const request = db.rentalRequests.find((item) => item.id === requestId);
      if (!request) return null;
      const processingMode = request.status === 'confirmation_pending' && request.programId
        ? 'reconcile'
        : request.status === 'pending'
          ? 'deploy'
          : null;
      if (!processingMode) return structuredClone(request);
      request.status = 'running';
      request.updatedAt = this.now().toISOString();
      const jobRun = db.jobRuns.find((item) => item.id === `digger-rental-request:${requestId}`);
      if (jobRun) jobRun.status = 'running';
      return { ...structuredClone(request), processingMode };
    });
  }

  async confirmQueuedDiggerRequest(requestId, deploy) {
    const completedAt = this.now().toISOString();
    const programId = normalizeAddress(deploy.programId);
    return this.store.update((db) => {
      const request = db.rentalRequests.find((item) => item.id === requestId);
      if (!request) throw new Error(`Queued rental request not found: ${requestId}`);
      request.status = 'confirmed';
      request.programId = programId;
      request.createTxHash = deploy.createTxHash || deploy.txHash || request.createTxHash || null;
      request.topUpTxHash = deploy.topUpTxHash || request.topUpTxHash || null;
      request.initTxHash = deploy.initTxHash || request.initTxHash || null;
      request.error = null;
      request.updatedAt = completedAt;

      const diggerRecord = {
        id: programId,
        requestId,
        programId,
        agentName: generateAgentName(programId),
        owner: request.owner,
        seasonId: request.seasonId,
        worldId: request.worldId,
        status: 'active',
        source: 'rental-request',
        codeId: request.codeId || null,
        targetExecBalance: request.targetExecBalance,
        lastRefuelAt: completedAt,
        createdAt: request.createdAt,
        updatedAt: completedAt,
      };
      const digger = db.diggers.find((item) => (
        item.requestId === requestId
        || (item.programId && normalizeStoredAddress(item.programId) === programId)
      ));
      if (digger) Object.assign(digger, diggerRecord);
      else db.diggers.push(diggerRecord);

      const grantId = `${requestId}:initial-top-up`;
      const grantRecord = {
        id: grantId,
        idempotencyKey: grantId,
        type: 'initial-rental',
        seasonId: request.seasonId,
        diggerId: programId,
        programId,
        targetExecBalance: request.targetExecBalance,
        balanceBefore: '0',
        amount: request.targetExecBalance,
        txHash: request.topUpTxHash || request.createTxHash,
        status: 'confirmed',
        createdAt: request.createdAt,
        updatedAt: completedAt,
      };
      const grant = db.fuelGrants.find((item) => item.idempotencyKey === grantId || item.id === grantId);
      if (grant) Object.assign(grant, grantRecord);
      else db.fuelGrants.push(grantRecord);

      const jobId = `digger-rental-request:${requestId}`;
      const jobRun = db.jobRuns.find((item) => item.id === jobId);
      if (jobRun) {
        jobRun.status = 'ok';
        jobRun.finishedAt = completedAt;
        jobRun.programId = programId;
        delete jobRun.error;
      } else {
        db.jobRuns.push({
          id: jobId,
          job: 'digger-rental-request',
          mode: 'live',
          status: 'ok',
          startedAt: request.createdAt,
          finishedAt: completedAt,
          requestId,
          programId,
        });
      }

      return {
        status: 'confirmed',
        requestId,
        programId,
        agentName: generateAgentName(programId),
        createTxHash: request.createTxHash,
        topUpTxHash: request.topUpTxHash,
        initTxHash: request.initTxHash,
      };
    });
  }

  async recordRequestProgress(requestId, progress) {
    return this.store.update((db) => {
      const request = db.rentalRequests.find((item) => item.id === requestId);
      if (!request) return null;
      if (progress.createTxHash) request.createTxHash = progress.createTxHash;
      if (progress.initTxHash) request.initTxHash = progress.initTxHash;
      if (progress.programId) request.programId = normalizeAddress(progress.programId);
      request.stage = progress.stage || request.stage || null;
      request.updatedAt = this.now().toISOString();
      return structuredClone(request);
    });
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
      if (current === null) {
        this.logger?.info?.('top_up.skip', {
          programId,
          reason: 'current_balance_unknown',
          target: target.toString(),
        });
        results.push({
          programId,
          status: 'skipped',
          reason: 'current_balance_unknown',
          current: null,
          target: target.toString(),
        });
        await this.removeLegacyExecutableBalance(programId);
        continue;
      }
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
        await this.removeLegacyExecutableBalance(programId);
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
          delete nextDigger.executableBalance;
          delete nextDigger.executableBalanceObservedAt;
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
    if (dryRun || !this.chain) return null;
    return this.chain.readExecutableBalance(normalizeAddress(digger.programId));
  }

  async removeLegacyExecutableBalance(programId) {
    await this.store.update((db) => {
      const digger = db.diggers.find((item) => normalizeAddress(item.programId) === programId);
      if (!digger) return;
      delete digger.executableBalance;
      delete digger.executableBalanceObservedAt;
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

function normalizeStoredAddress(address) {
  try {
    return normalizeAddress(address);
  } catch {
    return null;
  }
}

function currentWorldSessionId(db, worldId) {
  const world = db.worlds.find((item) => (
    normalizeStoredAddress(item.programId) === worldId
    || normalizeStoredAddress(item.id) === worldId
    || normalizeStoredAddress(item.worldId) === worldId
  ));
  return normalizeSessionId(world?.sessionId ?? world?.session?.id);
}

function sessionIdForDigger(db, digger, worldId, seasonId) {
  const direct = normalizeSessionId(digger.sessionId);
  if (direct !== null) return direct;

  const actorId = String(digger.actorId || actorIdFromProgramId(digger.programId) || '').toLowerCase();
  if (!actorId) return null;
  const stats = db.agentStats
    .filter((item) => (
      item.seasonId === seasonId
      && normalizeStoredAddress(item.worldId) === worldId
      && String(item.ownerActor || '').toLowerCase() === actorId
    ))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  return normalizeSessionId(stats?.sessionId);
}

function actorIdFromProgramId(programId) {
  const address = normalizeStoredAddress(programId);
  return address ? `0x${'00'.repeat(12)}${address.slice(2)}` : null;
}

function normalizeSessionId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
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
