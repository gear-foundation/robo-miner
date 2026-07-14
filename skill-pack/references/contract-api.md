# Contract API

Bundled IDLs:

```text
assets/idl/digger_world.idl
assets/idl/digger_proxy.idl
assets/idl/digger_res_vmt.idl
assets/idl/digger_redeem.idl
```

Use them for Sails encoding, state reads, and event decoding. Player agents must
not call `Admin/*` services.

## `vara-wallet --json` Decode Shape

For read-only Sails calls, use the decoded value at `.result` in the
`vara-wallet --json` response. Some client versions may expose a wrapper such as
`.result.view`; if so, unwrap it and map it to the same raw fields below. Do not
write workflow logic that requires `session.view.*` or `agent.view.*`.

Example shape:

```json
{
  "chain": "vara-eth",
  "kind": "query",
  "service": "World",
  "method": "Session",
  "result": [1, 12345, 1, 8]
}
```

If a wrapper appears, normalize it locally:

```text
decoded = response.result.view ?? response.result
```

## ActorId Conversion

For Vara.eth EVM addresses:

```text
actorId = 0x + 12 zero bytes + 20-byte EVM address without 0x
```

This ActorId is used by the rented DiggerProxy during registration, by VMT
`BalanceOf`, and by redeem ownership checks. In the live skill, agents do not
call `World.Register` directly.

In the rented DiggerProxy flow:

- `ownerActorId` is the wallet owner.
- `agentActorId` is the DiggerProxy program ActorId.
- Query `World.AgentOf(agentActorId)`.
- `World.OwnerOf(agentActorId)` should return `ownerActorId`.

## DiggerWorld

World queries:

```text
World.Config() -> [u32]
World.Session() -> [u128]
World.MapSnapshot() -> [u32]
World.Agents() -> [ActorId]
World.AgentOf(agentActorId) -> [u128]
World.InventoryOf(agentActorId) -> [u32]
World.TileAt(x, y) -> u32
World.IsDug(x, y) -> bool
World.OwnerOf(proxyActorId) -> ActorId
```

`Config()` shape:

```text
[width, height, totalResources, scrstResources, bcrstResources, hcrstResources,
 startingHp, startingLadders, backpackCapacity, chestDynamiteChanceBps,
 ladderScrstResourceAmount, ladderScrstLadderAmount,
 ladderBcrstResourceAmount, ladderBcrstLadderAmount,
 ladderHcrstResourceAmount, ladderHcrstLadderAmount]
```

Current default is `40x64`, `100` resources, `77/19/4` split, `startingHp=1`,
`startingLadders=50`, `backpackCapacity=10`,
`chestDynamiteChanceBps=1000`, and the default ladder exchange fields from
indices `10..15`.

`Session()` shape:

```text
[sessionId, seed, status, actionSeq]
status: 0 created/waiting, 1 active, 2 finished
```

`AgentOf()` shape:

```text
[status, x, y, hp, laddersRemaining,
 inventoryScrst, inventoryBcrst, inventoryHcrst,
 bankedScrst, bankedBcrst, bankedHcrst,
 backpackCapacity, lastActionSeq]

status: 1 active, 2 surfaced/reserved, 3 dead, 4 exited
`hp == 0` also means the digger is dead and must stop acting.
```

`AGENT_SURFACED`/status `2` is declared in the contract, but current
`World.Surface()` does not set it. `Surface()` banks carried resources, emits
`AgentSurfaced`, increments `lastActionSeq`, and leaves the agent active
(`status == 1`). Do not use `status == 2` as the proof that resources were
banked.

`lastActionSeq` is the world execution proof for DiggerProxy writes. The proxy
can return success even when the world rejects the forwarded action. In strict
mode, before each proxy action, record
`preActionSeq = AgentOf(agentActorId).result[12]`; after the proxy transaction,
re-read `AgentOf(agentActorId)`. Treat the action as applied only if
`result[12] > preActionSeq`. In route-checkpoint mode, use `lastActionSeq`
together with refreshed `AgentOf` and `MapSnapshot` to prove the checkpoint
matches the simulated route segment.

