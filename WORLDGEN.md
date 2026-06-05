# Robo-Miner — World Generation, and how it ties to Mode + Victory

> "Разобраться с генерацией миров: как они связаны с режимом и условиями
> победы." This documents how the world is built today, why one fixed shape
> doesn't fit a 10-agent match, and the design for **per-mode world presets** +
> **configurable victory conditions**.

## 1. How generation works today

`generateWorld(seed)` is **deterministic** (one seeded RNG threaded through every
step) — same seed ⇒ identical world. It runs 15 steps in `world/pipeline.js`:

| Phase | Steps | Produces |
| --- | --- | --- |
| Terrain | baseFill → barriers → caves → veins → sealVeins → diamond → re-carve fault | grid + cave `pockets[]` + `diamondPos` |
| Entities | chests → POIs → clues* → signals* | `chests[]`/`chestsAt`, `pois[]` |
| Hazards | lava → water | lava pools, flooded pockets |
| Finalize | frame → validate | stone border + reachability report |

`*clues` and `*signals` are **stubs** (no-op / `[]`).

**What actually drives ore distribution** (important — easy to get wrong):

- `config/resources.js` is the **real** ore engine: per-ore `minDepth/peakDepth/
  maxDepth`, `maxChance`, `veinCount/veinLen/veinRadius`. `baseFill` (per-tile
  gaussian rolls) and `veins` (vein walks) read it.
- `config.js` `BLOCK_DATA.minDepth/maxDepth` are **documentation only** — no step
  reads them.
- `config/layers.js` (the 5 biome "major layers" up to depth 1500) is **not wired
  in** — aspirational for a future deeper world.

