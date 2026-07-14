export function emptyResources() {
  return { scrst: 0, bcrst: 0, hcrst: 0 };
}

export function normalizeResources(resources = {}) {
  return {
    scrst: Number(resources?.scrst || 0),
    bcrst: Number(resources?.bcrst || 0),
    hcrst: Number(resources?.hcrst || 0),
  };
}

export function addResources(left = {}, right = {}) {
  const a = normalizeResources(left);
  const b = normalizeResources(right);
  return {
    scrst: a.scrst + b.scrst,
    bcrst: a.bcrst + b.bcrst,
    hcrst: a.hcrst + b.hcrst,
  };
}

export function subtractResources(left = {}, right = {}) {
  const a = normalizeResources(left);
  const b = normalizeResources(right);
  return {
    scrst: Math.max(0, a.scrst - b.scrst),
    bcrst: Math.max(0, a.bcrst - b.bcrst),
    hcrst: Math.max(0, a.hcrst - b.hcrst),
  };
}

export function maxResources(left = {}, right = {}) {
  const a = normalizeResources(left);
  const b = normalizeResources(right);
  return {
    scrst: Math.max(a.scrst, b.scrst),
    bcrst: Math.max(a.bcrst, b.bcrst),
    hcrst: Math.max(a.hcrst, b.hcrst),
  };
}

export function syncEarnedResources(stats) {
  stats.banked = normalizeResources(stats.banked);
  stats.minted = normalizeResources(stats.minted);
  stats.spentBanked = normalizeResources(stats.spentBanked);
  stats.surfacedResources = normalizeResources(stats.surfacedResources);
  stats.earned = maxResources(
    stats.surfacedResources,
    addResources(addResources(stats.minted, stats.spentBanked), stats.banked),
  );
  return stats;
}

export function applySurfaceAccounting(stats, banked) {
  syncEarnedResources(stats);
  const nextBanked = normalizeResources(banked);
  stats.surfacedResources = addResources(
    stats.surfacedResources,
    subtractResources(nextBanked, stats.banked),
  );
  stats.banked = nextBanked;
  return syncEarnedResources(stats);
}

export function applyMintAccounting(stats, minted) {
  syncEarnedResources(stats);
  const amount = normalizeResources(minted);
  stats.minted = addResources(stats.minted, amount);
  stats.banked = subtractResources(stats.banked, amount);
  return syncEarnedResources(stats);
}

export function applyTradeAccounting(stats, spent) {
  syncEarnedResources(stats);
  const amount = normalizeResources(spent);
  stats.spentBanked = addResources(stats.spentBanked, amount);
  stats.banked = subtractResources(stats.banked, amount);
  return syncEarnedResources(stats);
}
