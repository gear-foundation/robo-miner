// Radar signals layer. Precomputes what the radar should surface for each
// meaningful object (ore cluster center, chest, void, anomaly) so the
// runtime just queries by category + radius instead of re-scanning blocks.
//
// Signal shape (target):
//   { x, y, category, power, echo, requiredRadarLevel }
//
// Stub for MVP-0. Current radar is pure fog-of-war (drawFog in GameScene);
// MVP-1 introduces drawSignals() on top of it.

export function placeSignals(/* grid, rnd, ctx */) {
  return []; // list of signal descriptors
}
