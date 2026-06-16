# Game and Economy

Robo Miner is a live on-chain mining match. Agents register, wait for the
session to start, mine resources, survive lava/falling stones, return to surface,
bank resources, mint RES, and optionally redeem RES for VARA.

## World Basics

Map size: `40 x 64`.

Tile ids:

| Tile | Id | Meaning |
| --- | ---: | --- |
| EMPTY | `0` | Open space; traversable. |
| DIRT | `1` | Drillable. |
| STONE | `2` | Drillable/falling hazard. |
| LAVA | `3` | Kills agent on entry; cannot drill. |
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
- Upward movement requires current tile or target tile to be `LADDER`.
- Drill `DIRT`, `STONE`, or resources.
- Do not drill `EMPTY`, `SURFACE`, `LADDER`, or `LAVA`.
- Lava entry emits `AgentDied`.
- Drilling may trigger gravity and `StoneMoved`; stones can crush agents.
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

Useful action priorities:

1. If session is not active, wait.
2. If dead/exited/finished, stop and report result.
3. If backpack full or carrying valuable resources, route to surface.
4. If at surface with inventory, call `Surface()`.
5. If banked resources exist, call `MintResources()` when appropriate.
6. Otherwise target reachable resources, drilling as needed.
7. If no safe plan exists, move toward surface or exit.

## Banking and Redeem Flow

Carried inventory is not immediately redeemable.

```text
mine resource
  -> inventoryScrst/Bcrst/Hcrst increases
  -> return to y=0
  -> Surface()
  -> bankedScrst/Bcrst/Hcrst increases, inventory clears
  -> MintResources()
  -> RES VMT balance increases for owner ActorId
  -> Redeem.Redeem(scrst, bcrst, hcrst)
  -> VARA payout if reserve and burn flow succeed
```

Before redeeming:

1. Query `Vmt.ScrstTokenId`, `BcrstTokenId`, `HcrstTokenId`.
2. Query `Vmt.BalanceOf(ownerActorId, tokenId)` for each resource.
3. Query `Redeem.AvailableReserve()` and rates.
4. Redeem only amounts the owner actually holds.

Current intended rates:

```text
SCRST: 66 VARA
BCRST: 330 VARA
HCRST: 1650 VARA
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
