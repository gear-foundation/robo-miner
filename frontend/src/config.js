// Game configuration: tune these to balance the game.
//
// Economy reference: Motherload (XGen, 2004). Six upgrade tiers with a
// symmetric price ladder ($0/$100/$400/$1500/$5000/$15000/$50000) shared
// across all five stats; ore prices step ×2.5–3 per tier so reaching the
// next biome is roughly worth one upgrade. See the design doc for the
// trip-math that proves no single rare ore (ruby, etc.) skips a tier.

export const TILE = 48;              // px per tile — big & chunky
export const WORLD_W = 120;          // tiles wide
export const WORLD_H = 250;          // tiles deep
export const SURFACE_Y = 4;          // rows of sky before ground starts

// Block types — depth tiers go from surface down: coal → iron → copper →
// silver → gold → emerald → ruby → diamond. Ruby is the late-game grind
// ore; diamond is the unique win-condition pickup at the very bottom.
export const BLOCK = {
  SKY: 0,
  DIRT: 1,
  COAL: 2,
  IRON: 3,
  COPPER: 4,
  SILVER: 5,
  GOLD: 6,
  EMERALD: 7,
  RUBY: 15,        // squeezed in late so existing saves don't shift indices
  DIAMOND: 8,
  STONE: 9,        // undrillable without dynamite
  LADDER: 10,
  PILLAR: 11,
  CHEST: 12,
  LAVA: 13,
  WATER: 14,
  // Artifact / POI tiles (drillable like ore, but lore-flavoured)
  BONE:  16,       // dinosaur fossil
  COIN:  17,       // ancient coin pile
  RING:  18,       // lost ring
  SKULL: 19,       // miner's grave skull — drops a clue + small cash
  SHRINE: 20,      // altar — sacrifice 1 ore for a random buff
  DRILL_RELIC: 21, // jammed drill — needs dynamite, grants drill buff
  TORCH: 22,       // wall torch decoration
  // Digger campaign (agent arena) resource crystals — replace the 8-ore
  // economy in that mode. Redeemable in VARA: SCRST 6 / BCRST 30 / HCRST 150.
  SCRST: 23,       // small crystal — common, shallow
  BCRST: 24,       // big crystal — mid depth
  HCRST: 25,       // huge crystal — rare, deep
};

