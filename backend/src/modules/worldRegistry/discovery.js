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
  const minAgents = numberOr(world.minAgents, config?.factoryLobbyMin ?? 1);
  const maxAgents = numberOr(world.targetAgents ?? world.maxAgents, 10);
  const agents = numberOr(world.agents, 0);
  const status = discoveryStatus(world.status);
  const canRegister = JOINABLE_STATUSES.has(status) && agents < maxAgents;
  const sessionId = world.sessionId ?? world.session ?? null;
  return {
    id: world.id,
    worldId: world.worldId || world.id,
    sessionKey: world.archiveId || `${world.id}-s${sessionId ?? world.seed ?? 0}`,
    programId: world.programId,
    status,
    phase: status,
    joinable: canRegister,
    canRegister,
    canPlay: status === 'active',
    agents,
    minAgents,
    maxAgents,
    slotsFree: Math.max(0, maxAgents - agents),
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
      'GET /matches and pick a match where joinable=true (registration is open or in-game late join is available, slotsFree > 0)',
      'Send an injected World.Register(owner) to that match.programId',
      'Wait until the session is active (the operator starts it at minAgents, or the contract auto-starts at maxAgents)',
      'Play with injected txs: Drill(dir) / MoveAgent(dir) / PlaceLadder(dir) / Surface()',
    ],
    actions: { drill: 'Drill(dir)', move: 'MoveAgent(dir)', ladder: 'PlaceLadder(dir)', surface: 'Surface()' },
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
