# DiggerProxy Interface

The backend rental flow deploys a DiggerProxy as a separate Vara.eth program for
the requested wallet owner and world. The requested owner address becomes the
proxy owner after backend converts it to `ownerActorId`; the returned
`programId` is the digger program address. The proxy owns the in-world agent key
and forwards player actions to DiggerWorld. It is the preferred live-game path
because the backend can rent, fund, and track the digger.

Use `assets/idl/digger_proxy.idl` directly with `vara-wallet`. Do not
substitute `digger_world.idl` as the proxy IDL; it is not the DiggerProxy
interface. Use backend HTTP requests for discovery/rental and `vara-wallet` for
all proxy reads and writes.

## Constructor

```text
Create(owner: ActorId, world: ActorId)
```

## Service: Digger

Player functions:

```text
Register() -> [u8; 32]
Drill(direction: u32) -> [u8; 32]
MoveAgent(direction: u32) -> [u8; 32]
PlaceLadder(direction: u32) -> [u8; 32]
Surface() -> [u8; 32]
Exit() -> [u8; 32]
MintResources() -> [u8; 32]
TradeResourcesForLadders(scrst: u32, bcrst: u32, hcrst: u32) -> [u8; 32]
```

Owner maintenance functions:

```text
SetWorld(world: ActorId) -> ActorId
Kill(inheritor: ActorId)
```

Queries:

```text
Owner() -> ActorId
World() -> ActorId
Status() -> [u128]
LastMessageId() -> [u8; 32]
```

`Status()` shape:

```text
[actionSeq, lastAction]
```

Action ids:

```text
1 register
2 drill
3 moveAgent
4 placeLadder
5 surface
6 exit
7 mintResources
8 tradeResourcesForLadders
```

Events:

```text
Forwarded(actionSeq, actionId, messageId)
Killed(inheritor)
WorldUpdated(previousWorld, nextWorld)
```

## Forwarding Versus World Execution

A successful DiggerProxy reply, returned message id, `Success`, or `Forwarded`
event proves only that the proxy accepted and forwarded the request. It does not
prove that DiggerWorld applied the action. The world may reject the forwarded
message while the proxy transaction itself still succeeds.

In strict mode, source `scripts/robo-miner-action.sh` and use
`robo_miner_action`. For every state-changing proxy action it:

1. Read `World.AgentOf(agentActorId)` before the proxy write and save
   `preActionSeq = result[12]`.
2. Sends one proxy write through the named-wallet persistent session on the
   injected rail.
3. Polls only `World.AgentOf(agentActorId)`.
4. Treat the action as applied only when `result[12] > preActionSeq`.
5. If `lastActionSeq` did not increase, discard the intended local state update,
   refresh `Session`, `AgentOf`, and `MapSnapshot`, then replan or report the
   rejection.

Route-checkpoint mode is the only exception to the immediate read-after-write
pattern. Use it only for a short, prevalidated `MoveAgent` segment whose steps
satisfy direction-specific movement rules. For `MoveAgent(up)`, the current tile
under the agent must be `LADDER` and the target tile must be `LADDER` or
`SURFACE`; a ladder only in the target cell is not enough. For moves into
`EMPTY`, simulate agent gravity because one action can fall through multiple
empty cells and stop inside a ladder cell. After the checkpoint, re-read
`World.AgentOf(agentActorId)` and `World.MapSnapshot()` and continue only if the
chain state matches the simulated, gravity-adjusted checkpoint state.

## How to Use It

After backend returns `diggerProgramId`:

1. Derive `agentActorId` from `diggerProgramId`.
2. Query `Digger.Owner()` and confirm it equals `ownerActorId`.
3. Query `Digger.World()` and confirm it equals the chosen `worldId`.
4. Call `Digger/Register` with `robo_miner_action Digger/Register '[]'`.
5. Query `World.AgentOf(agentActorId)` with `vara-wallet`.
6. Play through `robo_miner_action` calls:
   `Digger/MoveAgent`, `Digger/Drill`, `Digger/PlaceLadder`,
   `Digger/Surface`, `Digger/TradeResourcesForLadders`, `Digger/Exit`, and
   `Digger/MintResources`. After each write, prove world execution with
   `World.AgentOf(agentActorId).result[12]`.
   `Digger/TradeResourcesForLadders` is valid only when the agent is on the
   surface and spends banked resources only; call `Digger/Surface` first when
   resources are still carried inventory.

Registration maps to this exact Sails call:

```text
program: diggerProgramId
service/method: Digger/Register
args: []
idl: assets/idl/digger_proxy.idl
transport: Vara.eth injected transaction
signer: owner wallet from vara-wallet
```

The helper is the primary command path:

```bash
source "$ROBO_MINER_SKILL_ROOT/scripts/robo-miner-action.sh"
robo_miner_action Digger/Register '[]'
```

If this returns a Sails route/header/decode error, treat it as a DiggerProxy
`codeId` versus IDL mismatch and stop. Do not call `World.Register` directly;
that would register the wallet as the agent instead of the rented proxy.

Proxy read checks:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Owner --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/World --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Status --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL"
```

If registration fails because the world is no longer joinable, choose a fresh
world from `/api/manifest`, convert its 20-byte program id to a 32-byte ActorId,
then call `Digger/SetWorld` with the helper. It verifies `Digger.World` equals
the new world ActorId before retrying `Digger/Register`.

```bash
newWorldActorId="0x000000000000000000000000${newWorldId#0x}"

robo_miner_action Digger/SetWorld "[\"$newWorldActorId\"]"
```

Action command matrix:

```bash
robo_miner_action Digger/MoveAgent '[2]'
robo_miner_action Digger/Drill '[1]'
robo_miner_action Digger/PlaceLadder '[4]'
robo_miner_action Digger/Surface '[]'
robo_miner_action Digger/TradeResourcesForLadders "[$scrst,$bcrst,$hcrst]"
robo_miner_action Digger/Exit '[]'
robo_miner_action Digger/MintResources '[]'
```

The world events will reference `agentActorId` (the proxy), not the wallet EVM
address. Use `World.OwnerOf(agentActorId)` when you need to display or verify
the owner wallet.

## Important Redeem Detail

`World.MintResources()` mints RES to the registered owner ActorId. In the rented
proxy flow that should be the wallet owner ActorId passed during registration.
Before redeeming, check the owner's VMT balances:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/BalanceOf \
  --args "[\"$ownerActorId\",0]" \
  --idl "$ROBO_MINER_RES_VMT_IDL"
```

If balances unexpectedly appear under `agentActorId`, query both `ownerActorId`
and `agentActorId` with `vara-wallet` and stop before redeeming. The deployed
proxy is not the EIP-712 signer for a backend redeem intent; the owner wallet is.
