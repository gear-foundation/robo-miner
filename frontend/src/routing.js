export function parseRoute(locationLike = window.location) {
  const path = String(locationLike?.pathname || '/').replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(locationLike?.search || '');
  const parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

  if (parts[0] === 'world' && parts[1]) {
    return { scene: 'Spectator', data: { mode: 'chain-live', seed: 0, programId: parts[1] } };
  }
  if (parts[0] === 'arena' && parts[1]) {
    return {
      scene: 'Spectator',
      data: {
        mode: parts[1],
        seed: Number(params.get('seed') || 0) || 0,
      },
    };
  }
  if (parts[0] === 'arena') return { scene: 'Lobby', data: {} };
  if (parts[0] === 'play') return { scene: 'Game', data: {} };
  return { scene: 'Menu', data: {} };
}

export function routePath(scene, data = {}) {
  if (scene === 'Spectator' && data.mode === 'chain-live' && data.programId) {
    return `/world/${encodeURIComponent(data.programId)}`;
  }
  if (scene === 'Spectator' && data.mode) {
    const seed = data.seed == null ? '' : `?seed=${encodeURIComponent(String(data.seed))}`;
    return `/arena/${encodeURIComponent(data.mode)}${seed}`;
  }
  if (scene === 'Lobby') return '/arena';
  if (scene === 'Game') return '/play';
  return '/';
}

export function setRoute(scene, data = {}, { replace = false } = {}) {
  if (typeof window === 'undefined' || !window.history) return;
  const next = routePath(scene, data);
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === next) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({ scene, data }, '', next);
}
