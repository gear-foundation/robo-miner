const LIVE_WORLD_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'open', 'active']);

export class WorldBalanceService {
  constructor({
    store,
    chain = null,
    config,
    now = () => new Date(),
    logger = console,
  }) {
    this.store = store;
    this.chain = chain;
    this.config = config;
    this.now = now;
    this.logger = logger;
  }

  async run({ dryRun = true, assumeBalance = null } = {}) {
    const startedAt = this.now();
    const db = await this.store.read();
    const selected = selectWorldPrograms(db);
    const results = [];

    for (const world of selected) {
      const programId = normalizeProgramId(world.programId);
      const current = assumeBalance === null
        ? await this.readCurrentBalance(programId, world, dryRun)
        : BigInt(assumeBalance);

      if (current >= this.config.worldBalanceMin) {
        results.push({
          programId,
          status: 'skipped',
          reason: 'already_at_or_above_min',
          current: current.toString(),
          min: this.config.worldBalanceMin.toString(),
        });
        await this.updateWorldBalance(programId, current);
        continue;
      }

      const recent = recentWorldBalanceGrant(db, programId, this.config.balanceCooldownMs, startedAt);
      if (recent) {
        results.push({
          programId,
          status: 'skipped',
          reason: 'cooldown',
          current: current.toString(),
          min: this.config.worldBalanceMin.toString(),
          grant: recent,
        });
        await this.updateWorldBalance(programId, current);
        continue;
      }

      const grant = {
        id: `world-balance:${programId}:${startedAt.toISOString()}`,
        idempotencyKey: `world-balance:${programId}:${startedAt.toISOString()}`,
        type: 'world-balance',
        seasonId: world.seasonId || this.config.diggerRentalSeason || null,
        worldId: world.id,
        programId,
        targetExecBalance: this.config.worldBalanceMin.toString(),
        balanceBefore: current.toString(),
        amount: this.config.worldBalanceTopUp.toString(),
        txHash: null,
        status: dryRun ? 'dry-run' : 'pending',
        createdAt: startedAt.toISOString(),
        updatedAt: this.now().toISOString(),
      };

      if (!dryRun) {
        if (!this.chain?.topUpExecutableBalance) throw new Error('Chain client does not support executable balance top-up');
        this.logger?.info?.('world_balance.top_up.send', {
          programId,
          current: current.toString(),
          min: this.config.worldBalanceMin.toString(),
          amount: this.config.worldBalanceTopUp.toString(),
        });
        const receipt = await this.chain.topUpExecutableBalance(programId, this.config.worldBalanceTopUp);
        grant.txHash = receipt.transactionHash || receipt.hash || null;
        grant.status = receipt.status === 'reverted' || receipt.status === false ? 'failed' : 'confirmed';
        grant.updatedAt = this.now().toISOString();
      }

      await this.store.update((nextDb) => {
        const nextWorld = nextDb.worlds.find((item) => sameProgram(item.programId, programId) && LIVE_WORLD_STATUSES.has(item.status));
        if (nextWorld) {
          nextWorld.executableBalance = dryRun
            ? current.toString()
            : (current + this.config.worldBalanceTopUp).toString();
          nextWorld.lastRefuelAt = grant.updatedAt;
          nextWorld.updatedAt = grant.updatedAt;
        }
        nextDb.fuelGrants.push(grant);
      });

      results.push({
        programId,
        status: grant.status,
        amount: grant.amount,
        current: current.toString(),
        min: this.config.worldBalanceMin.toString(),
        txHash: grant.txHash,
      });
    }

    await this.store.update((nextDb) => {
      nextDb.jobRuns.push({
        id: `world-balance:${startedAt.toISOString()}`,
        job: 'world-balance-top-up',
        mode: dryRun ? 'dry-run' : 'live',
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        selected: selected.length,
        results,
      });
    });

    return results;
  }

  async readCurrentBalance(programId, world, dryRun) {
    if (dryRun || !this.chain) return BigInt(world.executableBalance || 0);
    return this.chain.readExecutableBalance(programId);
  }

  async updateWorldBalance(programId, balance) {
    await this.store.update((db) => {
      const world = db.worlds.find((item) => sameProgram(item.programId, programId) && LIVE_WORLD_STATUSES.has(item.status));
      if (!world) return;
      world.executableBalance = balance.toString();
      world.updatedAt = this.now().toISOString();
    });
  }
}

export function selectWorldPrograms(db) {
  const seen = new Set();
  return db.worlds
    .filter((world) => world.programId && LIVE_WORLD_STATUSES.has(world.status))
    .filter((world) => {
      const programId = normalizeProgramId(world.programId);
      if (seen.has(programId)) return false;
      seen.add(programId);
      return true;
    });
}

function recentWorldBalanceGrant(db, programId, cooldownMs, now) {
  const cutoff = now.getTime() - Number(cooldownMs || 0);
  return [...db.fuelGrants]
    .filter((grant) => (
      grant.type === 'world-balance'
      && sameProgram(grant.programId, programId)
      && grant.status !== 'failed'
      && grant.status !== 'dry-run'
      && Date.parse(grant.updatedAt || grant.createdAt || '') >= cutoff
    ))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
}

function normalizeProgramId(programId) {
  return String(programId || '').toLowerCase();
}

function sameProgram(left, right) {
  return normalizeProgramId(left) === normalizeProgramId(right);
}
