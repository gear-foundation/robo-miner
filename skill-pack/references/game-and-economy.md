# Game and Economy

Robo Miner is a live on-chain mining match. Agents register, wait for the
session to start, mine resources, survive chests/falling stones, return to
surface, bank resources, optionally trade banked resources for ladders, mint RES,
and optionally redeem RES for WVARA.

## World Basics

Map size: `40 x 64`.

Tile ids:

| Tile | Id | Meaning |
| --- | ---: | --- |
| EMPTY | `0` | Open space; traversable. |
| DIRT | `1` | Drillable. |
| STONE | `2` | Falling hazard; not drillable. |
| CHEST | `3` | Drillable chest; either kills the agent or grants ladders. |
| LADDER | `4` | Traversable; anchors agent gravity and is required underfoot for upward ladder climbs. |
| SCRST | `10` | Common resource. |
| BCRST | `11` | Mid-value resource. |
| HCRST | `12` | High-value resource. |
| SURFACE | `20` | Surface row; anchors agent gravity. |

Directions:

```text
0 up, 1 right, 2 down, 3 left, 4 current
```

Sessions:

```text
0 waiting/created
1 active
2 finished
```

Agent status:

```text
1 active
2 surfaced/reserved; current `Surface()` banking keeps status `1`
3 dead
4 exited
```

## Movement and Mining Rules

- Move only into `EMPTY`, `SURFACE`, or `LADDER`.
- `MoveAgent(up)` has an extra ladder-continuity rule: the current tile under
  the agent must be `LADDER`, and the target tile must be `LADDER` or
  `SURFACE`. A ladder only in the target cell is not enough.
- After `MoveAgent` resolves its adjacent target, the contract immediately
  applies agent gravity. `LADDER` and `SURFACE` anchor the agent. From an
  `EMPTY` cell, the agent falls through consecutive `EMPTY` cells in the same
  action. A `LADDER` below catches the agent inside that ladder cell; otherwise
  the fall stops on the last `EMPTY` cell above the first non-empty/non-ladder
  tile or at map bottom. A single `MoveAgent(down)` can therefore move several
  rows.
- Drill `DIRT`, resources, or `CHEST`.
- Do not drill `STONE`, `EMPTY`, `SURFACE`, or `LADDER`.
- Resource collection happens on `Drill`, not on entering the tile. Drilling a
  `SCRST`, `BCRST`, or `HCRST` target immediately increments the matching
  carried inventory field, emits `ResourceExtracted`, and turns the target cell
  into `EMPTY`. Do not plan a follow-up `MoveAgent` into the resource cell just
  to collect it.
- After a successful `Drill`, the contract also applies agent gravity from the
  agent's current cell on the mutated map. Drilling open support beneath an
  agent can make it fall before the next action.
- Agent gravity is action-local, not a global world tick. When one agent changes
  the map, other agents are not automatically moved, dropped, or killed. If
  agent A stands above a tile that agent B drills, agent A remains at its
  previous `AgentOf` position until agent A later performs an action that
  applies its own gravity, such as `MoveAgent` or `Drill`.
- Chests are risky: drilling a chest either grants ladders or emits
  `AgentDied` with `causeTile = CHEST` (`3`), which means dynamite.
- Drilling may trigger gravity and `StoneMoved`; stones can crush agents and
  emit `AgentDied` with `causeTile = STONE` (`2`).
- `PlaceLadder(direction)` only works on an empty target tile and consumes one
  ladder.
- Backpack capacity is currently `10`; when full, return to surface.

## Stone-Aware Safe Routing

Treat `STONE` as both an obstacle and a dynamic hazard:

- `STONE` is not drillable. Do not send `Drill` into a stone tile, and do not
  retry that action after a failed reply.
- Before drilling `DIRT`, `CHEST`, `SCRST`, `BCRST`, or `HCRST`, inspect the
  tile directly above the target. If that tile is `STONE`, opening the target
  cell can make the stone fall through the opened target and every consecutive
  `EMPTY` cell below it. The stone stops on the last `EMPTY` cell above the
  first non-empty support, such as `DIRT`, `STONE`, `LADDER`, `SURFACE`, a
  resource, or a chest. It does not necessarily stop in the cell that was just
  drilled.
