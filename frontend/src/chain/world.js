// Typed binding for the DiggerWorld Vara.eth program — generated FROM world.idl
// (the contract is the source of truth). This is the single place that maps the
// contract's exact functions / queries / events to what the frontend drives and
// renders. Payloads are encoded/decoded through a sails-js SailsProgram parsed
// from world.idl — NEVER hand-encoded (per vara-eth-skills ts-api playbook).
//
// Program: DiggerWorld   ctor Create()
//   service World@0x44d3a89e1760075a  — the spatial game
//   service Admin@0xf0292894fb819cec  — session/map lifecycle
//
// NOTE — this World program is LEAN: the only agent actions are register / move /
// drill / place_ladder / surface / exit. There is NO upgrade / buy / refuel /
// pillar / dynamite / teleport here — the economy (RES tokens, redeem, upgrades)
// lives in separate contracts (spec §2.3–2.6), not in World.

// ── Direction (u32) ──────────────────────────────────────────────────────────
// CONFIRM the exact u32 encoding with the contract team — this is our assumed
// clockwise mapping. Everything routes through DIR so a fix is one line.
export const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
export const DIR_FROM_NAME = { up: DIR.UP, right: DIR.RIGHT, down: DIR.DOWN, left: DIR.LEFT };
export const DIR_TO_NAME = ['up', 'right', 'down', 'left'];

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
    register:    () => f.Register.encodePayload(),
    move:        (dirName) => f.MoveAgent.encodePayload(DIR_FROM_NAME[dirName]),
    drill:       (dirName) => f.Drill.encodePayload(DIR_FROM_NAME[dirName]),
    placeLadder: (dirName) => f.PlaceLadder.encodePayload(DIR_FROM_NAME[dirName]),
    surface:     () => f.Surface.encodePayload(),   // go up to bank
    exit:        () => f.Exit.encodePayload(),       // leave the map
  };
}

// ── READ queries (World service) — via api.call.program.calculateReplyForHandle ─
export function worldQueries(program) {
  const q = program.services.World.queries;
  return {
    mapSnapshot: () => q.MapSnapshot.encodePayload(),        // -> [u32] full grid (decode → world.grid bytes)
    tileAt:      (x, y) => q.TileAt.encodePayload(x, y),     // -> u32 single tile
    agentOf:     (owner) => q.AgentOf.encodePayload(owner),  // -> [u128] one agent's packed state
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
  };
}

// ── Events → our internal renderer/console event shape ───────────────────────
// Field order is taken verbatim from world.idl. The leading (u64, [u8;32]) is
// (agentId, ownerKey). CONFIRM the trailing u32s' meanings with the contract
// team — annotated below as best-read; the renderer/TX-console already consume
// {type,id,x,y,block,...}.
//
//   AgentDied(u64,[u8;32],u32,u32,u32)            → id,owner, x,y, cause?
//   AgentExited(u64,[u8;32])                      → id,owner
//   AgentMoved(u64,[u8;32],u32,u32,u32,u32)       → id,owner, fromX,fromY, x,y
//   AgentRegistered(u64,[u8;32])                  → id,owner
//   AgentSpawned(u64,[u8;32],u32,u32)             → id,owner, x,y
//   AgentSurfaced(u64,[u8;32],u32,u32,u32)        → id,owner, x,y, banked?
//   LadderPlaced(u64,[u8;32],u32,u32,u32)         → id,owner, x,y, dir?
//   ResourceExtracted(u64,[u8;32],u32,u32,u32,u32)→ id,owner, x,y, kind, amount
//   TileDrilled(u64,[u8;32],u32,u32,u32,u32)      → id,owner, x,y, tile, ?
export const WORLD_EVENTS = {
  AgentRegistered:   (a) => ({ type: 'registered', id: Number(a[0]), owner: a[1] }),
  AgentSpawned:      (a) => ({ type: 'spawned',     id: Number(a[0]), owner: a[1], x: a[2], y: a[3] }),
  AgentMoved:        (a) => ({ type: 'moved',       id: Number(a[0]), owner: a[1], fromX: a[2], fromY: a[3], x: a[4], y: a[5] }),
  TileDrilled:       (a) => ({ type: 'dug',         id: Number(a[0]), owner: a[1], x: a[2], y: a[3], block: a[4] }),
  ResourceExtracted: (a) => ({ type: 'resource_extracted', id: Number(a[0]), owner: a[1], x: a[2], y: a[3], block: a[4], amount: a[5] }),
  LadderPlaced:      (a) => ({ type: 'ladder_placed', id: Number(a[0]), owner: a[1], x: a[2], y: a[3] }),
  AgentSurfaced:     (a) => ({ type: 'surfaced',    id: Number(a[0]), owner: a[1], x: a[2], y: a[3], amount: a[4] }),
  AgentDied:         (a) => ({ type: 'death',       id: Number(a[0]), owner: a[1], x: a[2], y: a[3] }),
  AgentExited:       (a) => ({ type: 'exited',      id: Number(a[0]), owner: a[1] }),
};

export const ADMIN_EVENTS = {
  MapGenerated:    (a) => ({ type: 'map_generated', day: Number(a[0]), seed: a[1] }),
  SessionStarted:  (a) => ({ type: 'session_started', session: Number(a[0]) }),
  SessionFinished: (a) => ({ type: 'session_finished', session: Number(a[0]) }),
};

// Decode any program event (World or Admin) into our internal shape; null if
// the name isn't one we render.
export function decodeWorldEvent(name, args) {
  const fn = WORLD_EVENTS[name] || ADMIN_EVENTS[name];
  return fn ? fn(args) : null;
}
