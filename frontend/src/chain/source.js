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
import { CHAIN, CHAIN_PLAYBACK, chainReady, discoveryBaseUrl } from './config.js';
import { connectWorldProgram, createWorldEventListener } from './worldEventListener.js';
import { skinFromAddress } from '../render/robot.js';

// Pick the data source. Local engine today; the chain source once a World
// contract is deployed and .env is filled (CHAIN.enabled + ids).
export function createWorldSource(opts) {
  if (opts?.archiveId || opts?.mode === 'chain-replay') return new ArchivedSource(opts);
  if (chainReady(opts?.programId)) return new ChainSource(opts);
  return new RealtimeWorld(opts); // ← current behaviour, unchanged
}

const READ_SOURCE = '0x0000000000000000000000000000000000000001';
const DEFAULT_RAW_SURFACE = Number.isFinite(CHAIN.contractSurfaceY) ? CHAIN.contractSurfaceY : 1;
const AGENT_STATUS = {
  ACTIVE: 1,
  SURFACED: 2,
  DEAD: 3,
  EXITED: 4,
};
const CONTRACT_TILE = {
  EMPTY: 0,
  DIRT: 1,
  STONE: 2,
  CHEST: 3,
  LADDER: 4,
  SCRST: 10,
  BCRST: 11,
  HCRST: 12,
  SURFACE: 20,
};
const CHEST_OUTCOME = {
  DYNAMITE: 1,
  LADDERS: 2,
};

// Current live DiggerWorld tile ids differ from the older frontend
// constants. Keep the renderer stable by translating contract cells at the edge.
const CONTRACT_TO_RENDER_TILE = {
  [CONTRACT_TILE.EMPTY]: BLOCK.SKY,   // empty/drilled
  [CONTRACT_TILE.DIRT]: BLOCK.DIRT,
  [CONTRACT_TILE.STONE]: BLOCK.STONE,
  [CONTRACT_TILE.CHEST]: BLOCK.CHEST,
  [CONTRACT_TILE.LADDER]: BLOCK.LADDER,
  [CONTRACT_TILE.SCRST]: BLOCK.SCRST,
  [CONTRACT_TILE.BCRST]: BLOCK.BCRST,
  [CONTRACT_TILE.HCRST]: BLOCK.HCRST,
  [CONTRACT_TILE.SURFACE]: BLOCK.SKY,  // sky/surface cap in the live map
};

