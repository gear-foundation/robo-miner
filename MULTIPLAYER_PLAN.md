# Robo-Miner: Single-player + Agent Multiplayer — Design & Plan

> Status: **design + engine scaffold (phase 0)**. Blockchain is intentionally
> out of scope — the engine is a pure, deterministic, headless module so it can
> later be hosted by any backend (server today, another chain later) without
> changes to game rules.

## 1. Goal

Keep Robo-Miner playable as a single-player game **and** add a **cooperative
multiplayer** mode where up to **10 AI agents (machines, not humans)** mine a
**single shared map**. Agents are LLM-driven and act through a **skill/API**
(the same shape as the `vara-skills` packs already in this workspace): each
agent observes the world (fog-limited) and submits one action per tick. The
match advances in **lockstep ticks**. The team shares a score; the win is the
team finding the diamond and turning it in.

Decisions locked with the product owner:

| Question | Decision |
| --- | --- |
| Who controls a robot | **LLM agents via skills/API** |
| Tempo | **Lockstep tick simulation** |
| Conflict model | **Cooperative** (shared team score) |
| Now | **This design doc + start the engine scaffold** |

**Design stance.** Our job is the **world + the skills**, not a clever bot. The
world stays as challenging as it is — fuel, ladders, falls, lava, undrillable
stone. A competent agent *learns* to manage it (round-trip fuel/ladder budgeting,
reusing its laddered shaft as a free elevator, backtracking to sell, then going
deeper). So we don't dumb the world down; we make sure the agent **knows** enough
about it and has the **levers** to act. World tuning knobs (`safeFall`, size,
depth) and presets are optional — for *space and match length* with 10 agents, or
for cadence — not crutches for weak bots. The agent's full contract — what it
perceives, the levers, the strategy primitives, and the lockstep throughput
model — lives in [SKILLS.md](SKILLS.md). Scripted bots (`engine/agents.js`) are
only a baseline to watch the world work.

## 2. Where the current game stands

- `frontend/src/world/*` — world generation is **deterministic** (`generateWorld(seed)`,
  seeded mulberry32 RNG). Same seed ⇒ identical map. Perfect for a shared map.
- `frontend/src/robot.js`, `frontend/src/config*` — pure state/data, no Phaser.
- `frontend/src/render/robot.js` `drawRobot(g, cx, cy, size, opts)` is already
  **stateless** and can render N robots in one pass — multiplayer rendering is
  essentially free.
- `frontend/src/scenes/GameScene.js` — **4567-line monolith** that fuses
  simulation + Phaser rendering + DOM HUD/shop + audio + single-player keyboard
  input. **No** separation between "rules" and "view". This is the main work.
- The loop is **real-time** (ms timers: dig duration, 1.5 s stone shake, 280 ms
  lava steps). Some gameplay randomness uses `Math.random()` (chest loot, shrine)
  — **not** reproducible. Both must change for authoritative lockstep play.

## 3. Target architecture (5 layers)

```
┌─────────────────────────────────────────────────────────────┐
│ 5. Renderer (Phaser)  — single-player view + multiplayer      │
│    spectator/replay. Pure VIEW over engine snapshots.         │
├─────────────────────────────────────────────────────────────┤
│ 4. Server (Node, headless)  — runs the engine, hosts matches, │
│    exposes the agent API over WebSocket/REST. (Later: chain.) │
├─────────────────────────────────────────────────────────────┤
│ 3. Agent skill pack  — LLM tools: join / observe / act / wait.│
│    Strategy guidance. Mirrors vara-skills layout.             │
├─────────────────────────────────────────────────────────────┤
│ 2. Match controller (lockstep)  — collect 1 action/miner/tick,│
│    advance on a deadline, produce per-agent observations.     │
├─────────────────────────────────────────────────────────────┤
│ 1. Pure engine (headless, deterministic)  — the only source   │
│    of truth for rules. No Phaser/DOM/audio/Math.random/Date.  │
└─────────────────────────────────────────────────────────────┘
```

The same engine (layer 1) runs unchanged inside the browser (single-player and
spectator) and inside the server (authoritative multiplayer). This is the whole
point of extracting it.

## 4. The tick model (lockstep)

**1 tick = 1 simulation step = 1 action opportunity per miner.** Wall-clock
cadence (how long to wait for slow LLM agents before forcing the tick) lives in
the server, not the engine — the engine just exposes `step()`.

Real-time durations are converted to **tick counts**:

- **Move** one tile = 1 tick.
- **Dig** a block = `digTicks(block, miner)` ticks. While digging, the miner is
  *busy*: the engine auto-progresses the dig and ignores new actions until it
  finishes. Conversion: `max(1, round(max(MIN_DIG_DURATION, 420·hardness·drillSpeed) / MS_PER_TICK))`.
- **Falling stone**: shakes `SHAKE_TICKS`, then drops 1 tile/tick (cascades use
  a 1-tick shake so a slide reads as one motion).
- **Lava**: advances one cell every `LAVA_STEP_TICKS` ticks, capped by a
  per-source budget and a max number of active sources.
