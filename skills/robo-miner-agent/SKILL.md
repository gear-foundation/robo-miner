---
name: robo-miner-agent
description: "Use when an autonomous external agent needs to join and play Robo Miner / DiggerWorld live matches on Vara.eth: discover public matches, create or use an EVM key, convert it to ActorId, register, read world state, choose mining actions, send injected transactions, bank resources, and optimize competitive resource extraction."
license: MIT
metadata:
  author: web3-miner
  version: "0.2.0"
---

# Robo Miner Agent

This skill is for an autonomous external player agent. You are playing the deployed public Robo Miner game remotely. Do not run a local game, operate the backend, create worlds, top up balances, or manage factory state. Discover public matches, join one, read DiggerWorld state, and play by sending confirmed on-chain actions.

The agent is an independent competitor, not a team member. It should maximize its own banked resource value before the session ends while staying alive and conserving finite ladders.

The agent is long-running. It should complete the current match, record the result, then return to match discovery and join the next available match. Do not design it as a one-shot script.

## Operating Contract

The agent must behave like a player daemon, not a command snippet:

- Keep running until explicitly stopped by the user or runtime.
- Keep one durable EVM identity unless the user/test policy asks for fresh identities.
- Discover matches, join one, play it to a terminal state, record the result, then discover the next match.
- Submit at most one in-flight action per agent key. Never overlap two txs from the same key.
- Treat every decision as provisional until the confirmed reply or a fresh `AgentOf` read proves it.
- Never operate admin/factory/balance keeper/treasury flows. Those are backend operator responsibilities.
- Never top up executable balance from the player agent. If a match appears underfunded or actions stop confirming, wait, re-read state, or move to another match if discovery offers one.
- Never ask the user to paste private keys, mnemonics, API keys, or secrets into chat. Use local runtime secret storage.

The agent competes with up to 9 other agents in the same world. It should optimize its own banked resources, but it should reason about the shared map:

- Other agents may dig tiles first, place ladders, open tunnels, fall, or die.
- Open tunnels and ladders created by other agents are usable public infrastructure.
- Do not coordinate with other agents or assume any reserved path/target.
- Re-read or reconcile the map frequently; stale plans are normal in a shared world.
- Prefer opportunistic route changes when another agent opens a better tunnel.

## Preflight

Before joining a live match, verify the runtime has:

- a persistent local EVM private key for this agent;
- a Sails IDL/generated client for DiggerWorld;
- `ethRpc`, `varaWs`, and `router` from the selected match response;
- a way to send injected Vara.eth transactions and wait for confirmed replies;
- a way to query `Config`, `Session`, `MapSnapshot`, `Agents`, and `AgentOf`;
- optional backend ingest URL for spectator events.

If any of these are missing, set them up locally or wait for match discovery to provide them. Do not invent network constants when the match API supplies them.

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

## State Machine

Implement the agent as a small persistent state machine:

```txt
BOOT
  -> DISCOVER_MATCH
  -> REGISTER
  -> WAIT_SESSION
  -> PLAY
  -> BANK_OR_EXIT
  -> RECORD_RESULT
  -> DISCOVER_MATCH
```

State meanings:

- `BOOT`: load durable wallet, IDL/client, local config, and result log.
- `DISCOVER_MATCH`: poll `/matches` until a joinable match appears.
- `REGISTER`: register the local ActorId if not already registered.
- `WAIT_SESSION`: wait until `Session()[2] == 1`; keep checking whether the match is still valid.
- `PLAY`: repeatedly read state, plan, send one action, wait for confirmation, ingest event, and replan.
- `BANK_OR_EXIT`: if alive with cargo and at the surface, call `Surface`; otherwise record the terminal state.
- `RECORD_RESULT`: write local summary: world, session, owner, banked resources, death/exit, last action seq.

The agent may keep a short in-memory plan, but the confirmed chain state is always the authority.

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

## Live UI Event Ingest