// Ore data: color, price, hardness (dig time multiplier), min/max depth (tile rows below surface).
// Hardness rises ×0.5 per tier so each new biome demands a stronger drill;
// drill L1 ≈ 0.42s × hardness — coal is 0.42s, ruby 1.7s, diamond 2.1s.
// Price ratio is roughly ×2.5–3 per tier (Motherload-style), which keeps
// the upgrade ladder funded without runaway late-game inflation.
export const BLOCK_DATA = {
  [BLOCK.SKY]:    { name: 'sky',     color: 0x87ceeb, price: 0,      hardness: 0,    solid: false },
  [BLOCK.DIRT]:   { name: 'dirt',    color: 0x8b5a2b, price: 0,      hardness: 1,    solid: true },
  [BLOCK.COAL]:   { name: 'coal',    color: 0x8b5a2b, price: 5,      hardness: 1,    solid: true,  minDepth: 2,   maxDepth: 25 },
  [BLOCK.IRON]:   { name: 'iron',    color: 0x8b5a4d, price: 15,     hardness: 1.5,  solid: true,  minDepth: 18,  maxDepth: 55 },
  [BLOCK.COPPER]: { name: 'copper',  color: 0xc06844, price: 40,     hardness: 2,    solid: true,  minDepth: 45,  maxDepth: 95 },
  [BLOCK.SILVER]: { name: 'silver',  color: 0xd8d8e0, price: 100,    hardness: 2.5,  solid: true,  minDepth: 85,  maxDepth: 135 },
  [BLOCK.GOLD]:   { name: 'gold',    color: 0xffd700, price: 250,    hardness: 3,    solid: true,  minDepth: 125, maxDepth: 180 },
  [BLOCK.EMERALD]:{ name: 'emerald', color: 0x50c878, price: 750,    hardness: 3.5,  solid: true,  minDepth: 170, maxDepth: 215 },
  [BLOCK.RUBY]:   { name: 'ruby',    color: 0xe23a4f, price: 2000,   hardness: 4,    solid: true,  minDepth: 200, maxDepth: 235 },
  // Diamond is a unique pickup, not a sellable ore — turning it in at the
  // shop wins the game. price=0 so the auto-sell on surface ignores it.
  [BLOCK.DIAMOND]:{ name: 'diamond', color: 0x5ff6ff, price: 0,      hardness: 5,    solid: true,  minDepth: 220, maxDepth: 245 },
  [BLOCK.STONE]:  { name: 'stone',   color: 0x8a8a8a, price: 0,      hardness: 999,  solid: true },
  [BLOCK.LADDER]: { name: 'ladder',  color: 0xc28840, price: 0,      hardness: 0.5,  solid: false, climbable: true },
  // Pillar: passive support column. Robot walks THROUGH it (solid:false), it
  // can't be drilled (hardness 999), but it blocks/catches falling stones
  // from above, and has its own gravity — if you dig under it, it falls.
  [BLOCK.PILLAR]: { name: 'pillar',  color: 0xaaaaaa, price: 0,      hardness: 999,  solid: false },
  // Chest: drillable like a soft block — "digging" the tile opens it.
  // Loot is resolved from a parallel `world.chestsAt` map in GameScene
  // (so tier metadata / opened state lives as an entity, not in the grid).
  [BLOCK.CHEST]:  { name: 'chest',   color: 0x8a5a2a, price: 0,      hardness: 1,    solid: true },
  // Lava: you cannot dig it and stepping on it damages you. Visuals are
  // animated red/orange wavy bands — handled in GameScene.drawTile.
  [BLOCK.LAVA]:   { name: 'lava',    color: 0xff4a00, price: 0,      hardness: 999,  solid: false, damage: 30 },
  // Water: you can walk/fall through it (solid:false). While submerged the
  // robot takes slow damage and fuel drains extra — a shallow-zone hazard
  // that shapes routing without one-shotting the player.
  [BLOCK.WATER]:  { name: 'water',   color: 0x2a7fd8, price: 0,      hardness: 999,  solid: false, damage: 2, fuelDrain: 1.5 },
  // Artifacts: drillable like ore but with story flavor. Their price is
  // their full value — auto-sells on the surface like any other cargo.
  [BLOCK.BONE]:   { name: 'bone',    color: 0xefe4c2, price: 300,    hardness: 1.5,  solid: true,  minDepth: 50,  maxDepth: 150 },
  [BLOCK.COIN]:   { name: 'coin',    color: 0xffd84a, price: 150,    hardness: 1,    solid: true,  minDepth: 10,  maxDepth: 220 },
  [BLOCK.RING]:   { name: 'ring',    color: 0xffe8c8, price: 600,    hardness: 1.2,  solid: true,  minDepth: 100, maxDepth: 200 },
  [BLOCK.SKULL]:  { name: 'skull',   color: 0xeae0c4, price: 50,     hardness: 1,    solid: true,  minDepth: 30,  maxDepth: 220 },
  // Shrine: drillable but consumes 1 cargo ore on dig and grants a
  // random reward (blueprint / drill buff / teleporter / cash). Drilled
  // out of existence after one use, like a chest.
  [BLOCK.SHRINE]: { name: 'shrine',  color: 0xb59a5a, price: 0,      hardness: 1.5,  solid: true,  minDepth: 60, maxDepth: 200 },
  // Abandoned Drill Relic: undrillable, only dynamite can break it.
  // Destroying it grants a 60-second drill speed buff (×0.8 multiplier).
  [BLOCK.DRILL_RELIC]: { name: 'relic', color: 0x7a7a7a, price: 0, hardness: 999, solid: true,  minDepth: 50, maxDepth: 200 },
  // Torch: pure decoration. Soft so a stray drill clears it without
  // penalty; placed at cave edges by the POI generator.
  [BLOCK.TORCH]:  { name: 'torch',   color: 0xffaa20, price: 0,      hardness: 0.5,  solid: false },
  // Digger crystals (agent arena). `price` = the VARA redeem rate, so the
  // existing auto-sell / team-score code values them straight away. Hardness
  // rises with rarity so the deep HCRST takes a real drill to break.
  [BLOCK.SCRST]:  { name: 'scrst',   color: 0x5fd6ff, price: 6,      hardness: 1.5,  solid: true,  minDepth: 3,  maxDepth: 34 },
  [BLOCK.BCRST]:  { name: 'bcrst',   color: 0x66e06a, price: 30,     hardness: 2.5,  solid: true,  minDepth: 22, maxDepth: 50 },
  [BLOCK.HCRST]:  { name: 'hcrst',   color: 0xff5fc8, price: 150,    hardness: 4,    solid: true,  minDepth: 45, maxDepth: 60 },
};

