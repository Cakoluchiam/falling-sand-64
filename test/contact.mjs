// Grain-surface contact, checked against arithmetic rather than against
// itself.
//
// A sphere on a plane of angle θ has an exact answer: it stays put iff
// tan θ ≤ μ, and above that it slides at g(sin θ − μ cos θ). These grains have
// no rotational degrees of freedom, so there is no rolling mode to muddy it --
// the textbook sliding-block result applies directly, which is what makes this
// milestone testable at all. See open concern 4 in PLAN.md for what that
// missing degree of freedom costs elsewhere.
//
// This is deliberately done before grain-grain contact exists. Once pairs are
// in the picture a wrong angle has two possible homes, and the friction law is
// the one number the whole project's headline output depends on.

import { ContactSolver } from '../src/contact.js';
import { HexField } from '../src/hexfield.js';
import { Particles, PHASE_AWAKE, PHASE_RESTING } from '../src/particles.js';
import { Rng } from '../src/rng.js';

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

// Split for CI, the same way and for the same reason as `clumps`: one file
// with named entry points rather than four files, because every case below is
// calibrated against the constants and helpers at the top of this one and
// copying those into four places is how they drift apart. `node
// test/contact.mjs` with no argument still runs everything.
//
//   surface  a grain against the terrain: friction angle, sliding, restitution
//   pairs    grain against grain: separation, weighting, stacks, dense piles
//   sleep    retiring settled grains, and waking them again
//   repose   what the pile actually does -- the milestone's real question
const only = process.argv[2];
const PARTS = ['surface', 'pairs', 'sleep', 'repose'];
if (only && !PARTS.includes(only)) {
  console.error(`unknown part "${only}". Known: ${PARTS.join(', ')}`);
  process.exit(2);
}
const wants = (name) => !only || only === name;

const G = 9.81;
const R = 0.0005;                 // 1 mm grain
const DEG = Math.PI / 180;

// A field tilted by `deg` about the z axis: height rises with -x, so the
// downhill direction is +x. Built by writing heights directly rather than by
// depositing, because this needs an exact plane and deposition would round it
// through the volume ledger.
function tiltedField(deg) {
  const f = new HexField(128, 128, 0.003);
  const slope = Math.tan(deg * DEG);
  let maxH = 0;
  for (let r = 0; r < f.H; r++) {
    for (let q = 0; q < f.W; q++) {
      const h = -f.cellX(q, r) * slope;
      f.height[f.index(q, r)] = h;
      if (h > maxH) maxH = h;
    }
  }
  f.markAllDirty();
  return f;
}

// Put one grain on the slope at the origin and run it.
//
// ⚠ Acceleration is fitted from the *velocity* samples, and the run is kept
// short enough that the grain stays on the field. Both matter. Distance under
// `½at²` carries an O(1/N) bias from semi-implicit integration, while velocity
// under constant acceleration is exact. And the first version of this ran for
// a full second: at 4 m/s² that is two metres of travel across a 19 cm field,
// so the grain left the slope entirely and the "acceleration" being measured
// was partly a grain falling off the edge. It reported 22% *above* the
// frictionless value in one case, which friction cannot do -- the impossible
// number is the only reason the setup got questioned rather than the solver.
// `escaped` below is the guard that turns that into a stated failure.
function slideTest(deg, mu, restitution, dt, substeps) {
  const field = tiltedField(deg);
  const P = new Particles(4);
  const solver = new ContactSolver(4);
  const i = P.alloc();
  P.radius[i] = R;
  P.px[i] = 0; P.pz[i] = 0;
  P.vx[i] = 0; P.vy[i] = 0; P.vz[i] = 0;
  P.phase[i] = PHASE_AWAKE;

  // Start exactly in contact: the surface at the origin is at height 0 with
  // normal n, so a grain resting on it sits one radius out along n.
  const surf = new Float64Array(4);
  field.sampleSurface(0, 0, surf);
  P.py[i] = surf[0] + R / surf[2];

  const opts = { gravity: G, friction: mu, restitution, iterations: 2 };
  const startX = P.px[i], startZ = P.pz[i];
  // Stay well inside the field: beyond this the slope runs out and the grain
  // is no longer on the plane the arithmetic describes.
  const reach = Math.min(field.W, field.H) * field.s * 0.35;
  const ts = [], vs = [];
  let escaped = false;
  for (let s = 0; s < substeps; s++) {
    solver.step(P, field, dt, opts);
    const dx = P.px[i] - startX, dz = P.pz[i] - startZ;
    if (Math.hypot(dx, dz) > reach) { escaped = true; break; }
    ts.push((s + 1) * dt);
    vs.push(Math.hypot(P.vx[i], P.vz[i]) / Math.cos(deg * DEG));
  }
  const dist = Math.hypot(P.px[i] - startX, P.pz[i] - startZ) / Math.cos(deg * DEG);

  // Least-squares slope of v against t, which is the acceleration.
  const n = ts.length;
  let st = 0, sv = 0, stt = 0, stv = 0;
  for (let k = 0; k < n; k++) { st += ts[k]; sv += vs[k]; stt += ts[k] * ts[k]; stv += ts[k] * vs[k]; }
  const denom = n * stt - st * st;
  const accel = denom !== 0 ? (n * stv - st * sv) / denom : 0;
  return { distance: dist, accel, escaped };
}

if (wants('surface')) {
console.log('a grain sticks below the friction angle and slides above it');
  const mu = 0.5;
  const frictionAngle = Math.atan(mu) / DEG;
  console.log(`  mu = ${mu}, so the friction angle is ${frictionAngle.toFixed(2)}°`);
  const dt = 1 / 240;
  for (const deg of [5, 15, 25, frictionAngle - 1]) {
    const r = slideTest(deg, mu, 0, dt, 480);
    check(`  ${deg.toFixed(1)}° holds (below ${frictionAngle.toFixed(1)}°)`,
      r.distance < R * 0.02, `slid ${(r.distance * 1000).toFixed(4)} mm in 2 s`);
  }
  for (const deg of [frictionAngle + 1, 35, 45]) {
    const r = slideTest(deg, mu, 0, dt, 480);
    check(`  ${deg.toFixed(1)}° slides (above ${frictionAngle.toFixed(1)}°)`,
      r.distance > R * 2, `slid ${(r.distance * 1000).toFixed(3)} mm in 2 s`);
  }
}

