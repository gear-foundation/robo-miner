// Resumable deterministic RNG for the headless engine.
//
// Same mulberry32 algorithm as world/rng.js, but the internal state is exposed
// as a plain integer so a whole match can be snapshotted / resumed / replayed.
// Gameplay events (chest loot, shrine rewards) draw from this stream so a match
// is fully reproducible from (seed, action log).

export function createRng(seed) {
  let s = seed >>> 0;
  return {
    get state() {
      return s;
    },
    set state(v) {
      s = v >>> 0;
    },
    // Float in [0, 1) — drop-in for Math.random / the `rnd` callbacks the
    // world-gen and chest tables already accept.
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    // Integer in [0, n).
    int(n) {
      return Math.floor(this.next() * n);
    },
  };
}
