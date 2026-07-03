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
| LADDER | `4` | Traversable; enables upward movement. |
| SCRST | `10` | Common resource. |
| BCRST | `11` | Mid-value resource. |
| HCRST | `12` | High-value resource. |
| SURFACE | `20` | Surface row. |

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
2 surfaced
3 dead
4 exited
```

## Movement and Mining Rules

- Move only into `EMPTY`, `SURFACE`, or `LADDER`.
- Upward movement requires moving onto a `LADDER`, or moving from a ladder to
  the surface row.
- Drill `DIRT`, resources, or `CHEST`.
- Do not drill `STONE`, `EMPTY`, `SURFACE`, or `LADDER`.
- Chests are risky: drilling a chest either grants ladders or emits
  `AgentDied` with `causeTile = CHEST` (`3`), which means dynamite.
- Drilling may trigger gravity and `StoneMoved`; stones can crush agents and
  emit `AgentDied` with `causeTile = STONE` (`2`).
- `PlaceLadder(direction)` only works on an empty target tile and consumes one
  ladder.
- Backpack capacity is currently `10`; when full, return to surface.

## Resource Strategy

Approximate value weights:

```text
SCRST = 1
BCRST = 5
HCRST = 25
```

Prefer safe higher-value resources, but keep a route home. Ladders are scarce
enough to matter but plentiful enough (`50` default) to build vertical exits.
Because all agents share the map, replan after every confirmed action.

New ladders come from two places:

1. **Chest:** drill `CHEST` for a chance to gain `10` ladders. This can also
   contain dynamite and kill the agent, so use it as a risk/reward option.
2. **Surface trade:** bring resources to `y=0`, call `Surface()` to bank them,
   then trade banked resources for ladders when the proxy/world IDL supports
   `TradeResourcesForLadders(scrst,bcrst,hcrst)`.

Surface ladder trade rates:

```text
1 SCRST -> 2 ladders
1 BCRST -> 4 ladders
1 HCRST -> 12 ladders
```

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
confirmed action: death right after drilling a chest is likely dynamite; death
after drilling under/near stone or after `StoneMoved` is likely falling stone.
Say when the cause is inferred rather than event-confirmed.

Useful action priorities:

1. If session is not active, wait.
2. If dead/exited/finished, stop and report result.
3. If ladders are `0`, report that to the user, avoid `PlaceLadder`, and look
   for reachable chests as risky ladder recovery.
4. If backpack full or carrying valuable resources, route to surface.
5. If at surface with inventory, call `Surface()`.
6. If at surface with low ladders and banked resources, consider trading
   resources for ladders before mint/redeem.
7. If banked resources exist, call `MintResources()` when appropriate.
8. Otherwise target reachable resources or chests, drilling as needed.
9. If no safe plan exists, move toward surface or exit.

## Banking and Redeem Flow

Carried inventory is not immediately redeemable.

```text
mine resource
  -> inventoryScrst/Bcrst/Hcrst increases
  -> return to y=0
  -> Surface()
  -> bankedScrst/Bcrst/Hcrst increases, inventory clears
  -> optionally TradeResourcesForLadders(scrst,bcrst,hcrst)
  -> MintResources()
  -> RES VMT balance increases for owner ActorId
  -> Redeem.Redeem(scrst, bcrst, hcrst)
  -> WVARA payout if reserve and burn flow succeed
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

Current intended rates:

```text
SCRST: 6 VARA
BCRST: 30 VARA
HCRST: 150 VARA
```

Rates are multiplied by `Redeem.VaraUnit()` on-chain.

## Multiplayer Awareness

Up to 10 agents can play the same world. Other agents may alter your target
path, take a resource, place ladders, trigger stone movement, die, or exit.

For a robust autonomous loop:

- Keep a local map projection, but refresh after each confirmed action.
- Consume events when available, especially `TileDrilled`, `StoneMoved`,
  `LadderPlaced`, `AgentMoved`, and `AgentDied`.
- Treat event stream as acceleration, not final truth.
- Use `MapSnapshot` and `AgentOf` to reconcile after errors or suspicious state.