function renderTile(contractTile) {
  return CONTRACT_TO_RENDER_TILE[Number(contractTile)] ?? BLOCK.DIRT;
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

function facingToTarget(fromX, fromY, targetX, targetY, fallback = 'down') {
  if (targetX < fromX) return 'left';
  if (targetX > fromX) return 'right';
  if (targetY < fromY) return 'up';
  if (targetY > fromY) return 'down';
  return fallback;
}

function normalizeResourceTotals(value = {}) {
  return {
    scrst: normalizeEventNumber(value.scrst),
    bcrst: normalizeEventNumber(value.bcrst),
    hcrst: normalizeEventNumber(value.hcrst),
  };
}

function nowMs() {
  return globalThis.performance?.now?.() || Date.now();
}

function playbackGroupKey(event) {
  return event.messageId
    || event.txHash
    || event.id
    || `${event.source || 'event'}:${event.timestamp || ''}:${event.type || ''}`;
}

function playbackEventPriority(event) {
  switch (event?.type) {
    case 'dug': return 10;
    case 'resource_extracted': return 20;
    case 'chest_opened': return 20;
    case 'ladder_placed': return 10;
    case 'surfaced': return 20;
    case 'stone_moved': return 25;
    case 'moved': return 30;
    case 'death':
    case 'exited': return 40;
    default: return 50;
  }
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

  // Render the contract tiles as-is. The spectator draws its decorative stone
  // frame outside the contract grid, so it never hides live dug cells.
  return { grid, H, yOffset };
}

function chestTierForVisualY(y, surface, H) {
  const depth = Math.max(0, y - surface);
  const playable = Math.max(1, H - surface);
  const ratio = depth / playable;
  if (ratio < 0.35) return 'shallow';
  if (ratio < 0.69) return 'mid';
  return 'deep';
}

function buildDiggerChests(rawGrid, W, rawH, rawSurface, surface, yOffset, H) {
  const chests = [];
  const chestsAt = new Map();
  for (let rawY = rawSurface; rawY < rawH; rawY += 1) {
    const y = rawY + yOffset;
    for (let x = 0; x < W; x += 1) {
      if (Number(rawGrid[rawY * W + x]) !== CONTRACT_TILE.CHEST) continue;
      const chest = {
        id: chests.length,
        x,
        y,
        tier: chestTierForVisualY(y, surface, H),
        opened: false,
      };
      chests.push(chest);
      chestsAt.set(y * W + x, chest);
    }
  }
  return { chests, chestsAt };
}

function shortId(id) {
  if (!id) return 'agent';
  const text = String(id);
  const display = /^0x0{24}[0-9a-fA-F]{40}$/.test(text)
    ? `0x${text.slice(-40)}`
    : text;
  return `${display.slice(0, 6)}...${display.slice(-4)}`;
}

function makeEmptyStats() {
  return { tilesDug: 0, ore: 0, sold: 0, spent: 0, deaths: 0 };
}

function snapshotMiner(row, surface, rawSurface, yOffset, config = [], previous = null) {
  const status = Number(row.state?.[0] ?? AGENT_STATUS.ACTIVE);
  const x = Number(row.state?.[1] ?? 0);
  const rawY = Number(row.state?.[2] ?? rawSurface);
  const hp = Number(row.state?.[3] ?? config[6] ?? 1);
  const laddersRemaining = Number(row.state?.[4] ?? config[7] ?? 0);
  const backpackCapacity = Number(row.state?.[11] ?? config[8] ?? 0);
  const y = rawToVisualY(rawY, surface, rawSurface, yOffset);
  const inventory = Array.isArray(row.inventory) ? row.inventory : [];
  const dead = status === AGENT_STATUS.DEAD;
  const exited = status === AGENT_STATUS.EXITED;
  const cargo = resourceTotal({
    scrst: inventory[0] ?? row.state?.[5],
    bcrst: inventory[1] ?? row.state?.[6],
    hcrst: inventory[2] ?? row.state?.[7],
  });
  const bankedResources = normalizeResourceTotals({
    scrst: inventory[3] ?? row.state?.[8],
    bcrst: inventory[4] ?? row.state?.[9],
    hcrst: inventory[5] ?? row.state?.[10],
  });
  const skin = skinFromAddress(row.owner);
  return {
    id: row.index,
    owner: row.owner,
    name: shortId(row.owner),
    tx: x,
    ty: y,
    drawX: x,
    drawY: y,
    facing: previous?.facing || 'down',
    status,
    alive: status === AGENT_STATUS.ACTIVE || status === AGENT_STATUS.SURFACED,
    act: null,
    hp,
    cargo,
    maxCargo: backpackCapacity,
    backpackCapacity,
    inventory,
    banked: resourceTotal(bankedResources),
    bankedResources,
    items: { ladder: laddersRemaining },
    stats: makeEmptyStats(),
    respawnAtMs: dead ? Number.POSITIVE_INFINITY : null,
    spawnX: x,
    spawnY: surface,
    hat: skin.hat,
    color: skin.bodyColor,
    radar: 2,
    maxLadders: Number(config[7] ?? laddersRemaining),
    exited,
  };
}

export class ArchivedSource {
  constructor(opts = {}) {
    this.opts = opts;
    this.archiveId = opts.archiveId;
    this.archiveUrl = opts.archiveUrl || '';
    this.world = null;
    this.s = { miners: [] };
    this.stones = [];
    this.bombs = [];
    this.events = [];
    this.timeMs = 0;
    this.worldDirty = true;
    this.finished = true;
    this.teamScore = 0;
    this.match = { shopX: 0, diamondFound: false, finishedReason: 'archived' };
    this.ready = this.load();
  }

  setAgents() {}
  observe() { return null; }
  update(dtMs = 0) {
    this.timeMs += dtMs;
    this.events = [];
    this.worldDirty = false;
  }

  async load() {
    const archive = await this._fetchArchive();
    const snap = archive.snapshot || archive;
    const [W = 60, rawH = 40] = snap.config || [];
    const rawSurface = DEFAULT_RAW_SURFACE;
    const surface = 4;
    const { grid, H, yOffset } = decorateDiggerGrid(snap.rawGrid || [], W, rawH, rawSurface, surface);
    const { chests, chestsAt } = buildDiggerChests(snap.rawGrid || [], W, rawH, rawSurface, surface, yOffset, H);
    this.archive = archive;
    this.world = {
      grid,
      rawGrid: Uint32Array.from(snap.rawGrid || []),
      W,
      H,
      rawH,
      surface,
      rawSurface,
      yOffset,
      model: 'digger',
      seed: Number(snap.session?.[1] || archive.seed || 0),
      crystals: [],
      pockets: [],
      diamondPos: null,
      pois: [],
      chests,
      chestsAt,
      signals: null,
      validation: { ok: true, warnings: [] },
    };
    this.session = snap.session || [];
    this.config = snap.config || [W, rawH];
    this.s.miners = (snap.agents || []).map((row) => snapshotMiner(row, surface, rawSurface, yOffset, snap.config || []));
    this.match.shopX = this.s.miners[0]?.spawnX ?? Math.floor(W / 2);
    this.teamScore = this.s.miners.reduce((sum, m) => sum + (m.banked || 0), 0);
    return this;
  }

  async _fetchArchive() {
    const base = discoveryBaseUrl();
    if (this.archiveUrl) {
      const url = this.archiveUrl.startsWith('/') && base
        ? `${base}${this.archiveUrl}`
        : this.archiveUrl;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`archive fetch failed: ${response.status}`);
      return response.json();
    }
    if (!this.archiveId) throw new Error('archive id is required');
    if (!base) throw new Error('VITE_MATCHES_URL or VITE_BACKEND_URL is required to load archived worlds');
    const response = await fetch(`${base}/archives/${encodeURIComponent(this.archiveId)}`);
    if (!response.ok) throw new Error(`archive fetch failed: ${response.status}`);
    return response.json();
  }

  dispose() {}
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
    this._eventListener = null;
    this._polling = false;
    this._playbackGroups = [];
    this._playbackOpenGroups = new Map();
    this._snapshotReloadReason = null;
    this._snapshotReloadPromise = null;
    this._lastGrid = null;
    this._lastAgents = new Map();
    this.ready = this._boot();
  }

  setAgents() { /* chain: real agents drive their own diggers via injected tx */ }
  observe() { return null; } // read-only spectator

  syncSessionMeta(meta = {}) {
    const currentSessionId = Number(this.session?.[0] || 0);
    const nextSessionId = Number(meta.sessionId || 0);
    if (currentSessionId && nextSessionId && currentSessionId !== nextSessionId) {
      this._requestSnapshotReload(`discovery session ${nextSessionId}`);
      return;
    }

    const currentSeed = Number(this.session?.[1] || 0);
    const nextSeed = Number(meta.seed || 0);
    if (currentSeed && nextSeed && currentSeed !== nextSeed) {
      this._requestSnapshotReload(`discovery seed ${nextSeed}`);
    }
  }

  async _boot() {
    await this.connect();
    await this.load();
    await this.subscribe();
    return this;
  }

  // 1) Connect @vara-eth/api (Router + Ethereum RPC + Vara.eth WS). Read-only.
  async connect() {
    const connection = await connectWorldProgram({
      programId: this.programId,
      idlUrl: new URL('./world.idl', import.meta.url),
      config: CHAIN,
    });
    this._api = connection.api;
    this._program = connection.program;
    this._q = connection.queries;
    this._act = connection.actions;
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

  // 3) Live event path. After the initial snapshot, animation is event-only:
  // decoded World events are queued and played back in order. Snapshots are not
  // used to invent movement because a final state cannot preserve action timing.
  async subscribe() {
    this._eventListener = createWorldEventListener({
      api: this._api,
      program: this._program,
      programId: this.programId,
      config: CHAIN,
      onEvent: (event) => this._queuePlaybackEvent(event),
      onError: (error) => {
        this._pending.push({ type: 'chain_error', message: error?.message || String(error) });
      },
    });
    await this._eventListener.start();
  }

  _queuePlaybackEvent(event) {
    const currentSessionId = Number(this.session?.[0] || 0);
    const eventSessionId = Number(event?.sessionId || 0);
    if (event?.type === 'map_generated' || (eventSessionId && currentSessionId && eventSessionId !== currentSessionId)) {
      this._requestSnapshotReload(event?.type === 'map_generated' ? 'map generated' : `session ${eventSessionId}`);
      if (event?.type === 'map_generated') this._pending.push(event);
      return;
    }

    const key = playbackGroupKey(event);
    const ts = nowMs();
    let group = this._playbackOpenGroups.get(key);
    if (!group) {
      group = { key, events: [], firstAt: ts, lastAt: ts };
      this._playbackOpenGroups.set(key, group);
      this._playbackGroups.push(group);
    }
    group.events.push(event);
    group.lastAt = ts;
  }

  _drainPlaybackQueue() {
    if (!this._playbackGroups.length) return;
    const ts = nowMs();
    let released = 0;
    let index = 0;
    while (index < this._playbackGroups.length && released < CHAIN_PLAYBACK.maxGroupsPerFrame) {
      const group = this._playbackGroups[index];
      if (ts - group.lastAt < CHAIN_PLAYBACK.eventGroupGraceMs) break;
      if (!this._canReleasePlaybackGroup(group)) {
        index += 1;
        continue;
      }
      this._playbackGroups.splice(index, 1);
      this._playbackOpenGroups.delete(group.key);
      const events = group.events
        .slice()
        .sort((a, b) =>
          playbackEventPriority(a) - playbackEventPriority(b)
          || normalizeEventNumber(a.logIndex, 0) - normalizeEventNumber(b.logIndex, 0));
      for (const event of events) this._applyChainEvent(event);
      released += 1;
    }
  }

  _canReleasePlaybackGroup(group) {
    const owner = group.events.find((event) => event.owner)?.owner;
    if (!owner) return true;
    const miner = this.s.miners.find((m) => sameActor(m.owner, owner));
    if (!miner) return true;
    const visualBacklog = (miner.act ? 1 : 0) + (miner.actQueue?.length || 0);
    return visualBacklog < CHAIN_PLAYBACK.maxVisualQueue;
  }

  // 4) Per frame: drain buffered events, apply them to the grid + miners, and
  //    expose them as .events (the renderer + TX console read this verbatim).
  update(dtMs = 0) {
    this.timeMs += dtMs;
    this._startSnapshotReloadIfNeeded();
    this._drainPlaybackQueue();
    this._advanceAnimations(dtMs);

    this._eventListener?.tick(dtMs);
    this.events = this._pending.splice(0);
    if (this.events.some((e) => ['dug', 'resource_extracted', 'chest_opened', 'ladder_placed', 'stone_moved', 'stone_impact', 'death', 'map_generated'].includes(e.type))) {
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

  async inspectAgent(owner) {
    if (!owner || !this._program || !this._q) return null;
    const Wq = this._program.services.World.queries;
    const [stateResult, inventoryResult, ownerResult] = await Promise.allSettled([
      this._call(this._q.agentOf(owner)),
      this._call(this._q.inventoryOf(owner)),
      this._call(this._q.ownerOf(owner)),
    ]);
    const detail = { owner };
    if (stateResult.status === 'fulfilled') {
      detail.state = Wq.AgentOf.decodeResult(stateResult.value).map((v) => Number(v));
    }
    if (inventoryResult.status === 'fulfilled') {
      detail.inventory = Wq.InventoryOf.decodeResult(inventoryResult.value).map(Number);
    }
    if (ownerResult.status === 'fulfilled') {
      detail.walletOwner = String(Wq.OwnerOf.decodeResult(ownerResult.value));
    }
    return detail;
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
        this._placeMiner(miner, event.x, event.y, { alive: true, status: AGENT_STATUS.ACTIVE });
        miner.spawnX = event.x;
        miner.spawnY = this.world?.surface ?? event.y;
        break;
      case 'moved':
        this._enqueueMoveEvent(miner, event);
        return;
      case 'dug':
        if (miner) {
          this._enqueueAct(miner, {
            kind: 'dig',
            tx: event.x,
            ty: event.y,
            rawY: event.rawY,
            rawNewBlock: event.rawNewBlock ?? 0,
            blockType: event.block,
            event,
          });
          return;
        }
        this._setRawTile(event.x, event.rawY, event.rawNewBlock ?? 0);
        break;
      case 'resource_extracted':
        if (miner) {
          this._enqueueAct(miner, { kind: 'resource', event });
          return;
        }
        break;
      case 'chest_opened':
        if (miner) {
          this._enqueueAct(miner, { kind: 'chest', event });
          return;
        }
        this._applyChestOpened(event, null);
        break;
      case 'ladder_placed':
        if (miner) {
          this._enqueueAct(miner, { kind: 'ladder', event });
          return;
        }
        this._setRawTile(event.x, event.rawY, 4);
        break;
      case 'surfaced':
        if (miner) {
          this._enqueueAct(miner, { kind: 'surface', event });
          return;
        }
        break;
      case 'resources_minted':
        if (miner) {
          miner.mintedResources = normalizeResourceTotals(event.minted);
        }
        break;
      case 'resources_traded_for_ladders':
        if (miner) {
          if (Number.isFinite(event.laddersRemaining)) miner.items.ladder = event.laddersRemaining;
          if (event.spent) {
            const spent = normalizeResourceTotals(event.spent);
            miner.bankedResources = normalizeResourceTotals({
              scrst: Math.max(0, Number(miner.bankedResources?.scrst || 0) - spent.scrst),
              bcrst: Math.max(0, Number(miner.bankedResources?.bcrst || 0) - spent.bcrst),
              hcrst: Math.max(0, Number(miner.bankedResources?.hcrst || 0) - spent.hcrst),
            });
            miner.banked = resourceTotal(miner.bankedResources);
          }
        }
        break;
      case 'stone_moved':
        this._moveRawStone(event);
        break;
      case 'death':
        if (miner) {
          this._enqueueAct(miner, { kind: 'death', event });
          return;
        }
        break;
      case 'exited':
        if (miner) {
          miner.alive = false;
          miner.status = AGENT_STATUS.EXITED;
          miner.exited = true;
          miner.act = null;
          miner.actQueue = [];
          miner.respawnAtMs = null;
        }
        break;
      case 'session_finished':
        this.finished = true;
        break;
      case 'map_generated':
        this._requestSnapshotReload('map generated');
        return;
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
    if ('outcome' in event) event.outcome = normalizeEventNumber(event.outcome);
    if ('cause' in event) {
      event.rawCause = normalizeEventNumber(event.cause);
      event.cause = renderTile(event.rawCause);
    }
    if ('laddersRemaining' in event) event.laddersRemaining = normalizeEventNumber(event.laddersRemaining);
    if ('laddersAdded' in event) event.laddersAdded = normalizeEventNumber(event.laddersAdded);
    if (event.banked) event.banked = normalizeResourceTotals(event.banked);
    if (event.minted) event.minted = normalizeResourceTotals(event.minted);
    if (event.spent) event.spent = normalizeResourceTotals(event.spent);
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
    const skin = skinFromAddress(event.owner);
    const x = normalizeEventNumber(event.x, 0);
    const y = normalizeEventNumber(event.y, this.world?.surface ?? 4);
    const startingHp = Number(this.config?.[6] ?? 1);
    const startingLadders = Number(this.config?.[7] ?? 0);
    const backpackCapacity = Number(this.config?.[8] ?? 0);
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
      status: AGENT_STATUS.ACTIVE,
      act: null,
      hp: startingHp,
      cargo: 0,
      maxCargo: backpackCapacity,
      backpackCapacity,
      inventory: [],
      banked: 0,
      items: { ladder: startingLadders },
      stats: makeEmptyStats(),
      respawnAtMs: null,
      spawnX: x,
      spawnY: this.world?.surface ?? y,
      hat: skin.hat,
      color: skin.bodyColor,
      radar: 2,
      maxLadders: startingLadders,
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
    miner.actQueue = [];
    if ('alive' in opts) miner.alive = opts.alive;
    if ('status' in opts) miner.status = opts.status;
    if (opts.alive) {
      miner.exited = false;
      miner.respawnAtMs = null;
    }
  }

  _enqueueAct(miner, act) {
    if (!miner) return;
    if (!miner.actQueue) miner.actQueue = [];
    miner.actQueue.push(act);
  }

  _enqueueMoveEvent(miner, event) {
    if (!miner) return;
    const fromX = Number.isFinite(event.fromX) ? event.fromX : miner.tx;
    const fromY = Number.isFinite(event.fromY) ? event.fromY : miner.ty;
    const toX = Number.isFinite(event.x) ? event.x : fromX;
    const toY = Number.isFinite(event.y) ? event.y : fromY;

    if (fromX !== toX && fromY !== toY) {
      this._enqueueAct(miner, {
        kind: 'move',
        fromX,
        fromY,
        tx: toX,
        ty: fromY,
        event,
      });
      this._enqueueAct(miner, {
        kind: 'move',
        fromX: toX,
        fromY,
        tx: toX,
        ty: toY,
        preserveFacing: true,
      });
      return;
    }

    this._enqueueAct(miner, {
      kind: 'move',
      fromX,
      fromY,
      tx: toX,
      ty: toY,
      event,
    });
  }

  _emitVisualEvent(event) {
    if (!event) return;
    this._pending.push(event);
    if (this.s?.miners?.length) {
      this._lastAgents = new Map(this.s.miners.map((m) => [m.owner, { ...m }]));
    }
  }

  _startNextAct(miner) {
    if (!miner) return;
    while (!miner.act && miner.actQueue && miner.actQueue.length) {
      const started = this._startAct(miner, miner.actQueue.shift());
      if (started) break;
    }
  }

  _startAct(miner, act) {
    if (!miner || !act) return false;
    if (act.kind === 'move') {
      const fromX = Number.isFinite(act.fromX) ? act.fromX : miner.tx;
      const fromY = Number.isFinite(act.fromY) ? act.fromY : miner.ty;
      const toX = Number.isFinite(act.tx) ? act.tx : fromX;
      const toY = Number.isFinite(act.ty) ? act.ty : fromY;
      if (!act.preserveFacing) miner.facing = facingToTarget(fromX, fromY, toX, toY, miner.facing);
      miner.tx = toX;
      miner.ty = toY;
      miner.drawX = fromX;
      miner.drawY = fromY;
      miner.alive = true;
      miner.status = AGENT_STATUS.ACTIVE;
      miner.exited = false;
      miner.respawnAtMs = null;
      miner.act = { ...act, kind: 'move', fromX, fromY, tx: toX, ty: toY, t: 0, dur: CHAIN_PLAYBACK.moveMs };
      if (act.event) this._emitVisualEvent(act.event);
      return true;
    } else if (act.kind === 'dig') {
      miner.facing = facingToTarget(miner.tx, miner.ty, act.tx, act.ty, miner.facing);
      miner.act = { ...act, kind: 'dig', t: 0, dur: CHAIN_PLAYBACK.digMs };
      return true;
    } else if (act.kind === 'chest') {
      this._applyChestOpened(act.event, miner);
      this._emitVisualEvent(act.event);
      if (act.event?.outcome === CHEST_OUTCOME.DYNAMITE) {
        const bombId = `${act.event.id || act.event.messageId || 'chest'}:${act.event.x}:${act.event.y}`;
        this.bombs = (this.bombs || []).filter((bomb) => bomb.id !== bombId);
        this.bombs.push({
          id: bombId,
          x: act.event.x,
          y: act.event.y,
          radius: 0,
          fuseAt: this.timeMs + CHAIN_PLAYBACK.chestFuseMs,
        });
        miner.act = { ...act, kind: 'chest', t: 0, dur: CHAIN_PLAYBACK.chestFuseMs, bombId };
        return true;
      }
      return false;
    }
    this._commitQueuedAct(miner, act);
    return false;
  }

  _finishAct(miner, act) {
    if (!miner || !act) return;
    if (act.kind === 'move') {
      miner.drawX = act.tx;
      miner.drawY = act.ty;
      return;
    }
    if (act.kind === 'dig') {
      this._setRawTile(act.tx, act.rawY, act.rawNewBlock ?? 0);
      miner.stats.tilesDug += 1;
      this._emitVisualEvent(act.event);
      return;
    }
    if (act.kind === 'chest') {
      this.bombs = (this.bombs || []).filter((bomb) => bomb.id !== act.bombId);
      this._emitVisualEvent({
        type: 'detonation',
        owner: act.event?.owner,
        sessionId: act.event?.sessionId,
        x: act.event?.x,
        y: act.event?.y,
        radius: 0,
        source: act.event?.source,
        messageId: act.event?.messageId,
      });
    }
  }

  _commitQueuedAct(miner, act) {
    if (!miner || !act) return;
    const event = act.event;
    if (act.kind === 'resource') {
      const carriedTotal = event?.sessionId != null ? normalizeEventNumber(event?.amount, miner.cargo) : null;
      const amount = carriedTotal == null
        ? normalizeEventNumber(event?.amount, 1)
        : Math.max(0, carriedTotal - miner.cargo);
      if (carriedTotal != null) event.carriedTotal = carriedTotal;
      event.amount = amount;
      miner.cargo += amount;
      miner.stats.ore += amount;
      this._emitVisualEvent(event);
      return;
    }
    if (act.kind === 'ladder') {
      this._setRawTile(event.x, event.rawY, 4);
      if (Number.isFinite(event.laddersRemaining)) {
        miner.items.ladder = event.laddersRemaining;
      }
      this._emitVisualEvent(event);
      return;
    }
    if (act.kind === 'surface') {
      const banked = normalizeResourceTotals(event.banked);
      const previous = normalizeResourceTotals(miner.bankedResources);
      const deltaBanked = {
        scrst: Math.max(0, banked.scrst - previous.scrst),
        bcrst: Math.max(0, banked.bcrst - previous.bcrst),
        hcrst: Math.max(0, banked.hcrst - previous.hcrst),
      };
      const amount = banked.scrst + banked.bcrst + banked.hcrst;
      event.deltaBanked = deltaBanked;
      event.amount = deltaBanked.scrst + deltaBanked.bcrst + deltaBanked.hcrst;
      miner.banked = amount;
      miner.bankedResources = banked;
      miner.cargo = 0;
      miner.status = AGENT_STATUS.SURFACED;
      miner.stats.sold = amount;
      this.teamScore = this.s.miners.reduce((sum, m) => sum + (m.banked || 0), 0);
      this._emitVisualEvent(event);
      return;
    }
    if (act.kind === 'death') {
      this._placeMiner(miner, event.x, event.y, { alive: false, status: AGENT_STATUS.DEAD });
      miner.stats.deaths += 1;
      miner.respawnAtMs = this.timeMs + 1400;
      this._emitVisualEvent(event);
    }
  }

  _applyChestOpened(event, miner) {
    if (!event) return;
    this._setRawTile(event.x, event.rawY, CONTRACT_TILE.EMPTY);
    if (miner && Number.isFinite(event.laddersRemaining)) {
      miner.items.ladder = event.laddersRemaining;
    }
  }

  _setRawTile(x, rawY, rawTile, opts = {}) {
    if (!this.world || !Number.isFinite(x) || !Number.isFinite(rawY) || rawTile == null) return;
    const updateRaw = opts.raw !== false;
    const updateVisual = opts.visual !== false;
    const W = this.world.W;
    const rawH = this.world.rawH ?? this.world.H;
    if (x < 0 || x >= W || rawY < 0 || rawY >= rawH) return;

    if (updateRaw && this.world.rawGrid) this.world.rawGrid[rawY * W + x] = rawTile;
    if (!updateVisual) return;

    const y = this._visualY(rawY);
    this._setVisualTile(x, y, rawTile);
  }

  _setVisualTile(x, y, rawTile) {
    if (!this.world || !Number.isFinite(x) || !Number.isFinite(y) || rawTile == null) return;
    const W = this.world.W;
    if (y < 0 || y >= this.world.H) return;
    const i = y * W + x;
    let next = renderTile(rawTile);
    if (y < this.world.surface) next = BLOCK.SKY;
    if (this.world.grid[i] !== next) {
      this.world.grid[i] = next;
      this.worldDirty = true;
    }
    this._syncChestTile(x, y, rawTile, next);
  }

  _syncChestTile(x, y, rawTile, renderTileValue) {
    if (!this.world || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const key = y * this.world.W + x;
    const isChest = Number(rawTile) === CONTRACT_TILE.CHEST && renderTileValue === BLOCK.CHEST && y >= this.world.surface;
    const existing = this.world.chestsAt?.get(key);
    if (isChest) {
      if (existing) return;
      const chest = {
        id: this.world.chests?.length || 0,
        x,
        y,
        tier: chestTierForVisualY(y, this.world.surface, this.world.H),
        opened: false,
      };
      this.world.chests ||= [];
      this.world.chestsAt ||= new Map();
      this.world.chests.push(chest);
      this.world.chestsAt.set(key, chest);
      return;
    }
    if (!existing) return;
    existing.opened = true;
    this.world.chestsAt.delete(key);
    this.world.chests = (this.world.chests || []).filter((chest) => !(chest.x === x && chest.y === y));
  }

  _moveRawStone(event) {
    if (!this.world) return;
    const fromX = normalizeEventNumber(event.fromX, NaN);
    const fromY = normalizeEventNumber(event.rawFromY, NaN);
    const toX = normalizeEventNumber(event.x, NaN);
    const toY = normalizeEventNumber(event.rawY, NaN);
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) return;
    if (fromX !== toX) {
      this._setRawTile(fromX, fromY, 0);
      this._setRawTile(toX, toY, 2);
      return;
    }

    // The contract settles gravity instantly and emits only the confirmed
    // from/to. Keep raw state final, but animate the visual grid so spectators
    // still read the classic "wobble, then drop" rock behavior.
    this._setRawTile(fromX, fromY, 0, { visual: false });
    this._setRawTile(toX, toY, 2, { visual: false });
    this._setVisualTile(fromX, this._visualY(fromY), 2);
    this._setVisualTile(toX, this._visualY(toY), 0);

    this.stones = this.stones.filter((stone) => !(stone.x === fromX && stone.rawFromY === fromY));
    this.stones.push({
      x: fromX,
      rawFromY: fromY,
      rawToY: toY,
      y: this._visualY(fromY),
      toY: this._visualY(toY),
      phase: 'shake',
      elapsed: 0,
      stepElapsed: 0,
    });
    this.worldDirty = true;
  }

  _advanceAnimations(dtMs) {
    this._advanceStoneAnimations(dtMs);
    for (const m of this.s.miners) {
      if (!m.act && m.actQueue && m.actQueue.length) this._startNextAct(m);
      const a = m.act;
      if (!a) continue;
      a.t += dtMs;
      const p = Math.min(1, a.t / Math.max(1, a.dur || CHAIN_PLAYBACK.moveMs));
      if (a.kind === 'move') {
        m.drawX = a.fromX + (a.tx - a.fromX) * p;
        m.drawY = a.fromY + (a.ty - a.fromY) * p;
      }
      if (p >= 1) {
        this._finishAct(m, a);
        m.act = null;
        if (m.actQueue && m.actQueue.length) this._startNextAct(m);
      }
    }
  }

  _advanceStoneAnimations(dtMs) {
    if (!this.stones?.length) return;
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const stone = this.stones[i];
      stone.elapsed += dtMs;
      if (stone.phase === 'shake') {
        if (stone.elapsed >= CHAIN_PLAYBACK.stoneShakeMs) {
          stone.phase = 'fall';
          stone.stepElapsed = CHAIN_PLAYBACK.stoneStepMs;
        } else {
          this.worldDirty = true;
          continue;
        }
      }

      stone.stepElapsed += dtMs;
      while (stone.phase === 'fall' && stone.stepElapsed >= CHAIN_PLAYBACK.stoneStepMs) {
        stone.stepElapsed -= CHAIN_PLAYBACK.stoneStepMs;
        if (stone.y >= stone.toY) {
          this._setVisualTile(stone.x, stone.toY, 2);
          this._emitVisualEvent({ type: 'stone_impact', x: stone.x, y: stone.toY });
          this.stones.splice(i, 1);
          this.worldDirty = true;
          break;
        }
        this._setVisualTile(stone.x, stone.y, 0);
        stone.y += 1;
        this._setVisualTile(stone.x, stone.y, 2);
        this.worldDirty = true;
      }
    }
  }

  _requestSnapshotReload(reason) {
    this._snapshotReloadReason ||= reason || 'snapshot changed';
  }

  _startSnapshotReloadIfNeeded() {
    if (!this._snapshotReloadReason || this._snapshotReloadPromise || this._polling) return;
    const reason = this._snapshotReloadReason;
    this._snapshotReloadReason = null;
    this._snapshotReloadPromise = this._refresh({ resetPlayback: true, resetWorld: true })
      .then(() => {
        this._pending.push({ type: 'map_reloaded', message: `reloaded after ${reason}` });
      })
      .catch((error) => {
        this._pending.push({ type: 'chain_error', message: `snapshot reload failed: ${error?.message || error}` });
      })
      .finally(() => {
        this._snapshotReloadPromise = null;
      });
  }

  _clearPlaybackState() {
    this._playbackGroups = [];
    this._playbackOpenGroups.clear();
    this._pending = [];
    this.stones = [];
    this.bombs = [];
    for (const miner of this.s?.miners || []) {
      miner.act = null;
      miner.actQueue = [];
    }
  }

  _applySnapshot(snap, opts = {}) {
    const emitEvents = opts.emitEvents !== false;
    const [W = 40, rawH = 64] = snap.config;
    const rawSurface = DEFAULT_RAW_SURFACE;
    const surface = 4;
    const { grid, H, yOffset } = decorateDiggerGrid(snap.rawGrid, W, rawH, rawSurface, surface);
    const { chests, chestsAt } = buildDiggerChests(snap.rawGrid, W, rawH, rawSurface, surface, yOffset, H);
    const prevSessionId = Number(this.session?.[0] || 0);
    const nextSessionId = Number(snap.session?.[0] || 0);
    const sessionChanged = Boolean(prevSessionId && nextSessionId && prevSessionId !== nextSessionId);
    const rebuildWorld = !this.world || opts.resetWorld || sessionChanged;

    if (rebuildWorld) {
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
        chests,
        chestsAt,
        signals: null,
        validation: { ok: true, warnings: [] },
      };
      this.worldDirty = true;
    } else {
      let gridChanged = this.world.grid.length !== grid.length;
      if (!gridChanged) {
        for (let i = 0; i < grid.length; i += 1) {
          if (this.world.grid[i] !== grid[i]) {
            gridChanged = true;
            break;
          }
        }
      }
      this._emitGridDiffs(this.world.grid, grid, W, emitEvents);
      this.world.grid = grid;
      if (gridChanged) this.worldDirty = true;
      this.world.rawGrid = Uint32Array.from(snap.rawGrid);
      this.world.W = W;
      this.world.H = H;
      this.world.rawH = rawH;
      this.world.surface = surface;
      this.world.rawSurface = rawSurface;
      this.world.yOffset = yOffset;
      this.world.seed = Number(snap.session?.[1] || this.world.seed || 0);
      this.world.chests = chests;
      this.world.chestsAt = chestsAt;
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
    // Contract AgentOf layout:
    //   [status, x, y, hp, ladders_remaining, inv_scrst, inv_bcrst, inv_hcrst,
    //    banked_scrst, banked_bcrst, banked_hcrst, backpack_capacity, action_seq]
    const previous = this._lastAgents?.get(row.owner) || this.s?.miners?.find((m) => sameActor(m.owner, row.owner));
    return snapshotMiner(row, surface, rawSurface, yOffset, this.config || [], previous);
  }

  async _refresh(opts = {}) {
    this._polling = true;
    try {
      if (opts.resetPlayback) this._clearPlaybackState();
      const snap = await this._readSnapshot();
      this._applySnapshot(snap, { ...opts, emitEvents: false });
    } finally {
      this._polling = false;
    }
  }

  dispose() {
    this._eventListener?.stop?.();
    this._api?.provider?.disconnect?.();
  }
}
