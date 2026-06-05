# On-chain data model — WEB3 MINER (Vara / Sails)

> Goal of this doc: describe the **data and the handles (messages)** in a form a
> contract dev can implement directly as Sails programs. No Rust here — just the
> shapes, types, and message flow. The off-chain engine (`frontend/src/engine`) is
> the reference for the rules; this is how that state lives on-chain.

## Design principles (what "convenient for the contract" means)

1. **One authoritative world.** The shared map lives in **one** program (Room).
   Per-agent money/identity lives in **per-agent** programs (DiggerAccount).
2. **Packed state, delta events.** The grid is a flat byte array; each tick the
   program mutates only touched cells and **emits a delta**, never the whole map.
3. **Discrete, deterministic.** State advances in **ticks** (driven by blocks via
   self-scheduled delayed messages). Pure reducer `state' = apply(state, actions)`.
   Seed fixed at room creation → fully reproducible. No wall-clock, no per-step RNG.
4. **Small types.** Coords `u16`, counts `u32`, balances `u128`, tiles `u8`, actions
   a compact enum. Frontend smoothness is NOT the contract's problem (it interpolates
   between snapshots).

## Program topology

```
Registry            (1 global)   "who is allowed to play" + handle→account lookup
  └─ DiggerAccount   (1 per agent) the "персонаж": balance, inventory, history
        └─ acts in →
Room                (1 per daily map/session) the world: grid, miners, physics, tick
```

- A **move = one `Room.act(...)` message.** 10 agents firing these = the tx storm.
- Room → DiggerAccount messages only on **settlement** (sold ore, found diamond,
  session end) — not every step.

---

## Shared types

```
Dir     = Up | Down | Left | Right
Tile (u8) =
  Empty | Dirt | Stone | Bedrock |
  Ore(tier: 0..7)        // 8 ore tiers (or → 3 crystals: Scrst|Bcrst|Hcrst, TBD)
  Diamond | Chest | Shrine |
  Lava |
  Ladder | Pillar |      // agent-placed
  ShopFloor
  // ladder/pillar/bomb can also be an "overlay" byte parallel to the base grid

Action =
  Wait
  Move(Dir)
  Dig(Dir)
  PlaceLadder
  PlacePillar
  Dynamite(size: Small|Big)
  Teleport
  Upgrade(stat: Drill|Tank|Bag|Boots)
  Buy(item: ItemId)
  Refuel
  TurnIn               // sell carried ore / cash in at shop

Cell    = { x: u16, y: u16 }
```

---

## Program 1 — Room (the world; 1 per session)

### State
```
config: {
  seed: u64,                 // fixed at init (from block hash) → deterministic world
  width: u16, height: u16,   // brief map = 40 x 64
  surface_row: u16,
  max_miners: u8,            // up to 10
  min_to_start: u8,          // lobby fill threshold
  tick_blocks: u8,           // heartbeat period (how many blocks per tick)
  start_deadline: u64,       // block; timeout fallback to start
  session_end: u64,          // block; daily reset / extraction cutoff
  victory: { diamond_wins: bool, score_target: u32 }   // or extraction-only
}

grid:    Vec<u8>             // len = width*height, base tile per cell (packed)
overlay: Vec<u8>             // ladders / pillars / placed markers (optional 2nd plane)

miners:  Vec<Miner>          // indexed by miner_id (slot)
stones:  Vec<Stone>          // active falling-rock hazards
lava:    Vec<Cell>           // active lava front (spreads on tick)
bombs:   Vec<Bomb>           // armed dynamite

pending: Vec<Option<Action>> // buffered action per miner for the NEXT tick
tick:    u64
rng:     u64                 // deterministic PRNG state
status:  Lobby | Running | Settled
```

### Sub-structs
```
Miner = {
  id: u8,
  owner: ActorId,            // the DiggerAccount program (or account) that controls it
  x: u16, y: u16, facing: Dir,
  spawn_x: u16, spawn_y: u16,// respawn at own spot, not shop center
  fuel: u32,
  alive: bool,
  respawn_at: u64,           // tick to revive at (0 = alive)
  inv: { ladders: u8, pillars: u8, dynamite: u8, parachute: u8,
         drill_lvl: u8, tank_lvl: u8, bag_lvl: u8, boots_lvl: u8 },
  carry: { ore: [u32; 8], has_diamond: bool },   // unsold loot (lost/dropped on death)
  stats: { tiles_dug: u32, deaths: u16 }
}

Stone = { x: u16, y: u16, phase: Shake | Fall, at: u64 }   // `at` = tick of transition
Bomb  = { x: u16, y: u16, radius: u8, fuse_at: u64 }       // detonates at this tick
```

### Commands (handles — the "ручки")
```
join(meta: MinerMeta) -> MinerId
    // registered agent takes a slot in the lobby. Gated by Registry.
    // emits Joined. Starts the session when miners == max OR deadline passed.

act(miner_id: u8, a: Action) -> Accepted | Rejected(reason)
    // THE per-move tx. Buffers `a` as this miner's intent for the next tick.
    // Cheap, one message. Re-validated at tick against live state.

tick()                       // self-only (via send_delayed). NOT user-callable.
    // 1) apply pending actions in deterministic id order (illegal → Wait)
    // 2) run physics one step: stones shake→fall, lava spreads, fuses tick,
    //    gravity pulls unsupported miners, deaths → schedule respawn
    // 3) write changed cells, update miners
    // 4) emit Tick{delta}
    // 5) send_delayed(tick, tick_blocks)   // schedule next heartbeat
    // 6) on session_end → settle() to each DiggerAccount, status=Settled

start()                      // optional explicit lobby→running (or auto in join/tick)
```

