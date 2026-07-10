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

Source-of-truth precedence:

1. This workflow and the other bundled skill references.
2. Fresh chain reads through `vara-wallet`.
3. Backend discovery/rental projections.

If `/matches` or another backend response includes `register.steps` that call
`World.Register(owner)` directly, ignore those steps. They are legacy
frontend/non-authoritative instructions for this skill. Player agents register
only through the rented DiggerProxy.

Write path rule: use `vara-wallet call ... --via injected` for all DiggerProxy
state-changing play-loop calls. Do not use `--via eth` for the play loop unless
the user explicitly asks for that path. If an explicit `--via eth` call returns
`PROMISE_TIMEOUT`, do not assume failure; immediately verify the intended state
with a read-only query.

## Gate 1: Load the Skill

Install or load the top-level `skill-pack` folder as the skill source. The
required runtime tools are `curl` for backend HTTP and `vara-wallet` for wallet
and contract calls.

```bash
npx skills add https://github.com/gear-foundation/robo-miner/tree/main/skill-pack -g --all -y
```

If this reports `PromptScript does not support global skill installation`, treat
it as non-fatal. PromptScript is project-only; install it without `-g` from the
PromptScript project if needed.

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
export VARA_ETH_NETWORK="${VARA_ETH_NETWORK:-mainnet}"
export ROBO_MINER_BACKEND_URL="${ROBO_MINER_BACKEND_URL:-https://api-digger-eth.vara.network}"
export VARA_WALLET_ACCOUNT="${VARA_WALLET_ACCOUNT:-robo-miner-agent}"
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

Use the production mainnet backend and endpoints:

```bash
export VARA_ETH_NETWORK=mainnet
export ROBO_MINER_BACKEND_URL="${ROBO_MINER_BACKEND_URL:-https://api-digger-eth.vara.network}"
export ROBO_MINER_ETH_RPC="${ROBO_MINER_ETH_RPC:-https://mainnet-reth-rpc.gear-tech.io}"
export ROBO_MINER_VARA_RPC="${ROBO_MINER_VARA_RPC:-wss://validator-1-eth.vara.network}"
export ROBO_MINER_ROUTER="${ROBO_MINER_ROUTER:-0x9C13FE9242dfe2ba2Cd446480A9308279aA74cb6}"
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
`active[]` or the equivalent live list whose manifest status is
`waiting_agents` or `active` and whose `joinable/canRegister` flag is true. The
`worldId` is the world `programId`, not a human label.

Do not execute `/matches.register.steps`; they are legacy/non-authoritative for
this skill. Register only through the rented DiggerProxy.

Store:

```text
seasonId = manifest/match season id, for example season-1
worldId  = selected world programId
router   = manifest router or seasonConfig.router
resVmtProgramId = manifest economy/resource config value if present
redeemProgramId = manifest economy/resource config value if present
```

If `/api/manifest` does not include economy ids on mainnet, use the current
mainnet fallback ids below. Do not use them on another network.

```text
resVmtProgramId = 0x2295edd92104c5f9f4f9bddef28d1c20c3e9f448
redeemProgramId = 0xdb8dae5f6fc193006d428e12ee0c717715c6b887
```

Verification before using economy ids:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$resVmtProgramId" Vmt/ScrstTokenId \
  --args '[]' \
  --idl "$ROBO_MINER_RES_VMT_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/AvailableReserve \
  --args '[]' \
  --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/VaraUnit \
  --args '[]' \
  --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/ScrstRate \
  --args '[]' \
  --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/BcrstRate \
  --args '[]' \
  --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/HcrstRate \
  --args '[]' \
  --idl "$ROBO_MINER_REDEEM_IDL"
```

If either fallback read fails or decodes against the wrong service, stop before
settlement and report the manifest response plus the fallback ids.

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

If the backend returns `status: "pending"` and `programId: null`, store every
`requestId` or equivalent id from the response. Wait 180 seconds before the first
lookup, then poll the public digger list without a world filter every 30 seconds
for up to 10 minutes total:

