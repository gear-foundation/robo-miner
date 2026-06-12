// Smart agent brain (pure planner) — ported from contracts/scripts/agent-step-events.ts.
//
// Given an agent view + the current map, decide the next single action so the
// agent plays the real loop: dig toward the nearest reachable resource while
// ALWAYS reserving enough ladders to climb home, fill the backpack, then climb
// back to the surface (placing ladders) and bank. No chain or IO here — the
// driver feeds it state and executes the returned action.
//
// Difference from the original: in our contract STONE is undrillable (it's the
// map boundary / obstacle), so the planner treats stone as a solid wall — never
// drills or routes through it.

export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 64;

export const TILE = {
  EMPTY: 0, DIRT: 1, STONE: 2, LAVA: 3, LADDER: 4,
  SCRST: 10, BCRST: 11, HCRST: 12, SURFACE: 20,
};

export const DIRECTIONS = [
  { name: 'up', value: 0, dx: 0, dy: -1 },
  { name: 'right', value: 1, dx: 1, dy: 0 },
  { name: 'down', value: 2, dx: 0, dy: 1 },
  { name: 'left', value: 3, dx: -1, dy: 0 },
];
export const CURRENT = { name: 'current', value: 4, dx: 0, dy: 0 };

const idx = (x, y) => y * MAP_WIDTH + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP_WIDTH && y < MAP_HEIGHT;
const tileAt = (map, x, y) => map[idx(x, y)] ?? TILE.EMPTY;

const isResource = (t) => t === TILE.SCRST || t === TILE.BCRST || t === TILE.HCRST;
const isDrillable = (t) => t === TILE.DIRT || isResource(t); // NOT stone (undrillable)
const isTraversable = (t) => t === TILE.EMPTY || t === TILE.SURFACE || t === TILE.LADDER;

export function agentFromView(view) {
  const v = view.map(Number);
  return {
    status: v[0], x: v[1], y: v[2], hp: v[3], ladders: v[4],
    invScrst: v[5], invBcrst: v[6], invHcrst: v[7],
    bankedScrst: v[8], bankedBcrst: v[9], bankedHcrst: v[10],
    capacity: v[11], lastActionSeq: v[12],
  };
}
export const carried = (a) => a.invScrst + a.invBcrst + a.invHcrst;

function targetPosition(x, y, dir) {
  const t = { x: x + dir.dx, y: y + dir.dy };
  return inBounds(t.x, t.y) ? t : null;
}

// Can the agent step from (x,y) in `dir`? Movement enters traversable tiles or
// drills dirt; never stone/lava/resource. Up requires a ladder at current/target.
function canMoveInto(map, x, y, dir) {
  const t = targetPosition(x, y, dir);
  if (!t) return false;
  const cur = tileAt(map, x, y);
  const tgt = tileAt(map, t.x, t.y);
  if (tgt === TILE.LAVA || tgt === TILE.STONE || isResource(tgt)) return false;
  if (dir.name === 'up' && cur !== TILE.LADDER && tgt !== TILE.LADDER) return false;
  return isTraversable(tgt) || tgt === TILE.DIRT;
}

const movementCost = (t) => (isTraversable(t) ? 1 : t === TILE.DIRT ? 2 : Number.POSITIVE_INFINITY);

function reconstructPath(previous, startIndex, endIndex) {
  const path = [];
  let cursor = endIndex;
  while (cursor !== startIndex) {
    const step = previous[cursor];
    if (!step) return null;
    path.push(step.direction);
    cursor = step.from;
  }
  path.reverse();
  return path;
}

