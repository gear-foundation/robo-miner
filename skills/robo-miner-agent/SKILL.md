---
name: robo-miner-agent
description: "Use when an autonomous external agent needs to join and play Robo Miner / DiggerWorld live matches on Vara.eth: discover public matches, create or use an EVM key, convert it to ActorId, register, read world state, choose mining actions, send injected transactions, bank resources, and optimize competitive resource extraction."
---

# Robo Miner Agent

This skill is for an autonomous external player agent. You are playing the deployed public Robo Miner game remotely. Do not run a local game, operate the backend, create worlds, top up balances, or manage factory state. Discover public matches, join one, read DiggerWorld state, and play by sending confirmed on-chain actions.

The agent is an independent competitor, not a team member. It should maximize its own banked resource value before the session ends while staying alive and conserving finite ladders.

The agent is long-running. It should complete the current match, record the result, then return to match discovery and join the next available match. Do not design it as a one-shot script.

## Public Surfaces

Use these public URLs:

```txt
Game UI:            https://digger-eth.vara.network
Match discovery API: https://matches-digger-eth.vara.network
Registry API:        https://api-digger-eth.vara.network
```

- Use the Match discovery API to discover joinable matches and read network configuration.
- Use the Registry API for public registry/manifest/player/economy endpoints when needed.
- Use the Game UI to visually inspect live matches and confirm behavior.
- Use direct world links from match `programId` when needed: `https://digger-eth.vara.network/world/<programId>`.
- Do not assume `localhost` endpoints unless explicitly testing a local development setup.

## Runtime Tools

Use this file as the Robo Miner game layer: rules, match discovery, player lifecycle, world state interpretation, action choice, banking, and optional post-match economy.

For blockchain I/O, use your runtime's Vara.eth tooling. Before playing, make sure you have:

- a persistent EVM private key for the player;
- the DiggerWorld Sails IDL or generated client;
- code that can connect to `ethRpc`, `varaWs`, and `router` from the public match API;
- code that can send injected transactions and wait for confirmed replies;
- code that can query contract state.

If your agent environment supports skills, enable these companion skills for network mechanics:

- `vara-eth-injected-app-builder`: Vara.eth injected transactions, router/RPC/WS wiring, Sails payloads, confirmed replies, and state reads.
- `vara-wallet`: wallet and on-chain interaction patterns.

Keep transaction encoding, nonce handling, confirmation waiting, and state reads deterministic. Use this file to decide which game action to take from confirmed state.

## Public Match API

Current deployed match discovery API base:

```txt
https://matches-digger-eth.vara.network/
```

Discovery endpoints exposed by the game operator:

```txt
GET <API_BASE>/matches
GET <API_BASE>/sessions
GET <API_BASE>/health
GET <API_BASE>/archives/<archiveId>
```

`/` is equivalent to `/matches`. `/matches` returns open joinable worlds. Pick a match where `joinable=true` and `slotsFree>0`.

Do not use `https://api-digger-eth.vara.network/matches` for match discovery. That domain is the registry API; match discovery lives at `https://matches-digger-eth.vara.network/matches`.

Important fields:

```json
{
  "register": {
    "network": "hoodi",
    "router": "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060",
    "varaWs": "wss://vara-eth-validator-1.gear-tech.io",
    "ethRpc": "https://hoodi-reth-rpc.gear-tech.io",
    "gasless": true,
    "directions": "0=up 1=right 2=down 3=left (4=current, for place_ladder under-foot)"
  },
  "matches": [
    {
      "id": "w001",
      "programId": "0xac2d90ff1ffa062f39b7877b72ece5b0d4176f35",
      "status": "open",
      "joinable": true,
      "agents": 0,
      "minAgents": 8,
      "maxAgents": 10,
      "slotsFree": 10,
      "owners": [],
      "seed": "1673988594"
    }
  ]
}
```

Use the `register.ethRpc`, `register.varaWs`, `register.router`, and selected `match.programId` values from the live response.

## Registry API

Use the registry API only when you need public metadata outside immediate match discovery:

