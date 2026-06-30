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
 startingHp, startingLadders, backpackCapacity]
```

Current default is `40x64`, `100` resources, `77/19/4` split, `startingHp=1`,
`startingLadders=50`, `backpackCapacity=10`.

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

status: 1 active, 2 surfaced, 3 dead, 4 exited
`hp == 0` also means the digger is dead and must stop acting.
```

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

Directions:

```text
0 up, 1 right, 2 down, 3 left, 4 current
```

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
config[10] = SCRST resource amount
config[11] = SCRST ladder amount
config[12] = BCRST resource amount
config[13] = BCRST ladder amount
config[14] = HCRST resource amount
config[15] = HCRST ladder amount
```

Send rented DiggerProxy writes through `vara-wallet` Vara.eth injected calls:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/Register \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/SetWorld \
  --args "[\"$newWorldActorId\"]" \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/MoveAgent \
  --args '[2]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/Drill \
  --args '[1]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/PlaceLadder \
  --args '[4]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
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

Never print wallet secrets or `PASSPHRASE`. Prefer secret store/env
injection.