// Dijkstra over the map (drilling through dirt costs 2, walking costs 1) to every
// cell, then the cheapest stand-next-to-a-resource plan, sorted by cost.
function findResourcePlans(agent, map, targetResource) {
  const cells = MAP_WIDTH * MAP_HEIGHT;
  const start = idx(agent.x, agent.y);
  const dist = new Array(cells).fill(Number.POSITIVE_INFINITY);
  const prev = new Array(cells).fill(null);
  const queue = new Set([start]);
  dist[start] = 0;

  while (queue.size > 0) {
    let cur = -1;
    let best = Number.POSITIVE_INFINITY;
    for (const c of queue) { if (dist[c] < best) { cur = c; best = dist[c]; } }
    if (cur < 0) break;
    queue.delete(cur);
    const x = cur % MAP_WIDTH;
    const y = Math.floor(cur / MAP_WIDTH);
    for (const dir of DIRECTIONS) {
      if (!canMoveInto(map, x, y, dir)) continue;
      const t = targetPosition(x, y, dir);
      if (!t) continue;
      const ti = idx(t.x, t.y);
      const nd = best + movementCost(tileAt(map, t.x, t.y));
      if (nd < dist[ti]) { dist[ti] = nd; prev[ti] = { from: cur, direction: dir }; queue.add(ti); }
    }
  }

  const plans = [];
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const tile = tileAt(map, x, y);
      if (!isResource(tile)) continue;
      if (targetResource != null && tile !== targetResource) continue;
      for (const rd of DIRECTIONS) {
        const standX = x - rd.dx;
        const standY = y - rd.dy;
        if (!inBounds(standX, standY)) continue;
        const si = idx(standX, standY);
        if (!Number.isFinite(dist[si])) continue;
        const path = reconstructPath(prev, start, si);
        if (!path) continue;
        plans.push({ path, resourceDirection: rd, resource: { x, y, tile }, cost: dist[si] + 1 });
      }
    }
  }
  plans.sort((a, b) => a.cost - b.cost);
  return plans;
}

const findNearestResourcePlan = (agent, map, target) => findResourcePlans(agent, map, target)[0] ?? null;

// BFS to the surface (y=0) over ALREADY-OPEN tiles only (empty/surface/ladder).
function findSurfacePath(agent, map) {
  const start = idx(agent.x, agent.y);
  const prev = new Array(MAP_WIDTH * MAP_HEIGHT).fill(null);
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    const x = cur % MAP_WIDTH;
    const y = Math.floor(cur / MAP_WIDTH);
    if (y === 0) return reconstructPath(prev, start, cur);
    for (const dir of DIRECTIONS) {
      const t = targetPosition(x, y, dir);
      if (!t) continue;
      if (!isTraversable(tileAt(map, t.x, t.y))) continue;
      const ti = idx(t.x, t.y);
      if (visited.has(ti)) continue;
      visited.add(ti);
      prev[ti] = { from: cur, direction: dir };
      queue.push(ti);
    }
  }
  return null;
}

// How many ladders a path consumes (each up-step where neither tile is a ladder).
function requiredLaddersForPath(agent, map, path) {
  let x = agent.x;
  let y = agent.y;
  let needed = 0;
  for (const dir of path) {
    const t = targetPosition(x, y, dir);
    if (!t) return Number.POSITIVE_INFINITY;
    const cur = tileAt(map, x, y);
    const tgt = tileAt(map, t.x, t.y);
    if (dir.name === 'up' && cur !== TILE.LADDER && tgt !== TILE.LADDER) needed += 1;
    x = t.x; y = t.y;
  }
  return needed;
}

function surfaceReturnPlan(agent, map) {
  const path = findSurfacePath(agent, map);
  if (!path) return null;
  return { path, pathNames: path.map((s) => s.name), laddersNeeded: requiredLaddersForPath(agent, map, path) };
}

const mapWithTile = (map, x, y, tile) => { const n = map.slice(); n[idx(x, y)] = tile; return n; };

// Apply an action to a (cloned) agent+map for return-safety simulation.
function simulateAction(agent, map, action) {
  if (action.fn === 'move') {
    if (!action.target) return null;
    return { agent: { ...agent, x: action.target.x, y: action.target.y }, map };
  }
  if (action.fn === 'drill') {
    if (!action.target) return null;
    if (!isDrillable(tileAt(map, action.target.x, action.target.y))) return null;
    return { agent, map: mapWithTile(map, action.target.x, action.target.y, TILE.EMPTY) };
  }
  if (action.fn === 'placeLadder') {
    if (agent.ladders <= 0) return null;
    const t = action.target ?? { x: agent.x, y: agent.y };
    return { agent: { ...agent, ladders: agent.ladders - 1 }, map: mapWithTile(map, t.x, t.y, TILE.LADDER) };
  }
  return { agent, map };
}

function returnSafeAfter(agent, map, action) {
  const sim = simulateAction(agent, map, action);
  if (!sim) return { safe: false };
  const ret = surfaceReturnPlan(sim.agent, sim.map);
  if (!ret) return { safe: false };
  return { safe: ret.laddersNeeded <= sim.agent.ladders, laddersNeeded: ret.laddersNeeded };
}

function plannedActionForDirection(agent, map, dir) {
  const target = targetPosition(agent.x, agent.y, dir);
  if (!target) return null;
  if (!canMoveInto(map, agent.x, agent.y, dir)) return null;
  const tile = tileAt(map, target.x, target.y);
  if (isDrillable(tile)) return { fn: 'drill', dir, target, tile };
  if (!isTraversable(tile)) return null;
  return { fn: 'move', dir, target, tile };
}

