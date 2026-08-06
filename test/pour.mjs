const base = new URL('../src/', import.meta.url).href;
const { Rng } = await import(base + 'rng.js');
const { Noise } = await import(base + 'noise.js');
const { values, derived } = await import(base + 'params.js');
const { Particles, PHASE_BALLISTIC } = await import(base + 'particles.js');
const { Nozzle } = await import(base + 'source.js');
const { stepBallistic } = await import(base + 'ballistic.js');
const { HexField } = await import(base + 'hexfield.js');

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

Object.assign(values, {
  medianDiameter: 0.001, sorting: Math.log(1.4) / 2,
  minGrainRatio: 0.1, maxGrainRatio: 12,
  nozzleHeight: 0.5, apertureRadius: 0.02, initialSpeed: 0.4,
  clumpFraction: 0, surgeDepth: 0, continuousPour: true,
  turbAmplitude: 0, gravity: 9.81, clumpSize: 17.1, minClumpSize: 3.5,
});
const dt = 1 / 60;

// Ballistically land every emitted grain (turbulence and drag off, so this
// isolates the launch geometry) and describe where they fall.
function land(angle, spread, n = 60000) {
  values.pourAngle = angle;
  values.pourSpread = spread;
  const P = new Particles(n + 6000);
  const nz = new Nozzle(new Rng(4), new Noise(4));
  for (let f = 0; f < 500 && P.count < n; f++) nz.step(dt, f * dt, P, values);
  const g = values.gravity;
  let cx = 0, cz = 0, up = 0, cnt = 0;
  const xs = [], zs = [];
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    if (P.vy[i] > 0) up++;
    const t = (P.vy[i] + Math.sqrt(P.vy[i] * P.vy[i] + 2 * g * P.py[i])) / g;
    const x = P.px[i] + P.vx[i] * t, z = P.pz[i] + P.vz[i] * t;
    xs.push(x); zs.push(z); cx += x; cz += z; cnt++;
  }
  cx /= cnt; cz /= cnt;
  let s2 = 0, near = 0;
  for (let i = 0; i < cnt; i++) s2 += (xs[i] - cx) ** 2 + (zs[i] - cz) ** 2;
  const rms = Math.sqrt(s2 / cnt);
  for (let i = 0; i < cnt; i++) if (Math.hypot(xs[i] - cx, zs[i] - cz) < rms * 0.5) near++;
  return { cx, cz, rms, up, n: cnt, centreShare: near / cnt };
}

console.log('pour angle AIMS the stream (one fixed direction)');
console.log(' angle | centre x | centre z |  width (rms dia)');
for (const a of [0, 10, 20, 40]) {
  const r = land(a, 8);
  console.log(`  ${String(a).padStart(3)}° |${(r.cx * 100).toFixed(2).padStart(9)} cm |${(r.cz * 100).toFixed(3).padStart(9)} cm |${(r.rms * 200).toFixed(2).padStart(10)} cm`);
}
const a0 = land(0, 8), a20 = land(20, 8), a40 = land(40, 8);
check('untilted pour lands under the nozzle', Math.abs(a0.cx) < 0.002 && Math.abs(a0.cz) < 0.002,
  `(${(a0.cx * 100).toFixed(2)}, ${(a0.cz * 100).toFixed(2)}) cm`);
check('tilting moves the landing point downrange', a20.cx > a0.cx + 0.01 && a40.cx > a20.cx);
check('tilt is one direction, not a random bearing', Math.abs(a40.cz) < Math.abs(a40.cx) * 0.05,
  `z drift ${(a40.cz * 100).toFixed(3)} cm vs x ${(a40.cx * 100).toFixed(2)} cm`);
check('tilting alone does not widen the stream',
  Math.abs(a40.rms / a0.rms - 1) < 0.25, `${(a40.rms / a0.rms).toFixed(2)}x`);
check('predicted downrange offset matches', (() => {
  values.pourAngle = 20; values.pourSpread = 8;
  return Math.abs(derived.landingOffset() - a20.cx) / a20.cx < 0.2;
})(), `predicted ${(derived.landingOffset() * 100).toFixed(2)} cm vs ${(a20.cx * 100).toFixed(2)} cm`);

