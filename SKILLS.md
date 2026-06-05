# Robo-Miner — Agent Skills (the world a controller knows + the levers it pulls)

> Our job is **the world + the levers**, not the strategy. We expose every
> control and every bit of perception; *what to do with them* is the controller's
> business. Today the controllers are dumb local **test bots** that yank levers by
> simple rules (they can die — that's fine); later, people build real strategies
> on the same levers. This document is that contract: **what a controller knows
> about the world**, **the levers it can pull**, and the **strategy primitives**
> it *may* reason with (we describe them; we don't hardcode them).

The interface is intentionally tiny and uniform: every controller — a scripted
bot, a hand-written heuristic, whatever — is a function
`decide(observation) -> action` (sync or async). Nothing else. A controller can
also be handed only a **subset** of the levers (see §2).

---

## 1. What the agent must know about the world (the briefing)

A side-view mine on a tile grid. Down = deeper. Co-op: a team of agents shares
one map and one score.

- **Goal.** Find the unique **diamond** near the bottom and carry it to the shop
  to win (big team bonus). Along the way, mine ore for money.
- **Depth tiers.** Ore gets more valuable (and harder) with depth: coal → iron →
  copper → silver → gold → emerald → ruby → diamond. Deeper ore is worth far more
  per cargo slot, so deep trips pay off — *if* you can get home.
- **Fuel.** Every successful dig costs fuel ≈ the block's hardness. Walking is
  free. Fuel only refills at the **shop** (pay) — there is no fuel underground.
  Run out and you die. → *Budget fuel for the return trip, not just the descent.*
- **Cargo.** A limited number of slots. Sell by standing on the **surface row**
  (auto-sells anywhere on the surface, not only at the shop). Diamond is not
  cargo — it's a unique flag and is never auto-sold.
- **Ladders.** Climbing a non-laddered tile costs 1 ladder and plants it. So the
  **first** climb out of a fresh shaft costs (depth) ladders; **re-descending a
  shaft you already laddered is free**, and so is re-climbing it. Ladders refill
  at the surface. → *Budget ladders for the climb; reuse your shaft.*
- **Hazards.** `STONE` is undrillable — only **dynamite** breaks it. `LAVA` is
  near-instant death and slowly flows when you breach it. `WATER` drips damage.
  A **falling stone** can crush you (it wobbles first as a warning). Falling more
  than a few tiles without a **parachute** kills you.
- **Shop** (surface centre). Upgrades (drill/fuel/cargo/pack/radar), consumables
  (dynamite, parachute, teleporter, …), refuel, and **turn in the diamond to win**.
- **Vision is fogged** — you only see within your **radar** radius. Upgrading
  radar widens it. Chests (`C`) hold loot; shrines (`S`) trade an ore for a buff.

---

## 2. The levers (action set)

One action per tick. Multi-tick work (digging) is auto-continued by the engine;
while busy your action is ignored, so send `WAIT`.

| Action | Payload | Meaning |
| --- | --- | --- |
| `MOVE` | `{dir: left/right/up/down}` | Contextual: step into empty, **dig** into solid, climb up (auto-ladders), open a chest. The workhorse. |
| `DIG` | `{dir: left/right/up/down}` | Explicit "dig that way" — break the adjacent solid / open a chest; no-op on empty air. A pure mining lever (`DIG:left`, `DIG:right`, `DIG:down`). |
| `LADDER` | — | Plant a ladder in the current tile (manual route-building). |
| `PILLAR` | — | Plant a support pillar (stops falling stone). |
| `DYNAMITE` | `{size:1\|2, dir}` | Throw dynamite — the only way through `STONE`. **Clear the blast radius before the fuse ends.** |
| `TELEPORT` | — | Consume a teleporter → warp to the shop (sells + refills ladders). The deep-trip escape hatch. |
| `UPGRADE` | `{stat}` | At the shop door: buy the next tier. |
| `BUY` | `{item}` | At the shop door: buy a consumable. |
| `REFUEL` | — | At the shop door: full recharge. |
| `TURN_IN` | — | At the shop door with the diamond: **win**. |
| `WAIT` | — | Idle (also the default for a missed/late decision). |

The observation includes `legalActions` — the subset valid *right now* — so the
controller never has to guess what's currently allowed.

**Restricting the levers.** A controller can be limited to a subset: pass a
per-miner `allowed: ['MOVE','DIG', …]` (or a match-wide `allowedActions`). Out-of-set
actions idle (and are hidden from `legalActions`). Not every bot needs every lever.

---

## 3. What the agent perceives (observation)

`observe(minerId)` returns compact JSON (see `engine/observation.js`):

- `self` — pos, depth, facing, fuel/maxFuel, hp/maxHp, cargo + count + max,
  money, items (incl. ladders), upgrade levels, `hasDiamond`, `busy`, `alive`.
- `view` — tiles within radar (id + name + solid + hazard + value), live `bombs`
  with fuses, and an **ASCII minimap** of the local window (LLMs reason far
  better over the ASCII than a tile array). `@`=self, `&`=teammate, `*`=diamond,
  `C`=chest, `S`=shrine, `!`=lava, `~`=water, `X`=stone, `H`=ladder, `+`=ore.
- `team` — co-op: every teammate's position + the shared score and total sold.
- `surface` — surface row + shop column; `depth` — tiles below the surface.
- `legalActions` — currently-valid actions.

This is the **entire** sensory channel. If an agent needs to know something to
play well, it must be here — so this list is the real design surface.

---

## 4. Strategy primitives (what we *tell* the agent, not hardcode)

These are the reasoning patterns the briefing should hand the agent. The agent
decides *when* to apply them — we don't script them.

1. **Round-trip budgeting.** Before going deeper, check you can get back:
   fuel ≳ digs-remaining-to-return, ladders ≳ unladdered depth. Turn around (or
   teleport) while you still can.
2. **Shaft reuse / backtracking.** Your laddered shaft is a free elevator —
   descend it for nothing, mine the new face, climb it back to sell, repeat
   one band deeper each trip. (This is the core loop that makes the deep world
   tractable — no need to make the world easier.)
3. **Sell-when-heavy.** Cargo full ⇒ a trip to the surface; deeper ore is worth
   more per slot, so don't surface half-empty from a deep run.
4. **Stone routing.** Don't batter `STONE` (it never breaks) — go around, or
   spend dynamite when the shaft must continue straight. Then clear the fuse.
5. **Hazard avoidance.** Never step onto `LAVA`; don't free-fall past your safe
   height — ladder down or take stairs. Heed a wobbling stone.
6. **Co-op division of labour.** Spread across columns (the spawn already fans
   the team out); broadcast clue/chest/diamond finds via the shared score/positions;
   escort the diamond carrier home.

---

## 5. Lockstep & throughput

- **1 tick = 1 decision per controller.** The loop collects actions and advances
  on an optional **per-tick deadline** (`deadlineMs`). A controller that doesn't
  answer in time contributes `WAIT` that tick — being slow costs tempo, never
  correctness. Local test bots answer in microseconds; the deadline only matters
  for slow or remote controllers.
- Observations are deliberately **compact** (numbers + a small ASCII window).
- `engine/runner.js` runs any roster and **measures per-controller decision
  latency** (avg / max / missed-deadline count), so a slow controller's impact is
  visible and the cadence can be tuned.

---

## 6. Plugging in a controller

Every controller is the same shape — a dumb test bot, a hand-tuned heuristic, or
whatever a person builds later:

```js
const bot = {
  name: 'digger',
  decide: (obs) => {
    // read obs (ascii + numbers + legalActions), return one §2 action.
    if (obs.self.fuel < 12 && obs.self.depth > 0) return { type: 'MOVE', dir: 'up' };
    return { type: 'DIG', dir: 'down' };
  },
};
// drive it with engine/runner.js (or just submitAction/advance in a loop).
```

The baseline bots live in `engine/agents.js`; `engine/levers.mjs` verifies every
lever is wired and pullable (14/14). We ship the **world + the levers** — the
strategy is whatever the controller decides.
