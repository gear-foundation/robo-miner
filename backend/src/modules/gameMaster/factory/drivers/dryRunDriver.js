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

// A 32-byte ActorId-shaped id (deterministic per world+slot) so dry-run output
// matches chain mode's real World.Agents() owners.
function synthOwner(worldId, i) {
  let hex = '';
  const s = `${worldId}-agent-${i}`;
  for (let k = 0; k < s.length; k += 1) hex += s.charCodeAt(k).toString(16).padStart(2, '0');
  return `0x${(hex + '0'.repeat(64)).slice(0, 64)}`;
}

function drySnapshot(world) {
  const W = 60;
  const H = 40;
  const rawGrid = Array.from({ length: W * H }, (_, i) => {
    const y = Math.floor(i / W);
    if (y === 0) return 20;
    if (y < 4) return 0;
    return i % 11 === 0 ? 2 : (i % 17 === 0 ? 10 : 1);
  });
  const owners = Array.isArray(world.owners) ? world.owners : [];
  return {
    config: [W, H],
    session: [Number(world.sessionId || 1), Number(world.seed || 0), 2, 0],
    rawGrid,
    agents: owners.map((owner, index) => ({
      index,
      owner,
      state: [1, 6 + index * 2, 4, 2, 10, 0, 0, 0, index, 0, 0, 6 + index * 2],
      inventory: [0, 0, 0, index, 0, 0],
    })),
  };
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
      let count = world.agents;
      if (state && world.agents < state.target && now >= state.nextJoinAt) {
        state.nextJoinAt = now + 300 + Math.floor(Math.random() * 700);
        count = world.agents + 1;
      }
      // Synthetic owners shaped like real World.Agents() ActorIds (32-byte hex),
      // so registry/discovery output is identical to chain mode for testing.
      return Array.from({ length: count }, (_, i) => synthOwner(world.id, i));
    },
    async archiveSnapshot(world) {
      return drySnapshot(world);
    },
    ensureBalance() {}, // no executable balance off-chain
    balanceSnapshot: () => [],
  };
}
