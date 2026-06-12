import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmp, file);
}

function archiveIdFor(world) {
  return `${world.id}-s${Number(world.sessionId || 0)}`;
}

export function createArchiveStore({ root, stateDir = 'state', cfg }) {
  const dir = path.isAbsolute(stateDir)
    ? path.join(stateDir, 'snapshots')
    : path.resolve(root, stateDir, 'snapshots');

  function fileFor(archiveId) {
    if (!SAFE_ID.test(String(archiveId || ''))) throw new Error(`invalid archive id: ${archiveId}`);
    return path.join(dir, `${archiveId}.json`);
  }

  async function save(world, snapshot) {
    const now = Date.now();
    const archiveId = world.archiveId || archiveIdFor(world);
    const payload = {
      schemaVersion: 1,
      archiveId,
      worldId: world.id,
      id: world.id,
      status: 'archived',
      programId: world.programId || null,
      seed: world.seed ?? null,
      mapHash: world.mapHash || null,
      sessionId: Number(world.sessionId || 0),
      agents: Number(world.agents || 0),
      owners: Array.isArray(world.owners) ? world.owners : [],
      minAgents: cfg?.lobbyMin ?? null,
      capAgents: cfg?.lobbyCap ?? null,
      createdAt: world.createdAt ?? null,
      openedAt: world.openedAt ?? null,
      startedAt: world.startedAt ?? null,
      finishedAt: world.finishedAt ?? now,
      archivedAt: now,
      snapshot,
    };
    await writeJson(fileFor(archiveId), payload);
    return { archiveId, archiveUrl: `/archives/${encodeURIComponent(archiveId)}`, archivedAt: now };
  }

  async function read(archiveId) {
    return JSON.parse(await readFile(fileFor(archiveId), 'utf8'));
  }

  return { save, read };
}
