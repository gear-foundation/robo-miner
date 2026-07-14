import { worldIdentity } from './identity.js';

const DIR_HINT = '0=up 1=right 2=down 3=left (4=current, for place_ladder under-foot)';

const PAST_STATUSES = new Set(['finished', 'retired', 'archived']);
const OPEN_STATUSES = new Set(['map_ready', 'deployed', 'waiting_agents', 'open']);
const JOINABLE_STATUSES = new Set(['open', 'active']);

export function discoveryFromManifest(manifest, config, now = () => new Date()) {
  const worlds = Array.isArray(manifest?.worlds) ? manifest.worlds : [];
  const sessions = worlds
    .filter((world) => world.programId)
    .map((world) => sessionRecord(world, config));
  return {
    updatedAt: now().toISOString(),
    register: registerInfo(config),
    matches: sessions.filter((session) => session.joinable),
    sessions,
  };
}

export function sessionRecord(world, config) {
  const identity = worldIdentity(world);
  const minAgents = numberOr(world.minAgents, config?.factoryLobbyMin ?? 1);
  const maxAgents = numberOr(world.targetAgents ?? world.maxAgents, 10);
  const registeredAgents = numberOr(world.registeredAgents,
    numberOr(world.agents, Array.isArray(world.owners) ? world.owners.length : 0));
  const activeAgents = numberOr(world.activeAgents, numberOr(world.agents, 0));
  const status = discoveryStatus(world.status);
  const canRegister = JOINABLE_STATUSES.has(status) && registeredAgents < maxAgents;
  const sessionId = world.sessionId ?? world.session ?? null;
  return {
    id: world.id,
    ...identity,
    sessionKey: world.archiveId || `${world.id}-s${sessionId ?? world.seed ?? 0}`,
    programId: world.programId,
    status,
    phase: status,
    joinable: canRegister,
    canRegister,
    canPlay: status === 'active',
    agents: activeAgents,
    activeAgents,
    registeredAgents,
    minAgents,
    maxAgents,
    slotsFree: Math.max(0, maxAgents - registeredAgents),
    owners: Array.isArray(world.owners) ? world.owners : [],
    seed: world.seed,
    mapHash: world.mapHash || null,
    sessionId,
    startsAt: world.startsAt || null,
    endsAt: world.endsAt || null,
    sessionAutofinish: Boolean(world.sessionAutofinish ?? config.factorySessionAutofinish ?? false),
    finishedAt: world.finishedAt || world.chain?.finishedAt || null,
    archivedAt: world.archivedAt || null,
    archiveId: world.archiveId || null,
    archiveUrl: world.archiveUrl || (world.archiveId ? `/archives/${encodeURIComponent(world.archiveId)}` : null),
  };
}

export function registerInfo(config) {
  return {
    network: config.network || 'mainnet',
    router: config.routerAddress || null,
    varaWs: config.varaEthWs || null,
    ethRpc: config.ethRpc || null,
    gasless: true,
    owner: "actorId of your address: '0x' + 24 zero bytes (12) + your 20-byte EOA",
    steps: [
      'GET /matches and pick a match where joinable=true; retain match.worldLabel for display and match.programId for a rented proxy request',
      'POST /api/diggers/request for that world and wait until its rented DiggerProxy is active',
      'Call Digger/Register through that rented proxy (never call World.Register directly)',
      'Wait until the session is active (the operator starts it at minAgents, or the contract auto-starts at maxAgents)',
      'Play through the same proxy: Digger/Drill(dir) / Digger/MoveAgent(dir) / Digger/PlaceLadder(dir) / Digger/Surface()',
    ],
    actions: { register: 'Digger/Register', drill: 'Digger/Drill(dir)', move: 'Digger/MoveAgent(dir)', ladder: 'Digger/PlaceLadder(dir)', surface: 'Digger/Surface()' },
    directions: DIR_HINT,
  };
}

function discoveryStatus(status) {
  const value = String(status || '');
  if (OPEN_STATUSES.has(value)) return 'open';
  if (PAST_STATUSES.has(value)) return 'archived';
  return value || 'unknown';
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
