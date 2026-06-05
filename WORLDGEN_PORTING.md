# World generation — porting spec for the on-chain contract

The game world is a **pure deterministic function of a seed**. To put it on-chain
the contract regenerates the world from the seed, stores the live grid in state,
and mutates it on every action. This doc is the spec + acceptance tests for the
Rust/Sails port. The authoritative source is the JS under `frontend/src/world/`.

## 1. Seed → world; contract holds the live grid
- At room creation derive `seed: u32` from the block hash.
- Call `generate_world(seed)` once → fill the grid (`Vec<u8>`, length `W*H`).
- Store the grid in program state and **mutate it** on every action / physics step.
- The seed is kept only for reproducibility / audit — after init the grid is the
  authority. Nobody ever transfers the grid; clients regenerate it from the seed
  and apply the contract's deltas.

## 2. Dimensions & tile bytes (digger / agent-arena world)
- `W = 40`, `H = 64`, surface row `S = 4`.
- `index(x, y) = y * W + x`.
- Tile byte values (only these appear in the digger world):

| byte | tile |
|---|---|
| 0 | empty / sky |
| 1 | dirt (drillable) |
| 9 | stone (undrillable; falls when undermined) |
| 10 | ladder (climbable) |
| 11 | pillar |
| 13 | lava (lethal) |
| 23 | SCRST (small crystal) |
| 24 | BCRST (big crystal) |
| 25 | HCRST (huge crystal) |

## 3. RNG — mulberry32 (must match byte-for-byte)
```js
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // float in [0,1)
  };
}
```
- `Math.imul(a,b)` = 32-bit `wrapping_mul` (`(a as i32).wrapping_mul(b as i32) as u32`).
- **Biggest porting risk = the final float division.** WASM f64 is IEEE-754
  deterministic, so an exact replica works *if the op order is identical*. The
  **safer** route is to use the integer output `((t ^ (t >>> 14)) >>> 0)` and do
  `value % N` instead of `floor(rnd() * N)`. The JS side can provide an
  integer-only variant of the generator on request so the port has zero float
  matching to do.

## 4. Generation pipeline (order matters) — `generateDiggerPass`
1. **baseFillDirt** — rows `< S` → 0 (sky); rows `>= S` → 1 (dirt).
2. **carveCaves(rnd)** — elliptical pockets + passages carved to sky.
3. **placeStones(rnd)** — scattered stone clumps (obstacles + falling-rock hazard),
   a bit denser in the shallow band.
4. **placeDeepLava(rnd)** — lava pools in the deep band (guard the bottom).
5. **placeCrystals(rnd)** — SCRST 77 / BCRST 19 / HCRST 4 (counts scale with map
   area vs the 40×64 reference), placed by depth window; HCRST lava-adjacent.
6. **frameWorld** — seal the border with stone.
7. **validateDigger** — BFS reachability of the deepest crystal from the surface.
   If unreachable, **regenerate** with `passSeed = (seed + attempt * 0x9e3779b1) >>> 0`,
   up to **8 attempts**, then accept the last.

Exact parameters (cave/stone/lava counts, depth fractions) live in the JS steps —
treat them as the spec: `frontend/src/world/steps/{baseFill,caves,crystals,frame}.js`,
`frontend/src/world/pipeline.js` (`generateDiggerPass`), `frontend/src/world/spec.js`
(the `agents` preset: `{ width:40, height:64, model:'digger', regen:true }`).

## 5. State & mutations (how the world changes)
State = **grid** (`Vec<u8>`) + **miners[]** (pos / inventory / fuel — NOT in the grid)
+ **hazards** (stones / lava / bombs as lists). Applying a change = writing the
affected cell byte(s) at `y*W+x`:

| action | grid writes |
|---|---|
| DIG | target cell → 0; if it was a crystal → `miner.inv[type] += 1` |
| LADDER / PILLAR | cell → 10 / 11 |
| DYNAMITE | cells in blast radius → 0 |
| MOVE | none — only `miner.pos` changes |
| physics (per tick) | stone fall (2 cells), lava spread (1 cell), bomb fuse (timer) |

Per tick the deterministic reducer `apply(state, buffered_actions)` validates each
action against the current grid, writes cells, runs physics, and emits
`Tick { cells: [{ index, tile }], miners: [...], events: [...] }`. Clients keep
`base(seed)` and apply the cell deltas — the full grid is never re-sent.
Reference reducer: `frontend/src/engine/realtime.js` (and `sim.js`).

## 6. Acceptance tests — golden vectors
Hash = FNV-1a 32-bit over the grid bytes:
```
h = 0x811c9dc5
for b in grid: h = (h XOR b); h = (h * 0x01000193) mod 2^32
output = hex(h)
```
Reference (current generator, `model=digger`, 40×64):

| seed | grid hash |
|---|---|
| 7 | `7168c8cb` |
| 42 | `f0acf852` |

The Rust port MUST produce the same grid bytes (= same hash) for these seeds.
Re-snapshot these if any generation parameter changes.

## 7. Authoritative source files
- RNG: `frontend/src/world/rng.js` (`makeRng`)
- pipeline: `frontend/src/world/pipeline.js` (`generateDiggerPass`, `generateWorld`)
- steps: `frontend/src/world/steps/{baseFill,caves,crystals,frame}.js`
- dims / preset: `frontend/src/world/dims.js`, `frontend/src/world/spec.js`
- reducer (mutations + physics): `frontend/src/engine/realtime.js`, `frontend/src/engine/sim.js`
- tile values / economy: `frontend/src/config.js` (`BLOCK`, `BLOCK_DATA`)
