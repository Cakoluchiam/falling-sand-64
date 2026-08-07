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
import { Particles, PHASE_AWAKE } from '../src/particles.js';

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

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

console.log('a grain sticks below the friction angle and slides above it');
{
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

console.log('\nthe transition is at atan(mu), across the friction slider');
{
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

console.log('\nsliding acceleration is g(sin θ − μ cos θ)');
{
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

console.log('\nnone of it depends on the timestep');
{
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

console.log('\nrestitution bounces an impact but not a resting grain');
{
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