console.log('\npour spread WIDENS the stream, in a random direction per grain');
console.log(' spread |  width (rms dia) | clump share | grains near centre');
const rows = [];
for (const s of [0, 4, 8, 16, 30]) {
  const r = land(0, s);
  values.pourAngle = 0; values.pourSpread = s;
  const share = derived.clumpMetres() / derived.landingSpread() * 100;
  rows.push({ s, r, share });
  console.log(`  ${String(s).padStart(4)}° |${(r.rms * 200).toFixed(2).padStart(17)} cm |${share.toFixed(0).padStart(11)}% |${(r.centreShare * 100).toFixed(1).padStart(18)}%`);
}
check('zero spread keeps the stream at the aperture', rows[0].r.rms * 2 <= values.apertureRadius * 1.5,
  `${(rows[0].r.rms * 200).toFixed(2)} cm`);
check('spread widens the stream monotonically', rows.every((x, i) => i === 0 || x.r.rms > rows[i - 1].r.rms));
check('a clump goes from filling the stream to a fraction of it',
  rows[0].share > 35 && rows[rows.length - 1].share < 15,
  `${rows[0].share.toFixed(0)}% -> ${rows[rows.length - 1].share.toFixed(0)}%`);
check('the cone is filled, never a hollow ring',
  rows.every((x) => x.r.centreShare > 0.08), rows.map((x) => (x.r.centreShare * 100).toFixed(0) + '%').join(' '));
check('no grain is ever launched upward', rows.every((x) => x.r.up === 0) && a40.up === 0);

console.log('\npredicted width tracks the simulation');
for (const s of [0, 4, 8, 16, 30]) {
  values.pourAngle = 0; values.pourSpread = s;
  const predicted = derived.landingSpread();
  const measured = 2 * land(0, s).rms;
  const err = Math.abs(measured - predicted) / predicted;
  console.log(`  ${String(s).padStart(4)}° predicted ${(predicted * 100).toFixed(2)} cm, measured ${(measured * 100).toFixed(2)} cm  (${(err * 100).toFixed(0)}% off)`);
  check(`  estimate holds at ${s}°`, err < 0.2, `${(err * 100).toFixed(0)}%`);
}

console.log('\nbackdating still works with a tilted, scattered launch');
values.pourAngle = 20; values.pourSpread = 8;
const P2 = new Particles(50000);
const nz2 = new Nozzle(new Rng(11), new Noise(11));
nz2.step(dt, dt, P2, values);
let ymin = Infinity, ymax = -Infinity;
for (let k = 0; k < P2.count; k++) {
  const y = P2.py[P2.live[k]];
  if (y < ymin) ymin = y;
  if (y > ymax) ymax = y;
}
check('one step of emission is spread vertically', P2.count > 20 && ymax - ymin > 1e-4,
  `${(ymax - ymin).toExponential(2)} m over ${P2.count} grains`);
// A tilted opening puts half its mouth above the nozzle point and half below,
// which is what facing the pour direction means. It may not exceed its own
// radius, though.
check('emission stays within the aperture of the nozzle',
  ymax <= values.nozzleHeight + values.apertureRadius + 1e-9,
  `${((ymax - values.nozzleHeight) * 1000).toFixed(2)} mm above`);

// ---- Aperture shape ----
// Freeze the flight so the emitted positions are the aperture offsets and
// nothing else: no launch speed, no gravity, so the backdate displaces nobody.
function apertureCloud(ball, angleDeg, n = 40000) {
  const keep = { g: values.gravity, v: values.initialSpeed, b: values.apertureBall, a: values.pourAngle };
  values.gravity = 0; values.initialSpeed = 0;
  values.apertureBall = ball; values.pourAngle = angleDeg;
  const P = new Particles(n + 6000);
  const nz = new Nozzle(new Rng(21), new Noise(21));
  for (let f = 0; f < 4000 && P.count < n; f++) nz.step(dt, f * dt, P, values);
  const th = angleDeg * Math.PI / 180;
  const ax = [Math.sin(th), -Math.cos(th), 0];
  const R = values.apertureRadius;
  let maxR = 0, s2 = 0, perp2 = 0, axial2 = 0, inHalf = 0, cnt = 0, maxAxial = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    const o = [P.px[i], P.py[i] - values.nozzleHeight, P.pz[i]];
    const a = o[0] * ax[0] + o[1] * ax[1] + o[2] * ax[2];
    const p2 = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - a * a;
    maxR = Math.max(maxR, Math.hypot(o[0], o[1], o[2]));
    maxAxial = Math.max(maxAxial, Math.abs(a));
    s2 += o[0] ** 2 + o[1] ** 2 + o[2] ** 2;
    perp2 += p2; axial2 += a * a;
    if (p2 < (R / 2) ** 2) inHalf++;
    cnt++;
  }
  Object.assign(values, { gravity: keep.g, initialSpeed: keep.v, apertureBall: keep.b, pourAngle: keep.a });
  return {
    n: cnt, maxOverR: maxR / R,
    rms: Math.sqrt(s2 / cnt) / R,
    rmsPerp: Math.sqrt(perp2 / cnt) / R,
    rmsAxial: Math.sqrt(axial2 / cnt) / R,
    maxAxialOverR: maxAxial / R,
    withinHalf: inHalf / cnt,
  };
}

