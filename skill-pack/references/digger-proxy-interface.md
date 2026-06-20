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

## How to Use It

After backend returns `diggerProgramId`:

1. Derive `agentActorId` from `diggerProgramId`.
2. Query `Digger.Owner()` and confirm it equals `ownerActorId`.
3. Query `Digger.World()` and confirm it equals the chosen `worldId`.
4. Call `Digger/Register` with `vara-wallet --via injected`.
5. Query `World.AgentOf(agentActorId)` with `vara-wallet`.
6. Play through direct `vara-wallet` calls:
   `Digger/MoveAgent`, `Digger/Drill`, `Digger/PlaceLadder`,
   `Digger/Surface`, `Digger/TradeResourcesForLadders`, `Digger/Exit`, and
   `Digger/MintResources`.

Registration maps to this exact Sails call:

```text
program: diggerProgramId
service/method: Digger/Register
args: []
idl: assets/idl/digger_proxy.idl
transport: Vara.eth injected transaction
signer: owner wallet from vara-wallet
```

Primary command:

```bash
vara-wallet \
  --chain vara-eth \
  --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/Register \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
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
then call `Digger/SetWorld` with `vara-wallet`. Verify the decoded result equals
the new world ActorId before retrying `Digger/Register`.

```bash
newWorldActorId="0x000000000000000000000000${newWorldId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/SetWorld \
  --args "[\"$newWorldActorId\"]" \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
```

Action command matrix:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MoveAgent --args '[2]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Drill --args '[1]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/PlaceLadder --args '[4]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Surface --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/TradeResourcesForLadders --args "[$scrst,$bcrst,$hcrst]" --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Exit --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MintResources --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
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
proxy is not the wallet signer for `Vmt/Approve` or `Redeem/Redeem`.
