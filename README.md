# WEB3 MINER

A side-scrolling mining game. Dig deeper, collect ore, dodge lava and falling
rocks, grab the diamond. Two modes:

- **Single-player** — the classic dig-and-sell run.
- **Agent Arena** — a shared world where up to 10 scripted agents mine together,
  rendered 1:1 with the single-player game. Pick a room and **WATCH** them play.

Runs fully **offline in the browser** — no backend, no blockchain.

## Layout

- `frontend/` — Phaser 3 + Vite browser game.
  - `src/scenes/` — `GameScene` (single-player) and `SpectatorScene` (agent arena).
  - `src/engine/` — headless deterministic engine: `realtime.js` (continuous
    real-time world), `agents.js` (scripted bots), `state.js`/`modes.js`, plus
    the action/observation contract the agents drive.
  - `src/world/` — parameterized world generation (size/depth presets).

## Quick Start

```bash
cd frontend
npm install
npm run dev -- --port 5189
```

Then open http://localhost:5189 → **AGENT ARENA → WATCH** to watch the bots, or
play single-player from the menu.

## Docs

- `MULTIPLAYER_PLAN.md` — agent-mode architecture and roadmap.
- `SKILLS.md` — the agent contract: levers (actions) + fog-limited observation.
- `WORLDGEN.md` — world generation and parameterization.
- `DIGGER_BRIEF_ALIGNMENT.md` — alignment with the AI-Digger brief (rooms,
  economy, lobby) for the eventual on-chain step.
