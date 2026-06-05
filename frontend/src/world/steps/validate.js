import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

// Validator pass. MVP-0: only checks that the diamond is reachable from the
// spawn via drillable blocks (i.e. no wall of unbreakable STONE seals it off).
// Failure doesn't block generation — it only returns a report so the caller
// can log warnings or regenerate with a new seed.
//
// Later rules (MVP-1+):
//   - no choked starter zone
//   - unbreakable density <= cap per layer
//   - every POI has at least one approachable barrier pattern
//   - at least one meaningful signal within radarRadius + echoRange
//   - no chest fully buried without any clue
//   - no PvP vault inside a safe zone

export function validate(world, ctx) {
  const report = { ok: true, warnings: [] };

  const target = world.diamondPos;
  if (!target) return report;

  const spawn = {
    x: Math.floor(DIMS.W / 2),
    y: DIMS.S,
  };

  if (!reachable(world.grid, spawn, target)) {
    report.ok = false;
    report.warnings.push('diamond unreachable from spawn through drillable blocks');
  }

  return report;
}

// BFS over non-STONE cells. A drillable path exists if we can walk/dig
// through anything that isn't unbreakable STONE.
function reachable(grid, from, to) {
  const visited = new Uint8Array(DIMS.W * DIMS.H);
  const queue = [from.x, from.y];
  visited[idx(from.x, from.y)] = 1;

  while (queue.length > 0) {
    const y = queue.pop();
    const x = queue.pop();
    if (x === to.x && y === to.y) return true;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= DIMS.W || ny < 0 || ny >= DIMS.H) continue;
      if (visited[idx(nx, ny)]) continue;
      if (grid[idx(nx, ny)] === BLOCK.STONE) continue; // unbreakable blocks path
      visited[idx(nx, ny)] = 1;
      queue.push(nx, ny);
    }
  }
  return false;
}
