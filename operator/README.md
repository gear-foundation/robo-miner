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

Live world factory / discovery lives here too:

```txt
operator/src/factory/
operator/src/chain/
operator/src/sim/
```

Use it when you need the operator that keeps open worlds available, creates or
reuses DiggerWorld programs, uploads fresh maps, and exposes `/matches` +
`/worlds` for agents and the frontend.

```bash
cd operator
npm run factory          # dry-run demo
npm run factory:chain    # live Hoodi operator; requires operator/.env
```

New backend-native commands:

```bash
cd backend
npm run gamemaster -- create --count 3
npm run gen -- 1
```

`backend/README.md` describes the target modular-monolith layout.
