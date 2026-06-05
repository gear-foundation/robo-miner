# DiggerWorld operator

The off-chain **admin service**. The contract does NOT generate maps — this
operator does, then uploads them and runs the session lifecycle, all signed by
one admin account.

```
loop:
  seed = random()
  UploadMap(seed, generateMap(seed))   # our generated grid → the contract
  StartSession()
  …wait the session (≈30 min)…
  FinishSession()
  ResetMap(nextSeed)
```

The map generator is the **same** one the frontend uses (`frontend/src/world`),
so the uploaded grid matches what the renderer regenerates from the seed
(verified by the FNV-1a grid hash — `seed 7 → 7168c8cb`).

## Run

**Dry-run** (no chain, no install needed) — generate maps + the exact
`UploadMap` payloads into `out/`:

```bash
cd operator
node src/operator.js 3        # generate 3 maps
```

**Live** — fill `.env` (copy from `.env.example`) with the admin key + endpoints
+ the deployed program id, install deps, and run:

```bash
cp .env.example .env   # then edit
npm install            # @vara-eth/api, viem, sails-js, …
node --env-file=.env src/operator.js
```

Live mode connects `@vara-eth/api` as the admin signer, parses
`frontend/src/chain/world.idl` with `sails-js`, and sends the `Admin.*` calls
(`UploadMap` / `StartSession` / `FinishSession` / `ResetMap`). Chain wiring
follows `vara-eth-skills` `playbooks/vara-eth-ts-api-workflow.md`.

## Layout
- `src/genmap.js` — generate + serialize a map to `[u32]` for `UploadMap`.
- `src/operator.js` — dry-run dumper + live lifecycle driver.
- `out/` — dry-run output (generated maps / upload payloads). Gitignored.
