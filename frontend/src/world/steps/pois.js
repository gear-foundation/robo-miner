// Procedural POIs: vaults + artifacts + miner graves.
//
// Runs AFTER veins / sealing / diamond placement so it can carve into
// already-decorated dirt without stomping ore. Each POI is a small,
// hand-crafted structure dropped at a valid random spot:
//
//   - Vault: 5×5 stone-walled chamber with chests inside. Forces the
//     player to use dynamite to break in.
//   - Artifact tiles (bone, coin, ring): rare sellable lore drops
//     scattered through dirt at depth-appropriate windows.
//   - Skull (miner grave): drillable tile that yields a small cash
//     bonus + a "clue" message — handled at dig time in GameScene.

import { BLOCK } from '../../config.js';
import { DIMS } from '../dims.js';
import { idx } from '../grid.js';

// Artifacts: list of { type, count, minDepth, maxDepth }.
const ARTIFACTS = [
  { type: BLOCK.BONE,  count: 6,  minDepth: 50,  maxDepth: 150 },
  { type: BLOCK.COIN,  count: 10, minDepth: 10,  maxDepth: 220 },
  { type: BLOCK.RING,  count: 4,  minDepth: 100, maxDepth: 200 },
  { type: BLOCK.SKULL, count: 5,  minDepth: 30,  maxDepth: 220 },
];

// Vault count and depth window — capped at 2 per map so they always
// feel like a "find" rather than a guaranteed objective on every run.
const VAULT_COUNT = 2;
const VAULT_MIN_DEPTH = 80;
const VAULT_MAX_DEPTH = 200;
const VAULT_W = 5;
const VAULT_H = 5;

function plant(grid, x, y, type) {
  if (x <= 1 || x >= DIMS.W - 2) return false;
  if (y <= DIMS.S || y >= DIMS.H - 2) return false;
  // Only swap into plain dirt — never overwrite ore, stone or chests.
  if (grid[idx(x, y)] !== BLOCK.DIRT) return false;
  grid[idx(x, y)] = type;
  return true;
}

function placeArtifact(grid, rnd, art) {
  let placed = 0;
  let attempts = 0;
  while (placed < art.count && attempts++ < art.count * 10) {
    const x = 2 + Math.floor(rnd() * (DIMS.W - 4));
    const y = DIMS.S + art.minDepth +
      Math.floor(rnd() * (art.maxDepth - art.minDepth));
    if (plant(grid, x, y, art.type)) placed++;
  }
}

// Vault: a 5×5 stone-walled box with 2-3 chest slots inside. The walls
// are STONE so the player needs dynamite to crack the shell — payoff
// scales with the work to break in.
function placeVault(grid, rnd, ctx) {
  let attempts = 0;
  while (attempts++ < 40) {
    const cx = 4 + Math.floor(rnd() * (DIMS.W - 8));
    const cy = DIMS.S + VAULT_MIN_DEPTH +
      Math.floor(rnd() * (VAULT_MAX_DEPTH - VAULT_MIN_DEPTH));
    const left = cx - Math.floor(VAULT_W / 2);
    const top  = cy - Math.floor(VAULT_H / 2);
    // Bail if out of bounds or too close to the diamond.
    if (left < 2 || left + VAULT_W >= DIMS.W - 2) continue;
    if (top  < DIMS.S + 4 || top + VAULT_H >= DIMS.H - 2) continue;
    if (ctx?.diamondPos && Math.abs(ctx.diamondPos.x - cx) < 6
        && Math.abs(ctx.diamondPos.y - cy) < 6) continue;
    // Bail if the area overlaps a cave or contains existing chests.
    let bad = false;
    for (let yy = top; yy < top + VAULT_H && !bad; yy++) {
      for (let xx = left; xx < left + VAULT_W && !bad; xx++) {
        const t = grid[idx(xx, yy)];
        if (t === BLOCK.SKY || t === BLOCK.CHEST || t === BLOCK.DIAMOND) bad = true;
      }
    }
    if (bad) continue;
    // Stamp the shell: outer ring STONE, inner 3×3 SKY.
    for (let yy = top; yy < top + VAULT_H; yy++) {
      for (let xx = left; xx < left + VAULT_W; xx++) {
        const onBorder = xx === left || xx === left + VAULT_W - 1
                      || yy === top  || yy === top  + VAULT_H - 1;
        grid[idx(xx, yy)] = onBorder ? BLOCK.STONE : BLOCK.SKY;
      }
    }
    // 2 or 3 chests inside, sitting on the floor row. We register them
    // into chestsAt with the deepest tier ('deep') regardless of vault
    // depth — breaking into a vault should always feel premium.
    const floorY = top + VAULT_H - 2;
    const chestCount = 2 + (rnd() < 0.5 ? 1 : 0);
    const slots = [left + 1, left + 2, left + 3];
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    for (let i = 0; i < chestCount; i++) {
      const x = slots[i];
      grid[idx(x, floorY)] = BLOCK.CHEST;
      if (ctx?.chests && ctx?.chestsAt) {
        const chest = {
          id: ctx.chests.length,
          x, y: floorY,
          tier: 'deep',
          opened: false,
          fromVault: true,
        };
        ctx.chests.push(chest);
        ctx.chestsAt.set(idx(x, floorY), chest);
      }
    }
    return { x: cx, y: cy };
  }
  return null;
}