```bash
curl -fsS \
  "$ROBO_MINER_BACKEND_URL/api/diggers?owner=$ownerAddress&season=$seasonId&status=active"
```

Do not pass `world` or `worldId` to the public `/api/diggers` lookup. Compare
the returned `response.diggers[].worldId` locally against the selected
`worldId`; use only the matching record's `programId` as `diggerProgramId`. If
the list contains only diggers for other worlds, keep the request pending and
retry later instead of registering the wrong digger.

Do not send another `POST /api/diggers/request` while the pending request is
inside the 10-minute wait window. If a repeated request already happened and
returned a new `requestId` while the active list is still empty, treat that as a
backend/operator ambiguity: keep polling active diggers and include all request
ids in the failure report. This skill has no player-facing request-status
endpoint; do not call `/api/admin/*` to inspect operator state. If no matching
active digger appears within the wait window, stop at Gate 4 and report
`ownerAddress`, `seasonId`, `worldId`, all request ids, and the last backend
response.

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

## Read Response Shape

`vara-wallet --json call` returns a JSON object. For Sails queries, read the
decoded value from `.result`. Some client versions may wrap decoded values under
`.result.view`; if that wrapper exists, use it, then map it to the same fields
below. Do not assume `session.view.*` or `agent.view.*` exists.

Canonical mappings:

```text
World.Session().result:
[sessionId, seed, status, actionSeq]
status = result[2]  # 0 waiting, 1 active, 2 finished

World.AgentOf(agentActorId).result:
[status, x, y, hp, laddersRemaining,
 inventoryScrst, inventoryBcrst, inventoryHcrst,
 bankedScrst, bankedBcrst, bankedHcrst,
 backpackCapacity, lastActionSeq]

agentStatus = result[0]  # 1 active, 2 surfaced, 3 dead, 4 exited
agentX = result[1]
agentY = result[2]
agentHp = result[3]
laddersRemaining = result[4]
```

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
Registration is successful when `World.AgentOf(agentActorId).result[0]` is
present and is not `0`.

If registration fails because the world is finished, full, or no longer
joinable:

1. Return to Gate 3 and fetch fresh worlds.
2. Select a different `active[].programId` whose manifest status is
   `waiting_agents` or `active` and whose `joinable/canRegister` flag is true.
3. Query the candidate before switching:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$newWorldId" World/Session \
  --args '[]' \
  --idl "$ROBO_MINER_WORLD_IDL"