if (wants('surface')) {
console.log('\nthe transition is at atan(mu), across the friction slider');
  const dt = 1 / 240;
  for (const mu of [0.2, 0.5, 0.9, 1.2]) {
    const want = Math.atan(mu) / DEG;
    // Bisect on "did it move" to find where the model actually switches.
    let lo = 1, hi = 60;
    for (let it = 0; it < 22; it++) {
      const mid = (lo + hi) / 2;
      // 60 substeps is ample: a grain above the threshold starts moving on the
      // first one, and one below it never does.
      if (slideTest(mid, mu, 0, dt, 60).distance > R * 0.05) hi = mid; else lo = mid;
    }
    const found = (lo + hi) / 2;
    console.log(`    mu ${mu.toFixed(2)}: transition at ${found.toFixed(3)}°, atan gives ${want.toFixed(3)}°`);
    check(`  mu ${mu.toFixed(2)} switches within 0.5° of atan(mu)`,
      Math.abs(found - want) < 0.5, `${found.toFixed(3)} vs ${want.toFixed(3)}`);
  }
}

if (wants('surface')) {
console.log('\nsliding acceleration is g(sin θ − μ cos θ)');
  const dt = 1 / 240;
  for (const [deg, mu] of [[40, 0.3], [45, 0.5], [50, 0.2], [35, 0.1]]) {
    const want = G * (Math.sin(deg * DEG) - mu * Math.cos(deg * DEG));
    const r = slideTest(deg, mu, 0, dt, 36);
    const err = r.accel / want - 1;
    console.log(`    ${deg}° at mu ${mu}: ${r.accel.toFixed(4)} m/s^2, want ${want.toFixed(4)} (${(err * 100).toFixed(2)}%)`);
    check(`  ${deg}° at mu ${mu} stayed on the slope`, !r.escaped);
    check(`  ${deg}° at mu ${mu} accelerates as the textbook says`,
      Math.abs(err) < 0.02, `${(err * 100).toFixed(2)}% off`);
  }
}

if (wants('surface')) {
console.log('\nnone of it depends on the timestep');
  // ⚠ The point of the whole positional-friction design. A viscous damping
  // would put dt in the answer, and the repose angle this project measures
  // would be a property of the integrator rather than of the sand. Sixteenfold
  // in dt is a wide enough lever to see that immediately.
  const mu = 0.5, deg = 40;
  const want = G * (Math.sin(deg * DEG) - mu * Math.cos(deg * DEG));
  const seen = [];
  for (const hz of [60, 120, 240, 480, 960]) {
    const dt = 1 / hz;
    // Same wall of simulated time at every rate, so the comparison is between
    // step sizes and not between run lengths.
    const r = slideTest(deg, mu, 0, dt, Math.round(hz * 0.25));
    seen.push(r.accel);
    console.log(`    ${hz} Hz: ${r.accel.toFixed(4)} m/s^2${r.escaped ? '  (LEFT THE SLOPE)' : ''}`);
  }
  const lo = Math.min(...seen), hi = Math.max(...seen);
  check('  acceleration is flat across a 16x change in dt', (hi - lo) / want < 0.02,
    `${((hi - lo) / want * 100).toFixed(2)}% spread`);
  check('  and matches the analytic value at every step size',
    seen.every((a) => Math.abs(a / want - 1) < 0.02), `want ${want.toFixed(4)}`);

  // And the sticking threshold must not move either, which is the half a
  // one-sided check would miss: a rule that never slides is also "flat".
  const stuck = [60, 240, 960].map((hz) => slideTest(20, mu, 0, 1 / hz, hz).distance);
  check('  a holding slope holds at every step size', stuck.every((d) => d < R * 0.02),
    stuck.map((d) => (d * 1000).toFixed(4)).join(', '));
}

if (wants('surface')) {
console.log('\nrestitution bounces an impact but not a resting grain');
  const dt = 1 / 240;
  // Drop from a height onto flat ground and measure the rebound.
  const drop = (e) => {
    const field = tiltedField(0);
    const P = new Particles(4);
    const solver = new ContactSolver(4);
    const i = P.alloc();
    P.radius[i] = R;
    P.px[i] = 0; P.pz[i] = 0; P.py[i] = R;
    P.vx[i] = 0; P.vy[i] = -1; P.vz[i] = 0;   // 1 m/s into the ground
    P.phase[i] = PHASE_AWAKE;
    let peakUp = 0;
    for (let s = 0; s < 240; s++) {
      solver.step(P, field, dt, { gravity: G, friction: 0, restitution: e, iterations: 2 });
      if (P.vy[i] > peakUp) peakUp = P.vy[i];
    }
    return peakUp;
  };
  for (const e of [0, 0.2, 0.5, 0.8]) {
    const up = drop(e);
    console.log(`    restitution ${e}: rebound ${up.toFixed(3)} m/s from 1.000 m/s`);
    check(`  restitution ${e} rebounds at about e times the approach`,
      Math.abs(up - e) < 0.06, `${up.toFixed(3)} vs ${e}`);
  }

  // ⚠ The half that is easy to get wrong. A resting grain still "approaches"
  // the surface by g*dt every substep, so reflecting that unconditionally
  // gives it a permanent twitch and the pile simmers forever at any non-zero
  // restitution. Sitting still must stay sitting still.
  const field = tiltedField(0);
  const P = new Particles(4);
  const solver = new ContactSolver(4);
  const i = P.alloc();
  P.radius[i] = R; P.px[i] = 0; P.pz[i] = 0; P.py[i] = R;
  P.vx[i] = 0; P.vy[i] = 0; P.vz[i] = 0;
  P.phase[i] = PHASE_AWAKE;
  let worst = 0;
  for (let s = 0; s < 1200; s++) {
    solver.step(P, field, dt, { gravity: G, friction: 0.5, restitution: 0.8, iterations: 2 });
    worst = Math.max(worst, Math.abs(P.py[i] - R));
  }
  check('  a resting grain does not simmer at high restitution',
    worst < R * 0.02, `wandered ${(worst * 1e6).toFixed(2)} µm over 5 s`);
}

