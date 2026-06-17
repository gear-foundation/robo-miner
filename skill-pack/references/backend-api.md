# Backend API

The canonical public backend is:

```text
https://api-digger-eth.vara.network
```

The backend owns registry/discovery, digger rental, indexer/event projections,
leaderboard/stats, and fuel bookkeeping. Agents use it to discover where to play
and to get their DiggerProxy program. The contract remains the source of truth
for game state once registered.

## Source-Of-Truth Precedence

Use this order when backend responses disagree with the skill:

1. The `robo-miner-agent` workflow and bundled references.
2. Fresh chain reads through `vara-wallet`.
3. Backend discovery/rental projections.

`/matches` may return legacy `register.steps` telling a client to send injected
`World.Register(owner)`. Ignore those steps in this skill. They are not
authoritative for player agents. Register only through the rented DiggerProxy
with `Digger/Register --via injected`.

## Discovery

```text
GET /health
GET /api/manifest
GET /matches
GET /sessions
GET /api/worlds/live
GET /api/worlds
```

Use `/api/manifest` to discover network configuration and program ids. Use
`/matches` or `/sessions` to pick a live/waiting world. A useful match has a
world program id, season id, joinable/open status, and free slots.

Treat discovery write instructions as hints for legacy frontends only. Do not
use `/matches.register.steps` or any backend-provided write recipe that bypasses
the rented DiggerProxy.

Do not prefer `https://matches-digger-eth.vara.network` unless the operator says
that host is current and it returns the same worlds as `/matches` on the main
backend.

## Digger Rental

Lookup existing active digger:

```text
GET /api/diggers?owner=<ownerAddress>&season=<seasonId>&status=active
```

Do not include `world` or `worldId` in the public lookup request. Read all
returned diggers for the owner/season and compare `diggers[].worldId` locally
with the selected world. The request endpoint still needs `worldId`.

Request a backend-managed digger:

```http
POST /api/diggers/request
content-type: application/json

{
  "owner": "0xagentEvmAddress",
  "worldId": "0xworldProgramId",
  "seasonId": "season-1",
  "dryRun": false
}
```

Expected behavior:

```text
agent requests digger
  -> backend deploys a separate DiggerProxy program for owner + world
  -> backend initializes DiggerProxy.Create(ownerActorId, worldActorId)
  -> backend funds initial executable balance
  -> backend may refill executable balance on its daily schedule
  -> backend stores owner + season + world -> diggerProgramId
  -> backend returns programId, the DiggerProxy program address
```

Duplicate rule: one active/planned digger per `owner + season + world`. If the
same owner asks again, backend should return the existing `programId`.

Pending policy:

- If `POST /api/diggers/request` returns `status: "pending"` with
  `programId: null`, wait 180 seconds before the first lookup.
- Poll `GET /api/diggers?owner=<ownerAddress>&season=<seasonId>&status=active`
  every 30 seconds for up to 10 minutes total.
- Do not include `world` or `worldId` in that lookup; compare
  `diggers[].worldId` locally.
- Do not repeat `POST /api/diggers/request` while an existing request is still
  inside the 10-minute wait window.
- If a repeated request returns a different `requestId` while the active list is
  still empty, treat it as a backend/operator ambiguity, not as a new playable
  digger. Keep polling the active list and report all request ids if the gate
  times out.
- There is no player-facing request-status endpoint required by this skill. Do
  not call `/api/admin/*` for operator status. If the active list stays empty
  after the wait window, stop at Gate 4 and report owner, season, worldId, all
  request ids, and the last backend response.

The requested `owner` is the EVM address returned by `vara-wallet
vara-eth:wallet show`. Backend converts it to `ownerActorId` and sets that actor
as the DiggerProxy owner. The returned `programId` is not the player's wallet
address; it is the deployed digger program to call for `Digger/Register`,
`Digger/Drill`, `Digger/MoveAgent`, and other player actions.

## Events and Projections

```text
GET /api/events?limit=100
GET /api/events with Accept: text/event-stream
POST /api/ingest/injected
```

The event stream is useful for UI/projection sync, but the player loop should
still re-read contract state after writes. For injected transaction flows, post
transaction metadata to `/api/ingest/injected` when the runtime uses it, so the
backend can index and project fresh events.

## Stats

```text
GET /api/stats/agents?season=<seasonId>&world=<worldId>
GET /api/stats/economy
GET /api/leaderboard?metric=banked&season=<seasonId>&world=<worldId>&limit=50
```

Stats are read-only guidance. Do not use them as authority for movement,
inventory, or session status.

## Social/Fuel Adjacent Endpoints

```text
POST /api/social/x/submit
GET /api/social/x/:owner
```

Use these only when the task explicitly asks for social fuel. Normal game play
does not require them.

## Agent Rules for Backend Usage

- Use backend for discovery and rental.
- Use the chain for current game state and action confirmation.
- Do not call `/api/admin/*`.
- If backend and chain disagree, trust chain for current world/session state and
  report the discrepancy.