After every confirmed injected action, publish the resulting action event to the backend event bus when an ingest endpoint is available:

```txt
POST <REGISTRY_OR_LOCAL_BACKEND>/api/ingest/injected
Content-Type: application/json
```

Do this only after the injected transaction reply is confirmed and `AgentOf(ownerActorId)` or the action reply gives the new state. This keeps the spectator frontend live without polling snapshots. Current Vara.eth `block_events` exposes mirror/router request events, but local injected program actions may not appear there as decoded World events, so the acting agent must submit its confirmed result.

Important: if the confirmed reply changes the agent coordinates, submit an
`AgentMoved` event even when the original action was `Drill`, `PlaceLadder`, or
`Surface`. Contract gravity can move the agent after a drill, and the frontend
needs that coordinate delta to animate the robot.

Minimal payload:

```json
{
  "txHash": "0x... optional",
  "messageId": "0x... optional",
  "events": [
    {
      "programType": "world",
      "programId": "<world program id>",
      "service": "World",
      "event": "AgentMoved",
      "args": ["<session id>", "<owner actor id>", 3, 0, 4, 0]
    }
  ]
}
```

Event mapping from confirmed actions:

| Confirmed action | Backend event | Args |
| --- | --- | --- |
| `Register(owner)` | `AgentRegistered` and, if state includes spawn position, `AgentSpawned` | `[session, owner]`, `[session, owner, x, y]` |
| `MoveAgent(dir)` | `AgentMoved` | `[session, owner, fromX, fromY, toX, toY]` |
| `Drill(dir)` | `TileDrilled`; also `ResourceExtracted` when cargo increases | `[session, owner, x, y, oldTile, newTile]`; `[session, owner, x, y, resourceKind, carriedTotal]` |
| `PlaceLadder(dir)` | `LadderPlaced` | `[session, owner, x, y, laddersRemaining]` |
| `Surface()` | `AgentSurfaced` | `[session, owner, bankedScrst, bankedBcrst, bankedHcrst]` |
| terminal death/exit | `AgentDied` / `AgentExited` | IDL order from the World events |

When a confirmed action produces multiple consequences, send all of them in the
same ingest request, in this order: tile/resource/ladder/surface event first,
then `AgentMoved` if the final position changed.

If no `txHash` or `messageId` is available, omit them; the backend will still assign a unique received event id. If a stable message id is available, include it so retries deduplicate cleanly.

Important cumulative fields:

- `ResourceExtracted` carries `carriedTotal`, not just the delta. If the frontend/backend needs a delta, compute it from previous inventory.
- `AgentSurfaced` carries cumulative banked totals. Visual `+N` popups should use the difference from the previous banked state.

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

If the selected match disappears from discovery while already playing, continue using the confirmed `programId` until the session is terminal or reads fail repeatedly. Discovery is for finding matches; the contract is the source of truth once joined.

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

Use confirmed state only inside a match. The agent is a continuous controller,
not a one-command executor. It should keep running, plan several steps ahead,
then submit exactly one confirmed on-chain action at a time:

1. Poll `/matches`, pick a joinable world.
2. Register if not registered.
3. Wait until session is active.
4. Query `Config()`, `Session()`, `MapSnapshot()`, and `AgentOf(selfActorId)`.
5. Build a short plan from the current map:
   - choose reachable resources by value and distance;
   - simulate the path before acting;
   - reject any action that removes the return path to `y=0`;
   - reserve enough ladders for the climb back;
   - switch to return mode when cargo is full, cargo is valuable enough, or ladder budget is tight.
6. Submit the next single action from the plan as an injected tx and wait for the confirmed reply.
7. Decode the returned agent state, publish the confirmed event to `/api/ingest/injected` when available, then refetch or patch local map state.
8. If tx fails or another agent changed the target tile, refetch map and agent state, discard the current plan, and replan.
9. Send the next transaction immediately after the previous confirmed reply unless an explicit demo throttle is configured.
10. Repeat until current-match terminal state. Do not submit overlapping actions from the same key.
11. On terminal state, record the result and return to `Continuous Runtime` to discover the next match.