// ---------------------------------------------------------------- pairs ----

const BASE = 0.001;
const pairOpts = (mu = 0.5, e = 0) =>
  ({ gravity: G, friction: mu, restitution: e, iterations: 2, baseCell: BASE });

// A field far below everything, so pair behaviour is never confused with
// surface behaviour. Gravity is passed as 0 where only the pair matters.
function emptyField() {
  const f = new HexField(64, 64, 0.003);
  f.height.fill(-1);
  f.markAllDirty();
  return f;
}

function twoGrains(ri, rj, gap) {
  const P = new Particles(8);
  const a = P.alloc(), b = P.alloc();
  P.radius[a] = ri; P.vol[a] = (Math.PI / 6) * (2 * ri) ** 3;
  P.radius[b] = rj; P.vol[b] = (Math.PI / 6) * (2 * rj) ** 3;
  P.px[a] = -(ri + rj - gap) / 2; P.py[a] = 0; P.pz[a] = 0;
  P.px[b] = (ri + rj - gap) / 2; P.py[b] = 0; P.pz[b] = 0;
  P.phase[a] = PHASE_AWAKE; P.phase[b] = PHASE_AWAKE;
  return { P, a, b };
}

if (wants('pairs')) {
console.log('\noverlapping grains separate to exactly touching');
  const field = emptyField();
  for (const [ri, rj, overlap] of [[R, R, 0.4], [R, 3 * R, 0.6], [R, R, 0.95]]) {
    const { P, a, b } = twoGrains(ri, rj, (ri + rj) * (1 - overlap));
    const solver = new ContactSolver(8);
    for (let s = 0; s < 8; s++) solver.step(P, field, 1 / 240, { ...pairOpts(0), gravity: 0 });
    const d = Math.hypot(P.px[a] - P.px[b], P.py[a] - P.py[b], P.pz[a] - P.pz[b]);
    const want = ri + rj;
    check(`  ${(overlap * 100).toFixed(0)}% overlap of ${(ri * 2000).toFixed(1)}/${(rj * 2000).toFixed(1)} mm resolves`,
      Math.abs(d / want - 1) < 1e-6, `${(d * 1000).toFixed(5)} vs ${(want * 1000).toFixed(5)} mm`);
  }
}

if (wants('pairs')) {
console.log('\nthe correction is inverse-mass weighted, so the big grain barely moves');
  const field = emptyField();
  for (const ratio of [2, 4, 8]) {
    // Deliberately overlapping. At `gap = 0` the centres sit exactly a sum of
    // radii apart, there is no overlap to resolve, and the ratio measured is
    // 0/0 dressed up as Infinity.
    const { P, a, b } = twoGrains(R, R * ratio, R);
    const x0a = P.px[a], x0b = P.px[b];
    const solver = new ContactSolver(8);
    solver.step(P, field, 1 / 240, { ...pairOpts(0), gravity: 0 });
    const movedSmall = Math.abs(P.px[a] - x0a), movedBig = Math.abs(P.px[b] - x0b);
    // Displacement is inversely proportional to mass, and mass goes as r^3.
    const want = ratio ** 3;
    const got = movedSmall / movedBig;
    console.log(`    radius ratio ${ratio}: small moved ${(got).toFixed(1)}x further, want ${want}`);
    // 1e-3 rather than exact: `vol` and `radius` are Float32 by design, and a
    // 512-fold ratio amplifies their last digits. The check that matters is
    // that it is 512 and not 1/512 -- getting the weighting inverted is the
    // easy mistake, and it would read as a boulder flinching from a grain.
    check(`  radius ratio ${ratio} splits by inverse mass`, Math.abs(got / want - 1) < 1e-3,
      `${got.toFixed(3)} vs ${want}`);
  }
}

if (wants('pairs')) {
console.log('\nthe pair centre of mass does not move');
  // ⚠ Nothing external acts during the pair pass, so any drift here is the
  // solver pushing the pile somewhere by itself -- the kind of error that
  // looks like physics and would be invisible in a pile of 200k.
  const field = emptyField();
  // Not asserted at zero: `radius` and `vol` are Float32 by design, so the
  // sum of two radii disagrees with the distance between their centres in the
  // eighth digit, and the solver spends every substep resolving an overlap of
  // a fraction of a nanometre. A nanometre of drift is two millionths of a
  // grain radius; a real weighting error moves microns on the first step.
  for (const [ri, rj] of [[R, R], [R, 4 * R], [2 * R, 3 * R]]) {
    const { P, a, b } = twoGrains(ri, rj, (ri + rj) * 0.5);
    const com = () => (P.vol[a] * P.px[a] + P.vol[b] * P.px[b]) / (P.vol[a] + P.vol[b]);
    const before = com();
    const solver = new ContactSolver(8);
    for (let s = 0; s < 20; s++) solver.step(P, field, 1 / 240, { ...pairOpts(0.5), gravity: 0 });
    const drift = Math.abs(com() - before);
    check(`  ${(ri * 2000).toFixed(1)}/${(rj * 2000).toFixed(1)} mm pair holds its centre of mass`,
      drift < 1e-9, `drifted ${drift.toExponential(2)} m`);
  }
}