### Queries (read-only — how agents/frontend observe)
```
snapshot() -> WorldSnapshot { config, grid, overlay, miners, stones, lava, bombs, tick }
    // full state for the frontend renderer and for an agent's "look".

observe(miner_id) -> Observation
    // optional FOGGED view (radar radius, legal actions, nearby bombs).
    // Fog is a convenience; anti-cheat does NOT depend on it (act() re-validates).

miner(miner_id) -> Miner
```

### Events (deltas — this is how everyone "sees changes")
```
Joined   { miner_id, owner }
Started  { tick }
Tick {
  tick: u64,
  cells:   Vec<{ index: u32, tile: u8 }>,     // only changed cells
  miners:  Vec<MinerDelta>,                    // moved/fuel/alive/carry changes
  events:  Vec<GameEvent>                      // semantic deltas for UI/agents
}
GameEvent = Dug{miner,x,y,tile} | Moved{miner,x,y} | Fell{miner,dist}
          | Died{miner,x,y} | Respawned{miner} | DiamondFound{miner}
          | StoneFell{x,y} | LavaSpread{x,y} | Detonation{x,y,radius}
          | Sold{miner,amount} | Bought{miner,item} | Upgraded{miner,stat}
Settled  { miner_id, payout }
```

Agent loop: read `observe()`/listen to `Tick` events → `decide()` → `act()`. It
always acts on a slightly stale view; `act()` re-validates at the next tick.

---

## Program 2 — DiggerAccount (the "персонаж"; 1 per agent)

### State
```
owner:       ActorId
fuel:        u128            // exec balance / fuel (wVARA-style), spent on actions
resources:   { scrst: u32, bcrst: u32, hcrst: u32 }   // (or the 8-ore counts)
redeemed:    u128            // VARA cashed out (the only real outflow)
history:     { runs: u32, best_score: u32, total_dug: u64, diamonds: u16 }
current_room: Option<ActorId>
```

### Commands (handles)
```
// creation = deploying this program; init sets owner. (Registry can mint it.)
deposit_fuel(amount: u128)
redeem(res: ResId, amount: u32) -> u128        // RES → VARA at fixed in-app rate
withdraw(amount: u128)                          // VARA out to wallet
on_settle(run: RunResult)                       // called BY Room: credit mined RES + history
```

### Events
```
DiggerCreated { owner }
FuelChanged   { fuel }
Redeemed      { res, amount, vara }
Withdrawn     { amount }
RunRecorded   { room, score, dug }
```

---

## Program 3 — Registry (1 global; "only registered agents play")

### State
```
accounts: Map<ActorId -> ActorId>   // owner/handle -> DiggerAccount program id
handles:  Map<Handle -> ActorId>
```
### Commands
```
register(handle) -> DiggerAccountId   // the "ручка создать персонажа"
resolve(handle)  -> ActorId
```
Room.join() checks Registry that the caller owns a registered DiggerAccount.

---

## Flow of ONE move (sequence)

```
agent.brain (off-chain)
   reads Room.observe(me)            ← current (slightly stale) world
   decides action
   → Room.act(me, Dig(Down))         ← 1 tx  (buffered as pending[me])
... (other agents' act() land in the same/next block, all buffered) ...
Room.tick()  (self, every tick_blocks blocks)
   apply pending in id order → physics step → write cells
   → emit Tick{ cells, miners, events }   ← everyone sees the delta here
agent.brain reads the new snapshot → next act()  → ...
```

## Flow of a SESSION

```
REGISTER  agent → Registry.register → owns a DiggerAccount
LOBBY     agent → Room.join (slot).  start when miners==max OR start_deadline
RUNNING   Room.tick heartbeat; agents act(); world mutates; events stream
SETTLE    at session_end: Room → DiggerAccount.on_settle(mined RES) per miner;
          unmined resources deleted (not paid); status=Settled; daily reset
```

## Determinism & heartbeat (recap)

- `seed` fixed at Room init (block hash) → `generateWorld(seed)` is reproducible.
- Physics + action application are a **pure reducer per tick** — same inputs, same
  output on every validating node. This is exactly `sim.js`'s `step()`, ported.
- The heartbeat is the program **scheduling `tick()` to itself** via a delayed
  message every `tick_blocks` blocks. Nothing else "runs on its own".

---

## Open decisions to fill in (params, not structure)

1. **Resources:** keep the 8 ore tiers, or collapse to 3 crystals (SCRST/BCRST/HCRST)?
   Drives `Tile::Ore` and `DiggerAccount.resources`.
2. **Diamond:** keep diamond-win + jackpot, or make the deep chest (HCRST) the top
   prize? Drives `victory` + `carry.has_diamond`.
3. **Action routing:** `act()` straight to Room (recommended), settlements Room→Account.
   Or route every action through DiggerAccount (2× messages)?
4. **Fog on-chain or off-chain only?** Recommend: on-chain `snapshot()` is full;
   fog is an off-chain courtesy. Anti-cheat holds via `act()` re-validation.
5. **Map size:** lock 40×64 (brief) for density + cheap state?
6. **tick_blocks / session length:** how many blocks per tick; 30-min session in blocks.
7. **Gas / reverse-gas:** vouchers funded by Room/Account so agent `act()` is gasless
   to the operator (matches brief's reverse-gas).
```
