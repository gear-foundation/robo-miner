// Typed binding for the DiggerWorld Vara.eth program — generated FROM world.idl
// (the contract is the source of truth). This is the single place that maps the
// contract's exact functions / queries / events to what the frontend drives and
// renders. Payloads are encoded/decoded through a sails-js SailsProgram parsed
// from world.idl — NEVER hand-encoded (per vara-eth-skills ts-api playbook).
//
// Program: DiggerWorld   ctor Create()
//   service World@0xc63310d77006e90d  — the spatial game
//   service Admin@0x5acb75662050b164  — session/map lifecycle
//
// NOTE — this World program is LEAN: the only agent actions are register / move /
// drill / place_ladder / surface / exit / mint_resources / trade_resources.
// There is NO upgrade / buy / refuel / pillar / player dynamite / teleport here
// — redeem lives in separate contracts.

// ── Direction (u32) ──────────────────────────────────────────────────────────
// CONFIRM the exact u32 encoding with the contract team — this is our assumed
// clockwise mapping. Everything routes through DIR so a fix is one line.
export const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
export const DIR_FROM_NAME = { up: DIR.UP, right: DIR.RIGHT, down: DIR.DOWN, left: DIR.LEFT };
export const DIR_TO_NAME = ['up', 'right', 'down', 'left'];
export const CHEST_OUTCOME = { DYNAMITE: 1, LADDERS: 2 };

// ── Render tile bytes ────────────────────────────────────────────────────────
// The live DiggerWorld testnet contract currently returns its own compact tile
// ids (see chain/source.js CONTRACT_TO_RENDER_TILE). The renderer consumes the
// frontend BLOCK ids below, so every chain snapshot is translated at the edge.
export { BLOCK as TILE } from '../config.js';

// ── WRITE actions (World service) ────────────────────────────────────────────
// Agents send these as injected txs. `program` is a sails-js SailsProgram with
// the program id set; each returns the encoded payload to hand to the tx layer.
export function worldActions(program) {
  const f = program.services.World.functions;
  return {
    register:    (owner) => f.Register.encodePayload(owner),
    move:        (dirName) => f.MoveAgent.encodePayload(DIR_FROM_NAME[dirName]),
    drill:       (dirName) => f.Drill.encodePayload(DIR_FROM_NAME[dirName]),
    placeLadder: (dirName) => f.PlaceLadder.encodePayload(DIR_FROM_NAME[dirName]),
    surface:     () => f.Surface.encodePayload(),   // go up to bank
    exit:        () => f.Exit.encodePayload(),       // leave the map
    mintResources: () => f.MintResources.encodePayload(),
    tradeResourcesForLadders: (scrst, bcrst, hcrst) => f.TradeResourcesForLadders.encodePayload(scrst, bcrst, hcrst),
  };
}

// ── READ queries (World service) — via api.call.program.calculateReplyForHandle ─
export function worldQueries(program) {
  const q = program.services.World.queries;
  return {
    mapSnapshot: () => q.MapSnapshot.encodePayload(),        // -> [u32] full grid (decode → world.grid bytes)
    tileAt:      (x, y) => q.TileAt.encodePayload(x, y),     // -> u32 single tile
    agentOf:     (owner) => q.AgentOf.encodePayload(owner),  // -> [u128] one agent's packed state
    ownerOf:     (proxy) => q.OwnerOf.encodePayload(proxy),   // -> ActorId wallet owner for proxy
    agents:      () => q.Agents.encodePayload(),             // -> [ActorId] all agent ids
    inventoryOf: (owner) => q.InventoryOf.encodePayload(owner), // -> [u32] inventory counts
    isDug:       (x, y) => q.IsDug.encodePayload(x, y),       // -> bool
    config:      () => q.Config.encodePayload(),             // -> [u32] {width,height,surface,…}
    session:     () => q.Session.encodePayload(),            // -> [u128] session timing/status
  };
}

// ── Admin service (lifecycle) ────────────────────────────────────────────────
export function adminActions(program) {
  const f = program.services.Admin.functions;
  return {
    create:        () => program.ctors.Create.encodePayload(),
    uploadMap:     (seed, map) => f.UploadMap.encodePayload(seed, map),
    startSession:  () => f.StartSession.encodePayload(),
    finishSession: () => f.FinishSession.encodePayload(),
    resetMap:      (seed) => f.ResetMap.encodePayload(seed),
    setResourceVmt: (resourceVmt) => f.SetResourceVmt.encodePayload(resourceVmt),
    kill:          (inheritor) => f.Kill.encodePayload(inheritor),
  };
}