if (wants('pairs')) {
console.log('\ngrains bounce off each other at the restitution setting');
  // ⚠ Closing at 0.2 m/s, not the 2 m/s tried first, and the reason is a real
  // limit rather than a test detail. The broad phase runs on predicted
  // positions, so a pair closing faster than about a grain diameter per
  // substep is already through each other by the time it looks -- 1 mm grains
  // at 240 Hz tunnel above roughly 0.24 m/s of *relative* speed. Grains land
  // at metres per second, so grain-on-grain impacts at full speed are missed;
  // what stops those grains is the surface, which is continuous and cannot be
  // tunnelled. See PLAN.md on what that costs the splash zone.
  const field = emptyField();
  const closing = 0.2;
  for (const e of [0, 0.3, 0.7]) {
    const { P, a, b } = twoGrains(R, R, 0);
    P.vx[a] = closing / 2; P.vx[b] = -closing / 2;
    const solver = new ContactSolver(8);
    for (let s = 0; s < 12; s++) solver.step(P, field, 1 / 240, { ...pairOpts(0, e), gravity: 0 });
    const separating = P.vx[b] - P.vx[a];      // positive once they part
    console.log(`    restitution ${e}: separating at ${separating.toFixed(4)} m/s from ${closing.toFixed(3)}`);
    check(`  restitution ${e} rebounds a head-on pair`,
      Math.abs(separating - closing * e) < 0.02 + closing * e * 0.15,
      `${separating.toFixed(4)} vs ${(closing * e).toFixed(4)}`);
  }
}

if (wants('pairs')) {
console.log('\na column as deep as the active layer holds itself up');
  // ⚠ Depth 2 and 4, not 8, and that is a statement about the architecture
  // rather than a softened test. Position-based dynamics propagates support
  // one contact per iteration, so a tall chain compresses until the overlap
  // itself is large enough to carry the load. Measured steady state for an
  // 8-grain column at the shipped settings is 566 µm of sink -- more than a
  // grain radius -- against 57 µm for 2 grains and 230 µm for 4.
  //
  // The design is what makes that acceptable: absorption retires anything
  // deeper than `activeLayerDepth`, which defaults to two grain diameters, so
  // the solver is never asked to hold up a tower. The heightfield carries deep
  // load as a continuum, which is the entire point of the hybrid. A tall live
  // stack is a pre-M4 artefact, not a configuration to tune for.
  //
  // The residual is bounded by the *discretisation*, not by a number picked to
  // pass. Gravity advances a grain g·dt² per substep -- 170 µm at 240 Hz
  // against a 500 µm radius, a third of a grain -- and the solver removes that
  // every substep, so what is left over is on that scale times the depth of
  // the chain it had to propagate through. Asserting against `N · g·dt²` says
  // what is actually true and gets tighter automatically if the substep rate
  // is ever raised.
  const column = (N, hz, seconds = 5) => {
    const field = tiltedField(0);
    const P = new Particles(64);
    const solver = new ContactSolver(64);
    for (let k = 0; k < N; k++) {
      const i = P.alloc();
      P.radius[i] = R; P.vol[i] = (Math.PI / 6) * (2 * R) ** 3;
      P.px[i] = 0; P.pz[i] = 0; P.py[i] = R + k * 2 * R;
      P.phase[i] = PHASE_AWAKE;
    }
    for (let s = 0; s < seconds * hz; s++) solver.step(P, field, 1 / hz, pairOpts(0.5));
    let lowest = Infinity, worst = 0;
    for (let k = 0; k < P.count; k++) {
      const i = P.live[k];
      lowest = Math.min(lowest, P.py[i] - R);
      for (let m = k + 1; m < P.count; m++) {
        const j = P.live[m];
        const d = Math.abs(P.py[i] - P.py[j]);
        if (d < 2 * R) worst = Math.max(worst, 2 * R - d);
      }
    }
    return { sink: lowest, overlap: worst };
  };

  for (const N of [2, 4]) {
    const hz = 240;
    const gravityStep = G / (hz * hz);
    const r = column(N, hz);
    console.log(`    ${N} deep at ${hz} Hz: base ${(r.sink * 1e6).toFixed(1)} µm vs floor, ` +
      `overlap ${(r.overlap * 1e6).toFixed(1)} µm (g·dt² = ${(gravityStep * 1e6).toFixed(0)} µm)`);
    // The floor is hard: the surface is the last constraint solved, and M4's
    // engulfment invariant depends on this being exactly true.
    check(`  a ${N}-grain column sits on the floor, not in it`, r.sink > -1e-9,
      `${(r.sink * 1e6).toFixed(1)} µm`);
    check(`  a ${N}-grain column compresses no more than the substep allows`,
      r.overlap < N * gravityStep, `${(r.overlap * 1e6).toFixed(1)} µm vs ${(N * gravityStep * 1e6).toFixed(0)}`);
  }

  // ⚠ And the residual really is discretisation rather than a defect: it has
  // to shrink when the substep does. A solver that is simply wrong would not
  // care about dt, and this is the check that tells the two apart -- the same
  // question the friction test asks from the other direction.
  const coarse = column(8, 240, 4).overlap;
  const fine = column(8, 960, 4).overlap;
  console.log(`    8 deep: ${(coarse * 1e6).toFixed(1)} µm at 240 Hz -> ${(fine * 1e6).toFixed(1)} µm at 960 Hz` +
    `  (${(coarse / fine).toFixed(1)}x)`);
  check('  compression falls with the substep, as a discretisation error must',
    fine < coarse / 5, `${(coarse / fine).toFixed(1)}x for a 4x rate`);
}

