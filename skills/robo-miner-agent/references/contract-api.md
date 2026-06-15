# Contract API

Bundled IDLs:

```text
assets/idl/digger_world.idl
assets/idl/digger_res_vmt.idl
assets/idl/digger_redeem.idl
```

Use them for Sails encoding, state reads, and event decoding. Player agents must
not call `Admin/*` services.

## ActorId Conversion

For Vara.eth EVM addresses:

```text
actorId = 0x + 12 zero bytes + 20-byte EVM address without 0x
```

This ActorId is used for `World.Register(owner)`, VMT `BalanceOf`, and redeem
ownership checks.

In proxy mode:

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
[sessionId, seed, status, agentCount, actionSeq]
status: 0 created/waiting, 1 active, 2 finished
```

`AgentOf()` shape:

```text
[status, x, y, hp, laddersRemaining,
 inventoryScrst, inventoryBcrst, inventoryHcrst,
 bankedScrst, bankedBcrst, bankedHcrst,
 backpackCapacity, lastActionSeq]

status: 1 active, 2 surfaced, 3 dead, 4 exited
```

World player writes:

```text
World.Register(ownerActorId)
World.MoveAgent(direction)
World.Drill(direction)
World.PlaceLadder(direction)
World.Surface()
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
StoneMoved(sessionId, agentActorId, fromX, fromY, toX, toY)
AgentDied(sessionId, agentActorId, x, y, causeTile)
AgentSurfaced(sessionId, agentActorId, bankedScrst, bankedBcrst, bankedHcrst)
ResourcesMinted(sessionId, agentActorId, scrst, bcrst, hcrst)
AgentExited(sessionId, agentActorId)
SessionStarted(sessionId)
```

## RES VMT

Resource token ids are queried from the contract; current ids are expected to be
`SCRST=0`, `BCRST=1`, `HCRST=2` in the frontend flow.

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

Rates are multiplied by `VaraUnit()`. Current intended rates are
`SCRST=66`, `BCRST=330`, `HCRST=1650`.

## CLI-Shape Examples

Read state with IDL:

```bash
vara-wallet call <worldId> World/Session --args '[]' --idl assets/idl/digger_world.idl
vara-wallet call <worldId> World/AgentOf --args '["<agentActorId>"]' --idl assets/idl/digger_world.idl
vara-wallet call <worldId> World/MapSnapshot --args '[]' --idl assets/idl/digger_world.idl
```

Direct-mode writes:

```bash
vara-wallet --account robo-miner-agent call <worldId> World/Register \
  --args '["<ownerActorId>"]' --idl assets/idl/digger_world.idl

vara-wallet --account robo-miner-agent call <worldId> World/Drill \
  --args '[2]' --idl assets/idl/digger_world.idl
```

Proxy-mode writes use the DiggerProxy interface. If a generated proxy IDL is
available in the runtime, call `Digger/Register`, `Digger/MoveAgent`, etc. If it
is not available, use the project TypeScript scripts or generated client for the
proxy until the IDL is produced.

The proxy IDL should be generated from `contracts/digger-proxy`, not copied from
World. See `references/digger-proxy-interface.md`.

Repo script examples:

```bash
cd contracts
pnpm install
DIGGER_BACKEND_URL=https://api-digger-eth.vara.network \
DIGGER_WORLD_ID=<worldId> \
DIGGER_REQUEST_DIGGER=true \
PRIVATE_KEY=<secret-from-safe-store> \
pnpm run play-agent -- --steps 20

PRIVATE_KEY=<secret-from-safe-store> pnpm run mint-resources
PRIVATE_KEY=<secret-from-safe-store> pnpm tsx scripts/redeem-resources.ts
```

Never print `PRIVATE_KEY`. Prefer secret store/env injection.
