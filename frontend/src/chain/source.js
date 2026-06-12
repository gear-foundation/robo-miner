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
import { decodeWorldEvent, worldQueries, worldActions } from './world.js';

// Pick the data source. Local engine today; the chain source once a World
// contract is deployed and .env is filled (CHAIN.enabled + ids).
export function createWorldSource(opts) {
  if (chainReady(opts?.programId)) return new ChainSource(opts);
  return new RealtimeWorld(opts); // ← current behaviour, unchanged
}

const READ_SOURCE = '0x0000000000000000000000000000000000000001';
const ZERO_ACTOR_RE = /^0x0+$/i;
const CHAIN_MOVE_MS = 180;
const CHAIN_DIG_PULSE_MS = 240;
const MAX_BLOCK_BACKFILL = 24;
const DEFAULT_RAW_SURFACE = Number.isFinite(CHAIN.contractSurfaceY) ? CHAIN.contractSurfaceY : 1;

// Current live DiggerWorld testnet tile ids differ from the older frontend
// constants. Keep the renderer stable by translating contract cells at the edge.
const CONTRACT_TO_RENDER_TILE = {
  0: BLOCK.SKY,   // empty/drilled
  1: BLOCK.DIRT,
  2: BLOCK.STONE,
  3: BLOCK.LAVA,
  4: BLOCK.LADDER,
  10: BLOCK.SCRST,
  11: BLOCK.BCRST,
  12: BLOCK.HCRST,
  20: BLOCK.SKY,  // sky/surface cap in the live testnet map
};

function renderTile(contractTile) {
  return CONTRACT_TO_RENDER_TILE[Number(contractTile)] ?? BLOCK.DIRT;
}

function isZeroActor(id) {
  return typeof id === 'string' && ZERO_ACTOR_RE.test(id);
}

