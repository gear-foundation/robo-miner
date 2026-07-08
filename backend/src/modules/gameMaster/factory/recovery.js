const RESTORABLE_SESSION_STATUSES = new Set([0, 1, 2]);

export function persistedWorldLooksOpened(world) {
  const sessionId = Number(world?.sessionId || 0);
  const seed = Number(world?.seed || 0);
  return Boolean(
    world?.programId &&
    Number.isFinite(sessionId) &&
    sessionId > 0 &&
    Number.isFinite(seed) &&
    seed > 0 &&
    world?.mapHash,
  );
}

export function isRestorableProgramSnapshot({ session, rawGrid } = {}) {
  if (!Array.isArray(session) || session.length < 3) return false;
  const sessionId = Number(session[0] || 0);
  const seed = Number(session[1] || 0);
  const status = Number(session[2]);
  if (!Number.isFinite(sessionId) || sessionId <= 0) return false;
  if (!Number.isFinite(seed) || seed <= 0) return false;
  if (!RESTORABLE_SESSION_STATUSES.has(status)) return false;
  if (!Array.isArray(rawGrid) || rawGrid.length === 0) return false;
  return rawGrid.some((tile) => Number(tile) > 0);
}