**The diamond & reachability.** Placed at depth **225–243** (`SURFACE_Y + 225 +
rnd(0..18)`), hardcoded to `WORLD_H = 250`. After sealing, a winding fault is
re-carved at the diamond's column so it isn't walled off. `validate` BFS-checks a
non-STONE path spawn→diamond, but on failure it **only warns** — it does not
regenerate. (That's the `diamond unreachable from spawn` console warning.)

**Hazards.** Water floods 35% of shallow pockets (depth 12–90); lava pools sit
deep (depth 200+). Both depth bands are absolute.

## 2. Why one shape doesn't fit agent matches

The world is **120 wide × 250 deep, baked for a single skilled human** doing a long
marathon to the bottom. Two structural facts:

1. **Size is hardcoded.** `WORLD_W`/`WORLD_H` live in `config.js` and are imported
   directly by ~15 files; the grid stride is `idx(x,y) = y*WORLD_W + x`. Changing
   size is a real (but mechanical) refactor — see §5.
2. **Every depth landmark is an absolute constant** tuned to 250 deep: diamond
   depth (225), ore windows (2–235), chest tiers (2/60/140/245), POI bands
   (50–200), lava start (200), water band (12–90), stone-density depth
   breakpoints (20/60/150), the fault radius `1 + y/120`, the pocket-count
   divisor `/620`.

For 10 agents we want different shapes — **wider** (room to spread, fewer
collisions), often **shallower** (a match resolves in a sane tick budget), with
**tunable barriers/hazards**. None of that is reachable without parameterizing the
above.

We are **not** dumbing the world down — a competent controller manages fuel/
ladders/backtracking (see [SKILLS.md](SKILLS.md)). Presets are about *space and
match length per mode*, not difficulty crutches.

## 3. Mode → world preset (design)

Introduce a **`WorldSpec`** passed to `generateWorld(seed, spec)` and to
`createMatch`:

```
WorldSpec {
  width, height, surface,        // dimensions
  diamondDepthFrac,              // 0..1 of height (default ~0.92)
  oreScale, barrierScale,        // density multipliers
  hazardScale,                   // lava/water density
  // depth-band constants are derived from height, not hardcoded
}
```

Presets (the menu picks one per mode):

| Preset | Size (W×H) | Feel | Diamond |
| --- | --- | --- | --- |
| `solo` | 120×250 | current marathon | bottom (~230) |
| `coop` | ~180×120 | wide + shallow, room for 10, fewer death-walls | reachable in a match (~110) |
| `arena` | ~120×120 | compact, fast, dense interaction | mid-low (~100) |

`solo` reproduces today's world exactly (spec defaults = current constants), so
single-player is untouched.

## 4. Mode → victory conditions (now configurable in the engine)

The engine now accepts `victory` on `createMatch` (`config.victory`):

- `diamondWins` (default **true**) — turning the diamond in at the shop ends the
  match with a win.
- `scoreTarget` (default **null**) — when the **team score** reaches it, the match
  ends (`finished`, reason `score_target`).
- `maxTicks` (top-level) — always ends the match (reason `time`).

This lets each mode pick how it ends:

| Mode | Victory | Why the world must match |
| --- | --- | --- |
| Solo / coop "find the gem" | `diamondWins` | diamond must be **reachable in budget** ⇒ shallower diamond for agents |
| Score race | `scoreTarget` (+ maybe diamond bonus) | ore-rich, shallower ⇒ the race is about *throughput*, not a 250-deep trek |
| Timed haul | `maxTicks`, highest team score | bounded depth so a deadline is meaningful |
| (future) first-to-diamond PvP | `diamondWins`, competitive | shared map, `pvpImportance` from `resources.js` |

So **generation and victory are coupled**: a `scoreTarget`/timed mode wants a
shallow ore-dense preset; a `diamond` mode wants the diamond within reach of the
tick budget. The preset and the victory config are chosen together per mode.

## 5. The refactor to get there (scoped)

1. **Parameterize dimensions.** Thread `{width,height,surface}` (a spec) through
   `generateWorld` and the steps; make `idx`/bounds spec-aware instead of importing
   module-level `WORLD_W/H`. ~15 files, mechanical. Default spec = today's
   constants ⇒ zero behaviour change for `solo`.
2. **Derive depth constants from height.** Replace the absolute landmarks with
   fractions of `height` (diamond `height*diamondDepthFrac`; ore/chest/POI/lava/
   water bands scaled by `(height-surface)/246`; fault radius and pocket divisor
   scaled). The failure-point list is enumerated in this repo's gen audit.
3. **Add scale knobs** (`oreScale`, `barrierScale`, `hazardScale`) as simple
   multipliers on the existing counts/densities.
4. **Enforce reachability.** Upgrade `validate` to **regenerate with a new seed**
   (a few attempts) when the diamond is unreachable — so agent worlds always have a
   solvable `diamond` victory.
5. **Wire presets** into `createMatch(spec)` / rooms / the menu mode picker.

## 6. Optional finishing (stubs)

- `clues.js` — predecessor hints (pyrite before gold, bricks before vaults).
- `signals.js` — precomputed radar layer (so radar queries categories, not tiles).
- `layers.js` — wire the biome multipliers in once worlds get deeper.

---

## Status

- ✅ Generation fully mapped (this doc).
- ✅ **Victory conditions** implemented + configurable (`config.victory`:
  `diamondWins`, `scoreTarget`; + `maxTicks`).
- ✅ **Stage A1 — dimension parameterization (done):** `generateWorld(seed, spec)`
  accepts a `WorldSpec`; size lives in `world/dims.js` (generation-active) and on
  each world object (`world.W/H/surface`) for runtime. Presets `solo`/`coop`/
  `arena` in `world/spec.js`. The engine reads each world's own dims, so worlds of
  different sizes run side by side. **`solo` is byte-identical to the old world**
  (verified by a grid-hash baseline) — single-player untouched. `createMatch({ spec })`
  picks the preset.
- ✅ **Stage A2 — depth scaling (done):** a single `DIMS.depthScale =
  (height-surface)/246` + `scaleDepth()` compress the absolute depth landmarks
  (diamond, lava, water) onto the active world, so a shallow preset keeps the same
  relative layout (`depthScale === 1` for solo ⇒ byte-identical). `validate` now
  **regenerates** with fresh seeds (up to 8) until the diamond is reachable —
  enabled for agent presets (`regen: true`), off for solo (stays warn-only).
  Result: solo 120×250 (diamond ~98%), coop 200×160 (~92%), arena 140×110 (~97%),
  **all with a reachable diamond** and scaled lava/water.
- ⏭ **Optional refinement (A3, if needed):** compress the *ore* depth windows
  (and POI bands) the same way so a shallow preset keeps the full coal→ruby value
  gradient instead of cutting off the deep ores. Today ore sits at its natural
  depth, so a shallower preset simply has a shallower ore set (a deliberate, valid
  biome choice — tune preset height to include the ores a mode wants).