- **Dynamite**: fuse measured in ticks, detonates in the physics phase.

Per-tick order (deterministic):
1. `tick++`
2. World physics: falling stones → falling pillars → lava → bombs.
3. Miners in **ascending id order**: respawn check → if busy, progress dig → else
   apply gravity (a fall consumes the turn) → apply the submitted action.
4. Finish checks (diamond turned in / max ticks).

Deterministic ordering + a single seeded RNG stream for gameplay events means a
match is fully reproducible from `(seed, action log)` — essential for an
authoritative server and for a future on-chain port.

## 5. Action API (the agent "skills")

One action per miner per tick. The engine resolves multi-tick actions itself.

| Action | Payload | Effect |
| --- | --- | --- |
| `MOVE` | `{dir: left/right/up/down}` | Contextual, mirrors the game: into empty ⇒ step; into solid ⇒ start a dig; up ⇒ climb (auto-places a ladder) or dig up; into a chest ⇒ open + step. |
| `DIG` | `{dir: left/right/up/down}` | Explicit dig-that-way (break adjacent solid / open chest; no-op on air). |
| `LADDER` | — | Place a ladder in the current tile. |
| `PILLAR` | — | Place a support pillar. |
| `DYNAMITE` | `{size: 1/2, dir}` | Throw small/big dynamite in a direction. |
| `TELEPORT` | — | Consume a teleporter, warp to the shop (auto-sell + refill). |
| `UPGRADE` | `{stat: drill/fuel/cargo/pack/radar}` | At the shop door: buy next upgrade tier. |
| `BUY` | `{item}` | At the shop door: buy a consumable. |
| `REFUEL` | — | At the shop door: full recharge for `FUEL_PRICE`. |
| `TURN_IN` | — | At the shop door with the diamond: **team win**. |
| `WAIT` | — | Do nothing this tick (also the default for a missing submission). |

A controller can be restricted to a **subset** of these levers via a per-miner
`allowed: [...]` or a match-wide `allowedActions` — out-of-set actions idle and
are hidden from `legalActions`. The full agent contract is in [SKILLS.md](SKILLS.md).

## 6. Observation (fog of war) — what an agent sees

`observe(match, minerId)` returns compact JSON tuned for an LLM:

- `self`: position, facing, fuel/maxFuel, hp/maxHp, cargo + count + maxCargo,
  money, items, upgrade levels, `hasDiamond`, `busy` (dig in progress), `alive`.
- `view`: tiles within the radar radius (id + name + solid/hazard flags) **plus a
  small ASCII minimap** of the local window — LLMs reason far better over the
  ASCII than over a tile array.
- `team` (cooperative ⇒ full team visibility): every miner's id/name/position/
  alive/hasDiamond, plus the shared score and total sold.
- `surface`: surface row + shop column; `depth`: tiles below the surface.
- `legalActions`: the subset valid right now (huge quality boost for LLM play).

## 7. Cooperative scoring

- Each miner keeps a personal wallet (auto-sell on the surface, spends on its own
  upgrades). **Team score = Σ miners' money (+ diamond bonus on turn-in).**
- No PvP: miners never damage each other; they cannot occupy the same tile
  (movement is blocked, digging is fine).
- Death penalty (matches single-player respawn): lose cargo, drop the diamond,
  HP restored, fuel floored at 30 %, auto-respawn at the shop after `RESPAWN_TICKS`.
  Keeps a coop match going until the diamond is found or `maxTicks` elapses.
- Natural coop strategy the skill pack should encourage: split the map into
  columns/sectors, share clue/chest finds, route the diamond carrier home safely.

Open option for later: a **shared treasury** + shared upgrades instead of
per-miner wallets. Per-miner is simpler and is what the scaffold ships.

## 7b. Rooms, lobby & spectator (map gallery + live view)

A **room** is the unit a player browses and watches: **one generated map + the
match running on it**. Same seed ⇒ same room map, so a room is fully described
by `(seed, agent roster, mode)` and is reproducible.

- **Room** = `Match` + metadata (`id`, `seed`, `mode`, `status`, roster). A room
  is created from a seed; its map is the deterministic `generateWorld(seed)`.
- **Lobby (main menu)** = a gallery of rooms. Each card shows a **thumbnail of the
  generated map** (downsampled so landmarks — diamond, lava, chests, ore veins —
  survive the scale) plus a one-line summary (agents, alive, tick, team score,
  diamond found). This is the "посмотреть на карты" view.
- **Spectator** = enter a room and watch the agents move **live**. The view is the
  existing world renderer driven by engine **snapshots** instead of keyboard
  input. Motion is tick-based, but the renderer already tweens a robot's draw
  position between tiles (`tweenRobotDrawPosition`), so the camera reads as smooth
  even though decisions land on ticks. `drawRobot()` already renders N robots.
- The spectator can follow one agent, free-pan, or watch a minimap with all
  agents as dots — the thumbnail generator already supports a live agent overlay.

