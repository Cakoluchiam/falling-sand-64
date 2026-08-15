// Exchange: the machinery that moves sand between the grains and the
// heightfield, and the measures that decide when it may.
//
// Split for CI the same way and for the same reason as `clumps` and `contact`:
// one file with named entry points rather than four files, because every
// tolerance below is calibrated against the constants and helpers at the top
// of this one, and copying those into four places is how they drift apart.
// `node test/exchange.mjs` with no argument still runs everything.
//
//   producers  the per-frame passes M4 stands on: extrema, adjacency, timers
//   burial     direction coverage and geodesic depth
//   absorb     retiring grains, elevation, and the engulfment invariant
//   emit       putting sand back when the active layer runs thin

import { ExchangeSolver } from '../src/exchange.js';
import { ContactSolver } from '../src/contact.js';
import { GrainHash, CONTACT_SLACK } from '../src/hash.js';
import { HexField } from '../src/hexfield.js';
import { Particles, PHASE_AWAKE, PHASE_BALLISTIC, PHASE_RESTING } from '../src/particles.js';
import { Rng } from '../src/rng.js';

let failures = 0;
let ran = 0;
const check = (n, c, x = '') => { ran++; console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

const only = process.argv[2];
const PARTS = ['producers', 'burial', 'absorb', 'emit'];
if (only && !PARTS.includes(only)) {
  console.error(`unknown part "${only}". Known: ${PARTS.join(', ')}`);
  process.exit(2);
}
const wants = (name) => !only || only === name;

const G = 9.81;
const R = 0.0005;                 // 1 mm median grain
const SPACING = 0.003;            // the shipped cell spacing
const BASE = 0.001;               // broad-phase level 0, the median diameter
const SLEEP = { sleepSpeed: 0.002, sleepSubsteps: 12 };

const flatField = () => new HexField(96, 96, SPACING);

const volOf = (r) => (Math.PI / 6) * (2 * r) ** 3;

// A settled heap of polydisperse grains on a flat floor, which is the state
// every measure in this file is actually asked about. `spread` is the ratio of
// the largest grain to the smallest: the default is ordinary sand, and 8 is
// the sorting setting at which 14% of grains exceed 3x the median and the
// broad phase's level hierarchy is genuinely exercised.
function heap({ n = 900, spread = 2, seconds = 3, hz = 240, seed = 5, big = 0 } = {}) {
  const field = flatField();
  const rng = new Rng(seed);
  const P = new Particles(n + 16);
  const solver = new ContactSolver(n + 16);
  const o = {
    gravity: G, friction: 0.5, restitution: 0.2, iterations: 2, baseCell: BASE,
    ...SLEEP, wakeDepth: 0.2 * G / (hz * hz), stirSpeed: SLEEP.sleepSpeed * 10,
  };
  const lo = 1 / Math.sqrt(spread), hi = Math.sqrt(spread);

  const spawn = (radius) => {
    const i = P.alloc();
    if (i < 0) return -1;
    P.radius[i] = radius; P.vol[i] = volOf(radius);
    const a = rng.next() * Math.PI * 2, rad = Math.sqrt(rng.next()) * 0.004;
    P.px[i] = Math.cos(a) * rad; P.pz[i] = Math.sin(a) * rad;
    P.py[i] = 0.03 + rng.next() * 0.002;
    P.vy[i] = -0.3;
    P.phase[i] = PHASE_AWAKE;
    return i;
  };

  let spawned = 0, debt = 0;
  const steps = seconds * hz;
  const perStep = n / (steps * 0.5);          // done pouring halfway through
  for (let s = 0; s < steps; s++) {
    debt += perStep;
    while (debt >= 1 && spawned < n) {
      debt -= 1;
      // Log-uniform in radius: a crude stand-in for the real sampler, and the
      // point here is the level spread, not the distribution's shape.
      const r = R * Math.exp(Math.log(lo) + rng.next() * (Math.log(hi) - Math.log(lo)));
      if (spawn(r) < 0) break;
      spawned++;
    }
    // Clumps land last, so they come to rest on top of the sand rather than
    // under it -- which is the configuration the footprint check needs.
    if (big > 0 && s === Math.floor(steps * 0.55)) {
      for (let b = 0; b < big; b++) {
        const i = spawn(SPACING * 2);          // 12 mm across, four cells wide
        if (i >= 0) { P.isAgg[i] = 1; P.markAggregate(i); }
      }
    }
    solver.step(P, field, 1 / hz, o);
  }
  return { field, P, solver, hz, o };
}

// Every touching pair, found by looking at all of them. The reference the
// broad phase is checked against.
function brutePairs(P) {
  const { px, py, pz, radius, phase, live } = P;
  const slack = (1 + CONTACT_SLACK) ** 2;
  const out = new Set();
  for (let a = 0; a < P.count; a++) {
    const i = live[a];
    if (phase[i] === PHASE_BALLISTIC) continue;
    for (let b = a + 1; b < P.count; b++) {
      const j = live[b];
      if (phase[j] === PHASE_BALLISTIC) continue;
      const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
      const sum = radius[i] + radius[j];
      if (dx * dx + dy * dy + dz * dz >= sum * sum * slack) continue;
      out.add(i < j ? `${i},${j}` : `${j},${i}`);
    }
  }
  return out;
}

// The adjacency read back as the same pair set, plus the rows themselves.
function adjPairs(hash, P) {
  const out = new Set();
  const { adjStart, adjList } = hash;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    for (let a = adjStart[i]; a < adjStart[i + 1]; a++) {
      const j = adjList[a];
      out.add(i < j ? `${i},${j}` : `${j},${i}`);
    }
  }
  return out;
}

