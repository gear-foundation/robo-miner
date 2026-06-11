// Dry-run driver — simulates the chain so the factory's pool + lobby logic can be
// watched without keys or a node. Agents "arrive" at open lobbies over time; each
// lobby gets a random fill target so some hit the cap (auto-start) and some stall
// before it (idle-timeout / manual-start path). No real maps or programs are made.
//
// The real chain driver implements this exact shape with @vara-eth/api:
//   provision  → createProgramBuilder + withExecutableBalance + Create()
//   loadMap    → generateMap + Admin.UploadMap
//   start      → Admin.StartSession      finish → Admin.FinishSession
//   recycle    → Admin.ResetMap          pollAgents → World.Agents()

let programCounter = 0;
let seedCounter = 1000;

function fakeSeed() {
  seedCounter += 1 + Math.floor(Math.random() * 9999);
  return String(seedCounter);
}

function fakeHash() {
  return `0x${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
}

export function createDryRunDriver({ clock = Date.now } = {}) {
  const sim = new Map(); // worldId → { target, nextJoinAt }

  function planLobby(world, now) {
    const target = 5 + Math.floor(Math.random() * 6); // 5..10 — sometimes caps, sometimes stalls
    sim.set(world.id, { target, nextJoinAt: now + 300 + Math.floor(Math.random() * 700) });
  }

  return {
    async provision() {
      programCounter += 1;
      return { programId: `0xpool${String(programCounter).padStart(2, '0')}` };
    },
    async loadMap(world) {
      planLobby(world, clock());
      return { seed: fakeSeed(), mapHash: fakeHash(), sessionId: 1 };
    },
    async openLobby() {},
    async start() {},
    async finish() {},
    async recycle(world) {
      planLobby(world, clock());
      return { seed: fakeSeed(), mapHash: fakeHash(), sessionId: (world.sessionId || 1) + 1 };
    },
    async retire(world) {
      sim.delete(world.id);
    },
    async pollAgents(world) {
      const state = sim.get(world.id);
      const now = clock();
      if (!state) return world.agents;
      if (world.agents < state.target && now >= state.nextJoinAt) {
        state.nextJoinAt = now + 300 + Math.floor(Math.random() * 700);
        return world.agents + 1;
      }
      return world.agents;
    },
  };
}
