const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/i;

export class DiggerRegistryService {
  constructor({ store, config, now = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  async register({ programId, owner = null, seasonId = null, worldId = null, status = 'active', source = 'manual' }) {
    const normalizedProgramId = normalizeAddress(programId);
    const normalizedOwner = owner ? normalizeAddress(owner) : null;
    const normalizedWorldId = worldId ? normalizeAddress(worldId) : null;
    const resolvedSeasonId = seasonId || this.config.diggerRentalSeason;
    const now = this.now().toISOString();
    const targetExecBalance = this.config.diggerDailyExecTarget.toString();

    return this.store.update((db) => {
      const existing = db.diggers.find((digger) => normalizeAddress(digger.programId) === normalizedProgramId);
      const ownerDuplicate = normalizedOwner && normalizedWorldId
        ? db.diggers.find((digger) => (
          normalizeNullableAddress(digger.owner) === normalizedOwner
          && normalizeNullableAddress(digger.worldId) === normalizedWorldId
          && digger.seasonId === resolvedSeasonId
          && ['active', 'planned'].includes(digger.status)
          && normalizeAddress(digger.programId) !== normalizedProgramId
        ))
        : null;
      if (ownerDuplicate) {
        throw new Error(`Active digger already exists for owner/world/season: ${ownerDuplicate.programId}`);
      }
      const next = {
        id: existing?.id || normalizedProgramId,
        programId: normalizedProgramId,
        owner: normalizedOwner ?? existing?.owner ?? null,
        seasonId: resolvedSeasonId || existing?.seasonId || this.config.diggerRentalSeason,
        worldId: normalizedWorldId ?? existing?.worldId ?? null,
        status: status || existing?.status || 'active',
        source,
        targetExecBalance: existing?.targetExecBalance || targetExecBalance,
        executableBalance: existing?.executableBalance || '0',
        lastRefuelAt: existing?.lastRefuelAt || null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };

      if (existing) Object.assign(existing, next);
      else db.diggers.push(next);

      return next;
    });
  }

  async syncFromConfig() {
    const records = [];
    for (const programId of this.config.diggerProgramIds) {
      records.push(await this.register({ programId, source: 'env' }));
    }
    return records;
  }

  async list({ seasonId = null, worldId = null, owner = null, status = null } = {}) {
    const db = await this.store.read();
    const normalizedOwner = owner ? normalizeAddress(owner) : null;
    const normalizedWorldId = worldId ? normalizeAddress(worldId) : null;
    return db.diggers
      .filter((digger) => !seasonId || digger.seasonId === seasonId)
      .filter((digger) => !normalizedWorldId || normalizeNullableAddress(digger.worldId) === normalizedWorldId)
      .filter((digger) => !normalizedOwner || normalizeNullableAddress(digger.owner) === normalizedOwner)
      .filter((digger) => !status || digger.status === status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
}

export function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!ADDRESS_RE.test(value)) throw new Error(`Invalid EVM address: ${address}`);
  return `0x${value.slice(2).toLowerCase()}`;
}

function normalizeNullableAddress(address) {
  if (!address) return null;
  return normalizeAddress(address);
}