// Helper: find a wall tile (sky-adjacent dirt/stone) inside a cave
// pocket. Used for torches.
function findCaveWall(grid, rnd, pockets) {
  if (!pockets || pockets.length === 0) return null;
  for (let attempts = 0; attempts < 30; attempts++) {
    const p = pockets[Math.floor(rnd() * pockets.length)];
    const tx = p.x + Math.floor((rnd() - 0.5) * 6);
    const ty = p.y + Math.floor((rnd() - 0.5) * 4);
    if (tx <= 1 || tx >= DIMS.W - 2) continue;
    if (ty <= DIMS.S || ty >= DIMS.H - 2) continue;
    if (grid[idx(tx, ty)] !== BLOCK.SKY) continue;
    // Need a solid neighbour for the torch to "attach" to.
    const left  = grid[idx(tx - 1, ty)] !== BLOCK.SKY;
    const right = grid[idx(tx + 1, ty)] !== BLOCK.SKY;
    if (!left && !right) continue;
    return { x: tx, y: ty };
  }
  return null;
}

export function placePOIs(grid, rnd, ctx) {
  const pois = [];

  // --- Artifacts (small lore-collectibles)
  for (const a of ARTIFACTS) placeArtifact(grid, rnd, a);

  // --- Vaults (premium chest chambers)
  for (let i = 0; i < VAULT_COUNT; i++) {
    const v = placeVault(grid, rnd, ctx);
    if (v) pois.push({ kind: 'vault', x: v.x, y: v.y });
  }

  // --- Shrines: 2 per map, scattered through dirt mid-deep.
  let shrines = 0, sa = 0;
  while (shrines < 2 && sa++ < 60) {
    const x = 4 + Math.floor(rnd() * (DIMS.W - 8));
    const y = DIMS.S + 60 + Math.floor(rnd() * 140);
    if (plant(grid, x, y, BLOCK.SHRINE)) {
      shrines++;
      pois.push({ kind: 'shrine', x, y });
    }
  }

  // --- Abandoned Drill Relics: 3 per map, mid-deep dirt.
  let relics = 0, ra = 0;
  while (relics < 3 && ra++ < 60) {
    const x = 4 + Math.floor(rnd() * (DIMS.W - 8));
    const y = DIMS.S + 50 + Math.floor(rnd() * 150);
    if (plant(grid, x, y, BLOCK.DRILL_RELIC)) {
      relics++;
      pois.push({ kind: 'relic', x, y });
    }
  }

  // --- Torches: drop ~10 in cave pockets so they feel "lived in".
  let torches = 0;
  for (let i = 0; i < 30 && torches < 10; i++) {
    const spot = findCaveWall(grid, rnd, ctx?.pockets);
    if (!spot) continue;
    grid[idx(spot.x, spot.y)] = BLOCK.TORCH;
    torches++;
  }

  return pois;
}
