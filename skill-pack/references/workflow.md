# Robo Miner Agent Workflow

This is the live player checklist for Robo Miner on Vara.eth. Complete gates in
order and keep a small local state record:

```text
network, backendUrl, walletAccount, ownerAddress, ownerActorId, worldId,
agentActorId, diggerProgramId, seasonId, resVmtProgramId, redeemProgramId,
sessionId, last confirmed action sequence
```

Use `vara-wallet` as the primary path for every state-changing Robo Miner
transaction. The live workflow uses a rented DiggerProxy for actions.
Use ordinary backend HTTP requests for discovery and digger rental. Do not use
Robo Miner npm packages, helper CLIs, or local scripts for this workflow.

## Gate 1: Load the Skill

Install or load the top-level `skill-pack` folder as the skill source. The
required runtime tools are `curl` for backend HTTP and `vara-wallet` for wallet
and contract calls.

```bash
npx skills add https://github.com/gear-foundation/robo-miner/tree/main/skill-pack -g --all -y
```

```bash
curl --version
```

The skill folder provides IDLs, references, and env templates. No npm package,
package CLI, or helper script installation is required.

## Gate 2: Install and Prepare `vara-wallet`

Read `references/wallet-and-signing.md` for wallet details, passphrase handling,
and secret storage. This workflow only carries the short operational path.

`vara-wallet` must be v0.20.3 or newer:

```bash
which node
node --version
vara-wallet --version
```

Install or update `vara-wallet` from the official
`gear-foundation/vara-wallet` release artifacts before continuing if the
version is lower than v0.20.3.

If `vara-wallet --chain vara-eth ... vara-eth:wallet keys` fails with
`ERR_REQUIRE_ESM`, make sure `vara-wallet` is executed by the same modern Node
runtime it was installed with. A known local workaround is to switch to an
nvm-managed Node 22 runtime before running wallet commands:

```bash
nvm use 22
node --version
vara-wallet --version
```

Keep the same working Node/PATH for every subsequent `vara-wallet` command. If
the Node runtime still cannot run `vara-wallet keys`, stop and report the
tooling issue before chain writes.

Choose the Vara.eth network:

```bash
export VARA_ETH_NETWORK="${VARA_ETH_NETWORK:-hoodi}" # hoodi or mainnet
export ROBO_MINER_BACKEND_URL="${ROBO_MINER_BACKEND_URL:-https://api-digger-eth.vara.network}"
export VARA_WALLET_ACCOUNT="${VARA_WALLET_ACCOUNT:-agent-eth}"
export ROBO_MINER_SKILL_ROOT="${ROBO_MINER_SKILL_ROOT:-skill-pack}"
export ROBO_MINER_DIGGER_PROXY_IDL="${ROBO_MINER_DIGGER_PROXY_IDL:-$ROBO_MINER_SKILL_ROOT/assets/idl/digger_proxy.idl}"
export ROBO_MINER_WORLD_IDL="${ROBO_MINER_WORLD_IDL:-$ROBO_MINER_SKILL_ROOT/assets/idl/digger_world.idl}"
export ROBO_MINER_RES_VMT_IDL="${ROBO_MINER_RES_VMT_IDL:-$ROBO_MINER_SKILL_ROOT/assets/idl/digger_res_vmt.idl}"
export ROBO_MINER_REDEEM_IDL="${ROBO_MINER_REDEEM_IDL:-$ROBO_MINER_SKILL_ROOT/assets/idl/digger_redeem.idl}"
```

When running from a repository checkout, `ROBO_MINER_SKILL_ROOT=skill-pack` is
usually correct. When the skill was installed into an agent runtime, set
`ROBO_MINER_SKILL_ROOT` to the installed skill folder's absolute path before
calling `vara-wallet --idl`.

Hoodi uses the public backend above. Mainnet is selectable, but until mainnet
Robo Miner endpoints are published, provide explicit values:

```bash
export VARA_ETH_NETWORK=mainnet
export ROBO_MINER_BACKEND_URL=<mainnet-backend-url>
export ROBO_MINER_ETH_RPC=<mainnet-ethereum-rpc>
export ROBO_MINER_VARA_RPC=<mainnet-vara-eth-validator-rpc>
export ROBO_MINER_ROUTER=<mainnet-router-address>
```

If `PASSPHRASE` is not already available, ask the user for it and keep it only
in local runtime state:

```bash
if [ -z "${PASSPHRASE:-}" ]; then
  read -rsp "Vara.eth wallet passphrase: " PASSPHRASE
  export PASSPHRASE
  printf "\n"
fi
```