if (wants('pairs')) {
console.log('\nno overlap survives a dense random pile');
  // The end-to-end claim, against a brute-force sweep rather than the solver's
  // own bookkeeping.
  // A wide shallow slab, about three grains deep -- the shape the active layer
  // actually takes. Piling the same grains into a deep box instead tests the
  // tall-chain regime the milestone above exists to avoid, and fails for that
  // reason rather than because the broad phase missed anything.
  const field = tiltedField(0);
  const rng = new Rng(4242);
  const n = 1500;
  const P = new Particles(n + 8);
  const solver = new ContactSolver(n + 8);
  const slab = 6 * R;
  const span = Math.sqrt(n * Math.PI * R * R / 0.5) * 1.6;
  for (let k = 0; k < n; k++) {
    const i = P.alloc();
    const r = R * (0.5 + rng.next() * 1.5);
    P.radius[i] = r; P.vol[i] = (Math.PI / 6) * (2 * r) ** 3;
    P.px[i] = (rng.next() - 0.5) * span;
    P.pz[i] = (rng.next() - 0.5) * span;
    P.py[i] = R + rng.next() * slab;
    P.phase[i] = PHASE_AWAKE;
  }
  for (let s = 0; s < 1200; s++) solver.step(P, field, 1 / 240, pairOpts(0.5));

  let worst = 0, overlapping = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    for (let m = k + 1; m < P.count; m++) {
      const j = P.live[m];
      const d = Math.hypot(P.px[i] - P.px[j], P.py[i] - P.py[j], P.pz[i] - P.pz[j]);
      const pen = P.radius[i] + P.radius[j] - d;
      if (pen > R * 0.05) { overlapping++; worst = Math.max(worst, pen); }
    }
  }
  const surf = new Float64Array(4);
  let sunk = 0, deepest = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    field.sampleSurface(P.px[i], P.pz[i], surf);
    const gap = (P.py[i] - surf[0]) * surf[2] - P.radius[i];
    if (gap < 0) deepest = Math.min(deepest, gap);
    // A quarter radius, which is the scale the column measurement above says
    // is achievable at these settings -- grains under a locally deeper spot
    // press in by tens of microns and that is the solver working, not failing.
    if (gap < -R * 0.25) sunk++;
  }
  console.log(`    ${P.count} grains: ${overlapping} pairs still overlapping, worst ${(worst * 1e6).toFixed(1)} µm; ` +
    `deepest grain ${(deepest * 1e6).toFixed(1)} µm into the floor`);
  check('  the pile settles with no material overlap', overlapping === 0, `${overlapping} pairs`);
  check('  and nothing is materially through the floor', sunk === 0, `${sunk} grains, deepest ${(deepest * 1e6).toFixed(1)} µm`);
}

if (wants('pairs')) {
console.log('\na deep heap cannot press grains through the floor');
  // ⚠ Deep and crowded on purpose, and neither the columns nor the slab above
  // can stand in for it. The failure needs a grain that begins a substep clear
  // of the surface and is driven into it by a pair correction — a column only
  // ever has one grain near the floor and it is already touching, and a slab
  // three grains deep never pushes hard enough. Found in a 5.6 cm heap in the
  // running app, where 344 grains sat inside the terrain while every test here
  // reported none.
  // A bowl rather than a plane. On a flat floor the heap simply spreads until
  // it is a few grains deep and the pressure that causes the bug never
  // develops -- 3000 grains flattened to 4.5 mm and the check passed with the
  // defect still in. A basin confines them, and its sloped normal is closer to
  // a real pile surface than a flat floor is anyway.
  const field = new HexField(128, 128, 0.003);
  for (let r = 0; r < field.H; r++) {
    for (let q = 0; q < field.W; q++) {
      const x = field.cellX(q, r), z = field.cellZ(r);
      field.height[field.index(q, r)] = Math.min(0.03, 40 * (x * x + z * z));
    }
  }
  field.markAllDirty();

  const rng = new Rng(99);
  const n = 3000;
  const P = new Particles(n + 8);
  const solver = new ContactSolver(n + 8);
  const span = 0.01;
  for (let k = 0; k < n; k++) {
    const i = P.alloc();
    const r = R * (0.5 + rng.next() * 1.5);
    P.radius[i] = r; P.vol[i] = (Math.PI / 6) * (2 * r) ** 3;
    P.px[i] = (rng.next() - 0.5) * span;
    P.pz[i] = (rng.next() - 0.5) * span;
    P.py[i] = 0.01 + rng.next() * 0.05;
    P.phase[i] = PHASE_AWAKE;
  }
  const measure = (hz, seconds) => {
    for (let s = 0; s < seconds * hz; s++) solver.step(P, field, 1 / hz, pairOpts(0.5));
    const surf = new Float64Array(4);
    let below = 0, deepest = 0, top = 0;
    for (let k = 0; k < P.count; k++) {
      const i = P.live[k];
      top = Math.max(top, P.py[i] + P.radius[i]);
      field.sampleSurface(P.px[i], P.pz[i], surf);
      const gap = (P.py[i] - surf[0]) * surf[2] - P.radius[i];
      if (gap < -1e-6) { below++; deepest = Math.min(deepest, gap); }
    }
    return { below, deepest, top };
  };
  const r = measure(240, 3.75);
  console.log(`    ${P.count} grains heaped ${(r.top * 1000).toFixed(1)} mm deep in a bowl: ` +
    `${r.below} below the surface, deepest ${(r.deepest * 1e6).toFixed(1)} µm`);
  // The defect this guards against left 681 µm; what survives is 40 µm and is
  // a different thing entirely -- see below.
  check('  no grain is driven far into the terrain', r.deepest > -R * 0.15,
    `deepest ${(r.deepest * 1e6).toFixed(1)} µm of ${(R * 1e6).toFixed(0)} µm radius`);

  // ⚠ What remains is the *tangent* plane, not a solver error. The plane
  // cached for each grain is exact for a flat surface -- measured, a flat
  // floor leaves precisely zero grains below it however hard the heap presses
  // -- but a curved surface bends away from its own tangent, so a grain that
  // slides along that plane within a substep finishes marginally under the
  // real one. It therefore scales with curvature and with the square of the
  // tangential step: 2.4 µm at curvature 10, 40 µm at 40, 548 µm at 160; and
  // 40 µm at 240 Hz, 4.2 µm at 480, 1.0 µm at 960. Re-sampling the surface per
  // iteration would remove it and cost the two thirds of the solver that
  // caching just bought back, so it stays, bounded and converging.
  const fine = measure(960, 1.5);
  console.log(`    after 1.5 s more at 960 Hz: deepest ${(fine.deepest * 1e6).toFixed(1)} µm`);
  check('  and what remains converges away with the substep',
    fine.deepest > r.deepest / 4, `${(fine.deepest * 1e6).toFixed(1)} vs ${(r.deepest * 1e6).toFixed(1)} µm`);
}