function rebuiltHash(P) {
  const hash = new GrainHash(P.capacity);
  hash.rebuild(P, BASE, (i) => P.phase[i] !== PHASE_BALLISTIC);
  return hash;
}

// ------------------------------------------------------------- producers ----

if (wants('producers')) {
console.log('the adjacency is every touching pair, and both ends of each');
  for (const spread of [2, 8]) {
    const { P } = heap({ spread, seed: 11 });
    const hash = rebuiltHash(P);
    const pairs = hash.buildAdjacency(P);
    const want = brutePairs(P);
    const got = adjPairs(hash, P);

    // ⚠ Assert the sample size before the agreement. My own hash suite
    // reported "no touching pair missed" over fields holding 1, 5, 11 and 0
    // contacts, where an enumeration returning nothing would have passed. A
    // settled heap of 900 grains carries thousands of contacts; anything
    // near zero here means the heap never formed and the comparison below is
    // vacuous whichever way it comes out.
    check(`  spread ${spread}x: the heap has contacts to check`,
      want.size > 1000, `only ${want.size} touching pairs`);
    check(`  spread ${spread}x: pairs found = pairs that exist`,
      got.size === want.size && pairs === want.size,
      `brute ${want.size}, adjacency ${got.size}, reported ${pairs}`);

    let missing = 0, extra = 0;
    for (const k of want) if (!got.has(k)) missing++;
    for (const k of got) if (!want.has(k)) extra++;
    check(`  spread ${spread}x: none missed, none invented`,
      missing === 0 && extra === 0, `${missing} missing, ${extra} extra`);

    // Symmetry, which is the property the whole structure exists for.
    let asym = 0;
    const { adjStart, adjList } = hash;
    for (let k = 0; k < P.count; k++) {
      const i = P.live[k];
      for (let a = adjStart[i]; a < adjStart[i + 1]; a++) {
        const j = adjList[a];
        let back = false;
        for (let b = adjStart[j]; b < adjStart[j + 1]; b++) if (adjList[b] === i) back = true;
        if (!back) asym++;
      }
    }
    check(`  spread ${spread}x: every row entry has its mirror`, asym === 0, `${asym} one-way`);
  }
}

