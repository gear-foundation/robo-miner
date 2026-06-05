// Lever coverage check: prove every control we expose to bots is wired and
// actually does something when pulled. This is the "all the levers are there and
// pullable" verification — no strategy, just one tester yanking each lever.
//   node src/engine/levers.mjs   (from the frontend/ directory)

import { Match } from './match.js';
import { getBlock } from '../world.js';
import { BLOCK } from '../config.js';
import { DYNAMITE_FUSE_TICKS, SURFACE_ROW } from './constants.js';

const results = [];
const check = (lever, ok, note = '') => results.push({ lever, ok: !!ok, note });

// Submit one action, then advance until the miner is idle again (digs span
// several ticks), collecting every event along the way.
function pump(match, id, action, maxTicks = 40) {
  match.submitAction(id, action);
  let events = match.advance();
  const m = match.state.miners[id];
  let n = 1;
  while (m.busy && n < maxTicks) { events = events.concat(match.advance()); n++; }
  return events;
}

// ---- main tester: the "survival" levers on one stocked miner ----------------
{
  const match = new Match({ seed: 4242, miners: [{ name: 'tester' }] });
  const id = 0;
  const m = match.state.miners[id];
  // Stock it so the shop / consumable levers are reachable without grinding.
  m.money = 100000;
  m.items.pillar = 5;
  m.items.teleporter = 3;

  // Shop levers (spawns at the shop door on the surface).
  let before = m.upgrades.drill;
  pump(match, id, { type: 'UPGRADE', stat: 'drill' });
  check('UPGRADE', m.upgrades.drill > before, `drill L${before}→L${m.upgrades.drill}`);

  before = m.items.parachute;
  pump(match, id, { type: 'BUY', item: 'parachute' });
  check('BUY', m.items.parachute > before, 'parachute +1');

  m.fuel = 10;
  pump(match, id, { type: 'REFUEL' });
  check('REFUEL', m.fuel === m.maxFuel, `fuel→${m.fuel}`);

  // Dig levers.
  let dug = m.stats.tilesDug;
  pump(match, id, { type: 'DIG', dir: 'down' });
  check('DIG:down', m.stats.tilesDug > dug, `depth ${m.ty - SURFACE_ROW}`);

  let evs = pump(match, id, { type: 'DIG', dir: 'up' }); // air above → no-op
  check('DIG no-op on air', evs.some((e) => e.type === 'nothing_to_dig'));

  dug = m.stats.tilesDug;
  pump(match, id, { type: 'MOVE', dir: 'down' }); // contextual move-or-dig lever
  check('MOVE:down (dig/step)', m.stats.tilesDug > dug || m.ty > SURFACE_ROW + 1);

  // Go a little deeper for a solid surrounding, then placement levers.
  pump(match, id, { type: 'DIG', dir: 'down' });
  pump(match, id, { type: 'DIG', dir: 'down' });

  before = m.items.ladder;
  pump(match, id, { type: 'LADDER' });
  check('LADDER', getBlock(match.state.world, m.tx, m.ty) === BLOCK.LADDER && m.items.ladder < before);

  before = m.items.pillar;
  pump(match, id, { type: 'PILLAR' });
  check('PILLAR', getBlock(match.state.world, m.tx, m.ty) === BLOCK.PILLAR && m.items.pillar < before);

  // Climb / escape back to the surface.
  const fromRow = m.ty;
  for (let i = 0; i < fromRow + 2; i++) pump(match, id, { type: 'MOVE', dir: 'up' }, 6);
  check('MOVE:up (climb/escape)', m.ty < fromRow, `row ${fromRow}→${m.ty}`);

  // Teleporter lever (warp to the shop from anywhere).
  m.tx = 5; // shove sideways first so the warp is observable
  pump(match, id, { type: 'TELEPORT' });
  check('TELEPORT', m.tx === match.state.shopX && m.ty === SURFACE_ROW);

  // Win lever (turn the diamond in at the shop) — ends the match, so do it last.
  m.hasDiamond = true;
  pump(match, id, { type: 'TURN_IN' });
  check('TURN_IN (win)', match.state.finished && match.state.finishedReason === 'diamond');
}

// ---- dynamite on a throwaway miner (it may blow itself up — we only need the
// detonation to fire) --------------------------------------------------------
{
  const match = new Match({ seed: 99, miners: [{ name: 'demo', items: { dynamite: 5 } }] });
  const id = 0;
  pump(match, id, { type: 'DIG', dir: 'down' });
  pump(match, id, { type: 'DIG', dir: 'down' });
  match.submitAction(id, { type: 'DYNAMITE', size: 1, dir: 'down' });
  let boom = false;
  for (let i = 0; i < DYNAMITE_FUSE_TICKS + 3; i++) {
    if (match.advance().some((e) => e.type === 'detonation')) boom = true;
  }
  check('DYNAMITE', boom);
}

// ---- lever restriction: a miner limited to MOVE can't pull other levers -----
{
  const match = new Match({ seed: 1, miners: [{ name: 'limited', allowed: ['MOVE'] }] });
  const id = 0;
  const m = match.state.miners[id];
  m.money = 1000;
  const evs = pump(match, id, { type: 'UPGRADE', stat: 'drill' });
  const blocked = evs.some((e) => e.type === 'action_not_allowed') && m.upgrades.drill === 1;
  const obsHidesIt = !match.observe(id).legalActions.some((a) => a.startsWith('UPGRADE'));
  check('lever restriction (allowedActions)', blocked && obsHidesIt);
}

// ---- perception: upgrading radar widens the visible window ------------------
{
  const match = new Match({ seed: 7, miners: [{ name: 'eye' }] });
  const id = 0;
  const r1 = match.observe(id).view.radius;
  match.state.miners[id].radar = 5; // simulate a radar upgrade
  const r2 = match.observe(id).view.radius;
  check('radar widens vision (fog shrinks)', r2 > r1, `radius ${r1}→${r2}`);
}

// ---- report ----------------------------------------------------------------
console.log('=== LEVER COVERAGE ===');
let pass = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'}  ${r.lever.padEnd(34)} ${r.note}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} levers verified`);
process.exit(pass === results.length ? 0 : 1);
