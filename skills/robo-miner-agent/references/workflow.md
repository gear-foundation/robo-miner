# Robo Miner Agent Workflow

This file is the operational checklist. Complete gates in order and keep a small
local state record: `ownerAddress`, `ownerActorId`, `worldId`, `agentActorId`,
`diggerProgramId`, `seasonId`, `sessionId`, and last confirmed action sequence.

## Gate 1: Tooling

Read `references/wallet-and-signing.md` before creating keys or signing
transactions. The short version: backend rental uses an EVM `0x...` owner
address, while `vara-wallet` may also expose native Vara/SS58 wallets. Do not
mark identity ready until you have the EVM owner address required by the backend
and the signer required by the chosen transaction path.

Install runtime tools with npm:

```bash
npm install -g vara-wallet pnpm
vara-wallet --version
node --version
npm --version
```

If `vara-wallet` is not enough for the current Vara.eth injected transaction
path, use the repo TypeScript scripts as the signing implementation. Do not
paste or print private keys.

For a standalone runner outside this repo, install the Vara.eth client stack with
npm:

```bash
mkdir robo-miner-runner
cd robo-miner-runner
npm init -y
npm install @vara-eth/api @vara-eth/viem sails-js dotenv tsx typescript
```

When running from this repo:

```bash
cd contracts
pnpm install
```

## Gate 2: Identity

Create or load a persistent wallet before discovering a match:

```bash
vara-wallet wallet list
vara-wallet wallet create --name robo-miner-agent
vara-wallet wallet list
```

If `vara-wallet wallet list` returns only a native/SS58 address, that is useful
for native diagnostics but does not by itself satisfy the Vara.eth EVM owner
requirement. Use an EVM keypair/signer for `ownerAddress` and keep it in a local
secret store or protected env file.

For Vara.eth EVM-style addresses, derive ActorId as:

```text
actorId = 0x + 12 zero bytes + 20-byte EVM address without 0x
```

Example:

```text
0xf823ba3F10922DCca6970D1e012D8701f462Aa33
-> 0x000000000000000000000000f823ba3f10922dcca6970d1e012d8701f462aa33
```

Persist both values. Use the EVM address for backend rental requests and the
ActorId for `World.Register(owner)`, VMT balances, and redeem checks.

Helper:

```bash
node skills/robo-miner-agent/scripts/actor-id.mjs 0xf823ba3F10922DCca6970D1e012D8701f462Aa33
```

## Gate 3: Environment and Match Discovery

Default public backend:

```text
https://api-digger-eth.vara.network
```

Read:

```bash
curl -s https://api-digger-eth.vara.network/api/manifest
curl -s https://api-digger-eth.vara.network/matches
curl -s https://api-digger-eth.vara.network/sessions
```

Pick a match/world that is joinable or waiting for players. Use backend values
for `seasonId`, `worldId`, `resVmtProgramId`, `redeemProgramId`, network RPCs,
and router when present.

Avoid stale discovery hosts. A `matches-*` URL is only acceptable if it returns
the same worlds as the canonical backend registry.

## Gate 4: Get or Reuse a Digger

Preferred live flow is backend-managed rental:

```bash
curl -s "https://api-digger-eth.vara.network/api/diggers?owner=<ownerAddress>&world=<worldId>&season=<seasonId>&status=active"
```

If there is an active digger, keep its `programId` as `diggerProgramId`.

If none exists, request one:

```bash
curl -s -X POST "https://api-digger-eth.vara.network/api/diggers/request" \
  -H "content-type: application/json" \
  -d '{
    "owner": "<ownerAddress>",
    "worldId": "<worldId>",
    "seasonId": "<seasonId>",
    "dryRun": false
  }'
```

Do not proceed until the response contains an active/existing/created
`programId`. The backend deploys the DiggerProxy, funds executable balance, and
stores `owner + season + world -> digger program id`.

Direct world mode is allowed only when the operator/test explicitly says to skip
rental. In direct mode, the `agentActorId` is the signing wallet ActorId. In
proxy mode, the `agentActorId` is the DiggerProxy program ActorId.

## Gate 5: Register

Proxy mode:

1. Call `Digger.Register()` on `diggerProgramId`.
2. Query `Digger.World()` and confirm it equals the selected `worldId`.
3. Query `Digger.Owner()` and confirm it equals `ownerActorId`.
4. Query `World.AgentOf(agentActorId)` where `agentActorId` is the proxy ActorId.

Direct mode:

1. Call `World.Register(ownerActorId)` on `worldId`.
2. Query `World.AgentOf(ownerActorId)`.

Registration is allowed while session status is `0` (created/waiting). If the
world is full or finished, return to discovery.

## Gate 6: Wait for Active Session

Read `World.Session()` repeatedly. Shape:

```text
[sessionId, seed, status, agentCount, actionSeq]
```

Only play when `status === 1`. If `status === 0`, wait and poll. The contract
auto-starts at 10 registered agents; the operator may start earlier according to
backend policy. If `status === 2`, the match is finished; go back to discovery.

## Gate 7: Play One Confirmed Action at a Time

Before every action, read:

- `World.AgentOf(agentActorId)`
- `World.MapSnapshot()`
- `World.Session()`

Then send exactly one action through the DiggerProxy or direct world mode:

- `MoveAgent(direction)`
- `Drill(direction)`
- `PlaceLadder(direction)`
- `Surface()`
- `MintResources()`
- `Exit()`

Wait for confirmation/events. Update local state from the reply or events, then
choose the next action. If the transaction fails, discard the current plan,
refresh state, and replan.

## Gate 8: Bank, Mint, Redeem, Continue

When backpack is full or a valuable route is complete:

1. Return to surface (`y === 0`).
2. Call `Surface()` to move carried inventory into banked resources.
3. Call `MintResources()` when banked resources are non-zero and RES VMT is
   configured.
4. Check VMT balances for `ownerActorId`.
5. Redeem through `Redeem.Redeem(scrst, bcrst, hcrst)` when reserve and balance
   allow it.

If the session ends, the agent dies, or the agent exits, record the result and
return to match discovery.

## Failure Handling

- API unavailable: retry with bounded backoff; do not switch to stale hosts
  unless a human/operator provides them.
- Digger rental failed: report the backend response and stop before registration.
- Registration failed: read `Session`, `Agents`, and `AgentOf` to determine
  whether already registered, full, waiting, active, or finished.
- Write failed: read `AgentOf`, `MapSnapshot`, and `Session`; then replan.
- Balance/fuel error: use rental/top-up info from backend; do not use Admin
  world methods.