### Shared-World Planning

Every plan should account for the fact that the world is shared:

- Read `Agents()` and optionally `AgentOf` for other owners when deciding whether a route is crowded.
- Do not block on other agents; treat them as moving obstacles and likely map mutators.
- Prefer already-open tunnels when they reduce ladder cost or return risk.
- Prefer ladders already placed by any agent over spending your own ladder.
- If another agent opens your target first, switch to movement through the opened tile or pick a new nearby resource.
- If several agents are near the same resource corridor, consider a different resource cluster unless the path is still clearly best.
- Keep enough ladder budget to return from your own current depth even if other agents stop helping.

The map has no fog of war, so it is acceptable to plan over the full `MapSnapshot`. The uncertainty is not visibility; it is that other agents may change the map between your read and your confirmed action.

### Action Cadence For Spectators

Do not submit overlapping transactions from the same agent. Always wait for the
previous injected reply, publish its confirmed event(s), then plan the next
action. The frontend owns smooth playback: it buffers confirmed action events,
groups consequences from the same message, and plays them through each robot's
visual queue.

Agents should send the next action immediately after confirmation. For showcase
runs, a small optional delay may be enabled only when humans need slower logs:

```txt
default: 0 ms after confirmed reply
optional showcase throttle: 120-200 ms
optional jitter: agentIndex * 40-80 ms
```

Do not use sleeps as the primary smoothing mechanism; they make the robot
visibly pause between animations. Smoothness belongs in frontend playback,
while the agent remains a confirmed-state controller.

Recommended controller state:

```js
{
  mode: 'mine' | 'surface',
  target: { x, y, tile } | null,
  plannedPath: ['down', 'down', 'right'],
  ladderBuffer: 1,
  returnLoad: 1.0
}
```

The controller may refresh the full map every action. Smooth spectator playback
still comes from the emitted event stream; snapshots are for planning and
reconciliation, not animation.

### Confirmation And Recovery

Injected actions can fail or time out even when the node is healthy. The agent must recover without getting stuck:

1. Send one action.
2. Wait for the confirmed reply with a finite timeout.
3. If the reply succeeds, decode the returned agent state.
4. If the reply errors with a contract panic/rejection, immediately refetch `AgentOf` and `MapSnapshot`, discard the current plan, and replan.
5. If waiting for the reply times out, poll `AgentOf(self)` a few times:
   - if `last_action_seq` advanced, treat the action as applied and reconstruct the event from `before` and `after`;
   - if it did not advance, treat the action as not applied, refetch map/session, and replan.
6. If repeated actions stop confirming and executable balance appears low or reads indicate the match is unhealthy, do not top up. Wait for the operator/balance keeper, then either continue or move to a new joinable match when available.

This recovery rule is important for long-running play: never leave the agent permanently waiting on one unresolved promise.

### Safe Planning Rules

Before every non-surface action, simulate the resulting map and agent state:

- `MoveAgent(dir)` may enter only `EMPTY`, `SURFACE`, or `LADDER`.
- `Drill(dir)` opens one adjacent drillable tile; if it is a resource, cargo may increase.
- `PlaceLadder(4)` plants a ladder under the current position and costs one ladder.
- Upward movement is allowed only when the current or target tile is a ladder.
- A candidate action is valid only if, after simulating it, a path to any `y=0` tile still exists and required ladders are `<= ladders_remaining`.

Plan scoring should prefer bankable value over wandering:

```txt
score = travel_cost + ladder_cost + risk_penalty - resource_value
```

Use approximate values `SCRST=1`, `BCRST=5`, `HCRST=25`. Treat lava as forbidden.
Treat stone as high-risk; drill it only when the path/value payoff is worth it.

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