// ------------------------------------------------------------- sleeping ----

const SLEEP = { sleepSpeed: 0.002, sleepSubsteps: 12 };
const sleepOpts = (hz, mu = 0.5, e = 0) => ({
  gravity: G, friction: mu, restitution: e, iterations: 2, baseCell: BASE,
  ...SLEEP, wakeDepth: 0.2 * G / (hz * hz), stirSpeed: SLEEP.sleepSpeed * 10,
});

if (wants('sleep')) {
console.log('\ngrains that stop moving retire from the solver');
  const field = tiltedField(0);
  const P = new Particles(16);
  const solver = new ContactSolver(16);
  for (let k = 0; k < 3; k++) {
    const i = P.alloc();
    P.radius[i] = R; P.vol[i] = (Math.PI / 6) * (2 * R) ** 3;
    P.px[i] = 0; P.pz[i] = 0; P.py[i] = R + k * 2 * R;
    P.phase[i] = PHASE_AWAKE;
  }
  let firstAsleep = -1;
  for (let s = 0; s < 600; s++) {
    solver.step(P, field, 1 / 240, sleepOpts(240));
    if (firstAsleep < 0 && solver.asleep === P.count) firstAsleep = s;
  }
  console.log(`    all 3 asleep after ${firstAsleep} substeps (${(firstAsleep / 240).toFixed(2)} s)`);
  check('  a settled column falls asleep', solver.asleep === P.count, `${solver.asleep} of ${P.count}`);
  check('  and does so promptly', firstAsleep >= 0 && firstAsleep < 240, `${firstAsleep} substeps`);
}

if (wants('sleep')) {
console.log('\nnothing falls asleep in mid-air');
  // ⚠ The condition that is easy to omit. A grain thrown upward is motionless
  // at the top of its arc, so a speed test on its own retires it there and
  // leaves it hanging. Sleep needs contact as well as stillness.
  const field = tiltedField(0);
  const P = new Particles(8);
  const solver = new ContactSolver(8);
  const i = P.alloc();
  P.radius[i] = R; P.vol[i] = (Math.PI / 6) * (2 * R) ** 3;
  P.px[i] = 0; P.pz[i] = 0; P.py[i] = 0.05;
  P.vy[i] = 0;                                  // released from rest, high up
  P.phase[i] = PHASE_AWAKE;
  let sleptWhileFalling = false;
  for (let s = 0; s < 40; s++) {
    solver.step(P, field, 1 / 240, sleepOpts(240));
    if (P.phase[i] === PHASE_RESTING && P.py[i] > 0.01) sleptWhileFalling = true;
  }
  check('  a grain released in mid-air does not sleep on the way down', !sleptWhileFalling,
    `slept at y = ${(P.py[i] * 1000).toFixed(1)} mm`);
}

if (wants('sleep')) {
console.log('\na sleeping grain still holds up what lands on it');
  // Sleepers stay in the broad phase and act as immovable. Drop this test and
  // the surface layer sinks through the settled pile beneath it.
  const field = tiltedField(0);
  const P = new Particles(16);
  const solver = new ContactSolver(16);
  const base = P.alloc();
  P.radius[base] = R; P.vol[base] = (Math.PI / 6) * (2 * R) ** 3;
  P.px[base] = 0; P.pz[base] = 0; P.py[base] = R;
  P.phase[base] = PHASE_AWAKE;
  for (let s = 0; s < 400; s++) solver.step(P, field, 1 / 240, sleepOpts(240));
  check('  the lone grain is asleep before anything arrives', P.phase[base] === PHASE_RESTING);
  const restingY = P.py[base];

  const top = P.alloc();
  P.radius[top] = R; P.vol[top] = (Math.PI / 6) * (2 * R) ** 3;
  P.px[top] = 0; P.pz[top] = 0; P.py[top] = 4 * R;
  P.phase[top] = PHASE_AWAKE;
  for (let s = 0; s < 600; s++) solver.step(P, field, 1 / 240, sleepOpts(240));

  const gap = P.py[top] - P.py[base];
  console.log(`    arrival settled ${(gap * 1e6).toFixed(1)} µm above the sleeper ` +
    `(want ${(2 * R * 1e6).toFixed(0)} µm), sleeper moved ${((P.py[base] - restingY) * 1e6).toFixed(1)} µm`);
  check('  the arrival rests on top rather than through', gap > 2 * R * 0.85,
    `${(gap * 1e6).toFixed(1)} µm`);
  check('  and the sleeper was not shoved downward', P.py[base] > restingY - R * 0.05,
    `moved ${((P.py[base] - restingY) * 1e6).toFixed(1)} µm`);
}

