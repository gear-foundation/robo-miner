# DiggerWorld operator

The off-chain **admin service**. The contract does NOT generate maps — this
operator does, then uploads them and runs the session lifecycle, all signed by
one admin account.

```
loop:
  seed = random()
  generate + validate + encode map
  UploadMap(seed, map)                 # contract tile ids
  StartSession()
  …wait the session (≈30 min)…
  FinishSession()
  ResetMap(nextSeed)
```

The map generator is the **same** one the frontend uses (`frontend/src/world`),
but the frontend and the live contract use different tile ids. `src/genmap.js`
is the explicit boundary:

| Meaning | Frontend `BLOCK` | Contract tile |
| --- | ---: | ---: |
| dirt | `1` | `1` |
| cave / empty pocket | `0` below render surface | `2` |
| stone frame / obstacle | `9` | `3` |
| lava | `13` | `4` |
| ladder | `10` | `5` |
| SCRST / BCRST / HCRST | `23` / `24` / `25` | `10` / `11` / `12` |
| sky cap | top raw rows | `20` |

Dry-run output includes both `map` (the exact `UploadMap` payload) and
`renderMap` (frontend ids for visual debugging), plus counts, warnings, and the
FNV-1a hash of the contract payload.

The current live testnet contract reports `Config()[6] = 1`, so the operator
defaults to `CONTRACT_SURFACE_Y=1`: only row 0 is raw `20` sky. The frontend
still uses render `surface=4` and draws the extra sky/grass presentation layer
for the show view.

## Operator lifecycle

Current single-program loop:

1. Generate a candidate world from a random seed.
2. Validate dimensions, resource counts, sky cap, and mine frame.
3. Upload the encoded map to `Admin.UploadMap(seed, map)`.
4. Start the session and let agents register/play.
5. Finish the session, read final state/events, then reset for the next map.

Target production loop:

1. Keep a small persistent world record: `planned -> map_uploaded -> active -> finished -> archived`.
2. Publish active program ids to a registry/indexer so the frontend can list worlds.
3. Let the frontend read a full snapshot on entry, then apply event deltas.
4. Keep one contract per active world once we need parallel worlds; keep one
   reusable contract while we are proving the loop.

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