console.log('\nthe flat aperture faces the way the sand is thrown');
// It did not, once: the disc was written before the pour angle existed and
// stayed horizontal, so a tilted stream was cut obliquely and its
// cross-section squashed by cos(angle) -- a factor of two at 60 degrees.
// Positions are float32, and the axial component comes out of `py - nozzleHeight`
// where the two are within an aperture of each other, so a few ulps of 0.5 m is
// the floor on what "in the plane" can measure. Held horizontal the disc would
// score sin(angle)/2 here -- 0.25 R at 30 degrees, 0.43 R at 60 -- so there are
// four orders of magnitude between passing and the bug.
const F32_FLOOR = 8 * 6e-8 / 0.02;
for (const a of [0, 30, 60]) {
  const d = apertureCloud(false, a);
  const horizontalWouldBe = Math.sin(a * Math.PI / 180) / 2;
  console.log(`  ${String(a).padStart(2)}° | across the stream ${d.rmsPerp.toFixed(4)} R` +
    ` | along it ${d.rmsAxial.toExponential(1)} R (held flat: ${horizontalWouldBe.toFixed(3)} R)` +
    ` | widest ${d.maxOverR.toFixed(4)} R`);
  check(`  square to the axis at ${a}°`, d.rmsAxial < F32_FLOOR, `${d.rmsAxial.toExponential(2)} R off-plane`);
  // A uniform disc has RMS radius R/sqrt(2), whatever it is tilted to.
  check(`  same width at ${a}°`, Math.abs(d.rmsPerp - Math.SQRT1_2) < 0.01, `${d.rmsPerp.toFixed(4)} R`);
  check(`  inside the aperture at ${a}°`, d.maxOverR <= 1 + 1e-12);
}

console.log('\nthe ball is a source with volume, not a wider opening');
{
  const b = apertureCloud(true, 0), d = apertureCloud(false, 0);
  console.log(`  ball | rms radius ${b.rms.toFixed(4)} R (want ${Math.sqrt(0.6).toFixed(4)})` +
    ` | across ${b.rmsPerp.toFixed(4)} R (want ${Math.sqrt(0.4).toFixed(4)})` +
    ` | along ${b.rmsAxial.toFixed(4)} R (want ${Math.sqrt(0.2).toFixed(4)})`);
  // Uniform by volume, not by radius: E[r^2] = 3R^2/5, split evenly over three
  // axes, so 2/5 of it lies across the flow and 1/5 along it.
  check('the ball is uniform by volume', Math.abs(b.rms - Math.sqrt(0.6)) < 0.01, `${b.rms.toFixed(4)} R`);
  check('two fifths of its spread lies across the flow',
    Math.abs(b.rmsPerp - Math.sqrt(0.4)) < 0.01, `${b.rmsPerp.toFixed(4)} R`);
  check('and one fifth along it', Math.abs(b.rmsAxial - Math.sqrt(0.2)) < 0.01, `${b.rmsAxial.toFixed(4)} R`);
  check('nothing escapes the aperture', b.maxOverR <= 1 + 1e-12 && b.maxAxialOverR <= 1 + 1e-12);
  // The difference that shows: the disc releases sand evenly across its width,
  // the ball concentrates it down the middle.
  console.log(`  within half the radius: disc ${(d.withinHalf * 100).toFixed(1)}% (want 25.0%)` +
    `, ball ${(b.withinHalf * 100).toFixed(1)}% (want 35.1%)`);
  check('the disc releases sand evenly across its width',
    Math.abs(d.withinHalf - 0.25) < 0.01, `${(d.withinHalf * 100).toFixed(1)}%`);
  check('the ball concentrates it down the middle',
    Math.abs(b.withinHalf - (1 - Math.pow(0.75, 1.5))) < 0.01, `${(b.withinHalf * 100).toFixed(1)}%`);
  values.pourAngle = 0; values.pourSpread = 8;
  const withDisc = (values.apertureBall = false, derived.landingSpread());
  const withBall = (values.apertureBall = true, derived.landingSpread());
  values.apertureBall = false;
  check('the derived width knows which shape is in use', withBall < withDisc,
    `${(withBall * 100).toFixed(2)} cm vs ${(withDisc * 100).toFixed(2)} cm`);
}