if (wants('sleep')) {
console.log('\nan intruded sleeper wakes, a jostled one does not');
  const field = tiltedField(0);
  const P = new Particles(16);
  const solver = new ContactSolver(16);
  const a = P.alloc();
  P.radius[a] = R; P.vol[a] = (Math.PI / 6) * (2 * R) ** 3;
  P.px[a] = 0; P.pz[a] = 0; P.py[a] = R;
  P.phase[a] = PHASE_AWAKE;
  for (let s = 0; s < 400; s++) solver.step(P, field, 1 / 240, sleepOpts(240));
  check('  the sleeper is asleep to begin with', P.phase[a] === PHASE_RESTING);

  // Shove a grain into it hard enough to matter.
  const b = P.alloc();
  P.radius[b] = R; P.vol[b] = (Math.PI / 6) * (2 * R) ** 3;
  P.px[b] = 1.4 * R; P.pz[b] = 0; P.py[b] = R;
  P.phase[b] = PHASE_AWAKE;
  solver.step(P, field, 1 / 240, sleepOpts(240));
  check('  a real intrusion wakes it', P.phase[a] === PHASE_AWAKE);
}

if (wants('sleep')) {
console.log('\nsleeping does not change where the pile ends up');
  // ⚠ The check that sleeping is an optimisation rather than a physics change.
  // A too-eager sleep rule freezes a pile mid-collapse and the result looks
  // like a steeper repose angle -- which this project measures, so it would be
  // a wrong answer rather than a slow one.
  const build = (sleeping) => {
    const field = tiltedField(0);
    const rng = new Rng(77);
    const n = 900;
    const P = new Particles(n + 8);
    const solver = new ContactSolver(n + 8);
    for (let k = 0; k < n; k++) {
      const i = P.alloc();
      const r = R * (0.6 + rng.next() * 0.8);
      P.radius[i] = r; P.vol[i] = (Math.PI / 6) * (2 * r) ** 3;
      P.px[i] = (rng.next() - 0.5) * 0.01;
      P.pz[i] = (rng.next() - 0.5) * 0.01;
      P.py[i] = R + rng.next() * 0.03;
      P.phase[i] = PHASE_AWAKE;
    }
    const o = sleeping
      ? sleepOpts(240)
      : { ...pairOpts(0.5), sleepSpeed: 0, sleepSubsteps: 1e9, wakeDepth: 0 };
    for (let s = 0; s < 1500; s++) solver.step(P, field, 1 / 240, o);
    // ⚠ Distribution statistics, not extremes. A 900-grain pile is chaotic:
    // any perturbation sends two runs down different trajectories, and the
    // single highest grain then differs by 20% between runs that are
    // physically the same. The mean over the whole population, and a high
    // percentile of it, are what actually describe the heap's shape.
    const ys = [], rs = [];
    let sum = 0;
    for (let k = 0; k < P.count; k++) {
      const i = P.live[k];
      ys.push(P.py[i]); rs.push(Math.hypot(P.px[i], P.pz[i]));
      sum += P.py[i];
    }
    ys.sort((a, b) => a - b); rs.sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
    return { meanY: sum / P.count, p90Y: q(ys, 0.9), p90R: q(rs, 0.9), asleep: solver.asleep };
  };
  const on = build(true), off = build(false);
  const fmt = (r) => `mean y ${(r.meanY * 1000).toFixed(3)}, p90 y ${(r.p90Y * 1000).toFixed(3)}, ` +
    `p90 radius ${(r.p90R * 1000).toFixed(2)} mm`;
  console.log(`    sleeping on:  ${fmt(on)}, ${on.asleep} asleep`);
  console.log(`    sleeping off: ${fmt(off)}`);
  check('  sleeping retires some of the pile', on.asleep > 20, `${on.asleep} of 900`);
  check('  the heap sits at the same mean height', Math.abs(on.meanY / off.meanY - 1) < 0.05,
    `${(on.meanY * 1000).toFixed(3)} vs ${(off.meanY * 1000).toFixed(3)} mm`);
  check('  its upper reaches are the same height', Math.abs(on.p90Y / off.p90Y - 1) < 0.08,
    `${(on.p90Y * 1000).toFixed(3)} vs ${(off.p90Y * 1000).toFixed(3)} mm`);
  check('  and it spreads the same distance', Math.abs(on.p90R / off.p90R - 1) < 0.08,
    `${(on.p90R * 1000).toFixed(2)} vs ${(off.p90R * 1000).toFixed(2)} mm`);
}

// -------------------------------------------------------------- repose ----