// Minimum dig animation duration so high-tier drills don't make breaking
// blocks feel instant — keeps the crack/debris animation visible.
export const MIN_DIG_DURATION = 180;

// Robot base stats (can be upgraded in shop). Player starts at L1 of every
// upgrade — see UPGRADES below for the per-tier values.
export const ROBOT_BASE = {
  maxFuel: 100,
  maxHp: 100,
  maxCargo: 20,
  drillSpeed: 1,       // ms multiplier (lower = faster)
  moveSpeed: 120,      // px/sec, not upgradable
  fuelPerMove: 0.05,
  fuelPerDig: 0.5,
  radar: 2,            // vision radius in tiles
};

// Upgrade ladder. Six visible levels (L1 is the free starting tier, then
// five paid steps). Prices are *symmetric across all five categories* so
// players can budget by step number rather than memorizing five separate
// price lists. Level names + flavor lines surface in the shop UI to give
// each upgrade a tiny bit of personality.
//
// SHARED PRICE LADDER: 0 / 100 / 400 / 1500 / 5000 / 15000 / 50000
// Total spend per category to max = $71600 → $358000 to fully max all five
// (≈ 100+ rubies). This sets a clear endgame goal without grinding being
// the only path: a focused player can ignore some categories.
export const UPGRADE_PRICES = [0, 100, 400, 1500, 5000, 15000, 50000];