if (wants('producers')) {
console.log('\nforEachNeighbour alone is not a neighbourhood query');
  // This is why buildAdjacency exists rather than a per-grain call, and the
  // reason is easy to lose because the method name reads like the latter. A
  // coarse grain searches its own level and coarser, so every finer grain
  // touching it is delivered from the *other* end and never appears in its
  // own sweep. For a clump resting in sand that is most of what it touches.
  const { P } = heap({ n: 700, spread: 2, seed: 4, big: 1 });
  const hash = rebuiltHash(P);
  hash.buildAdjacency(P);
  let clump = -1;
  for (let k = 0; k < P.count; k++) if (P.isAgg[P.live[k]]) clump = P.live[k];

  check('  a clump came to rest in the sand', clump >= 0);
  if (clump >= 0) {
    let fromOwnSweep = 0;
    hash.forEachNeighbour(P, clump, (j) => {
      const dx = P.px[clump] - P.px[j], dy = P.py[clump] - P.py[j], dz = P.pz[clump] - P.pz[j];
      const sum = P.radius[clump] + P.radius[j];
      if (dx * dx + dy * dy + dz * dz < sum * sum * (1 + CONTACT_SLACK) ** 2) fromOwnSweep++;
    });
    const row = hash.adjStart[clump + 1] - hash.adjStart[clump];
    check('  the clump has neighbours at all', row >= 4, `row holds ${row}`);
    check('  its own sweep returns fewer than it touches',
      fromOwnSweep < row, `sweep ${fromOwnSweep}, adjacency row ${row}`);
  }
}

if (wants('producers')) {
console.log('\ngrainBottom sits under every live grain, over its whole footprint');
  const { field, P } = heap({ n: 700, spread: 2, seed: 7, big: 2 });
  const ex = new ExchangeSolver(P.capacity);
  const counted = ex.updateExtrema(P, field);
  check('  the pass saw the population', counted > 500, `counted ${counted}`);

  // The invariant the engulfment guard rests on: for every cell a grain's
  // volume would land in, the recorded floor is at or below that grain's
  // underside. Checked over the deposit footprint rather than the centre
  // triangle, because the rim cells of a large body are exactly where a
  // centre-only pass leaves a hole.
  let holesSmall = 0, holesLarge = 0, rimCells = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    if (P.phase[i] === PHASE_BALLISTIC) continue;
    const lo = P.py[i] - P.radius[i], hi = P.py[i] + P.radius[i];
    const large = P.radius[i] > field.s;
    const cells = large
      ? field.discCells(P.px[i], P.pz[i], P.radius[i])
      : (() => { const t = field.sampleTriangle(P.px[i], P.pz[i]); return [t.i0, 0, t.i1, 0, t.i2, 0]; })();
    for (let c = 0; c < cells.length; c += 2) {
      const idx = cells[c];
      if (large) rimCells++;
      const bad = field.grainBottom[idx] > lo + 1e-9 || field.grainTop[idx] < hi - 1e-9;
      if (bad) { if (large) holesLarge++; else holesSmall++; }
    }
  }
  check('  the large bodies covered more than their centre triangle',
    rimCells > 20, `only ${rimCells} footprint cells`);
  check('  no ordinary grain is outside its own extrema', holesSmall === 0, `${holesSmall} cells`);
  check('  no large body is outside its own extrema', holesLarge === 0, `${holesLarge} cells`);
}

