const base = new URL('../src/', import.meta.url).href;
const { Rng } = await import(base + 'rng.js');
const { Noise } = await import(base + 'noise.js');
const { values, derived } = await import(base + 'params.js');
const { Particles } = await import(base + 'particles.js');
const { Nozzle } = await import(base + 'source.js');

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
check('nothing is emitted above the nozzle', ymax <= values.nozzleHeight + 1e-9);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