Create or load a persistent Vara.eth wallet:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json vara-eth:wallet list
vara-wallet vara-eth:wallet create "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE"
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json vara-eth:wallet show "$VARA_WALLET_ACCOUNT"
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json vara-eth:wallet keys "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" >/dev/null
```

If the wallet already exists, `create` may fail with an exists-style error; in
that case continue with `show`.

```bash
ownerAddress=$(vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet show "$VARA_WALLET_ACCOUNT" | jq -r '.address')
ownerActorId="0x000000000000000000000000${ownerAddress#0x}"
```

Store `ownerAddress` and `ownerActorId` locally. Use `ownerAddress` for backend
rental and `ownerActorId` for VMT/redeem checks.

## Gate 3: Get Available Worlds

Fetch backend metadata with HTTP:

```bash
curl -fsS "$ROBO_MINER_BACKEND_URL/health"
curl -fsS "$ROBO_MINER_BACKEND_URL/api/manifest"
curl -fsS "$ROBO_MINER_BACKEND_URL/api/worlds"
curl -fsS "$ROBO_MINER_BACKEND_URL/matches"
```

Use `/api/manifest` and `/api/worlds` as the primary discovery responses.
Use `/matches` when it exposes clearer season/session status. Pick a world from
`active[]` or the equivalent live/waiting list, preferably one with manifest
status `waiting_agents`. The `worldId` is the world `programId`, not a human
label.

Store:

```text
seasonId = manifest/match season id, for example season-1
worldId  = selected world programId
router   = manifest router or seasonConfig.router
resVmtProgramId = manifest economy/resource config value if present
redeemProgramId = manifest economy/resource config value if present
```

Optional local env state:

```bash
export ROBO_MINER_SEASON_ID="$seasonId"
export ROBO_MINER_WORLD_ID="$worldId"
export ROBO_MINER_OWNER_ADDRESS="$ownerAddress"
export ROBO_MINER_RES_VMT_PROGRAM_ID="$resVmtProgramId"
export ROBO_MINER_REDEEM_PROGRAM_ID="$redeemProgramId"
```

## Gate 4: Request or Reuse a Digger

Request a backend-managed DiggerProxy for the selected owner, season, and world:

```bash
curl -fsS \
  -X POST "$ROBO_MINER_BACKEND_URL/api/diggers/request" \
  -H 'content-type: application/json' \
  --data "{\"owner\":\"$ownerAddress\",\"worldId\":\"$worldId\",\"seasonId\":\"$seasonId\",\"dryRun\":false}"
```

Equivalent request body:

```json
{
  "owner": "0xPLAYER_WALLET",
  "worldId": "0xWORLD_PROGRAM_ID",
  "seasonId": "season-1",
  "dryRun": false
}
```

Do not proceed until the response contains an active/existing/created
`programId`. Store it as `diggerProgramId`:

```bash
export ROBO_MINER_DIGGER_PROGRAM_ID="$diggerProgramId"
```

If the backend returns `status: "pending"` and `programId: null`, wait about
three minutes, then poll the public digger list without a world filter:

```bash
curl -fsS \
  "$ROBO_MINER_BACKEND_URL/api/diggers?owner=$ownerAddress&season=$seasonId&status=active"
```

Do not pass `world` or `worldId` to the public `/api/diggers` lookup. Compare
the returned `response.diggers[].worldId` locally against the selected
`worldId`; use only the matching record's `programId` as `diggerProgramId`. If
the list contains only diggers for other worlds, keep the request pending and
retry later instead of registering the wrong digger.

Verify the proxy before registration with `vara-wallet`:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Owner \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/World \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Status \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"
```

Gate 4 is complete only when `Digger.Owner()` equals `ownerActorId` and
`Digger.World()` equals the selected `worldId` converted to ActorId.

## Gate 5: Register

Register through the rented DiggerProxy with `vara-wallet`. Do not infer the
wire format from the method name, and do not call `World.Register` directly.

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

This sends a Vara.eth injected transaction to:

```text
program = diggerProgramId
method  = Digger/Register
args    = []
idl     = assets/idl/digger_proxy.idl
via     = injected
signer  = vara-wallet account owner
```

If `vara-wallet call` returns a decode error but the transaction was sent, use a
`--dry-run` call only to extract `encodedPayload`, then inspect the same message
with `vara-wallet message send --payload <encodedPayload> --via injected`.
This is a diagnostics fallback; the primary write path remains `vara-wallet`.

Set `ROBO_MINER_DIGGER_PROXY_IDL` to the local skill asset path, for example
`skill-pack/assets/idl/digger_proxy.idl`, or use the absolute path to the
installed skill folder. If `Register` returns a Sails route, header, or decode
error, stop and report the backend `codeId`, `diggerProgramId`, and IDL path; do
not fall back to direct `World/Register`.

Then verify world state:

```bash
agentActorId="0x000000000000000000000000${diggerProgramId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/AgentOf \
  --args "[\"$agentActorId\"]" \
  --idl "$ROBO_MINER_WORLD_IDL"
```

`agentActorId` is the DiggerProxy ActorId, derived from `diggerProgramId`.
Registration is successful when `agent.view.status` is present.