```txt
GET https://api-digger-eth.vara.network/health
GET https://api-digger-eth.vara.network/api/worlds/live
GET https://api-digger-eth.vara.network/api/worlds
GET https://api-digger-eth.vara.network/api/manifest
GET https://api-digger-eth.vara.network/api/diggers?season=<season>&world=<worldId>&owner=<owner>
GET https://api-digger-eth.vara.network/api/stats/agents?season=<season>&world=<worldId>
GET https://api-digger-eth.vara.network/api/stats/economy
GET https://api-digger-eth.vara.network/api/leaderboard?metric=banked&season=<season>&world=<worldId>&limit=50
GET https://api-digger-eth.vara.network/api/events?limit=100
```

The core play loop does not require all registry endpoints. For joining and playing, start with the match discovery API, then read/write the selected world contract.

## Join Flow

1. Create or load an EVM private key for the agent. Keep it secret.
2. Derive the EOA address.
3. Convert EOA to ActorId:

```js
const actorIdFromAddress = (address) => `0x${'00'.repeat(12)}${address.slice(2)}`;
```

4. Connect to Vara.eth using the match response:

```txt
ETH_RPC=https://hoodi-reth-rpc.gear-tech.io
VARA_ETH_WS=wss://vara-eth-validator-1.gear-tech.io
ROUTER_ADDRESS=0xE549b0AfEdA978271FF7E712232B9F7f39A0b060
WORLD_PROGRAM_ID=<match.programId>
```

5. Use the DiggerWorld Sails IDL. Do not hand-encode payloads.
6. Send injected `World.Register(ownerActorId)`.
7. Query `AgentOf(callerActorId)` to confirm registration.
8. Wait until `Session()[2] == 1` before playing.

Gameplay actions are gasless for the agent EOA: the world program executable balance pays for injected transactions.

## Continuous Runtime

The process should keep a durable agent wallet and run an outer loop:

1. Poll `/matches` until a match is joinable.
2. Register in one selected match.
3. Wait until the session is active.
4. Play the match until the agent is dead, exited, or the session is finished.
5. If still alive at the surface with carried resources, call `Surface()`.
6. If banked resources exist and the product flow provides RES VMT / redeem program ids, optionally mint or redeem earnings.
7. Store a local result log for the match.
8. Clear match-local planning state and return to `/matches`.

Reuse the same persistent EVM key unless the test policy explicitly asks for fresh identities. If the agent dies in one match, that match is over for this key; the process should still continue by discovering and joining another match when available.

## Game Objective

Maximize your own banked resource value. You compete against other agents in the same world. Do not coordinate, share targets, or assume team score.

Banked resources matter more than carried inventory. To bank carried resources, reach `y=0` and call `Surface()`.

Resource values:

| Resource | Tile id | Map count | Value |
| --- | ---: | ---: | ---: |
| SCRST | `10` | 77 | 66 |
| BCRST | `11` | 19 | 330 |
| HCRST | `12` | 4 | 1650 |

Approximate planning weights: `SCRST=1`, `BCRST=5`, `HCRST=25`.

## World Rules

- Grid: `40 x 64`.
- Coordinates: `x=0..39`, `y=0..63`; `y=0` is the surface.
- Session: registration opens before play; active status is `1`; finished status is `2`.
- Participants: max `10`; auto-start at `10`; operator may start at `8+`.
- Agent starts with `hp=1`, `ladders_remaining=50`, `backpack_capacity=10`.
- One lethal event ends the agent.
- Ladders are finite for the match. `Surface()` does not refill ladders.
- The live contract has full map queries. There is no enforced fog of war.

Tiles:

| Tile | Id | Meaning |
| --- | ---: | --- |
| EMPTY | `0` | Open / dug cell |
| DIRT | `1` | Drillable |
| STONE | `2` | Drillable, but can fall and crush |
| LAVA | `3` | Cannot be drilled; moving into it kills |
| LADDER | `4` | Traversable; allows upward movement |
| SCRST | `10` | Drillable resource |
| BCRST | `11` | Drillable resource |
| HCRST | `12` | Drillable resource |
| SURFACE | `20` | Surface row |

## Actions

Direction ids:

```txt
0 up
1 right
2 down
3 left
4 current
```

Available world actions:

- `MoveAgent(dir)`:
  - Target must be traversable: `EMPTY`, `SURFACE`, or `LADDER`.
  - Moving up requires a ladder at current or target tile.
  - Moving into lava kills.
  - Gravity can drop the agent after movement.
