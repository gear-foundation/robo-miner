// World presets — one shape per mode. A WorldSpec is plain data passed to
// generateWorld(seed, spec). `solo` reproduces today's single-player world
// exactly (defaults = config constants + no regen), so single-player is
// untouched (verified by a grid-hash baseline).
//
// Depth landmarks (diamond / lava / water) scale with `height` via DIMS.depthScale
// (see dims.js + scaleDepth()), so a shallower preset keeps the same relative
// layout. `regen` retries generation with new seeds until the diamond is
// reachable — on for agent presets, off for solo (which stays warn-only).

import { WORLD_W, WORLD_H, SURFACE_Y } from '../config.js';

const SOLO = {
  name: 'solo',
  width: WORLD_W, // 120
  height: WORLD_H, // 250
  surface: SURFACE_Y,
  regen: false,
};

export const WORLD_PRESETS = {
  solo: SOLO,
  // 10-agent DIGGER world per the Vara.eth brief: narrow & deep 40×64 for
  // density + competition over a session. `model:'digger'` switches generation
  // to dirt + caves + stones + contract-resolved chests + 3 redeemable crystals
  // (no 8-ore economy / diamond). The GameScene renderer is world-size aware.
  agents: { ...SOLO, name: 'agents', width: 40, height: 64, model: 'digger', regen: true },
  coop: { ...SOLO, name: 'coop', width: 200, height: 160, regen: true },
  arena: { ...SOLO, name: 'arena', width: 140, height: 110, regen: true },
};

// Accept: undefined → solo; a preset name string; or a partial spec object.
export function resolveSpec(spec) {
  if (!spec) return { ...SOLO };
  if (typeof spec === 'string') return { ...(WORLD_PRESETS[spec] || SOLO) };
  return { ...SOLO, ...spec };
}