// ---- The stream must not tear ----
// The nozzle backdates a grain onto the exact free-fall curve for its
// sub-frame age; the integrator has to walk that same curve, or the two hand
// off at different places and the stream opens a gap. `x += v_new * dt`
// overshoots it by 0.5*g*dt^2 every step, which is a third of a millimetre at
// the default step and a visible 12.6 cm hole at 0.16 s.
console.log('\nthe emitted ribbon and the integrator agree on the same curve');
{
  values.pourAngle = 0; values.pourSpread = 1; values.clumpFraction = 0;
  values.apertureBall = false;
  const field = new HexField(64, 64, 0.003);
  const g = values.gravity, v0 = values.initialSpeed;

  for (const h of [1 / 120, 0.04, 0.16]) {
    // One step of the integrator, drag and turbulence off, against the
    // analytic fall the backdate assumes for a grain of that age.
    const P = new Particles(16);
    const i = P.alloc();
    P.px[i] = 0; P.py[i] = values.nozzleHeight; P.pz[i] = 0;
    P.vx[i] = 0; P.vy[i] = -v0; P.vz[i] = 0;
    P.radius[i] = 5e-4; P.vol[i] = 1e-10; P.isAgg[i] = 0; P.phase[i] = PHASE_BALLISTIC;
    stepBallistic(P, field, h, { gravity: g, dragCoef: 0, turbAmplitude: 0, curl: null,
      halfW: 1, halfD: 1, tmp: new Float64Array(3) });
    const walked = values.nozzleHeight - P.py[i];
    const analytic = v0 * h + 0.5 * g * h * h;
    const eulerWouldBe = (v0 + g * h) * h;
    console.log(`  step ${h.toFixed(4)} s | integrator ${(walked * 100).toFixed(3)} cm` +
      ` | backdate ${(analytic * 100).toFixed(3)} cm | v_new*dt would be ${(eulerWouldBe * 100).toFixed(3)} cm`);
    check(`  one step matches the backdate at ${h.toFixed(4)} s`,
      Math.abs(walked - analytic) < 1e-6, `${((walked - analytic) * 1000).toExponential(2)} mm apart`);
  }

  // And end to end: pour into a flat field and look for a hole in the column.
  const holeAt = (h) => {
    const P = new Particles(300000);
    const nz = new Nozzle(new Rng(31), new Noise(31));
    const opts = { gravity: g, dragCoef: 0, turbAmplitude: 0, curl: null,
      halfW: 1, halfD: 1, tmp: new Float64Array(3) };
    for (let s = 0; s < Math.ceil(1.0 / h); s++) {
      stepBallistic(P, field, h, opts);
      nz.step(h, s * h, P, values);
    }
    const bins = new Float64Array(52);
    for (let k = 0; k < P.count; k++) {
      const b = Math.round(P.py[P.live[k]] * 100);
      if (b > 0 && b < bins.length) bins[b]++;
    }
    // Against the geometric mean of the neighbours, which follows the stream's
    // own thinning with depth instead of fighting it.
    let worst = 1, at = -1;
    for (let b = 6; b < 45; b++) {
      if (bins[b - 4] < 50 || bins[b + 4] < 50) continue;
      const r = bins[b] / Math.sqrt(bins[b - 4] * bins[b + 4]);
      if (r < worst) { worst = r; at = b; }
    }
    return { worst, at };
  };
  for (const h of [1 / 120, 0.16]) {
    const r = holeAt(h);
    console.log(`  step ${h.toFixed(4)} s | thinnest band ${(r.worst * 100).toFixed(0)}% of its neighbours at ${r.at} cm`);
    check(`  no hole in the stream at ${h.toFixed(4)} s`, r.worst > 0.6,
      `${(r.worst * 100).toFixed(0)}% at ${r.at} cm`);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
