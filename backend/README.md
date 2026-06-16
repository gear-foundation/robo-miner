# Web3 Miner backend

This is the modular monolith for the Digger stack. One backend owns the shared
chain client, admin key, jobs, database, registry, and indexer state. Individual
domains live as modules instead of separate services.

## Layout

```txt
backend/
  src/
    api/                  # HTTP/WebSocket surface for frontend and agents
    chain/                # shared Vara.eth/EVM client, deploy, top-up, calls
    config/               # env parsing and runtime config
    db/                   # storage, migrations, repositories
    jobs/                 # scheduled loops and background workers
    modules/
      gameMaster/         # world creation, map upload, sessions
      worldRegistry/      # active/current/past world discovery
      indexer/            # event ingestion, snapshots, replay
      diggerRental/       # deploy digger/proxy and keep it funded
      socialVerifier/     # X repost/quote verification -> fuel grants
      leaderboard/        # season scores and agent standings
```

LP Bonus is intentionally deferred and is not part of the current MVP runtime.

## Current module

`modules/gameMaster` contains the current off-chain admin and world factory
implementation:

- off-chain map generation;
- upload-ready map payloads;
- local world registry and frontend manifest;
- session lifecycle shape for live deploy/start/finish.

The map generator uses the frontend world generator, then translates frontend
`BLOCK` ids into contract tile ids at the backend boundary:

| Meaning | Frontend `BLOCK` | Contract tile |
| --- | ---: | ---: |
| empty / drilled pocket | `0` | `0` |
| dirt | `1` | `1` |
| stone frame / obstacle | `9` | `2` |
| lava | `13` | `3` |
| ladder | `10` | `4` |
| SCRST / BCRST / HCRST | `23` / `24` / `25` | `10` / `11` / `12` |
| surface cap | top raw row | `20` |

The target world lifecycle is:

```txt
map_ready -> deployed -> waiting_agents -> active -> finished -> archived
```

`Config()[6]` in the current contract is `starting_hp`, not surface, so the
backend uses `CONTRACT_SURFACE_Y=1` for the raw map and the frontend adds its
show-layer sky/grass presentation.

Run dry mode:

```bash
cd backend
npm run gamemaster -- create --count 3
npm run gamemaster -- list
npm run factory
```

All gameMaster, factory, chain, and simulation commands are run from `backend/`.

Factory and agent simulation commands:

```bash
cd backend
npm run factory            # dry-run factory + discovery server
npm run factory:forever    # dry-run forever
npm run factory:chain      # live Hoodi factory; requires backend/.env
npm run sim:register -- <worldProgramId> 10
npm run sim:play -- <worldProgramId> 10
```

## World Registry

`gameMaster` remains the writer for generated worlds and local map artifacts.
`worldRegistry` syncs those records into the shared backend DB so API, indexer,
rental, and leaderboard modules can use one canonical projection.

```bash
cd backend
npm run gamemaster -- create --count 3
npm run registry:sync
npm run api
```

Discovery endpoints:

```txt
GET /health
GET /api/season/current
GET /api/worlds/live
GET /api/worlds
GET /api/diggers?season=season-1&world=world-id&owner=0x...
POST /api/diggers/request
GET /api/stats/agents?season=season-1&world=world-id
GET /api/stats/economy
GET /api/leaderboard?metric=banked&season=season-1&world=world-id&limit=50
GET /api/events?limit=100
POST /api/social/x/submit
GET /api/social/x/:owner
POST /api/ingest/injected
GET /api/manifest
GET /api/admin/overview
GET /api/admin/rental/requests
GET /api/admin/rental/fuel-grants
GET /api/admin/social/x
GET /api/admin/redeem
POST /api/admin/redeem/deposit
POST /api/admin/rental/clear-failed
```

Set `ADMIN_API_TOKEN` to require `Authorization: Bearer <token>` for
`/api/admin/*`.

For MVP this registry is backend-first. A thin on-chain registry can be added
later if frontend discovery needs to be independently verifiable on-chain.

## Runtime Logs

Backend logs are structured JSON lines. Every line includes:

```txt
ts, level, scope, event
```

Common scopes:

- `api`: HTTP requests, admin calls, digger rental requests.
- `scheduler`: long-running registry/snapshot/rental worker.
- `rental-top-up`: one-off rental top-up CLI.
- `registry-sync`: one-off registry sync CLI.
- `indexer`: event/snapshot ingestion CLI.
- `admin`: redeem reserve and admin maintenance actions.

By default stack traces are hidden. Set `LOG_STACKS=true` only in trusted
development environments.

## Digger Rental Top-Up

The rental flow is backend-managed:

```txt
agent requests digger
  -> backend deploys DiggerProxy for owner + world
  -> backend funds initial executable balance to 120 VARA
  -> backend stores owner + season + world -> digger program id
  -> backend returns the digger program id to the agent
```

```txt
POST /api/diggers/request
{
  "owner": "0xagent...",
  "worldId": "0xworld...",
  "seasonId": "season-1",
  "dryRun": true
}
```

Live deploy requires `DIGGER_PROXY_CODE_ID` (or legacy `DIGGER_CODE_ID`) plus
`DIGGER_ADMIN_KEY`, `ETH_RPC`, `VARA_ETH_WS`, and `ROUTER_ADDRESS`.
When `DIGGER_PROXY_CODE_ID` already points to validated Router code, the backend
does not need the local proxy wasm artifact. If the code is not validated yet,
ship `digger_proxy.opt.wasm` with the backend image or set `DIGGER_PROXY_WASM_PATH`
to its deployed path so the backend can request validation.

The MVP duplicate rule is one active/planned digger per `owner + season + world`.
If the same owner asks again, the backend returns the existing `programId`
instead of deploying a second digger.

Agent/frontend lookup:

```txt
GET /api/diggers?owner=0xagent&world=0xworld&season=season-1&status=active
```

The response includes both the full `diggers[]` list and `digger`, the first
matching record for "my digger" flows.

The frontend helper mirrors the same flow:

```js
await fetchMyDigger({ owner, worldId, seasonId });
await ensureDiggerRental({ owner, worldId, seasonId, dryRun: false });
```

The agent script can resolve a rented digger without hardcoding
`DIGGER_PROGRAM_ID`:

```bash
cd contracts
DIGGER_BACKEND_URL=http://localhost:8787 \
DIGGER_WORLD_ID=0x936b5395876648772d37e22da57ba37c4e586df2 \
pnpm run play-agent
```

Set `DIGGER_REQUEST_DIGGER=true` only when the script should request a new
backend-managed digger if none exists yet. Social gates, referrals, or allowlist
checks can be added before `/api/diggers/request` later.

After the initial rental, the top-up job follows the spec value of
`120 VARA/day` and treats it as a daily executable-balance target, not a blind
daily transfer. For every active digger:

```txt
topUp = max(0, DIGGER_DAILY_EXEC_TARGET - currentExecutableBalance)
```

Dry-run writes the same audit records as live mode, but it does not block a later
live run for the same day.

```bash
cd backend
npm run digger:registry -- register --program 0x0000000000000000000000000000000000000000 --season season-1
npm run digger:registry -- list --status active
npm run rental:top-up
npm run rental:top-up -- --digger 0x0000000000000000000000000000000000000000 --assume-balance 0
```

Without `--digger`, the rental job selects active diggers from the configured
season. If a digger has `worldId`, that world must also be live according to
`worldRegistry`.

Live mode requires `DIGGER_ADMIN_KEY`, `ETH_RPC`, `VARA_ETH_WS`,
`ROUTER_ADDRESS`, and either `DIGGER_PROGRAM_IDS` or `--digger`:

```bash
npm run rental:top-up -- --live
```

The job stores diggers, fuel grants, and job-run audit data in
the backend DB.

## Social Verifier Free Fuel

The social verifier follows the PolyBaskets rewards pattern: external social
content is untrusted until the backend verifies it, creates an idempotent
`grantId`, checks wallet/X-account weekly caps, and records an auditable grant.
For Digger, the payout is not a withdrawable token reward. It becomes a
`social-x` fuel grant to the owner's active digger executable balance.

```txt
user submits X post
  -> backend verifies repost/quote through X API
  -> backend checks wallet + X account duplicate limits
  -> backend finds owner's active/planned digger
  -> backend tops up that digger executable balance
  -> backend stores socialRewardSubmissions + fuelGrants audit rows
```

Submit a task:

```txt
POST /api/social/x/submit
{
  "owner": "0xagent...",
  "taskType": "repost",
  "tweetUrl": "https://x.com/VaraNetwork/status/123",
  "xUsername": "agent_handle",
  "seasonId": "season-1",
  "dryRun": true
}
```

Task types:

```txt
repost -> SOCIAL_REPOST_FUEL_GRANT, default 60 VARA
quote  -> SOCIAL_QUOTE_FUEL_GRANT, default 120 VARA
```

Config:

```txt
SOCIAL_X_BEARER_TOKEN=...
SOCIAL_X_SOURCE_USERNAME=VaraNetwork
SOCIAL_REPOST_FUEL_GRANT=60000000000000
SOCIAL_QUOTE_FUEL_GRANT=120000000000000
SOCIAL_VERIFIER_MODE=live
```