// Pour a fixed mass onto a flat floor from just above it, let it settle, and
// describe the heap that results. Emitting from close range keeps this about
// the contact solver rather than about the nozzle and the air.
function heap(mu, { n = 2600, hz = 240, seconds = 6, seed = 3 } = {}) {
  const field = tiltedField(0);
  const rng = new Rng(seed);
  const P = new Particles(n + 8);
  const solver = new ContactSolver(n + 8);
  const o = {
    gravity: G, friction: mu, restitution: 0.2, iterations: 2, baseCell: BASE,
    ...SLEEP, wakeDepth: 0.2 * G / (hz * hz), stirSpeed: SLEEP.sleepSpeed * 10,
  };
  let spawned = 0;
  const perStep = n / (seconds * hz * 0.55);      // done pouring at ~55% through
  let debt = 0;
  for (let s = 0; s < seconds * hz; s++) {
    debt += perStep;
    while (debt >= 1 && spawned < n) {
      debt -= 1;
      const i = P.alloc();
      if (i < 0) break;
      const r = R * (0.6 + rng.next() * 0.8);
      P.radius[i] = r; P.vol[i] = (Math.PI / 6) * (2 * r) ** 3;
      // A narrow column, so the heap builds from a point source.
      const a = rng.next() * Math.PI * 2, rad = Math.sqrt(rng.next()) * 0.002;
      P.px[i] = Math.cos(a) * rad; P.pz[i] = Math.sin(a) * rad;
      P.py[i] = 0.02 + rng.next() * 0.002;
      P.vy[i] = -0.4;
      P.phase[i] = PHASE_AWAKE;
      spawned++;
    }
    solver.step(P, field, 1 / hz, o);
  }

  // Flank angle by least squares on height against radius, over the body of
  // the heap. The apex and the outermost skirt are both unrepresentative --
  // one is a single grain, the other is scattered strays.
  const pts = [];
  let peak = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    peak = Math.max(peak, P.py[i]);
    pts.push({ r: Math.hypot(P.px[i], P.pz[i]), y: P.py[i] });
  }
  // Upper envelope: the tallest grain in each radial bin is the surface.
  const BINS = 40, maxR = Math.max(...pts.map((q) => q.r));
  const env = new Float64Array(BINS).fill(-1);
  for (const q of pts) {
    const b = Math.min(BINS - 1, Math.floor(q.r / maxR * BINS));
    if (q.y > env[b]) env[b] = q.y;
  }
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let b = 0; b < BINS; b++) {
    if (env[b] < 0) continue;
    const rr = (b + 0.5) / BINS * maxR, yy = env[b];
    if (yy < peak * 0.15 || yy > peak * 0.85) continue;   // skip apex and skirt
    sx += rr; sy += yy; sxx += rr * rr; sxy += rr * yy; m++;
  }
  const slope = m > 1 ? (m * sxy - sx * sy) / (m * sxx - sx * sx) : 0;
  const angle = Math.atan(Math.abs(slope)) / DEG;

  // Six-fold ripple: the lattice printing itself onto the footprint. Compare
  // the mean radius of the heap in each of twelve bearings.
  const SECT = 12;
  const bearings = new Float64Array(SECT);
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    if (P.py[i] < peak * 0.1) continue;
    const th = Math.atan2(P.pz[i], P.px[i]);
    const b = Math.min(SECT - 1, Math.floor((th + Math.PI) / (2 * Math.PI) * SECT));
    const rr = Math.hypot(P.px[i], P.pz[i]);
    if (rr > bearings[b]) bearings[b] = rr;
  }
  let bm = 0;
  for (let b = 0; b < SECT; b++) bm += bearings[b];
  bm /= SECT;
  let dev = 0;
  for (let b = 0; b < SECT; b++) dev = Math.max(dev, Math.abs(bearings[b] - bm) / bm);

  return { angle, peak, grains: P.count, asleep: solver.asleep, bearingSpread: dev, maxR };
}

if (wants('repose')) {
console.log('friction holds material up, and the footprint is round');
  // ⚠ What this can and cannot establish at M3, stated plainly, because the
  // difference matters more than the numbers.
  //
  // **It cannot measure a repose angle yet.** The pile here is made entirely
  // of grains, and grains arriving at a realistic pour speed tunnel straight
  // through it: the broad phase runs on predicted positions, so a relative
  // closing speed above about a grain diameter per substep is invisible, which
  // is 0.24 m/s at 240 Hz against arrivals at 0.75 m/s. Measured, the heap
  // stays a 2 mm puddle 50 mm wide at 240 Hz and only starts to build at 960.
  //
  // Two things fix that, and neither belongs to M3. The substep rate is one --
  // `g*dt^2` again. **Absorption is the other and is the more important**: in
  // the finished design the body of the pile is heightfield, which is
  // continuous and cannot be tunnelled through, with a two-grain active layer
  // on top. The all-grain tower tested here is exactly the configuration M4
  // exists to prevent, so the honest reading is that repose is an M4
  // measurement that M3 makes possible rather than an M3 result.
  //
  // What it *does* establish is that the mechanism is connected: friction
  // reaches the pile and changes its shape. Peak height is the statistic
  // rather than a fitted flank angle, because a fit over a puddle is noise
  // while "how high can this material hold itself" is exactly what friction
  // decides.
  const seen = [];
  for (const mu of [0.05, 0.4, 1.0]) {
    const h = heap(mu, { n: 1600, hz: 480, seconds: 4 });
    seen.push({ mu, ...h });
    console.log(`    mu ${mu.toFixed(2)}: peak ${(h.peak * 1000).toFixed(2)} mm, ` +
      `reach ${(h.maxR * 1000).toFixed(1)} mm, flank ${h.angle.toFixed(1)}° (indicative only)`);
  }
  check('  material piles up rather than spreading flat',
    seen[seen.length - 1].peak > 6 * R,
    `peak ${(seen[seen.length - 1].peak * 1000).toFixed(2)} mm at mu 1.0`);
  check('  more friction holds it higher',
    seen[seen.length - 1].peak > seen[0].peak * 1.25,
    seen.map((s) => (s.peak * 1000).toFixed(2)).join(' -> ') + ' mm');
  check('  and draws it in rather than letting it run',
    seen[seen.length - 1].maxR < seen[0].maxR,
    seen.map((s) => (s.maxR * 1000).toFixed(1)).join(' -> ') + ' mm');
}

if (wants('repose')) {
console.log('\nthe heap is round, not hexagonal');
  // ⚠ The risk M2 deferred to this milestone. The heightfield is a hex
  // lattice, and choosing hex over a square grid was meant to keep the lattice
  // out of the pile's shape. M2 proved the *relaxation* rule isotropic to
  // 0.008%, but grains resting on lattice-aligned triangle facets is a
  // separate mechanism that could not be tested until contacts existed.
  //
  // Weaker than it will be at M4, and worth saying so: a low spreading heap
  // presses less directionally into the facets than a tall one will, so this
  // rules out a gross six-fold signature rather than proving isotropy at the
  // 0.008% the relaxation arm reached.
  const h = heap(0.6, { n: 2000, hz: 480, seconds: 4 });
  console.log(`    worst of twelve bearings deviates ${(h.bearingSpread * 100).toFixed(1)}% ` +
    `from the mean reach (peak ${(h.peak * 1000).toFixed(2)} mm)`);
  check('  the footprint has no gross six-fold signature', h.bearingSpread < 0.25,
    `${(h.bearingSpread * 100).toFixed(1)}%`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