```

Proceed only if `World.Session().result[2] === 0` and the manifest agent count
is below `targetAgents`.

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

`World.Session().result[2]` status values:

```text
0 created/waiting
1 active
2 finished
```

Only play when status is `1`. If status is `0`, wait and poll. If status is
`2`, return to discovery.

## Death and No-Ladder Checks

Run these checks after every confirmed action and before planning the next one:

1. If `AgentOf(agentActorId).result[0] == 3` or `result[3] == 0`, the digger is
   dead. Stop sending game actions for this digger. Report world id,
   `diggerProgramId`, position, last action, and the best known death cause.
2. Prefer event-confirmed causes: `AgentDied(..., causeTile=2)` means falling
   stone; `AgentDied(..., causeTile=3)` or `ChestOpened(..., outcome=1)` means
   chest dynamite.
3. If no event is available, state that the cause is inferred from context:
   after drilling a chest, likely dynamite; after drilling near/under stone or
   after `StoneMoved`, likely falling stone.
4. If `laddersRemaining == 0` while the agent is still active, do not call
   `PlaceLadder`. Tell the user the digger has no ladders, include position and
   inventory/banked resources, then search `MapSnapshot` for reachable `CHEST`
   tiles. A chest is a risky recovery path: `outcome=2` grants `10` ladders,
   `outcome=1` kills the digger.

## Gate 7: Play One Confirmed Action at a Time

Before every action, read fresh state:

```bash
agentActorId="0x000000000000000000000000${diggerProgramId#0x}"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Session --args '[]' --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Config --args '[]' --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/AgentOf --args "[\"$agentActorId\"]" --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/InventoryOf --args "[\"$agentActorId\"]" --idl "$ROBO_MINER_WORLD_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/MapSnapshot --args '[]' --idl "$ROBO_MINER_WORLD_IDL"
```

Before selecting the next action, scan the fresh `MapSnapshot` for all
`LADDER` tiles. These are shared infrastructure, including ladders placed by
other agents. For every resource route and every return-to-surface route,
compare:

- a route that reaches and uses existing/shared ladders;
- a direct route that spends this agent's own ladders;
- a mixed route that spends only the minimum own ladders needed to connect to
  the existing ladder network.

Prefer the safe route with the lowest current-agent ladder spend. Do not build a
new vertical return shaft only because the agent has enough ladders; first prove
that using existing/shared ladders is worse or unreachable. Record
`own_ladders_spent`, `new_ladders_placed`, `unique_existing_ladder_cells_used`,
and `shared_ladder_route_rejected_reason` in the run notes.

Also run a stone-safety pass before every planned `Drill`:

- `STONE` is not drillable. If the target tile is `STONE`, reject that action and
  replan around it.
- If the target tile is drillable but the tile directly above it is `STONE`,
  treat the action as unsafe unless a fresh local gravity simulation proves that
  the falling stone will not block the route or crush the agent.
- If `StoneMoved` appears in events, or a move into a just-drilled cell fails,
  discard the route and refresh `MapSnapshot`, `AgentOf`, and `Session`.
- For high-value resources, validate both the path to the resource and the path
  back to surface before mining it.

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
  call "$diggerProgramId" Digger/TradeResourcesForLadders \
  --args "[$scrst,$bcrst,$hcrst]" \
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
the next action. Always apply the death/no-ladder checks above before selecting
the next action.

## Gate 8: Bank, Mint, Redeem, Continue

When carried inventory should be banked:

1. Return to surface (`World.AgentOf(agentActorId).result[2] === 0`).
2. Call `Digger/Surface` with `vara-wallet`.
3. If ladders are low and banked resources are available, prefer the safe
   surface refill before mint/redeem. Before choosing `scrst,bcrst,hcrst`,
   query the selected world's live `World/Config()` and parse the current ladder
   exchange rate from indices `10..15`. Use `Digger/TradeResourcesForLadders`
   only when the installed `digger_proxy.idl` exposes that method. Do not call
   `World/TradeResourcesForLadders` directly in the live proxy workflow.

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$worldId" World/Config \
  --args '[]' \
  --idl "$ROBO_MINER_WORLD_IDL"
```

Config indices for ladder exchange:

```text
10: SCRST resource amount
11: SCRST ladder amount
12: BCRST resource amount
13: BCRST ladder amount
14: HCRST resource amount
15: HCRST ladder amount
```

Calculate expected ladders as `(resources / resource_amount) * ladder_amount`
for each resource. Each non-zero resource amount sent to
`TradeResourcesForLadders` must be a multiple of the matching configured
resource amount. If `World/Config()` returns fewer than 16 values, report that
the live world does not expose current ladder rates and ask before assuming a
legacy rate.

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$diggerProgramId" Digger/TradeResourcesForLadders \
  --args "[$scrst,$bcrst,$hcrst]" \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL" \
  --via injected
```

4. If banked resources are still non-zero and should be monetized, call:

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
  call "$redeemProgramId" Redeem/VaraUnit --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/ScrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/BcrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$redeemProgramId" Redeem/HcrstRate --args '[]' --idl "$ROBO_MINER_REDEEM_IDL"
```

Compute payout only from this live redeem config:

```text
payout =
  scrst * ScrstRate() * VaraUnit()
  + bcrst * BcrstRate() * VaraUnit()
  + hcrst * HcrstRate() * VaraUnit()
```

Do not use hard-coded redeem rates from docs, memory, earlier deployments, or
reports. Re-query the redeem contract after a redeploy or admin rate update.

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
return to match discovery. For death, include whether the cause was event-confirmed
falling stone, event-confirmed chest dynamite, or inferred from last action.

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