If registration fails because the world is active, finished, full, or no longer
joinable:

1. Return to Gate 3 and fetch fresh worlds.
2. Select a different `active[].programId` whose manifest status is
   `waiting_agents`.
3. Query the candidate before switching:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$newWorldId" World/Session \
  --args '[]' \
  --idl "$ROBO_MINER_WORLD_IDL"
```

Proceed only if `session.view.status === 0` and the manifest agent count is
below `targetAgents`.

4. Move the proxy to the new world:

```bash
newWorldActorId="0x000000000000000000000000${newWorldId#0x}"

vara-wallet \
  --chain vara-eth \
  --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/SetWorld \
  --args "[\"$newWorldActorId\"]" \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
```

5. Re-query `Digger.World()`, update `ROBO_MINER_WORLD_ID`, then retry
   `Digger/Register`.

If no joinable world exists, stop at Gate 5 and wait before discovery retry.

## Gate 6: Wait for Active Session

Poll:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Session \
  --args '[]' \
  --idl "$ROBO_MINER_WORLD_IDL"
```

`session.view.status` values:

```text
0 created/waiting
1 active
2 finished
```

Only play when status is `1`. If status is `0`, wait and poll. If status is
`2`, return to discovery.

## Gate 7: Play One Confirmed Action at a Time

Before every action, read fresh state:

```bash
agentActorId="0x000000000000000000000000${diggerProgramId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Session --args '[]' --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/AgentOf --args "[\"$agentActorId\"]" --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/InventoryOf --args "[\"$agentActorId\"]" --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/MapSnapshot --args '[]' --idl "$ROBO_MINER_WORLD_IDL"
```

Send exactly one `vara-wallet` action through the DiggerProxy. Directions are
`0 up`, `1 right`, `2 down`, `3 left`, and `4 current` for `PlaceLadder` only:

```bash
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

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/Surface \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/Exit \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
```

Wait for confirmation/events, refresh state, then replan. If a write fails,
discard the stale plan and read `AgentOf`, `MapSnapshot`, and `Session` before
the next action.

## Gate 8: Bank, Mint, Redeem, Continue

When carried inventory should be banked:

1. Return to surface (`agent.view.y === 0`).
2. Call `Digger/Surface` with `vara-wallet`.
3. If banked resources are non-zero, call:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/MintResources \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
```

Check RES balances and redeem configuration:

```bash
redeemActorId="0x000000000000000000000000${redeemProgramId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/ScrstTokenId --args '[]' --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/BcrstTokenId --args '[]' --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/HcrstTokenId --args '[]' --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/BalanceOf \
  --args "[\"$ownerActorId\",0]" \
  --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/IsApproved \
  --args "[\"$ownerActorId\",\"$redeemActorId\"]" \
  --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/AvailableReserve --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/ScrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/BcrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/HcrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"
```

If balances and reserve allow redeeming, approve the redeem contract once if
needed:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$resVmtProgramId" Vmt/Approve \
  --args "[\"$redeemActorId\"]" \
  --idl "$ROBO_MINER_RES_VMT_IDL" \
  --via injected
```

Then redeem:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$redeemProgramId" Redeem/Redeem \
  --args "[$scrst,$bcrst,$hcrst]" \
  --idl "$ROBO_MINER_REDEEM_IDL" \
  --via injected
```

Use cancel/confirm only for a redeem id returned by the redeem contract:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$redeemProgramId" Redeem/CancelRedeem \
  --args "[$redeemId]" \
  --idl "$ROBO_MINER_REDEEM_IDL" \
  --via injected

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$redeemProgramId" Redeem/ConfirmRedeem \
  --args "[$redeemId]" \
  --idl "$ROBO_MINER_REDEEM_IDL" \
  --via injected
```

If the session ends, the agent dies, or the agent exits, record the result and
return to match discovery.

## Failure Handling

- Backend unavailable: retry with bounded backoff; do not switch hosts unless a
  human/operator provides the replacement.
- Digger rental failed: report the backend response and stop before
  registration.
- Registration failed: use `vara-wallet` reads for `World/Session`,
  `World/Agents`, `World/AgentOf`, and `Digger/World` to determine whether
  already registered, full, waiting, active, or finished.
- Write failed: use `vara-wallet` reads for `AgentOf`, `MapSnapshot`, and
  `Session`; then replan. For decoder-only failures, run `vara-wallet call
  ... --dry-run` and `vara-wallet message send --payload <encodedPayload>` only
  as raw-reply diagnostics.
- Balance/fuel error: re-check `Digger/Owner`, `Digger/World`,
  `Digger/Status`, and the proxy balance with `vara-wallet`. If the proxy
  executable balance is depleted, report it and wait for backend refill/operator
  action. If executable balance is available and the agent has banked resources,
  use the player settlement flow: `Surface -> MintResources -> Redeem`. Do not
  call world `Admin/*` methods or transfer operator funds.
