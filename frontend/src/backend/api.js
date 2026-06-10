import { CHAIN } from '../chain/config.js';

function baseUrl() {
  return String(CHAIN.backendUrl || '').replace(/\/+$/, '');
}

export function backendEnabled() {
  return Boolean(baseUrl());
}

export async function backendGet(path) {
  const base = baseUrl();
  if (!base) return null;
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`Backend GET ${path} failed: ${response.status}`);
  return response.json();
}

export async function backendPost(path, body) {
  const base = baseUrl();
  if (!base) return null;
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`Backend POST ${path} failed: ${response.status}`);
  return response.json();
}

export async function fetchManifest() {
  return backendGet('/api/manifest');
}

export async function fetchLiveWorlds() {
  const data = await backendGet('/api/worlds/live');
  return data?.worlds || [];
}

export async function fetchLeaderboard(params = {}) {
  const search = new URLSearchParams(params);
  const query = search.toString();
  const data = await backendGet(`/api/leaderboard${query ? `?${query}` : ''}`);
  return data?.leaderboard || [];
}

export async function requestDiggerRental({ owner, worldId, seasonId = null, dryRun = undefined }) {
  return backendPost('/api/diggers/request', {
    owner,
    worldId,
    seasonId,
    dryRun,
  });
}
