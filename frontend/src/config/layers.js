// Major layers (biome zones) — data-only for now.
// Not wired into generation yet; steps read from this in later iterations
// to derive hardness multipliers, ore multipliers, barrier density, etc.
//
// Depth is measured in meters below surface (1 tile == 1 m).
// Current WORLD_H=250 means we only reach into the Iron Conflict Zone;
// the deeper layers exist here so MVP-1 can extend WORLD_H without
// touching generation code.

export const MAJOR_LAYERS = [
  {
    id: 'starter_dirt',
    name: 'Starter Dirt / Soft Stone',
    fromDepth: 0,
    toDepth: 200,
    hardnessMultiplier: 1.0,
    oreMultiplier: 1.0,
    barrierDensity: 0.4,
    chestChance: 0.05,
    caveChance: 1.0,
    dangerLevel: 1,
    pvpRelevance: 0,
    radarNoise: 0.0,
  },
  {
    id: 'iron_conflict',
    name: 'Iron Conflict Zone',
    fromDepth: 200,
    toDepth: 450,
    hardnessMultiplier: 1.2,
    oreMultiplier: 1.1,
    barrierDensity: 0.7,
    chestChance: 0.12,
    caveChance: 1.1,
    dangerLevel: 2,
    pvpRelevance: 1,
    radarNoise: 0.05,
  },
  {
    id: 'gold_cave',
    name: 'Gold Cave Zone',
    fromDepth: 450,
    toDepth: 750,
    hardnessMultiplier: 1.4,
    oreMultiplier: 1.2,
    barrierDensity: 0.9,
    chestChance: 0.18,
    caveChance: 1.3,
    dangerLevel: 3,
    pvpRelevance: 2,
    radarNoise: 0.10,
  },
  {
    id: 'crystal_ancient',
    name: 'Crystal Ancient Zone',
    fromDepth: 750,
    toDepth: 1100,
    hardnessMultiplier: 1.7,
    oreMultiplier: 1.3,
    barrierDensity: 1.1,
    chestChance: 0.22,
    caveChance: 1.2,
    dangerLevel: 4,
    pvpRelevance: 3,
    radarNoise: 0.18,
  },
  {
    id: 'core_pvp',
    name: 'Core PvP Zone',
    fromDepth: 1100,
    toDepth: 1500,
    hardnessMultiplier: 2.0,
    oreMultiplier: 1.4,
    barrierDensity: 1.3,
    chestChance: 0.28,
    caveChance: 1.0,
    dangerLevel: 5,
    pvpRelevance: 5,
    radarNoise: 0.25,
  },
];

export const MICRO_LAYER_HEIGHT = 20; // meters = tiles

export function majorLayerAt(depth) {
  for (const l of MAJOR_LAYERS) {
    if (depth >= l.fromDepth && depth < l.toDepth) return l;
  }
  return MAJOR_LAYERS[MAJOR_LAYERS.length - 1];
}

export function microLayerAt(depth) {
  return Math.floor(depth / MICRO_LAYER_HEIGHT);
}
