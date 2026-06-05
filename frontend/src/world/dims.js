// Generation-active world dimensions.
//
// World generation is a single SYNCHRONOUS, non-reentrant pass: generateWorld()
// calls setDims() once at the start, then every step reads the active size via
// idx() and DIMS.W/H/S. This keeps the ~90 generation call sites untouched while
// making the map size a parameter.
//
// IMPORTANT: DIMS is the *generation* config only. At RUNTIME each world carries
// its own W/H (grid.getBlock reads world.W), so multiple worlds of different
// sizes coexist — DIMS is never a runtime source of truth.

import { WORLD_W, WORLD_H, SURFACE_Y } from '../config.js';

// The reference playable depth (solo). All absolute depth constants in the
// generation steps are authored against this; scaleDepth() compresses them to
// the active world so a shallower preset keeps the same relative layout.
const REFERENCE_PLAYABLE = WORLD_H - SURFACE_Y; // 246

export const DIMS = { W: WORLD_W, H: WORLD_H, S: SURFACE_Y, depthScale: 1 };

export function setDims({ width, height, surface } = {}) {
  DIMS.W = width ?? WORLD_W;
  DIMS.H = height ?? WORLD_H;
  DIMS.S = surface ?? SURFACE_Y;
  DIMS.depthScale = (DIMS.H - DIMS.S) / REFERENCE_PLAYABLE;
  return DIMS;
}

// Scale an absolute reference-depth constant (authored for the 246-deep solo
// world) onto the current world. depthScale === 1 for solo ⇒ byte-identical.
export function scaleDepth(d) {
  return Math.round(d * DIMS.depthScale);
}
