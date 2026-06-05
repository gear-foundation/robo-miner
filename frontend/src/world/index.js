// Public world API. Everything outside src/world/ should import from here
// (or from the back-compat shim at src/world.js).

export { generateWorld } from './pipeline.js';
export { getBlock, setBlock, isSolid, isClimbable } from './grid.js';