function sameActor(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function rawToVisualY(rawY, surface, rawSurface, yOffset) {
  return rawY < rawSurface ? surface - 1 : rawY + yOffset;
}

function normalizeEventNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeResourceTotals(value = {}) {
  return {
    scrst: normalizeEventNumber(value.scrst),
    bcrst: normalizeEventNumber(value.bcrst),
    hcrst: normalizeEventNumber(value.hcrst),
  };
}

function resourceTotal(value = {}) {
  const totals = normalizeResourceTotals(value);
  return totals.scrst + totals.bcrst + totals.hcrst;
}

function decorateDiggerGrid(rawGrid, W, rawH, rawSurface, surface) {
  const yOffset = Math.max(0, surface - rawSurface);
  const H = rawH + yOffset;
  const grid = new Uint8Array(W * H);
  grid.fill(BLOCK.SKY);

  for (let y = rawSurface; y < rawH; y++) {
    const visualY = y + yOffset;
    for (let x = 0; x < W; x++) {
      grid[visualY * W + x] = renderTile(rawGrid[y * W + x]);
    }
  }

  // The contract snapshot is logical game state. The spectator adds the same
  // visual shell the local worlds have: sky above the playable surface and an
  // unbreakable-looking stone frame around the mine. The current contract has
  // rawSurface=1, while the show view uses surface=4, so raw underground rows
  // are shifted down instead of overwritten by the decorative sky band.
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
    }
  }

  return { grid, H, yOffset };
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
    this._eventPollEveryMs = Math.max(400, Number(CHAIN.pollMs || 1000));
    this._eventPollInMs = this._eventPollEveryMs;
    this._snapshotEveryMs = Math.max(5000, this._eventPollEveryMs * 5);
    this._snapshotInMs = this._snapshotEveryMs;
    this._polling = false;
    this._draining = false;
    this._lastBlockHash = null;
    this._lastBlockHeight = 0;
    this._eventDecoders = [];
    this._seenEventKeys = new Set();
    this._lastGrid = null;
    this._lastAgents = new Map();
    this.ready = this._boot();
  }

  setAgents() { /* chain: real agents drive their own diggers via injected tx */ }
  observe() { return null; } // read-only spectator

  async _boot() {
    await this.connect();
    await this.load();
    await this.subscribe();
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
    this._eventDecoders = this._buildEventDecoders();
  }

  _buildEventDecoders() {
    const decoders = [];
    for (const service of Object.values(this._program.services || {})) {
      for (const [name, event] of Object.entries(service.events || {})) {
        decoders.push({
          name,
          decode: (payload) => decodeWorldEvent(name, event.decode(payload)),
        });
      }
    }
    return decoders;
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

  // 3) Live event path. Vara.eth exposes block queries here, so the frontend
  // tracks new block headers, reads block outcomes, decodes Sails event payloads
  // emitted by this program, and applies those deltas immediately. Snapshot
  // polling remains a slower safety net for rehydrate / missed blocks.
  async subscribe() {
    this._unsub = null;
    await this._primeEventCursor();
  }

  // 4) Per frame: drain buffered events, apply them to the grid + miners, and
  //    expose them as .events (the renderer + TX console read this verbatim).
  update(dtMs = 0) {
    this.timeMs += dtMs;
    this._advanceAnimations(dtMs);

    this._eventPollInMs -= dtMs;
    if (this._eventPollInMs <= 0 && !this._draining) {
      this._eventPollInMs = this._eventPollEveryMs;
      this._drainNewBlocks().catch((error) => {
        this._pending.push({ type: 'chain_error', message: error?.message || String(error) });
      });
    }

    this._snapshotInMs -= dtMs;
    if (this._snapshotInMs <= 0 && !this._polling) {
      this._snapshotInMs = this._snapshotEveryMs;
      this._refresh({ emitEvents: false }).catch((error) => {
        this._pending.push({ type: 'chain_error', message: error?.message || String(error) });
      });
    }
    this.events = this._pending.splice(0);
    if (this.events.some((e) => ['dug', 'resource_extracted', 'ladder_placed', 'map_generated'].includes(e.type))) {
      this.worldDirty = true;
    }
  }

  async _call(payload) {
    const reply = await this._api.call.program.calculateReplyForHandle(
      READ_SOURCE,
      this.programId,
      payload,
    );
    return reply.payload;
  }

  async _primeEventCursor() {
    const header = await this._api.query.block.header();
    this._lastBlockHash = header.hash;
    this._lastBlockHeight = Number(header.height || 0);
  }

  async _drainNewBlocks() {
    if (!this._lastBlockHash) {
      await this._primeEventCursor();
      return;
    }

    this._draining = true;
    try {
      const latest = await this._api.query.block.header();
      if (!latest?.hash || latest.hash === this._lastBlockHash) return;

      const chain = [];
      let cursor = latest;
      let foundCursor = false;
      for (let i = 0; cursor && i < MAX_BLOCK_BACKFILL; i++) {
        if (cursor.hash === this._lastBlockHash) {
          foundCursor = true;
          break;
        }
        chain.push(cursor);
        if (!cursor.parentHash) break;
        cursor = await this._api.query.block.header(cursor.parentHash);
      }

      if (!foundCursor) {
        this._pending.push({ type: 'chain_gap', from: this._lastBlockHeight, to: latest.height });
        await this._refresh({ emitEvents: false });
        this._lastBlockHash = latest.hash;
        this._lastBlockHeight = Number(latest.height || this._lastBlockHeight);
        return;
      }

      for (const header of chain.reverse()) {
        await this._processBlock(header);
        this._lastBlockHash = header.hash;
        this._lastBlockHeight = Number(header.height || this._lastBlockHeight);
      }
    } finally {
      this._draining = false;
    }
  }

  async _processBlock(header) {
    const transitions = await this._api.query.block.outcome(header.hash);
    let messageIndex = 0;
    for (const transition of transitions || []) {
      if (!sameActor(transition.actorId, this.programId)) continue;
      for (const message of transition.messages || []) {
        if (!isZeroActor(message.destination)) continue;
        const key = `${header.hash}:${message.id || messageIndex++}`;
        const event = this._decodeSailsEvent(message.payload);
        if (!event || this._seenEventKeys.has(key)) continue;
        this._seenEventKeys.add(key);
        if (this._seenEventKeys.size > 500) this._seenEventKeys = new Set([...this._seenEventKeys].slice(-250));
        this._applyChainEvent(event, key);
      }
    }
  }

  _decodeSailsEvent(payload) {
    if (!payload) return null;
    const bytes = Array.isArray(payload) ? Uint8Array.from(payload) : payload;
    for (const decoder of this._eventDecoders) {
      try {
        const event = decoder.decode(bytes);
        if (event) return { ...event, chainEvent: decoder.name };
      } catch {
        // Payloads are matched by trying each Sails event header.
      }
    }
    return null;
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

  _applyChainEvent(rawEvent) {
    const event = this._normalizeChainEvent(rawEvent);
    const miner = this._minerForEvent(event, {
      create: ['registered', 'spawned', 'moved'].includes(event.type),
    });

    switch (event.type) {
      case 'registered':
        break;
      case 'spawned':
        this._placeMiner(miner, event.x, event.y, { alive: true });
        miner.spawnX = event.x;
        miner.spawnY = this.world?.surface ?? event.y;
        break;
      case 'moved':
        this._moveMiner(miner, event);
        break;
      case 'dug':
        this._setRawTile(event.x, event.rawY, event.rawNewBlock ?? 0);
        if (miner) {
          miner.stats.tilesDug += 1;
          miner.act = { kind: 'dig', tx: event.x, ty: event.y, blockType: event.block, t: 0, dur: CHAIN_DIG_PULSE_MS };
        }
        break;
      case 'resource_extracted':
        if (miner) {
          const amount = normalizeEventNumber(event.amount, 1);
          miner.cargo += amount;
          miner.stats.ore += amount;
        }
        break;
      case 'ladder_placed':
        this._setRawTile(event.x, event.rawY, 4);
        if (miner && Number.isFinite(event.laddersRemaining)) {
          miner.items.ladder = event.laddersRemaining;
        }
        break;
      case 'surfaced':
        if (miner) {
          const banked = normalizeResourceTotals(event.banked);
          const amount = banked.scrst + banked.bcrst + banked.hcrst;
          miner.banked = amount;
          miner.bankedResources = banked;
          miner.cargo = 0;
          miner.stats.sold = amount;
          this.teamScore = this.s.miners.reduce((sum, m) => sum + (m.banked || 0), 0);
        }
        break;
      case 'resources_minted':
        if (miner) {
          miner.mintedResources = normalizeResourceTotals(event.minted);
        }
        break;
      case 'death':
        if (miner) {
          this._placeMiner(miner, event.x, event.y, { alive: false });
          miner.stats.deaths += 1;
          miner.respawnAtMs = this.timeMs + 1400;
        }
        break;
      case 'exited':
        if (miner) {
          miner.alive = false;
          miner.exited = true;
          miner.act = null;
          miner.respawnAtMs = null;
        }
        break;
      case 'session_finished':
        this.finished = true;
        break;
      case 'map_generated':
        this._snapshotInMs = 0;
        break;
      default:
        break;
    }

    this._pending.push(event);
    if (this.s?.miners?.length) {
      this._lastAgents = new Map(this.s.miners.map((m) => [m.owner, { ...m }]));
    }
  }

  _normalizeChainEvent(rawEvent) {
    const event = { ...rawEvent };
    if ('id' in event) event.id = normalizeEventNumber(event.id, event.id);
    if ('x' in event) event.x = normalizeEventNumber(event.x);
    if ('fromX' in event) event.fromX = normalizeEventNumber(event.fromX);

    if ('y' in event) {
      event.rawY = normalizeEventNumber(event.y);
      event.y = this._visualY(event.rawY);
    }
    if ('fromY' in event) {
      event.rawFromY = normalizeEventNumber(event.fromY);
      event.fromY = this._visualY(event.rawFromY);
    }
    if ('block' in event) {
      event.rawBlock = normalizeEventNumber(event.block);
      event.block = renderTile(event.rawBlock);
    }
    if ('newBlock' in event) {
      event.rawNewBlock = normalizeEventNumber(event.newBlock);
      event.newBlock = renderTile(event.rawNewBlock);
    }
    if ('amount' in event) event.amount = normalizeEventNumber(event.amount);
    if ('laddersRemaining' in event) event.laddersRemaining = normalizeEventNumber(event.laddersRemaining);
    if (event.banked) event.banked = normalizeResourceTotals(event.banked);
    if (event.minted) event.minted = normalizeResourceTotals(event.minted);
    return event;
  }

  _visualY(rawY) {
    const rawSurface = this.world?.rawSurface ?? DEFAULT_RAW_SURFACE;
    const surface = this.world?.surface ?? 4;
    const yOffset = this.world?.yOffset ?? Math.max(0, surface - rawSurface);
    return rawToVisualY(rawY, surface, rawSurface, yOffset);
  }

  _minerForEvent(event, opts = {}) {
    const byOwner = event.owner
      ? this.s.miners.find((m) => sameActor(m.owner, event.owner))
      : null;
    const miner = byOwner || this.s.miners.find((m) => m.id === event.id);
    if (miner || !opts.create) return miner || null;

    const index = this.s.miners.length;
    const color = [0x5fd0e6, 0x7cffb0, 0xffdd55, 0xff8fdc, 0xb08cff][index % 5];
    const x = normalizeEventNumber(event.x, 0);
    const y = normalizeEventNumber(event.y, this.world?.surface ?? 4);
    const created = {
      id: Number.isFinite(event.id) ? event.id : index,
      owner: event.owner,
      name: shortId(event.owner),
      tx: x,
      ty: y,
      drawX: x,
      drawY: y,
      facing: 'down',
      alive: true,
      act: null,
      cargo: 0,
      inventory: [],
      banked: 0,
      items: {},
      stats: makeEmptyStats(),
      respawnAtMs: null,
      spawnX: x,
      spawnY: this.world?.surface ?? y,
      hat: index % 3 === 0 ? 'cap' : index % 3 === 1 ? 'visor' : 'antenna',
      color,
      radar: 2,
      maxLadders: 10,
    };
    this.s.miners.push(created);
    return created;
  }

  _placeMiner(miner, x, y, opts = {}) {
    if (!miner) return;
    miner.tx = x;
    miner.ty = y;
    miner.drawX = x;
    miner.drawY = y;
    miner.act = null;
    if ('alive' in opts) miner.alive = opts.alive;
    if (opts.alive) {
      miner.exited = false;
      miner.respawnAtMs = null;
    }
  }

  _moveMiner(miner, event) {
    if (!miner) return;
    const fromX = Number.isFinite(event.fromX) ? event.fromX : miner.tx;
    const fromY = Number.isFinite(event.fromY) ? event.fromY : miner.ty;
    const toX = Number.isFinite(event.x) ? event.x : fromX;
    const toY = Number.isFinite(event.y) ? event.y : fromY;
    if (toX < fromX) miner.facing = 'left';
    else if (toX > fromX) miner.facing = 'right';
    else if (toY < fromY) miner.facing = 'up';
    else if (toY > fromY) miner.facing = 'down';
    miner.tx = toX;
    miner.ty = toY;
    miner.drawX = fromX;
    miner.drawY = fromY;
    miner.alive = true;
    miner.exited = false;
    miner.respawnAtMs = null;
    miner.act = { kind: 'move', fromX, fromY, tx: toX, ty: toY, t: 0, dur: CHAIN_MOVE_MS };
  }

  _setRawTile(x, rawY, rawTile) {
    if (!this.world || !Number.isFinite(x) || !Number.isFinite(rawY) || rawTile == null) return;
    const W = this.world.W;
    const rawH = this.world.rawH ?? this.world.H;
    if (x < 0 || x >= W || rawY < 0 || rawY >= rawH) return;

    if (this.world.rawGrid) this.world.rawGrid[rawY * W + x] = rawTile;

    const y = this._visualY(rawY);
    if (y < 0 || y >= this.world.H) return;
    const i = y * W + x;
    let next = renderTile(rawTile);
    if (y < this.world.surface) next = BLOCK.SKY;
    else if (x === 0 || x === W - 1 || y === this.world.H - 1) next = BLOCK.STONE;
    if (this.world.grid[i] !== next) {
      this.world.grid[i] = next;
      this.worldDirty = true;
    }
  }

  _advanceAnimations(dtMs) {
    for (const m of this.s.miners) {
      const a = m.act;
      if (!a) continue;
      a.t += dtMs;
      const p = Math.min(1, a.t / Math.max(1, a.dur || CHAIN_MOVE_MS));
      if (a.kind === 'move') {
        m.drawX = a.fromX + (a.tx - a.fromX) * p;
        m.drawY = a.fromY + (a.ty - a.fromY) * p;
      }
      if (p >= 1) {
        if (a.kind === 'move') {
          m.drawX = a.tx;
          m.drawY = a.ty;
        }
        m.act = null;
      }
    }
  }

  _applySnapshot(snap, opts = {}) {
    const emitEvents = opts.emitEvents !== false;
    const [W = 40, rawH = 64] = snap.config;
    const rawSurface = DEFAULT_RAW_SURFACE;
    const surface = 4;
    const { grid, H, yOffset } = decorateDiggerGrid(snap.rawGrid, W, rawH, rawSurface, surface);

    if (!this.world) {
      this.world = {
        grid,
        rawGrid: Uint32Array.from(snap.rawGrid),
        W,
        H,
        rawH,
        surface,
        rawSurface,
        yOffset,
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
      this.world.rawH = rawH;
      this.world.surface = surface;
      this.world.rawSurface = rawSurface;
      this.world.yOffset = yOffset;
      this.world.seed = Number(snap.session?.[1] || this.world.seed || 0);
    }

    this.session = snap.session;
    this.config = snap.config;
    const miners = snap.agents.map((row) => this._toMiner(row, surface, rawSurface, yOffset));
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

  _toMiner(row, surface, rawSurface, yOffset) {
    // Current AgentOf layout observed on DiggerWorld:
    //   [status/alive, x, y, facing, ladders, ..., spawnX, ...]
    // The previous integration read [0],[1] as x/y, which mirrored agents into
    // the left wall and made them appear inside solid cells.
    const aliveRaw = Number(row.state[0] ?? 1);
    const x = Number(row.state[1] ?? 0);
    const rawY = Number(row.state[2] ?? rawSurface);
    const facing = Number(row.state[3] ?? 0);
    const y = rawToVisualY(rawY, surface, rawSurface, yOffset);
    const cargo = resourceTotal({
      scrst: row.inventory[0] ?? row.state[5],
      bcrst: row.inventory[1] ?? row.state[6],
      hcrst: row.inventory[2] ?? row.state[7],
    });
    const bankedResources = normalizeResourceTotals({
      scrst: row.inventory[3] ?? row.state[8],
      bcrst: row.inventory[4] ?? row.state[9],
      hcrst: row.inventory[5] ?? row.state[10],
    });
    const color = [0x5fd0e6, 0x7cffb0, 0xffdd55, 0xff8fdc, 0xb08cff][row.index % 5];
    const spawnX = Number(row.state[11] ?? x);
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
      banked: resourceTotal(bankedResources),
      bankedResources,
      items: {},
      stats: makeEmptyStats(),
      respawnAtMs: null,
      spawnX: Number.isFinite(spawnX) ? spawnX : x,
      spawnY: surface,
      hat: row.index % 3 === 0 ? 'cap' : row.index % 3 === 1 ? 'visor' : 'antenna',
      color,
      radar: 2,
      maxLadders: 10,
    };
  }

  async _refresh(opts = {}) {
    this._polling = true;
    try {
      const snap = await this._readSnapshot();
      this._applySnapshot(snap, opts);
    } finally {
      this._polling = false;
    }
  }

  dispose() {
    if (this._unsub) this._unsub();
    this._api?.provider?.disconnect?.();
  }
}
