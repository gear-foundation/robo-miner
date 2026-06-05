import { BLOCK, BLOCK_DATA } from '../config.js';
import { DIMS } from './dims.js';

// idx / inBounds read the GENERATION-active dimensions (set by generateWorld).
// They are only used during the synchronous generation pass.
export function idx(x, y) {
  return y * DIMS.W + x;
}

export function inBounds(x, y) {
  return x >= 0 && x < DIMS.W && y >= 0 && y < DIMS.H;
}

// Runtime block access reads the world's OWN dimensions (each world carries
// W/H), so worlds of different sizes coexist. Falls back to DIMS for any caller
// that passes a world without explicit dims.
export function getBlock(world, x, y) {
  const W = world.W ?? DIMS.W;
  const H = world.H ?? DIMS.H;
  if (x < 0 || x >= W || y < 0 || y >= H) return BLOCK.STONE;
  return world.grid[y * W + x];
}

export function setBlock(world, x, y, type) {
  const W = world.W ?? DIMS.W;
  const H = world.H ?? DIMS.H;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  world.grid[y * W + x] = type;
}

export function isSolid(type) {
  return BLOCK_DATA[type]?.solid === true;
}

export function isClimbable(type) {
  return BLOCK_DATA[type]?.climbable === true;
}
