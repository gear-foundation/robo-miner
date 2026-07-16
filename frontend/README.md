# Web3 Miner Frontend

Phaser 3 + Vite frontend for the Web3 Miner game, campaign pages, live arena
spectator, leaderboard, RES redeem, and social fuel flow.

## Commands

```bash
npm install
npm run dev -- --port 5189
npm run check:idl
npm run build
```

`npm run build` runs `npm run check:idl` first through `prebuild`.

## Routes

The app uses browser history, not a single in-memory scene switch. Reload and
the browser back button should work for the main surfaces.

| Path | Scene |
| --- | --- |
| `/` | `LandingScene` |
| `/menu` | `MenuScene` |
| `/game` | `GameScene` |
| `/play` | `GameScene` alias |
| `/arena` | `LobbyScene` |
| `/arena/<mode>?seed=<seed>` | `SpectatorScene` local arena |
| `/world/<programId>` | `SpectatorScene` live Vara.eth world |
| `/leaderboard` | `LeaderboardScene` |
| `/redeem-res` | `RedeemScene` |
| `/free-wvara` | `SocialFuelScene` |

Use `src/router.js` for new navigation. `src/routing.js` remains as a
compatibility wrapper for older scene code that imports `setRoute`.

## Spectating Diggers

The arena spectator has a **Diggers** control that opens a roster of active
diggers. Select a row to follow that digger and view its live status, position,
cargo, banked resources, and executable balance. The roster starts collapsed so
the mine remains visible, and the selected digger is marked on the map.

## Wallet

Wallet connection is centralized in `src/chain/wallet.js`.

The main menu owns the visible wallet button. The button opens one modal-like
provider/account selection flow and can be clicked again to switch wallet or
account. Other flows should read the selected wallet state instead of
implementing their own connector.

## Chain Configuration

Copy `.env.example` to `.env` for local live-chain work.

Key frontend variables:

```txt
VITE_CHAIN_ENABLED=true
VITE_ETH_RPC=...
VITE_VARA_ETH_WS=...
VITE_ROUTER_ADDRESS=...
VITE_BACKEND_URL=https://api-digger-eth.vara.network
VITE_MATCHES_URL=          # optional override; empty uses VITE_BACKEND_URL
VITE_WORLD_PROGRAM_IDS=    # optional fallback only
VITE_RES_VMT_PROGRAM_ID=...
VITE_REDEEM_PROGRAM_ID=...
```

The arena lobby discovers current and past worlds from `/sessions`. Direct
`/world/:programId` routes still work without listing that program id in env.

If `VITE_CHAIN_ENABLED=false`, the arena falls back to the local realtime
engine.

## IDL Snapshots

Frontend keeps checked-in Sails IDL snapshots so Vite can build independently of
Rust build output:

```txt
src/chain/world.idl
src/chain/digger_res_vmt.idl
src/chain/digger_redeem.idl
```

The source of truth is:

```txt
../contracts/target/wasm32-gear/release/digger_world.idl
../contracts/target/wasm32-gear/release/digger_res_vmt.idl
../contracts/target/wasm32-gear/release/digger_redeem.idl
```

After changing any public Sails contract interface:

```bash
cd ../contracts
cargo build --release

cd ../frontend
npm run check:idl
npm run build
```

If `check:idl` fails, refresh the matching `src/chain/*.idl` snapshot from the
contract release IDL.

## Backend Integration

Set `VITE_BACKEND_URL` to the backend API origin. Current frontend integrations:

- leaderboard reads `/api/leaderboard`;
- live worlds read `/api/worlds/live`;
- social fuel submits to `/api/social/x/submit`;
- live world movement is read directly from Vara.eth `subscribeBestState`;
- redeem uses configured RES VMT and redeem program ids directly through
  Vara.eth RPC.

## Smoke Checklist

Before shipping frontend changes:

```bash
npm run check:idl
npm run build
```

Manual browser smoke:

1. Open `/`, then enter `/menu`.
2. Connect wallet from the menu button and reopen it to switch account/provider.
3. Visit `/leaderboard`, `/redeem-res`, `/free-wvara`, and use browser back.
4. Visit `/arena`, open a local spectator, open **Diggers**, and select a
   moving digger. Confirm the camera follows it, its details update, and the
   selected-digger marker stays visible. Reload the page, then go back.
5. If live ids are configured, open `/world/<programId>` and confirm the world
   snapshot loads.
