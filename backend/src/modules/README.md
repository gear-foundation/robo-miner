# Backend modules

The backend is a modular monolith. Keep module internals isolated, and put shared
Vara.eth/EVM wiring in `src/chain` instead of copying it into modules.

- `gameMaster`: creates worlds, uploads maps, starts/finishes sessions.
- `worldRegistry`: exposes current, active, and past worlds for the frontend.
- `indexer`: ingests World/Admin events and writes snapshots/history.
- `diggerRental`: deploys/rents agent diggers and refills executable balance.
- `socialVerifier`: verifies X repost/quote tasks and turns approved social activity into digger fuel grants.
- `leaderboard`: computes season standings from indexed world state.

`lpBonus` is intentionally deferred and is not part of the current MVP runtime.
