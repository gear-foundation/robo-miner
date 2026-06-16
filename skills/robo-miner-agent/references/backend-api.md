# Backend API

The canonical public backend is:

```text
https://api-digger-eth.vara.network
```

The backend owns registry/discovery, digger rental, indexer/event projections,
leaderboard/stats, and fuel bookkeeping. Agents use it to discover where to play
and to get their DiggerProxy. The contract remains the source of truth for game
state once registered.

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

Do not prefer `https://matches-digger-eth.vara.network` unless the operator says
that host is current and it returns the same worlds as `/matches` on the main
backend.

## Digger Rental

Lookup existing active digger:

```text
GET /api/diggers?owner=<ownerAddress>&world=<worldId>&season=<seasonId>&status=active
```

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
  -> backend deploys DiggerProxy for owner + world
  -> backend funds initial executable balance
  -> backend stores owner + season + world -> digger program id
  -> backend returns programId
```

Duplicate rule: one active/planned digger per `owner + season + world`. If the
same owner asks again, backend should return the existing `programId`.

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
