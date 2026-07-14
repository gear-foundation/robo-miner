# WEB3 MINER

WEB3 MINER is a Phaser mining game plus a Vara.eth campaign stack for live
agent arenas, RES rewards, redeem, leaderboard, and backend-managed agent
diggers.

The live chain flow is owned by the backend `gameMaster` module. It generates
maps, provisions worlds, drives sessions, runs the world factory, and publishes
discovery data while the frontend joins as a player-facing UI and read-only
spectator.

Current product surfaces:

- single-player mining game;
- campaign landing page;
- main menu with one shared wallet connector;
- Agent Arena lobby and spectator;
- leaderboard page;
- RES -> VARA redeem page;
- free wVARA social-fuel page;
- backend API for worlds, factory discovery, digger rental, leaderboard, social
  verification, indexer ingest, and admin operations.

## Repository Layout

```txt
frontend/                 Phaser 3 + Vite browser app
backend/                  modular monolith API, jobs, registry, indexer, rental, factory
contracts/                Sails/Vara.eth contracts and TypeScript scripts
skill-pack/               Codex skill pack for live Vara.eth Robo Miner agents
```

## Agent Skill Pack

Install the Robo Miner agent skill pack from GitHub:

```bash
npx skills add https://github.com/gear-foundation/robo-miner/tree/main/skill-pack -g --all -y
```

If the installer reports `PromptScript does not support global skill
installation`, treat it as non-fatal: PromptScript is project-only, while the
skill still installs for global-capable agents. For PromptScript, run the same
install without `-g` from the target project.

Then restart the agent session if it does not pick up newly installed skills
immediately. The skill uses `vara-wallet` for wallet and contract calls, and
plain backend HTTP requests for world discovery and digger rental.

Important frontend areas:

```txt
frontend/src/scenes/      Landing/Menu/Game/Lobby/Spectator/Leaderboard/Redeem/SocialFuel
frontend/src/router.js    browser routes and back-button integration
frontend/src/chain/       wallet, IDL snapshots, chain sources, redeem client
frontend/scripts/         local checks, including IDL snapshot sync
```

Important backend areas:

```txt
backend/src/api/                         HTTP API
backend/src/modules/gameMaster/factory/  live world factory and discovery server
backend/src/modules/gameMaster/sim/      agent registration/play/reset helpers
backend/src/modules/                     registry, indexer, rental, leaderboard, social verifier
backend/src/jobs/                        scheduler, registry sync, indexer, top-up jobs
backend/src/chain/                       shared Vara.eth clients and DiggerWorld IDL
```

Important contracts:

```txt
contracts/digger-world/   World/session/mining logic
contracts/digger-proxy/   Agent-owned proxy/digger program
contracts/digger-res-vmt/ RES VMT token contract
contracts/digger-redeem/  RES -> VARA reserve and redeem contract
contracts/l1-adapter/     L1/Mirror adapter spike
```

## Frontend Routes

The app uses real browser paths, so reload and back navigation work:

| Path | Scene |
| --- | --- |
| `/` | campaign landing |
| `/menu` | game menu |
| `/game` | single-player game |
| `/play` | single-player alias |
| `/arena` | Agent Arena lobby |
| `/arena/<mode>?seed=<seed>` | local spectator deep link |
| `/world/<programId>` | live Vara.eth world spectator |
| `/leaderboard` | leaderboard |
| `/redeem-res` | RES redeem |
| `/free-wvara` | social fuel |

`frontend/src/routing.js` is kept as a compatibility wrapper for older code, but
new scene navigation should use `frontend/src/router.js`.

## Quick Start

Frontend only:

```bash
cd frontend
npm install
npm run dev -- --port 5189
```

Open `http://localhost:5189`.

Backend API and dry-run factory:

```bash
cd backend
cp .env.example .env
npm install
npm run api
npm run factory
```

Live mainnet world factory:

```bash
cd backend
npm run factory:chain
```

`factory:chain` requires a funded `DIGGER_ADMIN_KEY`, DiggerWorld code id, and
the mainnet RPC/router env values in `backend/.env`.

Useful local checks:

```bash
cd frontend
npm run check:idl
npm run build

cd backend
npm test

cd contracts
cargo test
```

`frontend` build runs `npm run check:idl` automatically through `prebuild`.

## IDL Source Of Truth

Contract release IDLs under `contracts/target/wasm32-gear/release/` are the
source of truth for frontend snapshots and backend indexing.

Frontend snapshots:

```txt
frontend/src/chain/world.idl
frontend/src/chain/digger_res_vmt.idl
frontend/src/chain/digger_redeem.idl
```

Check sync:

```bash
cd frontend
npm run check:idl
```

If a Sails contract interface changes, rebuild the contracts, copy the updated
release IDL into `frontend/src/chain/`, then run `npm run check:idl` and
`npm run build`.

The backend indexer reads release IDLs directly through
`backend/src/modules/indexer/idlRegistry.js`. The backend factory also carries
its own DiggerWorld IDL snapshot at `backend/src/chain/diggerWorld.idl`.

## Live Mainnet Configuration

Frontend:

```bash
cd frontend
cp .env.example .env
```

Set:

```txt
VITE_CHAIN_ENABLED=true
VITE_BACKEND_URL=https://api-digger-eth.vara.network
VITE_RES_VMT_PROGRAM_ID=
VITE_REDEEM_PROGRAM_ID=
VITE_MATCHES_URL=
VITE_WORLD_PROGRAM_IDS=  # optional fallback only; lobby reads /sessions
```

The frontend lobby reads current and past worlds from the operator discovery API
(`/sessions`). `VITE_MATCHES_URL` can override the discovery host; when it is
empty, `VITE_BACKEND_URL` is used. Live world movement is read directly from
Vara.eth, not from backend event streams.

Leave `VITE_WORLD_PROGRAM_ID` and `VITE_WORLD_PROGRAM_IDS` empty in production
when the backend/Postgres registry is seeded. They are only emergency fallbacks.

Backend:

```bash
cd backend
cp .env.example .env
```

For dry-run API/indexer work, private keys can stay empty. Live factory and
live rental/top-up require `DIGGER_ADMIN_KEY`, `DIGGER_CODE_ID` or
`DIGGER_PROXY_CODE_ID`, `ETH_RPC`, `VARA_ETH_WS`, and `ROUTER_ADDRESS`.

Set `ADMIN_API_TOKEN` before exposing `/api/admin/*` outside localhost.

## Backend Runtime

Common commands:

```bash
cd backend
npm run api
npm run factory
npm run factory:chain
npm run scheduler
npm run scheduler -- --once
npm run registry:sync
npm run indexer -- snapshot-once
npm run indexer -- snapshot-watch
npm run rental:top-up
```

Factory discovery endpoints:

```txt
GET http://localhost:8781/matches
GET http://localhost:8781/sessions
GET http://localhost:8781/health
```

Backend event log diagnostics:

```txt
GET http://localhost:8787/api/events?limit=100
```

The frontend live world listens to Vara.eth directly from `frontend/src/chain/worldEventListener.js`.
Backend event logs are for diagnostics/history, not the live renderer.

The MVP leaderboard uses this source order:

1. optional legacy agent ingest flows through `POST /api/ingest/injected`;
2. snapshot reconciliation through `npm run scheduler` or
   `npm run indexer -- snapshot-watch`;
3. live UI movement is handled on the frontend through `subscribeBestState`.

See `backend/README.md` for API endpoints, rental, social verifier, indexer,
and smoke check details.

For the mainnet deployment runbook with current program ids, code id, env files,
factory commands, and smoke steps, see `DEPLOYMENT.md`.

## Campaign Economy

RES is stored in `digger-res-vmt` as three token ids:

| Resource | Token id |
| --- | ---: |
| `SCRST` | `0` |
| `BCRST` | `1` |
| `HCRST` | `2` |

Redeem rates are display VARA values:

| Resource | Rate |
| --- | ---: |
| `SCRST` | `6` |
| `BCRST` | `30` |
| `HCRST` | `150` |

`digger-redeem` stores `vara_unit` separately. Current Vara.eth unit is
`1000000000000`.

## Current MVP Status

Ready or mostly ready:

- backend world factory lives under `backend/src/modules/gameMaster/factory`;
- redeem contract and RES VMT flow;
- separate leaderboard/redeem/social fuel frontend pages;
- backend API skeleton, registry, rental/top-up, leaderboard, admin endpoints;
- injected ingest plus snapshot fallback for MVP leaderboard;
- IDL sync guard in frontend build.

Still needs live/product hardening:

- live backend rental smoke: deploy digger through backend, verify initial
  top-up, verify daily skip when executable balance is already at target;
- live leaderboard validation against real agent events;
- public agent registration/onboarding/allowlist flow;
- production social verifier smoke with X API credentials;
- anticheat monitor;
- campaign landing polish if a marketing-grade site is required.

Intentionally deferred:

- LP Bonus.
