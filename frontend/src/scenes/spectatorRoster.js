// Pure spectator-roster helpers. Keeping identity and live metric formatting
// outside the Phaser scene makes local and chain diggers behave identically.

export function spectatorAgentKey(agent = {}) {
  if (agent.owner) return `chain:${String(agent.owner).toLowerCase()}`;
  return `local:${String(agent.id ?? agent.name ?? 'unknown')}`;
}

// Chain snapshots replace miner objects. Resolve by the stable spectator key
// whenever a scene needs the current rendered instance.
export function findSpectatorAgent(agents = [], key) {
  if (!key) return null;
  return agents.find((agent) => spectatorAgentKey(agent) === key) || null;
}

export function spectatorDepth(agent = {}, surface = 0) {
  return Math.max(0, Number(agent.ty ?? 0) - (Number(surface) - 1));
}

export function canFollowSpectatorAgent(agent = {}) {
  return !agent.exited && Number.isFinite(Number(agent.drawX ?? agent.tx)) &&
    Number.isFinite(Number(agent.drawY ?? agent.ty));
}

export function localCargoCount(agent = {}) {
  if (Number.isFinite(Number(agent.cargoCount))) return Number(agent.cargoCount);
  if (!agent.cargo || typeof agent.cargo !== 'object') return 0;
  return Object.values(agent.cargo).reduce((sum, count) => sum + Number(count || 0), 0);
}
