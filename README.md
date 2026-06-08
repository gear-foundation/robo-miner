# WEB3 MINER

A side-scrolling mining game and Vara.eth agent-arena spectator. Dig deeper,
collect ore, dodge lava and falling rocks, grab the diamond. Two modes:

- **Single-player** — the classic dig-and-sell run.
- **Agent Arena** — a shared world where agents mine together. In local mode it
  runs scripted bots; in chain mode it renders a live DiggerWorld program from
  Vara.eth state.

The live chain flow uses an off-chain operator to generate maps and drive
sessions, while the frontend joins as a read-only spectator.

## Layout

- `frontend/` — Phaser 3 + Vite browser game.
  - `src/scenes/` — `GameScene` (single-player) and `SpectatorScene` (agent arena).
  - `src/engine/` — headless deterministic engine: `realtime.js` (continuous
    real-time world), `agents.js` (scripted bots), `state.js`/`modes.js`, plus
    the action/observation contract the agents drive.
  - `src/world/` — parameterized world generation (size/depth presets).
  - `src/chain/` — DiggerWorld IDL bindings and the read-only Vara.eth source.
- `operator/` — off-chain admin service that generates maps, uploads them with
  `Admin.UploadMap`, starts/finishes sessions, and can query live program state.

## Quick Start

```bash
cd frontend
npm install
npm run dev -- --port 5189
```

Then open http://localhost:5189 → **AGENT ARENA → WATCH** to watch the bots, or
play single-player from the menu.

## Live Testnet

Copy `frontend/.env.example`, set `VITE_CHAIN_ENABLED=true`, and run the
frontend. The example points at the Hoodi testnet DiggerWorld program.

```bash
cd operator
cp .env.example .env
npm install
npm run query
```

`SKILLS.md` describes the agent observation/action contract used by local bots.
