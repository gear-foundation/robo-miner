// Lockstep match controller. Buffers one action per miner and advances the
// simulation when tick() is called. The WALL-CLOCK cadence (how long to wait
// for slow LLM agents before forcing the tick) belongs to the server that
// drives this — the controller itself is synchronous and deterministic.

import { createMatch } from './state.js';
import { step } from './sim.js';
import { observe } from './observation.js';
import { normalizeAction } from './actions.js';

export class Match {
  constructor(opts = {}) {
    this.state = createMatch(opts);
    this.pending = new Map(); // minerId -> action (cleared each tick)
  }

  get tick() {
    return this.state.tick;
  }

  get finished() {
    return this.state.finished;
  }

  get minerIds() {
    return this.state.miners.map((m) => m.id);
  }

  /** Buffer an agent's action for the upcoming tick. Last write wins. */
  submitAction(minerId, action) {
    if (!this.state.miners.some((m) => m.id === minerId)) return false;
    this.pending.set(minerId, normalizeAction(action));
    return true;
  }

  /** Advance one tick. Miners with no buffered action default to WAIT. */
  tick_() {
    const actions = {};
    for (const [id, act] of this.pending) actions[id] = act;
    step(this.state, actions);
    this.pending.clear();
    return this.state.events;
  }

  /** Fog-limited observation for one agent. */
  observe(minerId, optsOverride) {
    return observe(this.state, minerId, optsOverride);
  }

  /** Lightweight snapshot for the renderer / logging (not the full grid). */
  snapshot() {
    const s = this.state;
    return {
      tick: s.tick,
      seed: s.seed,
      mode: s.mode,
      finished: s.finished,
      finishedReason: s.finishedReason,
      teamScore: s.teamScore,
      diamondFound: s.diamondFound,
      shopX: s.shopX,
      miners: s.miners.map((m) => ({
        id: m.id,
        name: m.name,
        hat: m.hat,
        color: m.color,
        x: m.tx,
        y: m.ty,
        facing: m.facing,
        alive: m.alive,
        digging: !!m.busy,
        hasDiamond: m.hasDiamond,
        money: m.money,
        fuel: Math.round(m.fuel),
        hp: Math.round(m.hp),
      })),
    };
  }
}

// `tick_` has a trailing underscore because `tick` is a getter above; expose a
// friendlier alias too.
Match.prototype.advance = Match.prototype.tick_;
