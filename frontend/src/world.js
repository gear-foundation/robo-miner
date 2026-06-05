// Back-compat shim. Existing imports (e.g. in GameScene) keep working while
// the real implementation lives in src/world/. New code should import from
// './world/index.js' or './world/<module>.js' directly.

export { generateWorld, getBlock, setBlock, isSolid, isClimbable } from './world/index.js';
