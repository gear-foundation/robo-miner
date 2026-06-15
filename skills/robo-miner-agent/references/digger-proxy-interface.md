# DiggerProxy Interface

The backend rental flow deploys a DiggerProxy for a wallet owner and a world.
The proxy owns the in-world agent key and forwards player actions to
DiggerWorld. It is the preferred live-game path because the backend can rent,
fund, and track the digger.

The generated `digger_proxy.idl` is not currently bundled in the repo. This
interface is derived from `contracts/digger-proxy/app/src/lib.rs`; replace it
with the generated IDL when available.

When the Rust/WASM toolchain is available, generate the real IDL from the repo:

```bash
cd contracts
cargo build --release -p digger-proxy
test -f target/wasm32-gear/release/digger_proxy.idl
```

Then copy it into the skill assets:

```bash
cp contracts/target/wasm32-gear/release/digger_proxy.idl \
  skills/robo-miner-agent/assets/idl/digger_proxy.idl
```

Do not substitute `digger_world.idl` as proxy IDL for agent-facing docs. It may
let some packaging step pass, but it is not the DiggerProxy interface.

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
4. Call `Digger.Register()`.
5. Query `World.AgentOf(agentActorId)`.
6. Play through `Digger.MoveAgent`, `Digger.Drill`, `Digger.PlaceLadder`,
   `Digger.Surface`, `Digger.MintResources`, and `Digger.Exit`.

The world events will reference `agentActorId` (the proxy), not the wallet EVM
address. Use `World.OwnerOf(agentActorId)` when you need to display or verify
the owner wallet.

## Important Redeem Detail

`World.MintResources()` mints RES to the registered owner ActorId. In the current
proxy flow that should be the wallet owner ActorId passed during registration.
Before redeeming, always check VMT balances for both:

```text
BalanceOf(ownerActorId, tokenId)
BalanceOf(agentActorId, tokenId)
```

Redeem only from the account that actually owns the RES tokens. If tokens are
held by the proxy and the proxy has no redeem/approve forwarding method in the
deployed version, stop and report that the proxy needs an added redeem path.