// Walk a full resource plan, checking that EVERY step keeps a funded return path
// (so the agent never digs itself into a hole it can't climb out of).
function returnSafeForPlan(agent, map, plan) {
  let a = agent;
  let m = map;
  const step = (action) => {
    const s = returnSafeAfter(a, m, action);
    if (!s.safe) return false;
    const sim = simulateAction(a, m, action);
    if (!sim) return false;
    a = sim.agent; m = sim.map;
    return true;
  };
  for (const dir of plan.path) {
    const first = plannedActionForDirection(a, m, dir);
    if (!first) return false;
    if (first.fn === 'drill' && !step(first)) return false;
    const move = plannedActionForDirection(a, m, dir);
    if (!move || move.fn !== 'move') return false;
    if (!step(move)) return false;
  }
  const t = targetPosition(a.x, a.y, plan.resourceDirection);
  if (!t || t.x !== plan.resource.x || t.y !== plan.resource.y) return false;
  if (!isResource(tileAt(m, t.x, t.y))) return false;
  if (!step({ fn: 'drill', dir: plan.resourceDirection, target: t, tile: tileAt(m, t.x, t.y) })) return false;
  const fin = surfaceReturnPlan(a, m);
  return Boolean(fin && fin.laddersNeeded <= a.ladders);
}

function chooseMineAction(agent, map, plan) {
  const dir = plan.path[0] ?? plan.resourceDirection;
  const target = targetPosition(agent.x, agent.y, dir);
  if (!target) return null;
  const tile = tileAt(map, target.x, target.y);
  if (isDrillable(tile)) return { fn: 'drill', dir, target, tile, resource: isResource(tile) ? plan.resource : undefined };
  if (!isTraversable(tile)) return null;
  return { fn: 'move', dir, target, tile };
}

function findReturnSafeMineAction(agent, map, target) {
  for (const plan of findResourcePlans(agent, map, target)) {
    if (!returnSafeForPlan(agent, map, plan)) continue;
    const action = chooseMineAction(agent, map, plan);
    if (!action) continue;
    if (returnSafeAfter(agent, map, action).safe) return action;
  }
  return null;
}

// One climb-toward-surface step: at y=0 bank; else place a ladder under our feet
// when an up-move needs it, otherwise step along the open path to the surface.
function chooseSurfaceAction(agent, map) {
  if (agent.y === 0) return { fn: 'surface' };
  const path = findSurfacePath(agent, map);
  if (!path || path.length === 0) return null;
  const dir = path[0];
  const target = targetPosition(agent.x, agent.y, dir);
  if (!target) return null;
  const cur = tileAt(map, agent.x, agent.y);
  const tgt = tileAt(map, target.x, target.y);
  if (dir.name === 'up' && cur !== TILE.LADDER && tgt !== TILE.LADDER) {
    return { fn: 'placeLadder', dir: CURRENT, target: { x: agent.x, y: agent.y } };
  }
  return { fn: 'move', dir, target, tile: tgt };
}

// Decide the next single action. `state` carries the persistent mine/surface mode
// per agent. Returns { action, mode } or { action: null } when nothing is doable.
export function decideAction(agent, map, state = {}) {
  let mode = state.mode || 'mine';

  if (mode === 'mine') {
    const ret = surfaceReturnPlan(agent, map);
    const tight = ret && ret.laddersNeeded >= agent.ladders;
    if (carried(agent) > 0 && (agent.y === 0 || carried(agent) >= agent.capacity || tight)) {
      mode = 'surface';
    }
  }

  if (mode === 'surface') {
    if (agent.y === 0) {
      if (carried(agent) > 0) return { action: { fn: 'surface' }, mode };
      mode = 'mine'; // banked → dive again
    } else {
      const action = chooseSurfaceAction(agent, map);
      if (action) return { action, mode };
      // No open path up (shouldn't happen if we kept return-safety) → try to dig.
    }
  }

  // mine: head for the nearest return-safe resource.
  const safe = findReturnSafeMineAction(agent, map, null);
  if (safe) return { action: safe, mode: 'mine' };

  // Nothing return-safe: if carrying, go bank; else nudge downward to open the map.
  if (carried(agent) > 0) return { action: chooseSurfaceAction(agent, map), mode: 'surface' };
  const down = plannedActionForDirection(agent, map, DIRECTIONS[2]);
  if (down && returnSafeAfter(agent, map, down).safe) return { action: down, mode: 'mine' };
  return { action: null, mode };
}
