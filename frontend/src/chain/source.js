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
import { BLOCK } from '../config.js';
import { CHAIN, chainReady } from './config.js';
import { worldQueries, worldActions } from './world.js';

// Pick the data source. Local engine today; the chain source once a World
// contract is deployed and .env is filled (CHAIN.enabled + ids).
export function createWorldSource(opts) {
  if (chainReady(opts?.programId)) return new ChainSource(opts);
  return new RealtimeWorld(opts); // ← current behaviour, unchanged
}

const READ_SOURCE = '0x0000000000000000000000000000000000000001';

// Current live DiggerWorld testnet tile ids differ from the older frontend
// constants. Keep the renderer stable by translating contract cells at the edge.
const CONTRACT_TO_RENDER_TILE = {
  0: BLOCK.SKY,   // empty/drilled
  1: BLOCK.DIRT,
  2: BLOCK.SKY,   // caves / air pockets
  3: BLOCK.STONE,
  4: BLOCK.LAVA,
  5: BLOCK.LADDER,
  10: BLOCK.SCRST,
  11: BLOCK.BCRST,
  12: BLOCK.HCRST,
  20: BLOCK.SKY,  // sky/surface cap in the live testnet map
};

function renderTile(contractTile) {
  return CONTRACT_TO_RENDER_TILE[Number(contractTile)] ?? BLOCK.DIRT;
}

function decorateDiggerGrid(rawGrid, W, H, surface) {
  const grid = Uint8Array.from(rawGrid.map(renderTile));

  // The contract snapshot is logical game state. The spectator adds the same
  // visual shell the local worlds have: sky above the playable surface and an
  // unbreakable-looking stone frame around the mine.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (y < surface) {
        grid[i] = BLOCK.SKY;
        continue;
      }
      if (x === 0 || x === W - 1 || y === H - 1) {
        grid[i] = BLOCK.STONE;
        continue;
      }
      if (y === surface && grid[i] === BLOCK.SKY) {
        grid[i] = BLOCK.DIRT;
      }
    }
  }

  return grid;
}