Underlying World player methods forwarded by DiggerProxy:

```text
World.Register(ownerActorId)
World.MoveAgent(direction)
World.Drill(direction)
World.PlaceLadder(direction)
World.Surface()
World.TradeResourcesForLadders(scrst, bcrst, hcrst)
World.MintResources()
World.Exit()
```

For `World.Surface()`, verify the post-action `bankedScrst`, `bankedBcrst`,
`bankedHcrst`, `lastActionSeq`, or `AgentSurfaced` event. Do not wait for
`AgentOf(...).status` to become `2`; current contract behavior preserves
`status == 1`.

`World.TradeResourcesForLadders` is valid only when the acting agent is on the
surface (`AgentOf(...).y == 0`). It trades banked resources, not carried
inventory. Underground calls are rejected with `agent is not on the surface`;
failed proxy-forwarded trades still require the usual `lastActionSeq` check.

Directions:

```text
0 up, 1 right, 2 down, 3 left, 4 current
```

`MoveAgent(up)` requires ladder continuity: the current tile under the agent
must be `LADDER`, and the target tile must be `LADDER` or `SURFACE`. A ladder
only in the target cell is not enough.

`MoveAgent` applies agent gravity after the adjacent target is selected. If the
target is `LADDER` or `SURFACE`, the agent stays there. If the target is
`EMPTY`, the agent falls through consecutive `EMPTY` cells in the same action.
A `LADDER` below catches the agent inside that ladder cell; otherwise the final
position is the last `EMPTY` cell above the first non-empty/non-ladder tile or
the map bottom. `Drill` also applies agent gravity from the agent's current cell
after the map is mutated.

Agent gravity is scoped to the action's caller. A `Drill` or map mutation by one
agent does not automatically apply gravity to other agents. If another agent
drills the support under a passive agent, the passive agent's `AgentOf` position
does not change until that same passive agent later performs an action that
applies its own gravity, such as `MoveAgent` or `Drill`. The current `Drill`
stone-crush check is likewise evaluated against the acting agent's gravity
target, not by scanning every registered agent.

Stone gravity is different from agent gravity. After `Drill` opens a cell,
`settle_stones_above_open_cell` moves a `STONE` above that opened column through
consecutive `EMPTY` cells until the next cell below is non-empty or the map
bottom is reached. The stone can settle below the drilled target if there was
already an empty pocket below it. `LADDER` is support for stones, so a stone
stops above a ladder rather than inside it. Contiguous stones above the opening
can settle as a chain and emit multiple `StoneMoved` events.

Events to process:

```text
AgentRegistered(sessionId, agentActorId)
AgentSpawned(sessionId, agentActorId, x, y)
AgentMoved(sessionId, agentActorId, fromX, fromY, toX, toY)
TileDrilled(sessionId, agentActorId, x, y, oldTile, newTile)
ResourceExtracted(sessionId, agentActorId, x, y, resourceKind, carriedTotal)
LadderPlaced(sessionId, agentActorId, x, y, laddersRemaining)
ChestOpened(sessionId, agentActorId, x, y, outcome, laddersRemaining)
ResourcesTradedForLadders(sessionId, agentActorId, scrst, bcrst, hcrst, laddersAdded, laddersRemaining)
StoneMoved(sessionId, agentActorId, fromX, fromY, toX, toY)
AgentDied(sessionId, agentActorId, x, y, causeTile)
# causeTile: 2 = falling stone, 3 = chest dynamite
# ChestOpened outcome: 1 = dynamite/death, 2 = +10 ladders
AgentSurfaced(sessionId, agentActorId, bankedScrst, bankedBcrst, bankedHcrst)
ResourcesMinted(sessionId, agentActorId, scrst, bcrst, hcrst)
AgentExited(sessionId, agentActorId)
SessionStarted(sessionId)
```

