// Chests: entity metadata and loot tables.
//
// A chest lives as BLOCK.CHEST in the grid + a descriptor in world.chests /
// world.chestsAt. Tier is decided at generation time from depth.
//
// Loot table = weighted list of outcomes. One outcome is rolled per open.
// This is a DRAFT — numbers chosen as a starting point for playtest, not
// final balance. Adjust weights / ranges and we'll re-tune together.

export const CHEST_TIERS = {
  shallow: {
    id: 'shallow',
    // Depth window (meters below surface). Shallow tier starts at the very
    // first buried tile so players can find chests from the first meter.
    fromDepth: 2,
    toDepth: 60,
    // Visual tint used by the renderer.
    color: 0x8a5a2a,
    bandColor: 0xc9a36a,
    lockColor: 0xffd26b,
    label: 'Rusty',
  },
  mid: {
    id: 'mid',
    fromDepth: 60,
    toDepth: 140,
    color: 0x6d4a22,
    bandColor: 0xd9b46a,
    lockColor: 0xffe27a,
    label: 'Miner Cache',
  },
  deep: {
    id: 'deep',
    fromDepth: 140,
    toDepth: 245,
    color: 0x3f2e1c,
    bandColor: 0xe2c078,
    lockColor: 0xffdd55,
    label: 'Ancient',
  },
};

export function chestTierForDepth(depth) {
  if (depth < CHEST_TIERS.mid.fromDepth) return CHEST_TIERS.shallow;
  if (depth < CHEST_TIERS.deep.fromDepth) return CHEST_TIERS.mid;
  return CHEST_TIERS.deep;
}

// Loot outcome shape:
//   { kind: 'money' | 'items' | 'fuel' | 'trap' | 'empty' | 'blueprint', weight, ...payload }
// payload for 'money':     { min, max }
// payload for 'items':     { give: { ladder?, pillar?, dynamite?, bigDynamite?, parachute?, teleporter? } }
// payload for 'fuel':      { pct }      — partial battery refill
// payload for 'trap':      { size: 'small' | 'big', fuseMs }
// payload for 'empty':     (nothing — kept rare so opening a chest stays exciting)
// payload for 'blueprint': { }          — applies a free L+1 upgrade to a random stat
//
// Weights are relative — summed and sampled by the roller. Tables are
// tuned so utility drops (ladders / pillars / fuel) appear often in
// shallow tier where running out is most painful, and lean toward
// premium consumables + blueprints as you go deeper.

export const LOOT_TABLES = {
  // Shallow: emergency-supply theme. Lots of ladders / pillars / partial
  // recharges so a stranded shallow-zone player can usually claw their
  // way home. Blueprint cannot drop here so the early game can't be
  // trivialised.
  shallow: [
    // Utility — very common (~55% combined)
    { kind: 'items', weight: 22, give: { ladder: [3, 6] } },
    { kind: 'items', weight: 14, give: { pillar: [1, 3] } },
    { kind: 'items', weight: 10, give: { ladder: [2, 4], pillar: [1, 2] } },
    { kind: 'fuel',  weight: 12, pct: 30 },
    { kind: 'fuel',  weight: 4,  pct: 60 },
    // Cash — modest
    { kind: 'money', weight: 18, min: 30, max: 90 },
    // Tools — rare-ish
    { kind: 'items', weight: 6,  give: { dynamite: [1, 1] } },
    { kind: 'items', weight: 4,  give: { parachute: [1, 1] } },
    { kind: 'items', weight: 1,  give: { dynamite: [3, 3] } }, // jackpot
    // Bad outcomes — rare
    { kind: 'trap',  weight: 6,  size: 'small', fuseMs: 3500 },
    { kind: 'empty', weight: 3 },
  ],
  // Mid: balanced, with the first sniff of blueprints + fuel-cans large
  // enough to fully top off small batteries.
  mid: [
    { kind: 'money', weight: 22, min: 100, max: 400 },
    { kind: 'fuel',  weight: 14, pct: 40 },
    { kind: 'fuel',  weight: 6,  pct: 80 },
    { kind: 'items', weight: 14, give: { ladder: [4, 8], pillar: [1, 3] } },
    { kind: 'items', weight: 12, give: { dynamite: [1, 2] } },
    { kind: 'items', weight: 8,  give: { ladder: [3, 6] } },
    { kind: 'items', weight: 6,  give: { pillar: [2, 4] } },
    { kind: 'items', weight: 5,  give: { bigDynamite: [1, 1] } },
    { kind: 'items', weight: 5,  give: { parachute: [1, 1] } },
    { kind: 'items', weight: 4,  give: { teleporter: [1, 1] } },
    { kind: 'blueprint', weight: 6 },
    { kind: 'trap',  weight: 7,  size: 'small', fuseMs: 3000 },
    { kind: 'empty', weight: 2 },
  ],
  // Deep: premium tier — bigger blueprint chance, full recharges, multiple
  // teleporters, heavier traps.
  deep: [
    { kind: 'money', weight: 22, min: 400, max: 1500 },
    { kind: 'fuel',  weight: 12, pct: 60 },
    { kind: 'fuel',  weight: 8,  pct: 100 },
    { kind: 'items', weight: 12, give: { dynamite: [2, 4] } },
    { kind: 'items', weight: 10, give: { ladder: [6, 12], pillar: [2, 5] } },
    { kind: 'items', weight: 9,  give: { bigDynamite: [1, 2] } },
    { kind: 'items', weight: 7,  give: { teleporter: [1, 2] } },
    { kind: 'items', weight: 5,  give: { parachute: [1, 2] } },
    { kind: 'items', weight: 5,  give: { bigDynamite: [1, 1], dynamite: [1, 2] } },
    { kind: 'blueprint', weight: 14 },
    { kind: 'trap',  weight: 9,  size: 'big',   fuseMs: 2500 },
    { kind: 'trap',  weight: 5,  size: 'small', fuseMs: 2000 },
    { kind: 'empty', weight: 1 },
  ],
};

// Generic weighted sampler that works off the tables above.
export function rollLoot(tierId, rnd) {
  const table = LOOT_TABLES[tierId];
  if (!table || !table.length) return { kind: 'empty' };

  let total = 0;
  for (const o of table) total += o.weight;
  let pick = rnd() * total;
  for (const o of table) {
    pick -= o.weight;
    if (pick <= 0) return resolveOutcome(o, rnd);
  }
  return resolveOutcome(table[table.length - 1], rnd);
}

function resolveOutcome(o, rnd) {
  if (o.kind === 'money') {
    const amount = Math.round(o.min + rnd() * (o.max - o.min));
    return { kind: 'money', amount };
  }
  if (o.kind === 'items') {
    const give = {};
    for (const [name, range] of Object.entries(o.give)) {
      const [min, max] = range;
      give[name] = Math.round(min + rnd() * (max - min));
    }
    return { kind: 'items', give };
  }
  if (o.kind === 'trap') {
    return { kind: 'trap', size: o.size, fuseMs: o.fuseMs };
  }
  if (o.kind === 'blueprint') {
    return { kind: 'blueprint' };
  }
  if (o.kind === 'fuel') {
    return { kind: 'fuel', pct: o.pct };
  }
  return { kind: 'empty' };
}