// Pure level definitions. Each entry's `lvl` is its 1-based index, `val`
// is the resulting stat value at that level, `name` shows in the shop
// header, `desc` is the cheeky one-liner. Drill levels are stored as
// drillSpeed multipliers (lower = faster), matching ROBOT_BASE.drillSpeed.
export const UPGRADES = {
  fuel: [
    { lvl: 1, price: UPGRADE_PRICES[0], val: 100,  name: 'Pocket Cell',   desc: 'Tiny battery. Tiny ambitions.' },
    { lvl: 2, price: UPGRADE_PRICES[1], val: 160,  name: 'AA Pack',       desc: 'A modest sip more juice.' },
    { lvl: 3, price: UPGRADE_PRICES[2], val: 250,  name: 'Heavy-Duty',    desc: 'Now we are powering the dig.' },
    { lvl: 4, price: UPGRADE_PRICES[3], val: 400,  name: 'Lithium Pack',  desc: 'Smells faintly of progress.' },
    { lvl: 5, price: UPGRADE_PRICES[4], val: 650,  name: 'Plasma Cell',   desc: 'Glowing. Probably safe.' },
    { lvl: 6, price: UPGRADE_PRICES[5], val: 1000, name: 'Reactor Core',  desc: 'Do not stand near it during lunch.' },
  ],
  cargo: [
    { lvl: 1, price: UPGRADE_PRICES[0], val: 20,   name: 'Daypack',       desc: 'Holds a snack and a dream.' },
    { lvl: 2, price: UPGRADE_PRICES[1], val: 35,   name: 'Backpack',      desc: 'For real expeditions now.' },
    { lvl: 3, price: UPGRADE_PRICES[2], val: 60,   name: 'Hauler',        desc: 'Squeaks at the seams.' },
    { lvl: 4, price: UPGRADE_PRICES[3], val: 100,  name: 'Container',     desc: 'A walking shipping crate.' },
    { lvl: 5, price: UPGRADE_PRICES[4], val: 150,  name: 'Mega-Hold',     desc: 'Echoes when you yell into it.' },
    { lvl: 6, price: UPGRADE_PRICES[5], val: 250,  name: 'Cargo Bay',     desc: 'Officially a small warehouse.' },
  ],
  drill: [
    { lvl: 1, price: UPGRADE_PRICES[0], val: 1.0,  name: 'Tin Bit',       desc: 'Bites dirt. Mostly.' },
    { lvl: 2, price: UPGRADE_PRICES[1], val: 0.67, name: 'Iron Spike',    desc: 'Now we are biting back.' },
    { lvl: 3, price: UPGRADE_PRICES[2], val: 0.45, name: 'Copper Auger',  desc: 'Crunches through copper without crying.' },
    { lvl: 4, price: UPGRADE_PRICES[3], val: 0.30, name: 'Silver Crusher',desc: 'Pulverizes ore. Whispers in pure greed.' },
    { lvl: 5, price: UPGRADE_PRICES[4], val: 0.20, name: 'Tungsten Splitter', desc: 'Does not stop. Cannot stop.' },
    { lvl: 6, price: UPGRADE_PRICES[5], val: 0.13, name: 'Diamond Drill', desc: 'Eats diamond. With ketchup.' },
  ],
  // Pack used to be Hull. The category now upgrades how many ladders +
  // pillars you can carry on a single trip (HP rides along as a side
  // bonus so lava traversal still scales with progression).
  // val packs three numbers: [ladders, pillars, hp].
  pack: [
    { lvl: 1, price: UPGRADE_PRICES[0], val: [12, 5,  100], name: 'Daypack',         desc: 'Holds enough for one trip. Maybe.' },
    { lvl: 2, price: UPGRADE_PRICES[1], val: [16, 7,  130], name: 'Big Pack',        desc: 'Now we are talking real loadouts.' },
    { lvl: 3, price: UPGRADE_PRICES[2], val: [22, 10, 170], name: 'Hauler Sack',     desc: 'Squeaks when you breathe wrong.' },
    { lvl: 4, price: UPGRADE_PRICES[3], val: [30, 14, 220], name: 'Cargo Frame',     desc: 'Industrial-grade pocket arsenal.' },
    { lvl: 5, price: UPGRADE_PRICES[4], val: [42, 19, 290], name: 'Industrial Rack', desc: 'You walk slower. Worth it.' },
    { lvl: 6, price: UPGRADE_PRICES[5], val: [60, 25, 380], name: 'Master Vault',    desc: 'A small warehouse strapped to a robot.' },
  ],
  radar: [
    { lvl: 1, price: UPGRADE_PRICES[0], val: 2,    name: 'Eye',           desc: 'You can see your own feet.' },
    { lvl: 2, price: UPGRADE_PRICES[1], val: 3,    name: 'Lantern',       desc: 'A cozy bubble of vision.' },
    { lvl: 3, price: UPGRADE_PRICES[2], val: 4,    name: 'Scanner',       desc: 'Beeps at suspicious rocks.' },
    { lvl: 4, price: UPGRADE_PRICES[3], val: 5,    name: 'X-Ray',         desc: 'Sees through stone. Probably legal.' },
    { lvl: 5, price: UPGRADE_PRICES[4], val: 7,    name: 'Sonar',         desc: 'Pings the whole neighbourhood.' },
    { lvl: 6, price: UPGRADE_PRICES[5], val: 9,    name: 'All-Seeing',    desc: 'It knows what you ate for lunch.' },
  ],
};

// Consumables (ladders are NOT bought — they refill automatically at the surface)
export const ITEMS = {
  pillar:     { price: 15,  name: 'Pillar',           desc: 'Holds the ceiling up. Mostly.' },
  dynamite:   { price: 80,  name: 'Dynamite (3x3)',   desc: 'Boom. Small. Effective.' },
  bigDynamite:{ price: 250, name: 'Big Dynamite (5x5)', desc: 'Reshapes geography on contact.' },
  parachute:  { price: 40,  name: 'Parachute',        desc: 'Gravity is no longer the boss.' },
  teleporter: { price: 300, name: 'Teleporter',       desc: 'Beam back to the shop. One use.' },
};

// Ladders: how many the surface gives you back each time you return.
export const MAX_LADDERS = 12;
// Pillars: same auto-refill on the surface row.
export const MAX_PILLARS = 5;

// Fixed surface recharge price for a full tank (kept tiny — refuelling is
// not a meaningful sink, the real money pit is upgrades + consumables).
export const FUEL_PRICE = 5;