- If multiple contiguous `STONE` tiles sit above the opened column, they can
  settle as a chain and emit multiple `StoneMoved` events. A chain can seal
  cells below the drill target, not only the target cell itself.
- A falling stone can either block the planned corridor or crush the agent if
  the agent's gravity target is in the falling path. A plan that ignores this is
  unsafe even if the target tile itself is drillable.
- For every simulated `MoveAgent` or `Drill`, update the agent to the
  contract-style gravity target before planning the next action. Do not model a
  movement action as exactly one tile unless the gravity target equals the
  adjacent target.
- Do not apply agent gravity globally to passive agents after another agent's
  action. The current contract's `Drill` stone-crush check is also scoped to the
  acting agent's gravity target; do not infer that another agent fell or died
  unless fresh `AgentOf` state or an event proves it.
- For pathfinding, model `STONE` as blocked, `CHEST` as blocked unless the user
  explicitly accepts chest risk, and a drillable cell under `STONE` as unsafe
  unless a local agent-and-stone gravity simulation proves the full fall path is
  harmless all the way down to the first support.
- If a `Drill` succeeds but the next `MoveAgent` fails, immediately refresh
  `MapSnapshot`; a stone may have fallen into the cell that was just opened or
  into a lower pocket in the same column.

Safe resource routes should be planned as a graph, not as a straight line:

1. Refresh `MapSnapshot` and `AgentOf`.
2. Mark traversable cells: `EMPTY`, `LADDER`, and `SURFACE`; for upward edges,
   require `currentTile == LADDER` and `targetTile == LADDER || SURFACE`.
3. Mark drillable cells: `DIRT`, resources, and deliberately accepted `CHEST`
   cells. For resource cells, plan a route to a safe adjacent drill position;
   the `Drill` itself harvests the resource and opens the cell.
4. Exclude `STONE` and lava/death tiles.
5. Penalize or exclude any drillable cell with `STONE` directly above it.
6. Include the return-to-surface path and required ladder placements before
   mining high-value resources.
7. Prefer a route that spends more actions but preserves a safe return path over
   a cheaper route that can be blocked by falling stone.

## Shared Ladder Planning

All `LADDER` tiles in `MapSnapshot` are usable map infrastructure, even when a
different agent placed them. A planner must account for those shared ladders
before spending the current agent's own ladders.

Before any `PlaceLadder` action or return-to-surface plan:

1. Extract every existing `LADDER` tile from the fresh `MapSnapshot`.
2. Build a safe route that uses the existing ladder network, including horizontal
   travel to reach another agent's shaft when that is cheaper.
3. Build the direct/new-ladder route, such as a local vertical return shaft.
4. Compare the plans by safety first, then by current agent ladder spend.
5. Choose the shared-ladder route whenever it is safe and spends fewer own
   ladders.

Do not choose a local vertical ascent only because the digger has enough ladders
to build it. Use that route only when it is cheaper, safer, or the shared
network is unreachable after checking the map.

For reports and metrics, separate:

- own ladders spent by this agent;
- new ladders placed by this agent;
- unique existing/shared ladder cells used;
- existing/shared ladder route rejected reason;
- resources mined before and after using shared ladders.

If the planner cannot model shared ladders, mark the plan incomplete and replan
instead of executing a ladder-heavy route.

## Resource Strategy

Approximate value weights:

```text
SCRST = 1
BCRST = 5
HCRST = 25
```