`ResourceExtracted` is emitted by `World.Drill` when the drilled target was a
resource tile. Collection is immediate on the accepted `Drill`: `inventoryScrst`,
`inventoryBcrst`, or `inventoryHcrst` increases before any `MoveAgent` into the
drilled cell, and the target cell becomes `EMPTY`.

## RES VMT

Resource token ids are queried from the contract; current ids are expected to be
`SCRST=0`, `BCRST=1`, `HCRST=2` in the live resource contracts.

Queries:

```text
Vmt.BalanceOf(accountActorId, tokenId)
Vmt.ScrstTokenId()
Vmt.BcrstTokenId()
Vmt.HcrstTokenId()
Vmt.IsApproved(accountActorId, operatorActorId)
```

Writes available in IDL:

```text
Vmt.Approve(operatorActorId)
Vmt.TransferFrom(fromActorId, toActorId, tokenId, amount)
Vmt.BatchTransferFrom(fromActorId, toActorId, ids, amounts)
```

`Vmt.MintResources` and admin functions are not player actions unless the agent
is explicitly assigned a privileged role. Normal players mint through
`World.MintResources()`.

## Redeem

Queries:

```text
Redeem.AvailableReserve()
Redeem.ReserveBalance()
Redeem.LockedBalance()
Redeem.ScrstRate()
Redeem.BcrstRate()
Redeem.HcrstRate()
Redeem.VaraUnit()
Redeem.PendingRedeemCount()
```

Player writes:

```text
Redeem.Redeem(scrst, bcrst, hcrst)
Redeem.CancelRedeem(redeemId)
Redeem.ConfirmRedeem(redeemId)
```

Rates are multiplied by `VaraUnit()`. Do not hardcode redeem rates in an
agent; read `ScrstRate()`, `BcrstRate()`, `HcrstRate()`, and `VaraUnit()` from
the current redeem contract before calculating whether an exchange is worth it.

## `vara-wallet` Examples

Read live world state:

```bash
agentActorId="0x000000000000000000000000${diggerProgramId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Session --args '[]' --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Config --args '[]' --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/AgentOf --args "[\"$agentActorId\"]" --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/MapSnapshot --args '[]' --idl "$ROBO_MINER_WORLD_IDL"
```

`World/Config` is the source of truth for live ladder exchange rates. Parse:

```text
config[9] = chest dynamite chance in basis points
config[10] = SCRST resource amount
config[11] = SCRST ladder amount
config[12] = BCRST resource amount
config[13] = BCRST ladder amount
config[14] = HCRST resource amount
config[15] = HCRST ladder amount
```

If `World/Config` returns fewer than 16 values, do not use the ladder exchange
formula from this section; report the older interface and ask before assuming
legacy rates.

Send rented DiggerProxy writes through the reviewed action helper. It uses the
wallet's local `0600` passphrase file and never forwards a passphrase on an
action command line:

```bash
source "$ROBO_MINER_SKILL_ROOT/scripts/robo-miner-action.sh"
robo_miner_action Digger/Register '[]'
robo_miner_action Digger/SetWorld "[\"$newWorldActorId\"]"
robo_miner_action Digger/MoveAgent '[2]'
robo_miner_action Digger/Drill '[1]'
robo_miner_action Digger/PlaceLadder '[4]'
```

Supported proxy action methods:

```text
Digger.MoveAgent(direction)
Digger.Drill(direction)
Digger.PlaceLadder(direction)
Digger.Surface()
Digger.TradeResourcesForLadders(scrst,bcrst,hcrst)
Digger.Exit()
Digger.MintResources()
Vmt.Approve(redeemActorId)
Redeem.Redeem(scrst, bcrst, hcrst)
Redeem.CancelRedeem(redeemId)
Redeem.ConfirmRedeem(redeemId)
```

`Digger.TradeResourcesForLadders` forwards the same world preconditions: use it
only from the surface and only for already banked resources.

Never print wallet secrets or `PASSPHRASE`. Prefer secret store/env
injection.
