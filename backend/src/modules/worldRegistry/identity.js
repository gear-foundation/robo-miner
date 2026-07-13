const FACTORY_WORLD_ID = /^w0*(\d+)$/i;
const CONFIGURED_WORLD_ID = /^configured-world-(\d+)$/i;

// A world label is a stable human-facing alias. It is deliberately separate
// from programId, which remains the only identifier used in chain calls.
export function worldIdentity(world = {}) {
  const worldId = clean(world.worldId ?? world.id);
  const worldNumber = numberFrom(world.worldNumber) ?? numberFromId(worldId);
  const worldCode = clean(world.worldCode) || (worldNumber == null ? null : `W${String(worldNumber).padStart(3, '0')}`);
  const worldLabel = clean(world.worldLabel) || (worldCode ? `World ${worldCode}` : 'World');

  return { worldId, worldNumber, worldCode, worldLabel };
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function numberFromId(worldId) {
  if (!worldId) return null;
  const match = FACTORY_WORLD_ID.exec(worldId) || CONFIGURED_WORLD_ID.exec(worldId);
  return match ? numberFrom(match[1]) : null;
}

function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}
