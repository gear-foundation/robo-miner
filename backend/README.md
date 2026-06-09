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
      lpBonus/            # LP checks and executable-balance bonuses
      leaderboard/        # season scores and agent standings
```

## Current module

`modules/gameMaster` contains the current operator implementation:

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
```

The old `operator/` package remains as a compatibility wrapper while we migrate
scripts and docs to `backend/`.
