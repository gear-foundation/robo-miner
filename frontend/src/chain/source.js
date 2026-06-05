// World data source — the seam between the renderer and where the data lives.
//
// The spectator renders from a SOURCE that exposes one fixed surface. Today the
// source is the local real-time engine (RealtimeWorld). When the Vara.eth World
// contract is live, ChainSource exposes the SAME surface by reading state +
// subscribing to events — so the renderer, HUD, totems, and TX console never
// change. Swapping local↔chain is a single factory decision (createWorldSource).
//
// THE SURFACE (what the spectator consumes — RealtimeWorld already implements it):
//   .world          generated world { grid:Uint8Array, W, H, surface, model, ... }
//   .s.miners[]      live diggers { id,name,tx,ty,drawX,drawY,facing,alive,
//                      hat,color,act,cargo,items,stats,respawnAtMs,spawnX,spawnY }
//   .stones, .bombs  hazards to render
//   .events[]        events emitted during the last update() — the §8 stream the
//                      TX console + feed read (moved/drilled/resource_extracted/…)
//   .timeMs          clock in ms
//   .worldDirty      true when grid cells changed → renderer re-draws tiles
//   .finished, .teamScore, .match
//   .update(dtMs)    advance one frame (local: sim step; chain: drain+apply events)
//   .setAgents(fns)  local bots only (chain: no-op — real agents push their own tx)
//   .observe(id)     local only (chain: read-only spectator returns null)
//
// Mapping local→chain (so the contract team and we agree on the shapes):
//   .world.grid   ← World program state grid bytes (read once: seed→generateWorld,
//                   OR raw readState), then mutated by cell-delta events
//   .s.miners     ← per-digger state (pos/inv/ladders) from state + moved events
//   .events       ← decoded World program events (§8 taxonomy)

import { RealtimeWorld } from '../engine/realtime.js';
import { CHAIN, chainReady } from './config.js';
import { worldQueries, worldActions, decodeWorldEvent } from './world.js';

// Pick the data source. Local engine today; the chain source once a World
// contract is deployed and .env is filled (CHAIN.enabled + ids).
export function createWorldSource(opts) {
  if (chainReady()) return new ChainSource(opts);
  return new RealtimeWorld(opts); // ← current behaviour, unchanged
}

// Read-only Vara.eth source (spectator). Built per vara-eth-skills:
//   - playbooks/vara-eth-ts-api-workflow.md  (connect, queries, readState)
//   - skills/vara-eth-injected-app-builder/SKILL.md (RPC reads, no signer)
// IMPORTANT (spec §0): the exact @vara-eth/api calls + the event-subscription
// API must be confirmed against the SDK/source-of-truth when wiring — the lines
// below are the documented plan, intentionally not executed until the World
// contract + its Sails IDL exist. @vara-eth/api is imported dynamically so the
// local build never depends on it.
export class ChainSource {
  constructor(opts) {
    this.opts = opts;
    // The fixed surface, empty until load() runs.
    this.world = null;
    this.s = { miners: [] };
    this.stones = [];
    this.bombs = [];
    this.events = [];
    this.timeMs = 0;
    this.worldDirty = false;
    this.finished = false;
    this.teamScore = 0;
    this.match = { shopX: 0 };
    this._pending = []; // events buffered from the subscription between frames
    this._api = null;
    this._program = null;
  }

  setAgents() { /* chain: real agents drive their own diggers via injected tx */ }
  observe() { return null; } // read-only spectator

  // 1) Connect @vara-eth/api (Router + Ethereum RPC + Vara.eth WS). Read-only.
  async connect() {
    // const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
    // const { createPublicClient, http } = await import('viem');
    // const { SailsProgram } = await import('sails-js');
    // const { SailsIdlParser } = await import('sails-js/parser');
    // const publicClient = createPublicClient({ transport: http(CHAIN.ethRpc) });
    // this._api = await createVaraEthApi(new WsVaraEthProvider(CHAIN.varaEthWs), publicClient, CHAIN.routerAddress /* , read-only signer */);
    // const parser = new SailsIdlParser(); await parser.init();
    // const idl = await (await fetch(new URL('../chain/world.idl', import.meta.url))).text();
    // this._program = new SailsProgram(parser.parse(idl)); // DiggerWorld (services World + Admin)
    // this._program.setProgramId(CHAIN.worldProgramId);
    // this._q = worldQueries(this._program); this._act = worldActions(this._program); // typed calls
    throw new Error('[ChainSource] connect: wire @vara-eth/api once the World contract is deployed (chain/source.js)');
  }

  // 2) Load the world grid + agents from the World queries (world.idl).
  //    MapSnapshot() -> [u32] grid bytes; Config() -> dims; Agents()/AgentOf() ->
  //    miners. (Alternatively read just the seed and generateWorld() locally —
  //    see WORLDGEN_PORTING.md — then apply deltas.)
  async load() {
    // const SRC = await this._signer.getAddress(); // or any read source
    // const snapReply = await this._api.call.program.calculateReplyForHandle(SRC, CHAIN.worldProgramId, this._q.mapSnapshot());
    // const grid = this._program.services.World.queries.MapSnapshot.decodeResult(snapReply.payload); // [u32]
    // const cfgReply = await this._api.call.program.calculateReplyForHandle(SRC, CHAIN.worldProgramId, this._q.config());
    // const cfg = this._program.services.World.queries.Config.decodeResult(cfgReply.payload);        // {W,H,surface,…}
    // this.world = { grid: Uint8Array.from(grid), W: cfg[0], H: cfg[1], surface: cfg[2], model: 'digger' };
    // this.s.miners = (await this._loadAgents());  // Agents() + AgentOf()/InventoryOf()
    throw new Error('[ChainSource] load: read World MapSnapshot/Config/Agents via calculateReplyForHandle (ts-api playbook §9)');
  }

  // 3) Subscribe to the World program events (world.idl) → buffer for update().
  //    AgentMoved/TileDrilled/ResourceExtracted/LadderPlaced/AgentSurfaced/… are
  //    mapped to our internal {type,id,x,y,block,…} by decodeWorldEvent().
  subscribe() {
    // this._unsub = this._api.subscribeToProgramEvents(CHAIN.worldProgramId, (raw) => {
    //   const { service, name, args } = this._program.decodeEvent(raw); // sails-js
    //   const ev = decodeWorldEvent(name, args);
    //   if (ev) this._pending.push(ev);
    // });
    throw new Error('[ChainSource] subscribe: confirm the @vara-eth/api event-subscription call against the SDK + app-builder skill');
  }

  // 4) Per frame: drain buffered events, apply them to the grid + miners, and
  //    expose them as .events (the renderer + TX console read this verbatim).
  update(/* dtMs */) {
    this.events = this._pending.splice(0);
    // for (const e of this.events) this._apply(e);
    //   moved             → miner.tx/ty (+ interpolate drawX/drawY)
    //   resource_extracted/drilled/ladder_placed → setBlock(grid, x, y, tile); worldDirty = true
    //   death / respawned → miner.alive / position
    //   sold              → teamScore += amount
    this.worldDirty = this.events.length > 0;
  }

  dispose() { if (this._unsub) this._unsub(); }
}
