// Registry publisher — writes factory worlds into the World Registry. In
// production this goes directly to Postgres; local JSON mode still writes the
// legacy gamemaster.json file for dry-run/debug flows.

import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../../..'); // backend/src/modules/gameMaster/factory → repo root

// Factory states → shared WorldRegistry/gamemaster status vocabulary.
const STATUS_MAP = {
  provisioning: 'deployed',
  open: 'waiting_agents',
  active: 'active',
  finished: 'finished',
  retired: 'archived',
};

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function archiveIdFor(world) {
  return `${world.id}-s${world.sessionId ?? 0}`;
}

export function createRegistryPublisher({ cfg, env = {}, stateDir = 'state', now = Date.now, worldRegistry = null }) {
  const dir = path.isAbsolute(stateDir) ? stateDir : path.resolve(ROOT, stateDir);
  const file = path.join(dir, 'gamemaster.json');
  const deployMode = env.adminKey ? 'live' : 'dry-run';
  let createdAt = null;

  function toRecord(world, ts) {
    const startsAt = world.startedAt ?? world.openedAt ?? world.createdAt;
    const status = STATUS_MAP[world.status] || world.status;
    const archiveId = status === 'archived'
      ? (world.archiveId || archiveIdFor(world))
      : (world.archiveId || null);
    const id = status === 'archived' ? archiveId : world.id;
    return {
      schemaVersion: 1,
      id,
      worldId: world.id,
      status,
      deployMode,
      programId: world.programId || null,
      seed: String(world.seed ?? ''),
      network: env.network || 'mainnet',
      router: env.router || null,
      createdAt: iso(world.createdAt),
      updatedAt: ts,
      startsAt: iso(startsAt),
      endsAt: cfg.sessionAutofinish && world.startedAt ? iso(world.startedAt + cfg.sessionMs) : null,
      sessionId: world.sessionId ?? null,
      sessionMs: cfg.sessionMs,
      sessionAutofinish: Boolean(cfg.sessionAutofinish),
      admission: {
        minAgents: cfg.lobbyMin,
        targetAgents: cfg.lobbyCap,
        // Real on-chain owner ActorIds (World.Agents()); falls back to synthetic
        // only if owners haven't been polled yet.
        registeredAgents:
          world.owners && world.owners.length
            ? world.owners
            : Array.from({ length: world.agents }, (_, i) => `${world.id}-agent-${i}`),
      },
      map: { hash: world.mapHash || null },
      paths: {},
      chain: { startedAt: iso(world.startedAt), finishedAt: iso(world.finishedAt) },
      finishedAt: iso(world.finishedAt),
      archivedAt: iso(world.archivedAt),
      archiveId,
      archiveUrl: world.archiveUrl || (status === 'archived' && archiveId ? `/archives/${encodeURIComponent(archiveId)}` : null),
    };
  }

  return {
    file,
    async publish(worlds) {
      const ts = new Date(now()).toISOString();
      if (!createdAt) createdAt = ts;
      const records = worlds.map((world) => toRecord(world, ts));
      if (worldRegistry) {
        await worldRegistry.syncWorldRecords(records, { source: 'factory', mode: deployMode });
        return;
      }
      const payload = {
        schemaVersion: 1,
        createdAt,
        updatedAt: ts,
        worlds: records,
      };
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(tmp, file);
    },
  };
}