function shortId(id) {
  if (!id) return 'agent';
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function makeEmptyStats() {
  return { tilesDug: 0, ore: 0, sold: 0, spent: 0, deaths: 0 };
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
    this.programId = opts?.programId || CHAIN.worldProgramId;
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
    this._pollEveryMs = Math.max(500, Number(CHAIN.pollMs || 1000));
    this._pollInMs = this._pollEveryMs;
    this._polling = false;
    this._lastGrid = null;
    this._lastAgents = new Map();
    this.ready = this._boot();
  }

  setAgents() { /* chain: real agents drive their own diggers via injected tx */ }
  observe() { return null; } // read-only spectator

  async _boot() {
    await this.connect();
    await this.load();
    this.subscribe();
    return this;
  }

  // 1) Connect @vara-eth/api (Router + Ethereum RPC + Vara.eth WS). Read-only.
  async connect() {
    const { Buffer } = await import('buffer');
    globalThis.Buffer ||= Buffer;
    const { WsVaraEthProvider, createVaraEthApi } = await import('@vara-eth/api');
    const { createPublicClient, http } = await import('viem');
    const { SailsProgram } = await import('sails-js');
    const { SailsIdlParser } = await import('sails-js/parser');

    const publicClient = createPublicClient({ transport: http(CHAIN.ethRpc) });
    this._api = await createVaraEthApi(
      new WsVaraEthProvider(CHAIN.varaEthWs),
      publicClient,
      CHAIN.routerAddress,
    );

    const parser = new SailsIdlParser();
    await parser.init();
    const idl = await (await fetch(new URL('./world.idl', import.meta.url))).text();
    this._program = new SailsProgram(parser.parse(idl));
    this._program.setProgramId(this.programId);
    this._q = worldQueries(this._program);
    this._act = worldActions(this._program);
  }

  // 2) Load the world for display. The map is generated OFF-CHAIN by us
  //    (generateWorld(seed)) and uploaded into the contract via Admin.UploadMap;
  //    the contract just stores it. To render we can either read it back —
  //    MapSnapshot() -> [u32] grid, Config() -> dims, Agents()/AgentOf() ->
  //    miners — or regenerate locally from the same seed; either way we then
  //    apply the event deltas. (No on-chain generation, so no Rust generator port.)
  async load() {
    const snap = await this._readSnapshot();
    this._applySnapshot(snap, { emitEvents: false });
  }

  // 3) Event subscriptions are the target live path. The current SDK exposes
  // block/query primitives, but no stable high-level program-event subscription
  // in this app yet, so the stand uses state polling below and emits the same
  // internal event shapes from snapshot diffs. Replacing this with real event
  // drain should not touch SpectatorScene.
  subscribe() {
    this._unsub = null;
  }

  // 4) Per frame: drain buffered events, apply them to the grid + miners, and
  //    expose them as .events (the renderer + TX console read this verbatim).
  update(dtMs = 0) {
    this.timeMs += dtMs;
    this._pollInMs -= dtMs;
    if (this._pollInMs <= 0 && !this._polling) {
      this._pollInMs = this._pollEveryMs;
      this._refresh().catch((error) => {
        this._pending.push({ type: 'chain_error', message: error?.message || String(error) });
      });
    }
    this.events = this._pending.splice(0);
    this.worldDirty = this.events.length > 0;
  }

  async _call(payload) {
    const reply = await this._api.call.program.calculateReplyForHandle(
      READ_SOURCE,
      this.programId,
      payload,
    );
    return reply.payload;
  }

  async _readSnapshot() {
    const Wq = this._program.services.World.queries;
    const [cfgPayload, sessionPayload, mapPayload, agentsPayload] = await Promise.all([
      this._call(this._q.config()),
      this._call(this._q.session()),
      this._call(this._q.mapSnapshot()),
      this._call(this._q.agents()),
    ]);

    const config = Wq.Config.decodeResult(cfgPayload).map(Number);
    const session = Wq.Session.decodeResult(sessionPayload).map((v) => Number(v));
    const rawGrid = Wq.MapSnapshot.decodeResult(mapPayload).map(Number);
    const owners = Wq.Agents.decodeResult(agentsPayload);
    const agentRows = await Promise.all(owners.map(async (owner, index) => {
      const [statePayload, inventoryPayload] = await Promise.all([
        this._call(this._q.agentOf(owner)),
        this._call(this._q.inventoryOf(owner)),
      ]);
      return {
        index,
        owner,
        state: Wq.AgentOf.decodeResult(statePayload).map((v) => Number(v)),
        inventory: Wq.InventoryOf.decodeResult(inventoryPayload).map(Number),
      };
    }));

    return { config, session, rawGrid, agents: agentRows };
  }

  _applySnapshot(snap, opts = {}) {
    const emitEvents = opts.emitEvents !== false;
    const [W = 40, H = 64] = snap.config;
    const rawSurface = Number.isFinite(snap.config[6]) ? snap.config[6] : 1;
    const surface = 4;
    const grid = decorateDiggerGrid(snap.rawGrid, W, H, surface);

    if (!this.world) {
      this.world = {
        grid,
        rawGrid: Uint32Array.from(snap.rawGrid),
        W,
        H,
        surface,
        rawSurface,
        model: 'digger',
        seed: Number(snap.session?.[1] || 0),
        crystals: [],
        pockets: [],
        diamondPos: null,
        pois: [],
        chests: [],
        chestsAt: new Map(),
        signals: null,
        validation: { ok: true, warnings: [] },
      };
    } else {
      this._emitGridDiffs(this.world.grid, grid, W, emitEvents);
      this.world.grid = grid;
      this.world.rawGrid = Uint32Array.from(snap.rawGrid);
      this.world.W = W;
      this.world.H = H;
      this.world.surface = surface;
      this.world.rawSurface = rawSurface;
      this.world.seed = Number(snap.session?.[1] || this.world.seed || 0);
    }

    this.session = snap.session;
    this.config = snap.config;
    const miners = snap.agents.map((row) => this._toMiner(row, surface));
    this._emitAgentDiffs(miners, emitEvents);
    this.s.miners = miners;
    this.match = {
      shopX: miners[0]?.spawnX ?? Math.floor(W / 2),
      diamondFound: false,
      finishedReason: null,
    };
    this.finished = snap.session?.[2] === 2;
    this.teamScore = miners.reduce((sum, m) => sum + (m.banked || 0), 0);
    this._lastGrid = grid;
    this._lastAgents = new Map(miners.map((m) => [m.owner, { ...m }]));
  }

  _emitGridDiffs(prev, next, W, emitEvents) {
    if (!emitEvents || !prev || prev.length !== next.length) return;
    for (let i = 0; i < next.length; i++) {
      if (prev[i] === next[i]) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      const oldBlock = prev[i];
      const newBlock = next[i];
      if ([BLOCK.SCRST, BLOCK.BCRST, BLOCK.HCRST].includes(oldBlock) && newBlock === BLOCK.SKY) {
        this._pending.push({ type: 'resource_extracted', x, y, block: oldBlock, amount: 1 });
      } else if (newBlock === BLOCK.LADDER) {
        this._pending.push({ type: 'ladder_placed', x, y });
      } else {
        this._pending.push({ type: 'dug', x, y, block: oldBlock });
      }
    }
  }

  _emitAgentDiffs(miners, emitEvents) {
    if (!emitEvents) return;
    if (!this._lastAgents.size) {
      for (const m of miners) this._pending.push({ type: 'spawned', id: m.id, owner: m.owner, x: m.tx, y: m.ty });
      return;
    }
    for (const m of miners) {
      const prev = this._lastAgents.get(m.owner);
      if (!prev) {
        this._pending.push({ type: 'registered', id: m.id, owner: m.owner });
        this._pending.push({ type: 'spawned', id: m.id, owner: m.owner, x: m.tx, y: m.ty });
        continue;
      }
      if (prev.tx !== m.tx || prev.ty !== m.ty) {
        this._pending.push({ type: 'moved', id: m.id, owner: m.owner, fromX: prev.tx, fromY: prev.ty, x: m.tx, y: m.ty });
      }
      if (prev.alive && !m.alive) this._pending.push({ type: 'death', id: m.id, owner: m.owner, x: m.tx, y: m.ty });
      if (!prev.alive && m.alive) this._pending.push({ type: 'spawned', id: m.id, owner: m.owner, x: m.tx, y: m.ty });
    }
  }

  _toMiner(row, surface) {
    const [x = 0, rawY = surface - 1, facing = 0, aliveRaw = 1] = row.state;
    const y = rawY < surface ? surface - 1 : rawY;
    const cargo = row.inventory.reduce((sum, v) => sum + Number(v || 0), 0);
    const color = [0x5fd0e6, 0x7cffb0, 0xffdd55, 0xff8fdc, 0xb08cff][row.index % 5];
    return {
      id: row.index,
      owner: row.owner,
      name: shortId(row.owner),
      tx: x,
      ty: y,
      drawX: x,
      drawY: y,
      facing: ['up', 'right', 'down', 'left'][facing] || 'down',
      alive: aliveRaw !== 0,
      act: null,
      cargo,
      inventory: row.inventory,
      banked: Number(row.state[10] || 0),
      items: {},
      stats: makeEmptyStats(),
      respawnAtMs: null,
      spawnX: Number(row.state[11] || x),
      spawnY: Number(row.state[12] || surface),
      hat: row.index % 3 === 0 ? 'cap' : row.index % 3 === 1 ? 'visor' : 'antenna',
      color,
      radar: 2,
      maxLadders: 10,
    };
  }

  async _refresh() {
    this._polling = true;
    try {
      const snap = await this._readSnapshot();
      this._applySnapshot(snap);
    } finally {
      this._polling = false;
    }
  }

  dispose() {
    if (this._unsub) this._unsub();
    this._api?.provider?.disconnect?.();
  }
}
