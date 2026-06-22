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
  if (!response.ok) throw new Error(await backendErrorMessage(response, `Backend GET ${path} failed`));
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
  if (!response.ok) throw new Error(await backendErrorMessage(response, `Backend POST ${path} failed`));
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

export async function fetchAgentStats(params = {}) {
  const search = new URLSearchParams(params);
  const query = search.toString();
  const data = await backendGet(`/api/stats/agents${query ? `?${query}` : ''}`);
  return data?.agents || [];
}

export async function fetchDiggers({ owner = null, worldId = null, seasonId = null, status = null } = {}) {
  const search = new URLSearchParams();
  if (owner) search.set('owner', owner);
  if (worldId) search.set('world', worldId);
  if (seasonId) search.set('season', seasonId);
  if (status) search.set('status', status);
  const query = search.toString();
  const data = await backendGet(`/api/diggers${query ? `?${query}` : ''}`);
  return data?.diggers || [];
}

export async function fetchMyDigger({ owner, worldId = null, seasonId = null } = {}) {
  const diggers = await fetchDiggers({ owner, worldId, seasonId, status: 'active' });
  return diggers[0] || null;
}

export async function requestDiggerRental({ owner, worldId, seasonId = null, dryRun = undefined }) {
  return backendPost('/api/diggers/request', {
    owner,
    worldId,
    seasonId,
    dryRun,
  });
}

export async function ensureDiggerRental({ owner, worldId, seasonId = null, dryRun = undefined }) {
  const existing = await fetchMyDigger({ owner, worldId, seasonId });
  if (existing) return { status: 'existing', programId: existing.programId, digger: existing };
  return requestDiggerRental({ owner, worldId, seasonId, dryRun });
}

export async function submitSocialXTask({
  owner,
  taskType,
  tweetUrl,
  xUsername = '',
  seasonId = null,
  diggerProgramId = null,
}) {
  return backendPost('/api/social/x/submit', {
    owner,
    taskType,
    tweetUrl,
    xUsername,
    seasonId,
    diggerProgramId,
  });
}

export async function fetchSocialXSubmissions({ owner, limit = 20 }) {
  const search = new URLSearchParams();
  if (limit) search.set('limit', String(limit));
  const query = search.toString();
  const data = await backendGet(`/api/social/x/${encodeURIComponent(owner)}${query ? `?${query}` : ''}`);
  return data?.submissions || [];
}

async function backendErrorMessage(response, fallback) {
  const status = response.status;
  try {
    const json = await response.json();
    if (json?.error) return `${json.error}`;
    if (json?.message) return `${json.message}`;
  } catch {
    try {
      const text = await response.text();
      if (text) return `${fallback}: ${status}: ${text.slice(0, 180)}`;
    } catch { /* noop */ }
  }
  return `${fallback}: ${status}`;
}