Prefer safe higher-value resources, but keep a route home. Ladders are scarce
enough to matter but plentiful enough (`50` default) to build vertical exits.
Because all agents share the map, strict mode should replan after every proxy
write and fresh world state read. A DiggerProxy success only proves forwarding;
verify world execution with `World.AgentOf(agentActorId).result[12]`
(`lastActionSeq`). Route-checkpoint mode may reduce reads only for a short,
prevalidated `MoveAgent` path through already traversable cells that also
satisfy direction-specific movement rules and agent gravity. For upward
movement, the simulated route must have `LADDER` underfoot and `LADDER` or
`SURFACE` in the target cell. For movement into `EMPTY`, simulate the full
gravity target; the refreshed checkpoint position may be several rows below the
adjacent target or inside a ladder cell. Reconcile the refreshed state against
the gravity-adjusted simulated checkpoint state before continuing.

New ladders come from two places:

1. **Chest:** drill `CHEST` for a chance to gain `10` ladders. This can also
   contain dynamite and kill the agent, so use it as a risk/reward option.
2. **Surface trade:** bring resources to `y=0`, call `Surface()` to bank them,
   read the current ladder exchange rate from the selected world's live
   `World/Config()`, then trade banked resources for ladders when the proxy/world
   IDL supports `TradeResourcesForLadders(scrst,bcrst,hcrst)`.

`Surface()` is a banking action, not a status transition in the current
contract. After successful banking, expect the agent to remain `status == 1`
(`active`); confirm the action by `lastActionSeq`, `AgentSurfaced`, and the
banked resource fields, not by waiting for `status == 2`.

`TradeResourcesForLadders` has two hard preconditions: the agent must be on the
surface (`AgentOf.result[2] == 0`), and the resources must already be banked.
It spends `bankedScrst`, `bankedBcrst`, and `bankedHcrst`; carried inventory is
not enough. A trade attempted underground is rejected with
`agent is not on the surface` and must not be treated as a partial exchange.

Never use hard-coded ladder trade rates. Before deciding whether resources are
worth trading for ladders, query the current world:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Config --args '[]' --idl "$ROBO_MINER_WORLD_IDL"
```

Parse the returned config vector as:

```text
config[10] = SCRST resource amount
config[11] = SCRST ladder amount
config[12] = BCRST resource amount
config[13] = BCRST ladder amount
config[14] = HCRST resource amount
config[15] = HCRST ladder amount
```

The ladder calculation is:

```text
SCRST ladders = (scrst / config[10]) * config[11]
BCRST ladders = (bcrst / config[12]) * config[13]
HCRST ladders = (hcrst / config[14]) * config[15]
```

Each non-zero resource amount passed to `TradeResourcesForLadders` must be a
multiple of its configured resource amount. If `World/Config()` has fewer than
16 values, the selected world uses an older interface: report that live ladder
rates are unavailable and ask before assuming a legacy rate.

Do not assume an agent with `0` ladders is dead or permanently stuck. It may
still be able to find a chest or return to surface and trade banked resources.
When ladders reach `0`, explicitly report the low-ladder state to the user,
including position, carried/banked resources, and whether a route to surface is
still visible. Then enter recovery mode: do not call `PlaceLadder`; look for
reachable `CHEST` tiles in `MapSnapshot` and treat drilling one as a deliberate
risk to recover `10` ladders. Warn that the chest can contain dynamite and kill
the digger.

## Death and Recovery Signals

The chain state is authoritative:

```text
AgentOf(agentActorId).result[0] == 3  # dead
AgentOf(agentActorId).result[3] == 0  # hp zero, also dead
```

When dead, stop all game actions for that digger and report the last known
position, last action, and best known cause. Use events when available:

```text
AgentDied(..., causeTile = 2)  # falling stone
AgentDied(..., causeTile = 3)  # chest dynamite
ChestOpened(..., outcome = 1)  # dynamite
ChestOpened(..., outcome = 2)  # +10 ladders
```

If events are unavailable, infer cautiously from the refreshed state and last
world-accepted action: death right after drilling a chest is likely dynamite;
death after drilling under/near stone or after `StoneMoved` is likely falling
stone.
Say when the cause is inferred rather than event-confirmed.

Useful action priorities:

1. If session is not active, wait.
2. If dead/exited/finished, stop and report result.
3. If ladders are `0`, report that to the user, avoid `PlaceLadder`, and look
   for reachable chests as risky ladder recovery.
4. If backpack full or carrying valuable resources, route to surface.
5. If at surface with inventory, call `Surface()` and verify banked resources
   increased; do not expect `status == 2`.
6. If at surface with low ladders and banked resources, consider trading
   resources for ladders before mint/redeem. Never trade from underground.
7. If banked resources exist, call `MintResources()` when appropriate.
8. Otherwise target reachable resources or chests, drilling as needed.
9. If no safe plan exists, move toward surface or exit.

## Banking and Redeem Flow

Carried inventory is not immediately redeemable.

```text
Drill adjacent/current resource tile
  -> inventoryScrst/Bcrst/Hcrst increases immediately
  -> resource tile becomes EMPTY
  -> return to y=0
  -> Surface()
  -> bankedScrst/Bcrst/Hcrst increases, inventory clears
  -> optionally TradeResourcesForLadders(scrst,bcrst,hcrst) from y=0 only
  -> MintResources()
  -> RES VMT balance increases for owner ActorId
  -> Redeem.Redeem(scrst, bcrst, hcrst)
  -> wait for Redeem Mirror L1 Message value claim
  -> owner wallet claims claimedId from the mailbox
  -> verify owner WVARA balance increased
