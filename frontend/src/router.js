export const ROUTES = {
  Landing: '/',
  Menu: '/menu',
  Leaderboard: '/leaderboard',
  Redeem: '/redeem-res',
  SocialFuel: '/free-wvara',
  Lobby: '/arena',
  Spectator: '/arena/watch',
  Game: '/game',
};

const ROUTE_SCENES = new Map(Object.entries(ROUTES).map(([scene, path]) => [path, scene]));
let currentIndex = 0;

export function normalizeInitialRoute() {
  if (window.location.hash === '#menu') {
    window.history.replaceState(null, '', '/menu');
  }
}

export function parseRoute(locationLike = window.location) {
  const pathname = normalizePath(locationLike?.pathname || '/');
  const params = new URLSearchParams(locationLike?.search || '');
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

  if (parts[0] === 'world' && parts[1]) {
    return { scene: 'Spectator', data: { mode: 'chain-live', seed: 0, programId: parts[1], backTo: 'Lobby' } };
  }
  if (parts[0] === 'replay' && parts[1]) {
    return { scene: 'Spectator', data: { mode: 'chain-replay', seed: 0, archiveId: parts[1], backTo: 'Lobby' } };
  }
  if (parts[0] === 'arena' && parts[1]) {
    return {
      scene: 'Spectator',
      data: {
        mode: parts[1],
        seed: Number(params.get('seed') || 0) || 0,
        backTo: 'Lobby',
      },
    };
  }
  if (parts[0] === 'play') return { scene: 'Game', data: {} };

  const scene = sceneForPath(pathname);
  return { scene, data: {} };
}

export function initialSceneKey() {
  return parseRoute().scene;
}

export function initialRoute() {
  return parseRoute();
}

export function routeForScene(sceneKey, data = {}) {
  if (sceneKey === 'Spectator' && data.mode === 'chain-live' && data.programId) {
    return `/world/${encodeURIComponent(data.programId)}`;
  }
  if (sceneKey === 'Spectator' && data.mode === 'chain-replay' && data.archiveId) {
    return `/replay/${encodeURIComponent(data.archiveId)}`;
  }
  if (sceneKey === 'Spectator' && data.mode) {
    const seed = data.seed == null ? '' : `?seed=${encodeURIComponent(String(data.seed))}`;
    return `/arena/${encodeURIComponent(data.mode)}${seed}`;
  }
  return ROUTES[sceneKey] || ROUTES.Landing;
}

export function sceneForPath(pathname) {
  const path = normalizePath(pathname);
  return ROUTE_SCENES.get(path) || 'Landing';
}

export function installHistoryRouter(game) {
  const route = parseRoute();
  window.history.replaceState({ scene: route.scene, data: route.data, index: currentIndex }, '', routeForScene(route.scene, route.data));
  window.addEventListener('popstate', (event) => {
    const route = event.state?.scene ? event.state : parseRoute();
    const nextScene = route.scene;
    const data = route.data || {};
    currentIndex = Number.isFinite(event.state?.index) ? event.state.index : 0;
    startSceneFromHistory(game, nextScene, data);
  });
}

export function navigateTo(scene, sceneKey, data = {}, options = {}) {
  const path = routeForScene(sceneKey, data);
  if (!options.replace) currentIndex += 1;
  const state = { scene: sceneKey, data, index: currentIndex };
  if (options.replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);
  scene.scene.start(sceneKey, data);
}

export function replaceRoute(sceneKey, data = {}) {
  const state = { scene: sceneKey, data, index: currentIndex };
  window.history.replaceState(state, '', routeForScene(sceneKey, data));
}

export function navigateBack(scene, fallbackScene = 'Menu', data = {}) {
  if (currentIndex > 0) {
    window.history.back();
    return;
  }
  navigateTo(scene, fallbackScene, data, { replace: true });
}

function normalizePath(pathname) {
  const path = pathname || '/';
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function startSceneFromHistory(game, sceneKey, data = {}) {
  const activeScenes = game.scene.getScenes(true);
  const target = game.scene.getScene(sceneKey);
  if (target?.scene?.isActive?.()) {
    target.scene.restart(data);
    return;
  }
  for (const active of activeScenes) {
    if (active.scene?.key !== sceneKey) active.scene.stop();
  }
  game.scene.start(sceneKey, data);
}
