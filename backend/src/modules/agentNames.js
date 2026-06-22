const ADJECTIVES = [
  'Agile', 'Amber', 'Arcane', 'Ardent', 'Ashen', 'Avid', 'Azure', 'Beryl',
  'Blazing', 'Bold', 'Brave', 'Bright', 'Brisk', 'Bronze', 'Calm', 'Candid',
  'Clever', 'Copper', 'Cosmic', 'Crimson', 'Curious', 'Daring', 'Dawnlit', 'Deep',
  'Dizzy', 'Dusky', 'Eager', 'Electric', 'Emerald', 'Fabled', 'Feral', 'Fiery',
  'Fleet', 'Frosty', 'Gentle', 'Gilded', 'Glowing', 'Golden', 'Granite', 'Green',
  'Hardy', 'Hidden', 'Honey', 'Icy', 'Iron', 'Ivory', 'Jolly', 'Keen',
  'Lively', 'Lucky', 'Lunar', 'Merry', 'Mighty', 'Minty', 'Misty', 'Molten',
  'Mystic', 'Nimble', 'Noble', 'Onyx', 'Opal', 'Patient', 'Pepper', 'Plucky',
  'Primal', 'Quick', 'Quiet', 'Radiant', 'Rapid', 'Raven', 'Restless', 'Ruby',
  'Rusty', 'Sable', 'Scarlet', 'Shiny', 'Silent', 'Silver', 'Sly', 'Solar',
  'Sonic', 'Sparkling', 'Spicy', 'Spirited', 'Spry', 'Stalwart', 'Stellar', 'Stone',
  'Stormy', 'Sturdy', 'Sunny', 'Swift', 'Tactical', 'Teal', 'Thunder', 'Tiny',
  'Umber', 'Valiant', 'Velvet', 'Vivid', 'Wary', 'Wild', 'Wise', 'Zesty',
  'Astral', 'Burly', 'Canary', 'Cobalt', 'Dapper', 'Elder', 'Foxglove', 'Hasty',
  'Jade', 'Kind', 'Lofty', 'Marble', 'Neon', 'Ochre', 'Proud', 'Rugged',
  'Saffron', 'Tidy', 'Urban', 'Verdant', 'Witty', 'Yielding', 'Zealous', 'Turbo',
];

const NOUN_PREFIXES = [
  'Astro', 'Basalt', 'Beacon', 'Bolt', 'Cave', 'Chrome', 'Crystal', 'Drift',
  'Echo', 'Ember', 'Forge', 'Fossil', 'Gear', 'Glow', 'Granite', 'Helix',
  'Iron', 'Lava', 'Lumen', 'Magma', 'Marble', 'Meteor', 'Moon', 'Nova',
  'Obsidian', 'Quartz', 'Rift', 'Rocket', 'Ruby', 'Shadow', 'Spark', 'Tunnel',
];

const NOUN_ROOTS = [
  'Borer', 'Breaker', 'Burrower', 'Cart', 'Climber', 'Courier', 'Crawler', 'Cutter',
  'Delver', 'Digger', 'Driller', 'Finder', 'Forager', 'Hauler', 'Hopper', 'Hunter',
  'Mapper', 'Miner', 'Pilot', 'Ranger', 'Runner', 'Scout', 'Seeker', 'Shifter',
  'Skipper', 'Sprinter', 'Surveyor', 'Tracker', 'Trailblazer', 'Tunneler', 'Warden', 'Walker',
];

export const AGENT_NAME_SPACE = ADJECTIVES.length * NOUN_PREFIXES.length * NOUN_ROOTS.length;

export function generateAgentName(seed) {
  const text = String(seed || 'agent');
  const a = hash32(`${text}:adjective`) % ADJECTIVES.length;
  const p = hash32(`${text}:prefix`) % NOUN_PREFIXES.length;
  const r = hash32(`${text}:root`) % NOUN_ROOTS.length;
  return `${ADJECTIVES[a]} ${NOUN_PREFIXES[p]}${NOUN_ROOTS[r]}`;
}

export function agentNameSeed(record = {}) {
  return record.programId || record.diggerProgramId || record.ownerActor || record.owner || record.id || 'agent';
}

export function withAgentName(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    agentName: record.agentName || generateAgentName(agentNameSeed(record)),
  };
}

function hash32(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
