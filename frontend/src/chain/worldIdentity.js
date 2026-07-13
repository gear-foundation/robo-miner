const FACTORY_WORLD_ID = /^w0*(\d+)$/i;
const CONFIGURED_WORLD_ID = /^configured-world-(\d+)$/i;
const PROGRAM_ID = /^0x[0-9a-f]{40}$/i;

export function worldLabelFor(world = {}) {
  const explicit = clean(world.worldLabel);
  if (explicit) return explicit;
  const code = worldCodeFor(world);
  return code ? `World ${code}` : 'World';
}

export function worldCodeFor(world = {}) {
  const explicit = clean(world.worldCode);
  if (explicit) return explicit;
  const number = worldNumberFor(world);
  return number == null ? null : `W${String(number).padStart(3, '0')}`;
}

export function worldNumberFor(world = {}) {
  const explicit = Number(world.worldNumber);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const id = clean(world.worldId ?? world.id);
  const match = id && (FACTORY_WORLD_ID.exec(id) || CONFIGURED_WORLD_ID.exec(id));
  return match ? Number(match[1]) : null;
}

export function seasonLabelFor(seasonId) {
  const value = clean(seasonId);
  if (!value) return null;
  const match = /^season-(.+)$/i.exec(value);
  return match ? `Season ${match[1]}` : value;
}

export function shortProgramId(programId) {
  const value = clean(programId);
  return value && value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value || 'Program unavailable';
}

export function isProgramId(value) {
  return PROGRAM_ID.test(String(value || ''));
}

function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}
