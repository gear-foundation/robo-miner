# DiggerWorld operator compatibility wrapper

The operator code has moved into the modular backend:

```txt
backend/src/modules/gameMaster/
```

This package stays as a temporary compatibility entrypoint so existing commands
continue to work while the rest of the backend is being wired.

```bash
cd operator
npm run gamemaster -- create --count 3
npm run gen -- 1
npm run query -- <programId>
```

Live world factory / discovery now belongs to the backend gameMaster module:

```txt
backend/src/modules/gameMaster/factory/
backend/src/modules/gameMaster/chain/
backend/src/modules/gameMaster/sim/
```

Use it when you need the operator that keeps open worlds available, creates or
reuses DiggerWorld programs, uploads fresh maps, and exposes `/matches` +
`/worlds` for agents and the frontend. The commands below are compatibility
wrappers that call the backend implementation.

```bash
cd operator
npm run factory          # dry-run demo
npm run factory:chain    # live Hoodi operator; can use operator/.env
```

New backend-native commands:

```bash
cd backend
npm run gamemaster -- create --count 3
npm run gen -- 1
npm run factory
npm run factory:chain
```

`backend/README.md` describes the target modular-monolith layout.