Set `SOCIAL_VERIFIER_MODE=mock` only for local development without X API calls.

Lookups:

```txt
GET /api/social/x/0xagent...
GET /api/admin/social/x
```

The social verifier defaults to `SOCIAL_VERIFIER_MODE=live`. Use
`SOCIAL_VERIFIER_MODE=mock` only in local development when X API calls are not
available. Production-like verification requires `SOCIAL_X_BEARER_TOKEN`.

## Storage

Production should use Postgres for shared backend state. The backend keeps the
same `store.read()` / `store.update()` contract, but stores the canonical state
document in a locked Postgres row so `api`, `scheduler`, and indexer jobs can
share one database safely.

```txt
BACKEND_STORE=postgres
DATABASE_URL=postgres://user:pass@host:5432/dbname
DATABASE_SCHEMA=public
DATABASE_DOCUMENT_ID=main
```

Local dry-runs can still use the JSON fallback:

```txt
BACKEND_STORE=json
BACKEND_STATE_DIR=state
BACKEND_DB_FILE=state/backend.json
```

To migrate an existing JSON state file into Postgres:

```bash
cd backend
DATABASE_URL=postgres://user:pass@host:5432/dbname npm run db:migrate-json-to-postgres
```

Pass `-- --force` only when intentionally overwriting an existing Postgres
state document.

When `BACKEND_STORE=postgres`, the live factory persists its pool/live/past
documents in Postgres and also publishes world records directly into the shared
Postgres-backed registry. It still writes compatibility JSON files locally, but
API, scheduler, and factory containers do not need a shared filesystem for
`backend.json`, `gamemaster.json`, `factory-live.json`, `factory-past.json`, or
`factory-programs.json`.

The always-on worker runs registry sync, snapshot projection, and rental top-up:

```bash
cd backend
npm run scheduler
npm run scheduler -- --once
```

LP Bonus is not scheduled.

## Admin Operations

Admin endpoints are meant for the protected backend, not public frontend calls.
Set `ADMIN_API_TOKEN` in live environments and send:

```txt
Authorization: Bearer <ADMIN_API_TOKEN>
```

Useful admin checks:

```bash
curl -sS http://localhost:8787/api/admin/overview
curl -sS "http://localhost:8787/api/admin/rental/requests?limit=20"
curl -sS "http://localhost:8787/api/admin/redeem?program=0xa302b35865311778adc5b17dbe47406e7e6a117c"
```

Reserve deposit dry-run:

```bash
curl -sS -X POST http://localhost:8787/api/admin/redeem/deposit \
  -H 'content-type: application/json' \
  -d '{"programId":"0xa302b35865311778adc5b17dbe47406e7e6a117c","amount":"1000000000000","dryRun":true}'
```

Set `"dryRun": false` only from a protected live backend environment.

## Indexer Foundation

The indexer uses the generated contract IDLs under
`contracts/target/wasm32-gear/release/` as the source of truth:

```bash
cd backend
npm run indexer -- inspect-idl
npm run indexer -- apply-events --file events.json
npm run indexer -- ingest-injected --file injected-result.json
npm run indexer -- live-once
npm run indexer -- watch
npm run indexer -- snapshot-once
npm run indexer -- snapshot-watch
```

`apply-events` accepts normalized decoded Sails events. The live RPC reader will
feed the same shape later, so projections do not depend on the transport:

```json
{
  "programType": "world",
  "programId": "0x936b5395876648772d37e22da57ba37c4e586df2",
  "service": "World",
  "event": "ResourceExtracted",
  "args": ["1", "0x0000000000000000000000000000000000000000000000000000000000000002", 10, 12, 0, 3]
}
```

Current projections:

- `chainEvents`: raw applied event log with idempotency.
- `agentStats`: world/session/agent lifecycle, movement, drilling, extraction,
  banking, minting.
- `economyStats`: RES mint/burn, transfers, redeem reserve and payouts.

Live mode reads Vara.eth `block_outcome`, decodes program events with the IDL for
each configured program type, then feeds the same projection layer. Configure
programs with `INDEXER_WORLD_PROGRAM_IDS`, `INDEXER_PROXY_PROGRAM_IDS`,
`INDEXER_RES_VMT_PROGRAM_IDS`, `INDEXER_REDEEM_PROGRAM_IDS`, or let synced
`worldRegistry` records provide world program ids.

If the current RPC does not expose `block_outcome`, use the snapshot fallback.
It reads current state through Sails queries (`World.Session`, `World.Agents`,
`World.AgentOf`, proxy `Owner/World/Status`, VMT total supply, and Redeem
reserve totals) and applies current-state projections. This keeps leaderboard,
registry, rental selection, and economy totals usable while full event history is
unavailable.

