// Registry publisher — writes the factory's worlds into gamemaster.json, the file
// the colleague's World Registry ingests via syncFromGameMaster(). Record shape +
// status vocabulary match backend/src/modules/worldRegistry (normalizeWorld) and
// the existing gamemaster.js, so their showcase serves our worlds unchanged.

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

export function createRegistryPublisher({ cfg, env = {}, stateDir = 'state', now = Date.now, worldRegistry = null }) {
  const dir = path.isAbsolute(stateDir) ? stateDir : path.resolve(ROOT, stateDir);
  const file = path.join(dir, 'gamemaster.json');
  const deployMode = env.adminKey ? 'live' : 'dry-run';
  let createdAt = null;

  function toRecord(world, ts) {
    const startsAt = world.startedAt ?? world.openedAt ?? world.createdAt;
    return {
      schemaVersion: 1,
      id: world.id,
      status: STATUS_MAP[world.status] || world.status,
      deployMode,
      programId: world.programId || null,
      seed: String(world.seed ?? ''),
      network: env.network || 'mainnet',
      router: env.router || null,
      createdAt: iso(world.createdAt),
      updatedAt: ts,
      startsAt: iso(startsAt),
      endsAt: cfg.sessionAutofinish && world.startedAt ? iso(world.startedAt + cfg.sessionMs) : null,
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
    };
  }

  return {
    file,
    async publish(worlds) {
      const ts = new Date(now()).toISOString();
      if (!createdAt) createdAt = ts;
      const records = worlds.map((world) => toRecord(world, ts));
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
      await worldRegistry?.syncWorldRecords(records, { source: 'factory', mode: deployMode });
    },
  };
}
