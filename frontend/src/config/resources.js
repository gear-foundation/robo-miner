// Unified resource table with peak distribution.
//
// Each resource has a triangular min/peak/max depth window. The probability
// of a tile or vein origin being that resource is highest at peakDepth and
// falls off toward minDepth/maxDepth following a gaussian curve.
//
// Metadata fields (rarity/pattern/signalPower/value/pvpImportance/
// requiredDrillTier) are already written so later steps (signals, loot,
// radar) can consume them without another schema migration.
//
// Depth is meters below surface (1 tile == 1 m).

import { BLOCK } from '../config.js';

export const RESOURCES = [
  {
    type: BLOCK.COAL, name: 'coal',
    minDepth: 2, peakDepth: 15, maxDepth: 34,
    maxChance: 0.22,
    veinCount: 50, veinLen: [3, 8], veinRadius: [0.65, 1.1],
    rarity: 1, pattern: 'cluster',
    signalPower: 1, value: 5, pvpImportance: 0, requiredDrillTier: 1,
  },
  {
    type: BLOCK.IRON, name: 'iron',
    minDepth: 18, peakDepth: 36, maxDepth: 65,
    maxChance: 0.12,
    veinCount: 42, veinLen: [3, 8], veinRadius: [0.65, 1.1],
    rarity: 2, pattern: 'vein',
    signalPower: 2, value: 15, pvpImportance: 1, requiredDrillTier: 1,
  },
  {
    type: BLOCK.COPPER, name: 'copper',
    minDepth: 45, peakDepth: 70, maxDepth: 105,
    maxChance: 0.09,
    veinCount: 38, veinLen: [3, 9], veinRadius: [0.70, 1.1],
    rarity: 2, pattern: 'vein',
    signalPower: 2, value: 40, pvpImportance: 1, requiredDrillTier: 2,
  },
  {
    type: BLOCK.SILVER, name: 'silver',
    minDepth: 85, peakDepth: 110, maxDepth: 150,
    maxChance: 0.07,
    veinCount: 32, veinLen: [3, 8], veinRadius: [0.65, 1.0],
    rarity: 3, pattern: 'vein',
    signalPower: 3, value: 100, pvpImportance: 2, requiredDrillTier: 3,
  },
  {
    type: BLOCK.GOLD, name: 'gold',
    minDepth: 125, peakDepth: 150, maxDepth: 195,
    maxChance: 0.05,
    veinCount: 26, veinLen: [3, 7], veinRadius: [0.60, 1.0],
    rarity: 4, pattern: 'pocket',
    signalPower: 4, value: 250, pvpImportance: 3, requiredDrillTier: 3,
  },
  {
    type: BLOCK.EMERALD, name: 'emerald',
    minDepth: 170, peakDepth: 190, maxDepth: 225,
    maxChance: 0.025,
    veinCount: 12, veinLen: [2, 5], veinRadius: [0.55, 0.85],
    rarity: 5, pattern: 'protected',
    signalPower: 5, value: 750, pvpImportance: 4, requiredDrillTier: 4,
  },
  // Ruby — late-game grind ore. Veins are short and sparse so a full
  // late-game cargo bay (250 slots × $2000 = $500k) is *unreachable* in
  // a single trip; the player typically nets 4–10 rubies per visit and
  // the rest must be filled with cheaper ores. This is the cap that
  // keeps "1 ruby = 1 free upgrade" from happening.
  {
    type: BLOCK.RUBY, name: 'ruby',
    minDepth: 200, peakDepth: 218, maxDepth: 235,
    maxChance: 0.016,
    veinCount: 6, veinLen: [2, 4], veinRadius: [0.45, 0.75],
    rarity: 6, pattern: 'protected',
    signalPower: 6, value: 2000, pvpImportance: 5, requiredDrillTier: 5,
  },
];

// Ordered from rarest to commonest so base-fill rolls rare ores first.
// This way a tile at the overlap of two ranges gets the rarer type.
export const RESOURCES_BY_RARITY = [...RESOURCES].sort((a, b) => b.rarity - a.rarity);

// Gaussian around peak, normalized to 1.0 at peak, ~0 at min/max.
// sigma = quarter of the half-window so tails reach ~e^-2 ≈ 0.13 at the edges.
export function peakFactor(depth, res) {
  if (depth < res.minDepth || depth > res.maxDepth) return 0;
  const halfWindow = Math.max(
    res.peakDepth - res.minDepth,
    res.maxDepth - res.peakDepth,
    1,
  );
  const sigma = halfWindow / 2;
  const dz = depth - res.peakDepth;
  return Math.exp(-(dz * dz) / (2 * sigma * sigma));
}

export function oreRollChance(depth, res) {
  return res.maxChance * peakFactor(depth, res);
}