MVP leaderboard source order:

1. `POST /api/ingest/injected` from the agent/frontend immediately after an
   injected action. This is the fast path for fresh leaderboard rows.
2. `snapshot-watch` or `npm run scheduler` periodically reads current contract
   state and reconciles the read models. If an injected event is missed, the
   next world snapshot still updates the agent's current `banked` totals.
3. `live-once` / `watch` stay prepared for an RPC endpoint with `block_outcome`.
   Once that endpoint is available, decoded block outcome events can become the
   primary indexed source.

### Injected Watch Ingest

For fast agent/frontend flows, the client that sends an injected transaction can
submit the watched result or decoded action projection to the backend immediately:

```txt
frontend/agent sendAndWaitForReceipt()
  -> update live UI directly from Vara.eth
  -> POST /api/ingest/injected for leaderboard/backend aggregates
```

Example payload:

```json
{
  "txHash": "0x...",
  "messageId": "0x...",
  "events": [
    {
      "programType": "world",
      "programId": "0x936b5395876648772d37e22da57ba37c4e586df2",
      "service": "World",
      "event": "ResourceExtracted",
      "args": ["1", "0x0000000000000000000000000000000000000000000000000000000000000002", 10, 12, 0, 3]
    }
  ]
}
```

The backend treats this as a fast client-submitted projection and still relies on
snapshot polling or future `block_outcome` replay for reconciliation.

`contracts/scripts/agent-step-events.ts` already posts decoded fresh outcome
events after each successful injected action when `DIGGER_BACKEND_URL` or
`BACKEND_URL` is set:

```bash
cd contracts
DIGGER_BACKEND_URL=http://localhost:8787 pnpm run agent-step-events -- --until-resource
```

For MVP rewards the leaderboard uses only `banked`: resources brought back to
the surface. The agent script sends `World.AgentSurfaced` to
`/api/ingest/injected`; the projector stores surfaced totals in
`agentStats[].banked`; `/api/leaderboard` defaults to `metric=banked`.

Run the reconciliation worker next to the API:

```bash
cd backend
npm run scheduler
```

For an indexer-only fallback:

```bash
cd backend
npm run indexer -- snapshot-watch
```

## Leaderboard

Leaderboard rows are aggregated by agent/owner across the selected scope.

```txt
GET /api/leaderboard?metric=live
GET /api/leaderboard?metric=banked
GET /api/leaderboard?metric=minted
GET /api/leaderboard?metric=banked&season=season-1&world=world-id&session=1&summary=true
```

Metrics:

- `live`: resources extracted during the session. Fast and exciting, but includes
  inventory that may not be banked yet.
- `banked`: resources surfaced/banked. Default leaderboard for MVP rewards.
- `minted`: resources minted into RES. Best for confirmed economy accounting.

Leaderboard score uses display VARA rates:
`SCRST * 66 + BCRST * 330 + HCRST * 1650`.

The on-chain redeem contract stores `vara_unit` separately from display rates.
For live redeem initialization use:

```txt
VARA_UNIT=1000000000000
SCRST_RATE=66
BCRST_RATE=330
HCRST_RATE=1650
```

## Pre-Merge Smoke

Dry-run smoke:

```bash
cd backend
npm install
npm run scheduler -- --once
npm run registry:sync
npm run rental:top-up -- --assume-balance 0
```

API smoke:

```bash
cd backend
npm run api
curl -sS http://localhost:8787/health
curl -sS http://localhost:8787/api/manifest
curl -sS http://localhost:8787/api/leaderboard
```

Frontend smoke:

```bash
cd frontend
npm install
npm run build
```

Live rental smoke checklist:

```txt
1. Set DIGGER_RENTAL_MODE=live.
2. Set DIGGER_ADMIN_KEY, DIGGER_PROXY_CODE_ID, ETH_RPC, VARA_ETH_WS, ROUTER_ADDRESS.
3. If DIGGER_PROXY_CODE_ID is not validated yet, include digger_proxy.opt.wasm and set DIGGER_PROXY_WASM_PATH.
4. Set ADMIN_API_TOKEN before exposing the API outside localhost.
5. POST /api/diggers/request with owner + worldId + dryRun=false.
6. Confirm response has programId, createTxHash, topUpTxHash, initTxHash.
7. Run npm run scheduler -- --once.
8. Confirm the same digger is skipped when executable balance is already >= 120 VARA.
```

Before merging, keep LP Bonus out of the runtime until its Uniswap accounting and
abuse rules are specified.
