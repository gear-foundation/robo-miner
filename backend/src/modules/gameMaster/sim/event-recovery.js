export const DEFAULT_MAP_WIDTH = 40;
export const AGENT_DEAD = 3;

export function isAgentDead(agent) {
  if (!agent) return false;
  return Number(agent.status) === AGENT_DEAD || Number(agent.hp) <= 0;
}

export function tileAt(map, x, y, width = DEFAULT_MAP_WIDTH) {
  if (!Array.isArray(map) && !(map instanceof Uint8Array)) return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) return undefined;
  return map[y * width + x];
}

export function inferStoneMoves(beforeMap, afterMap, {
  width = DEFAULT_MAP_WIDTH,
  stoneTile = 2,
  drilledTarget = null,
  columns = null,
} = {}) {
  if (!beforeMap || !afterMap || beforeMap.length !== afterMap.length) return [];
  const height = Math.floor(beforeMap.length / width);
  const scanColumns = Array.isArray(columns) && columns.length
    ? columns.filter((x) => Number.isInteger(x) && x >= 0 && x < width)
    : Array.from({ length: width }, (_, x) => x);
  const removedByX = new Map();
  const addedByX = new Map();

  const push = (map, x, point) => {
    const values = map.get(x) || [];
    values.push(point);
    map.set(x, values);
  };

  for (const x of scanColumns) {
    for (let y = 0; y < height; y += 1) {
      const before = beforeMap[y * width + x];
      const after = afterMap[y * width + x];
      const isDrilledStone = drilledTarget && drilledTarget.x === x && drilledTarget.y === y;
      if (before === stoneTile && after !== stoneTile && !isDrilledStone) {
        push(removedByX, x, { x, y });
      }
      if (before !== stoneTile && after === stoneTile) {
        push(addedByX, x, { x, y });
      }
    }
  }

  const moves = [];
  for (const [x, removed] of removedByX) {
    const added = addedByX.get(x) || [];
    removed.sort((a, b) => b.y - a.y);
    added.sort((a, b) => b.y - a.y);
    const count = Math.min(removed.length, added.length);
    for (let i = 0; i < count; i += 1) {
      if (removed[i].y === added[i].y) continue;
      moves.push({ fromX: x, fromY: removed[i].y, x, y: added[i].y });
    }
  }
  return moves;
}

export function inferDeathCause({ action, beforeMap, after, stoneMoves = [], width = DEFAULT_MAP_WIDTH, tiles = {} } = {}) {
  const stoneTile = tiles.STONE ?? 2;
  const lavaTile = tiles.LAVA ?? 3;
  if (stoneMoves.some((move) => move.x === after?.x && move.y === after?.y)) return stoneTile;
  if (action?.target && tileAt(beforeMap, action.target.x, action.target.y, width) === lavaTile) return lavaTile;
  return stoneTile;
}