if (wants('producers')) {
console.log('\nextrema ignore grains still in flight');
  const field = flatField();
  const P = new Particles(8);
  const ex = new ExchangeSolver(8);
  const rest = P.alloc();
  P.radius[rest] = R; P.vol[rest] = volOf(R);
  P.px[rest] = 0; P.py[rest] = R; P.pz[rest] = 0;
  P.phase[rest] = PHASE_RESTING;
  const flying = P.alloc();
  P.radius[flying] = R; P.vol[flying] = volOf(R);
  P.px[flying] = 0; P.py[flying] = 0.2; P.pz[flying] = 0;
  P.phase[flying] = PHASE_BALLISTIC;

  ex.updateExtrema(P, field);
  const t = field.sampleTriangle(0, 0);
  check('  a grain 20 cm up does not raise grainTop',
    field.grainTop[t.i0] < 0.01, `grainTop ${field.grainTop[t.i0]}`);
  check('  the resting grain does', Math.abs(field.grainTop[t.i0] - 2 * R) < 1e-9);
}

if (wants('producers')) {
console.log('\nthe rest timer keeps counting after a grain retires');
  // Quiescence is a stricter threshold on this same timer, so a timer that
  // saturates at `sleepSubsteps` makes every setting above it identical and a
  // sweep across it measures one point while looking like it measured a range.
  const field = flatField();
  const P = new Particles(4);
  const solver = new ContactSolver(4);
  const i = P.alloc();
  P.radius[i] = R; P.vol[i] = volOf(R);
  P.px[i] = 0; P.pz[i] = 0; P.py[i] = R;
  P.phase[i] = PHASE_AWAKE;
  const hz = 240;
  const o = {
    gravity: G, friction: 0.5, restitution: 0, iterations: 2, baseCell: BASE,
    ...SLEEP, wakeDepth: 0.2 * G / (hz * hz), stirSpeed: SLEEP.sleepSpeed * 10,
  };
  for (let s = 0; s < 200; s++) solver.step(P, field, 1 / hz, o);

  check('  the grain retired', P.phase[i] === PHASE_RESTING);
  check('  and its timer ran well past the sleep threshold',
    P.restTimer[i] > SLEEP.sleepSubsteps * 5,
    `restTimer ${P.restTimer[i]} against sleepSubsteps ${SLEEP.sleepSubsteps}`);
}

if (wants('producers')) {
console.log('\nwhat the per-frame passes cost');
  const { field, P } = heap({ n: 3000, spread: 2, seed: 9, seconds: 4 });
  const ex = new ExchangeSolver(P.capacity);
  const hash = rebuiltHash(P);

  let t0 = performance.now();
  for (let r = 0; r < 20; r++) ex.updateExtrema(P, field);
  const extremaMs = (performance.now() - t0) / 20;

  t0 = performance.now();
  for (let r = 0; r < 20; r++) hash.buildAdjacency(P);
  const adjMs = (performance.now() - t0) / 20;

  const pairs = hash.adjPairs;
  console.log(`  ${P.count} grains, ${pairs} contacts` +
    `   extrema ${extremaMs.toFixed(2)} ms   adjacency ${adjMs.toFixed(2)} ms`);
  // Not a performance assertion -- the numbers are the point and they belong
  // in the log. This only catches an accidental quadratic, which is the
  // failure mode a per-grain neighbourhood search would have had.
  check('  both passes are far under one contact substep',
    extremaMs + adjMs < 50, `${(extremaMs + adjMs).toFixed(2)} ms`);
}

// ⚠ A part that runs no checks must be red, not green. This suite is built a
// part at a time and registered in `run.mjs` and the CI matrix by name, so the
// obvious mistake is to register a part before its section exists -- which
// gives a job that passes while testing nothing, indistinguishable in the
// checks list from one that passed while testing everything. That failure has
// already happened here in another form: a broad-phase check that reported
// success over a field holding one contact.
if (ran === 0) {
  console.log(`\nFAIL ${only ? `part "${only}"` : 'the suite'} ran no checks at all`);
  process.exit(1);
}

console.log(failures === 0 ? `\nall ${ran} exchange checks passed` : `\n${failures} of ${ran} FAILED`);
process.exit(failures === 0 ? 0 : 1);
