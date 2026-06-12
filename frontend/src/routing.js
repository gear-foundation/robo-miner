import { parseRoute, replaceRoute, routeForScene } from './router.js';

export { parseRoute };

export function routePath(scene, data = {}) {
  return routeForScene(scene, data);
}

export function setRoute(scene, data = {}, { replace = false } = {}) {
  if (typeof window === 'undefined' || !window.history) return;
  if (replace) {
    replaceRoute(scene, data);
    return;
  }
  const next = routeForScene(scene, data);
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === next) return;
  window.history.pushState({ scene, data }, '', next);
}