// ── Events → our internal renderer/console event shape ───────────────────────
// Field order is taken verbatim from world.idl. The leading (u64, [u8;32]) is
// (sessionId, proxy ActorId). AgentSurfaced reports cumulative banked resource
// counts, not coordinates.
//
//   AgentDied(u64,[u8;32],u32,u32,u32)            → session,owner, x,y, cause
//   AgentExited(u64,[u8;32])                      → session,owner
//   AgentMoved(u64,[u8;32],u32,u32,u32,u32)       → session,owner, fromX,fromY, x,y
//   AgentRegistered(u64,[u8;32])                  → session,owner
//   AgentSpawned(u64,[u8;32],u32,u32)             → session,owner, x,y
//   AgentSurfaced(u64,[u8;32],u32,u32,u32)        → session,owner, banked SCRST/BCRST/HCRST
//   ChestOpened(u64,[u8;32],u32,u32,u32,u32)      → session,owner, x,y, outcome, laddersRemaining
//   LadderPlaced(u64,[u8;32],u32,u32,u32)         → session,owner, x,y, laddersRemaining
//   ResourceExtracted(u64,[u8;32],u32,u32,u32,u32)→ session,owner, x,y, kind, carriedTotal
//   ResourcesMinted(u64,[u8;32],u32,u32,u32)      → session,owner, minted SCRST/BCRST/HCRST
//   ResourcesTradedForLadders(u64,[u8;32],u32,u32,u32,u32,u32)
//                                                    → session,owner, spent SCRST/BCRST/HCRST, added, remaining
//   StoneMoved(u64,[u8;32],u32,u32,u32,u32)       → session,owner, fromX,fromY, x,y
//   TileDrilled(u64,[u8;32],u32,u32,u32,u32)      → session,owner, x,y, oldTile, newTile
export const WORLD_EVENTS = {
  AgentRegistered:   (a) => ({ type: 'registered', sessionId: Number(a[0]), owner: a[1] }),
  AgentSpawned:      (a) => ({ type: 'spawned',     sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3] }),
  SessionStarted:    (a) => ({ type: 'session_started', session: Number(a[0]) }),
  AgentMoved:        (a) => ({ type: 'moved',       sessionId: Number(a[0]), owner: a[1], fromX: a[2], fromY: a[3], x: a[4], y: a[5] }),
  TileDrilled:       (a) => ({ type: 'dug',         sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3], block: a[4], newBlock: a[5] }),
  ResourceExtracted: (a) => ({ type: 'resource_extracted', sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3], block: a[4], amount: a[5] }),
  ChestOpened:       (a) => ({ type: 'chest_opened', sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3], outcome: a[4], laddersRemaining: a[5] }),
  LadderPlaced:      (a) => ({ type: 'ladder_placed', sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3], laddersRemaining: a[4] }),
  AgentSurfaced:     (a) => ({ type: 'surfaced',    sessionId: Number(a[0]), owner: a[1], banked: { scrst: a[2], bcrst: a[3], hcrst: a[4] } }),
  AgentDied:         (a) => ({ type: 'death',       sessionId: Number(a[0]), owner: a[1], x: a[2], y: a[3], cause: a[4] }),
  AgentExited:       (a) => ({ type: 'exited',      sessionId: Number(a[0]), owner: a[1] }),
  ResourcesMinted:   (a) => ({ type: 'resources_minted', sessionId: Number(a[0]), owner: a[1], minted: { scrst: a[2], bcrst: a[3], hcrst: a[4] } }),
  ResourcesTradedForLadders: (a) => ({ type: 'resources_traded_for_ladders', sessionId: Number(a[0]), owner: a[1], spent: { scrst: a[2], bcrst: a[3], hcrst: a[4] }, laddersAdded: a[5], laddersRemaining: a[6] }),
  StoneMoved:        (a) => ({ type: 'stone_moved', sessionId: Number(a[0]), owner: a[1], fromX: a[2], fromY: a[3], x: a[4], y: a[5] }),
};

export const ADMIN_EVENTS = {
  Killed:          (a) => ({ type: 'killed', inheritor: a[0] }),
  MapGenerated:    (a) => ({ type: 'map_generated', day: Number(a[0]), seed: a[1] }),
  SessionStarted:  (a) => ({ type: 'session_started', session: Number(a[0]) }),
  SessionFinished: (a) => ({ type: 'session_finished', session: Number(a[0]) }),
  ResourceVmtUpdated: (a) => ({ type: 'resource_vmt_updated', previous: a[0], next: a[1] }),
};

// Decode any program event (World or Admin) into our internal shape; null if
// the name isn't one we render.
export function decodeWorldEvent(name, args) {
  const fn = WORLD_EVENTS[name] || ADMIN_EVENTS[name];
  return fn ? fn(args) : null;
}