This is already real headless: `engine/preview.js` produces the thumbnail (a
2-D hex-color grid for the menu canvas **and** an ASCII version), `engine/room.js`
wraps a match as a room with a lobby summary + a live spectator frame, and
`node src/engine/lobby.mjs` prints a multi-room lobby with map thumbnails and a
live `@`-overlay spectator frame in the terminal. In Phase 4 the same data feeds
a Phaser menu gallery (paint `colors` to a texture) and a spectator scene.

The authoritative **multi-room host** (create / list / join / reap rooms, cap
concurrent rooms, stream snapshots to spectators) lands with the server in
Phase 2/4 — `room.js` is the seed of that API.

## 8. Determinism requirements (must-fix during extraction)

1. All gameplay randomness (chest loot `rollLoot`, shrine reward, ore rolls)
   draws from the match's **seeded** RNG stream, never `Math.random()`.
   (`rollLoot(tier, rnd)` already takes an rng — trivial to seed.)
2. No `Date.now()` / `this.time.now` in rules — use the tick counter.
3. Cosmetic-only randomness (debris, flicker) stays in the **renderer**, never in
   the engine.
4. RNG state is serializable (a single integer) so a match can be snapshotted,
   resumed, and replayed.

## 9. Roadmap (phased, non-breaking)

**Phase 0 — Engine scaffold (this change).** New `frontend/src/engine/` package:
deterministic state model, action set, fog observation, lockstep `step()` and a
`Match` controller, plus a Node smoke test proving determinism. Single-player is
untouched.

**Phase 1 — Single-player on the engine.** Make `GameScene` a *view*: translate
keyboard input into engine actions, run the engine each frame, render from
engine state. Delete the duplicated rules from `GameScene` as each system moves
over (dig, gravity, lava, stones, shop). End state: one source of truth.

**Phase 2 — Match server.** Node process hosting matches; WebSocket/REST endpoints
`join / observe / act`; tick on a deadline (force `WAIT` for late agents).

**Phase 3 — Agent skill pack.** `skills/robo-miner-*` (join, observe, act, a
strategy overview) mirroring `vara-skills`. An LLM agent loop: observe → decide →
submit → wait for tick.

**Phase 4 — Lobby + multiplayer renderer.** Main-menu **room gallery** (paint
`preview.js` thumbnails to textures) and a **spectator scene** rendering N robots
from streamed snapshots (`drawRobot` already supports this) + a coop HUD. The
terminal lobby/spectator (`lobby.mjs`) already proves the data path.

**Phase 5 — Balance & polish.** Tune tick costs, AP/economy, coop incentives;
optional shared treasury; reconnect/resume; later the chain port.

## 10. File layout

```
games/robo-miner/
  MULTIPLAYER_PLAN.md          ← this document
  SKILLS.md                    ← the agent contract: world knowledge + levers + strategy + throughput
  WORLDGEN.md                  ← how world gen works + per-mode presets + victory conditions
  frontend/src/world/
    dims.js                    ← generation-active dimensions (Stage A1)
    spec.js                    ← WorldSpec + presets solo/coop/arena (Stage A1)
  frontend/src/engine/         ← Phase 0 (pure, Node + browser)
    index.js                   ← public API
    constants.js               ← tick/balance constants
    rng.js                     ← resumable seeded RNG
    state.js                   ← createMatch / miners / spawn
    actions.js                 ← action types + normalize/validate
    sim.js                     ← step(): physics + per-miner resolution
    observation.js             ← fog-limited per-agent observation
    match.js                   ← lockstep Match controller
    preview.js                 ← room map thumbnail (menu gallery + ASCII)
    room.js                    ← Room = map + match; lobby summary; spectator frame
    modes.js                   ← game modes = world preset + victory + spawn (Stage B)
    agents.js                  ← scripted bot factory (baseline to watch the world)
    runner.js                  ← pluggable async runner + decision-latency metering
    smoke.mjs                  ← Node determinism + coop-run smoke test
    lobby.mjs                  ← Node lobby + live spectator demo (terminal)
    watch.mjs                  ← Node: 10 bots play a coop match live (terminal)
    runner-demo.mjs            ← Node: latency / tick-deadline throughput demo
    levers.mjs                 ← Node: verifies every lever is wired + pullable (14/14)
  server/                      ← Phase 2 (later)
  skills/                      ← Phase 3 (later)
```

The engine imports only the already-pure modules (`config.js`, `world.js`,
`robot.js`, `config/chests.js`), so it runs in Node as-is. A later move to a
top-level shared package is mechanical.

## 11. Risks / notes

- **Extraction is the bulk of the effort.** The scaffold reimplements the *core*
  rules cleanly from the config values; Phase 1 must reconcile any drift so the
  single-player feel is preserved as `GameScene` delegates to the engine.
- **LLM latency.** Lockstep with a generous per-tick deadline absorbs slow agents;
  late/no submission ⇒ `WAIT`. Server cadence is the tuning knob, not the engine.
- **Scaffold scope.** Phase 0 fully implements movement, gravity, digging,
  economy/shop, hazards, falling stones, lava, dynamite, chest loot and the win;
  shrine/drill-relic/chest-trap have simplified deterministic stubs marked
  `TODO(parity)` to reconcile against `GameScene` in Phase 1.
```