```

This is the allowed player-side economic path for turning earned resources into
WVARA. It is separate from backend executable-balance refills and does not
require `Admin/*` methods.

Before redeeming:

1. Query VMT token ids, owner balances, and approval with `vara-wallet`.
2. Query redeem reserve and rates with `vara-wallet`.
3. Call `Vmt/Approve(redeemActorId)` with `vara-wallet --via injected` if the
   redeem contract is not approved.
4. Call `Redeem/Redeem(scrst,bcrst,hcrst)` with `vara-wallet --via injected`
   only for amounts the owner actually holds and the reserve can cover.
5. Treat the redeem reply as pending settlement, not a wallet payout.
6. Wait for the Ethereum `Message` event addressed to `ownerAddress`, extract
   its `id`, and claim it with `vara-eth:mailbox claim` using the owner wallet.
7. Report success only after both the claim receipt and owner WVARA balance
   increase are verified. A reduced reserve or Sails `Redeemed` event is not
   sufficient.

Rates are deployment configuration, not skill constants. Read
`Redeem.ScrstRate()`, `Redeem.BcrstRate()`, `Redeem.HcrstRate()`, and
`Redeem.VaraUnit()` from the current redeem contract before estimating payout.

## Multiplayer Awareness

Up to 10 agents can play the same world. Other agents may alter your target
path, take a resource, place ladders, trigger stone movement, die, or exit.
Their ladders can also make your route cheaper, so treat every existing ladder
as potentially reusable unless the refreshed map proves it unreachable.

For a robust autonomous loop:

- Keep a local map projection, but refresh it after each world-accepted
  map-changing action, after any proxy write that does not increase
  `lastActionSeq`, before route planning, and at route checkpoints. A full
  `Session`/`Config`/`AgentOf`/`InventoryOf`/`MapSnapshot` read set before every
  action is safe for debugging, but it is not required for normal play.
- Use route-checkpoint mode only for movement-only route segments whose every
  step satisfies direction-specific movement rules, including the
  ladder-underfoot rule for upward movement, and whose every prefix is safe under
  the current map, shared ladders, agent gravity, and stone gravity. Keep
  checkpoints small by default; long movement batches are advanced-only and must
  be backed by a locally validated simulator. Use strict mode for all drilling,
  ladder placement, chest, surface, mint, trade, redeem, and recovery decisions.
- Treat `STONE` as blocked and re-run stone-aware pathfinding before each
  `Drill`.
- Before placing a ladder or surfacing, compare the route through all existing
  ladders against the route that spends new ladders.
- Consume events when available, especially `TileDrilled`, `StoneMoved`,
  `LadderPlaced`, `AgentMoved`, and `AgentDied`.
- Treat event stream as acceleration, not final truth.
- Use `MapSnapshot` and `AgentOf` to reconcile after errors or suspicious state.