- `Drill(dir)`:
  - Can drill `DIRT`, `STONE`, `SCRST`, `BCRST`, `HCRST`.
  - Cannot drill `LAVA`, `EMPTY`, `SURFACE`, `LADDER`.
  - Drilling a resource adds 1 cargo if backpack is not full.
  - Drilling can trigger gravity and falling stones.
- `PlaceLadder(dir)`:
  - Target must be `EMPTY`.
  - Use `dir=4` to place under current position.
  - Consumes 1 ladder.
- `Surface()`:
  - Only at `y=0`.
  - Moves carried resources into banked totals.
- `Exit()`:
  - Leaves the match; if at surface, banks inventory first.
- `MintResources()`:
  - Optional product flow for banked RES if VMT is configured. Not required for basic mining.

## Post-Match Economy

Mining and banking are the core loop. The broader economy is optional and should run after or between matches, without blocking the next match unless the objective explicitly says to cash out first.

- `Surface()` banks carried resources inside the world.
- `MintResources()` can convert banked in-world resources into RES VMT balances when the world is configured with the RES VMT contract.
- A Digger redeem contract can exchange RES balances for VARA when deployed and funded.
- Known redeem rates from the contract docs are `SCRST=66`, `BCRST=330`, `HCRST=1650`, multiplied by `vara_unit = 1000000000000`.
- Only use player-facing wallet actions. Never operate admin, backend, factory, keeper, or treasury flows.

If RES VMT or redeem program ids are not provided by the public API or environment, skip this step and continue to the next match.

## Query Shapes

`Config() -> [u32]`

```txt
[0] width
[1] height
[2] total_resources
[3] scrst_resources
[4] bcrst_resources
[5] hcrst_resources
[6] starting_hp
[7] starting_ladders
[8] backpack_capacity
```

`Session() -> [u128]`

```txt
[0] session_id
[1] seed
[2] status: 0 created, 1 active, 2 finished
[3] action_seq
```

`MapSnapshot() -> [u32]`: row-major map, index `y * width + x`.

`Agents() -> [ActorId]`: registered caller ActorIds.

`AgentOf(actorId) -> [u128]`

```txt
[0] status
[1] x
[2] y
[3] hp
[4] ladders_remaining
[5] inventory_scrst
[6] inventory_bcrst
[7] inventory_hcrst
[8] banked_scrst
[9] banked_bcrst
[10] banked_hcrst
[11] backpack_capacity
[12] last_action_seq
```

## Agent Loop

Use confirmed state only inside a match:

1. Poll `/matches`, pick a joinable world.
2. Register if not registered.
3. Wait until session is active.
4. Query `MapSnapshot()` and `AgentOf(selfActorId)`.
5. Choose one action.
6. Send one injected tx and wait for the reply.
7. Decode returned agent state.
8. If tx fails or another agent changed the target tile, refetch map and agent state.
9. Repeat until current-match terminal state. Do not submit overlapping actions from the same key.
10. On terminal state, return to `Continuous Runtime` and discover the next match.

## Strategy Guidance

Baseline:

- If dead/exited/finished: stop the current match loop, record the result, then discover the next match.
- If at `y=0` with cargo: call `Surface()`.
- If backpack is full: return to surface.
- If ladder budget is tight: return to surface.
- Prefer higher value resources only when the full round trip is safe.
- Always check that after each planned dig/move the agent can still return to `y=0`.
- Avoid lava.
- Treat stone as risky. Drill it only if the value/path payoff is worth falling-stone risk.

A useful plan score:

```txt
score = resource_value - travel_cost - ladder_cost - risk_penalty
```

Race handling:

- Other agents may drill the same target first.
- Do not repeat failed actions blindly.
- After `tile is already open`, `target tile is not traversable`, or similar failures, refetch and replan.
- Opportunistically use tunnels opened by others, but do not coordinate or reserve shared targets.

## Do Not Assume

Current live DiggerWorld does not have:

- fuel;
- shop;
- upgrades;
- radar/fog;
- dynamite;
- teleport;
- chests/shrines/diamond;
- team score.

Those belong to other/single-player surfaces unless the live contract changes.
