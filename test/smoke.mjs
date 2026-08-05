// Headless smoke test of the pure (non-DOM, non-GL) modules.
const base = new URL('../src/', import.meta.url).href;

const { Rng } = await import(base + 'rng.js');
const { Noise, CurlField } = await import(base + 'noise.js');
const { CONFIG, values, domainBounds, enforceConstraints } = await import(base + 'params.js');
const { Particles, PHASE_RESTING } = await import(base + 'particles.js');
const { Nozzle } = await import(base + 'source.js');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); failures++; }
}

console.log('rng');
const rng = new Rng(42);
let mn = 1, mx = 0;
for (let i = 0; i < 100000; i++) { const v = rng.next(); if (v < mn) mn = v; if (v > mx) mx = v; }
check('uniform in [0,1)', mn >= 0 && mx < 1, `[${mn}, ${mx}]`);

rng.reseed(42);
const a = [rng.next(), rng.next(), rng.next()];
rng.reseed(42);
const b = [rng.next(), rng.next(), rng.next()];
check('reseed reproduces', a.every((v, i) => v === b[i]));

let gs = 0, gss = 0;
for (let i = 0; i < 200000; i++) { const g = rng.gaussian(); gs += g; gss += g * g; }
const gMean = gs / 200000, gVar = gss / 200000 - gMean * gMean;
check('gaussian mean ~0', Math.abs(gMean) < 0.01, gMean.toFixed(4));
check('gaussian var ~1', Math.abs(gVar - 1) < 0.02, gVar.toFixed(4));

// dirichlet: no systematic drift (bit-exactness is not achievable across
// summation orders), positivity, and evenness that tracks concentration.
let worstSum = 0, signedDrift = 0, negatives = 0;
for (let i = 0; i < 20000; i++) {
  const n = 2 + (i % 7);
  const s = rng.dirichlet(n, 0.15 + (i % 5));
  let sum = 0;
  for (let j = 0; j < n; j++) { sum += s[j]; if (s[j] < 0) negatives++; }
  worstSum = Math.max(worstSum, Math.abs(sum - 1));
  signedDrift += sum - 1;
}
check('dirichlet shares are positive', negatives === 0, `${negatives} negative`);
check('dirichlet sums to 1 within a few ulps', worstSum < 8 * Number.EPSILON, `worst dev ${worstSum}`);
check('dirichlet has no systematic drift', Math.abs(signedDrift / 20000) < Number.EPSILON,
  `mean drift ${(signedDrift / 20000).toExponential(2)}`);

// The behaviour fragmentation actually needs: concentration must control how
// asymmetric a 2-way split is, monotonically. Low = shear a chunk off a large
// remainder; high = burst into near-equal pieces.
function meanMaxShare(n, conc, trials = 20000) {
  const r = new Rng(11);
  let acc = 0;
  for (let i = 0; i < trials; i++) acc += Math.max(...r.dirichlet(n, conc));
  return acc / trials;
}
const shear = meanMaxShare(2, 0.15);
const mid = meanMaxShare(2, 1.5);
const burst = meanMaxShare(2, 20);
check('2-way split at low concentration is a shear', shear > 0.9, shear.toFixed(3));
check('2-way split at high concentration is near-even', burst < 0.62, burst.toFixed(3));
check('evenness is monotonic in concentration', shear > mid && mid > burst,
  `${shear.toFixed(3)} > ${mid.toFixed(3)} > ${burst.toFixed(3)}`);
const burst8 = meanMaxShare(8, 20);
check('many-way burst spreads volume', burst8 < 0.25, burst8.toFixed(3));

console.log('noise');
const noise = new Noise(7);
let nmin = 9, nmax = -9;
for (let i = 0; i < 200000; i++) {
  const v = noise.noise3(i * 0.013, i * 0.0071, i * 0.0037);
  if (v < nmin) nmin = v;
  if (v > nmax) nmax = v;
}
check('noise3 bounded', nmin > -1.5 && nmax < 1.5, `[${nmin.toFixed(3)}, ${nmax.toFixed(3)}]`);
check('noise3 spans a real range', nmax - nmin > 0.8, (nmax - nmin).toFixed(3));
check('noise3 is zero at lattice points', Math.abs(noise.noise3(3, 5, 8)) < 1e-6);

console.log('curl field');
const { min, size } = domainBounds(values.nozzleHeight * 1.15);
const cf = new CurlField(noise, CONFIG.turbNodeBudget, CONFIG.turbMaxRes);
check('setBounds allocates', cf.setBounds(min, size) === true);
check('setBounds is a no-op when unchanged', cf.setBounds(min, size) === false);
console.log(`  info grid ${[...cf.res].join(' x ')} over ${size.map((s) => s.toFixed(2)).join(' x ')} m`);
// Cells should stay roughly cubic even though the region is not.
const cell = [...cf.res].map((r, i) => size[i] / r);
check('cells stay roughly isotropic', Math.max(...cell) / Math.min(...cell) < 2.5,
  cell.map((c) => (c * 100).toFixed(1) + 'cm').join(' x '));
// A tall pour must not collapse the horizontal resolution.
const tall = domainBounds(12.5);
cf.setBounds(tall.min, tall.size);
check('tall pour keeps horizontal resolution', cf.res[0] >= 4 && cf.res[2] >= 4, [...cf.res].join('x'));
cf.setBounds(min, size);
const t0 = performance.now();
cf.rebuild(0, 0.2);
const rebuildMs = performance.now() - t0;
const out = new Float64Array(3);
cf.sample(0, 1, 0, out);
check('curl finite', out.every(Number.isFinite), `[${out.join(', ')}]`);
let cmax = 0;
for (let i = 0; i < 2000; i++) {
  cf.sample(rng.range(min[0], min[0] + size[0]), rng.range(0, size[1]), rng.range(min[2], min[2] + size[2]), out);
  cmax = Math.max(cmax, Math.hypot(out[0], out[1], out[2]));
}
check('curl magnitude O(1)', cmax > 0.05 && cmax < 20, cmax.toFixed(3));
console.log(`  info rebuild ${rebuildMs.toFixed(2)} ms (budget is ${CONFIG.frameBudgetMs} ms, every ${CONFIG.turbRebuildFrames} frames)`);

// Out-of-bounds must clamp, not wrap or NaN.
cf.sample(1e6, -1e6, 1e6, out);
check('curl clamps out of bounds', out.every(Number.isFinite));

console.log('particles');
const P = new Particles(1000);
const idx = [];
for (let i = 0; i < 1000; i++) idx.push(P.alloc());
check('alloc fills to capacity', P.count === 1000 && idx.every((v) => v >= 0));
check('alloc returns -1 when full', P.alloc() === -1);
for (const i of idx) P.vol[i] = 2;
check('totalVolume', Math.abs(P.totalVolume() - 2000) < 1e-6);
// Free a scattered set; live list must stay consistent and dense.
for (let i = 0; i < 1000; i += 3) P.free(idx[i]);
const expected = 1000 - Math.ceil(1000 / 3);
check('count after frees', P.count === expected, `${P.count} vs ${expected}`);
const seen = new Set();
let liveOk = true;
for (let k = 0; k < P.count; k++) {
  const i = P.live[k];
  if (seen.has(i) || P.slot[i] !== k) liveOk = false;
  seen.add(i);
}
check('live/slot stay consistent', liveOk);
const re = P.alloc();
check('freed slots are recycled', re >= 0 && P.count === expected + 1);

console.log('nozzle');
enforceConstraints();
const dt = 1 / 60;

// With modulation off, the volume-debt accumulator alone should track the
// requested rate to within one grain volume -- that is the whole point of
// carrying a fractional remainder instead of rounding grain counts.
// At 1 mm sand and 400 g/s the 200k store fills in 0.7 s, so keep the run
// inside that -- otherwise this measures the store's capacity, not the debt.
const P2 = new Particles(200000);
const nz = new Nozzle(new Rng(1), new Noise(1));
// clumpFraction 0: this measures the grain jar, and the clump jar deliberately
// holds its share back until a whole clump is affordable.
const steady = { ...values, surgeDepth: 0, clumpFraction: 0 };
let t = 0;
for (let f = 0; f < 24; f++) { t += dt; nz.step(dt, t, P2, steady); }
check('store did not fill during the debt test', P2.count < P2.capacity, `${P2.count}`);
const expectedVol = steady.flowRate * t;
const err = Math.abs(nz.emittedVolume - expectedVol) / expectedVol;
check('debt accumulator tracks flowRate * time', err < 0.002, `${(err * 100).toFixed(3)}% off`);
check('grains actually spawned', P2.count > 1000, String(P2.count));

// Burst intensity must change how uneven the flow is WITHOUT changing its mean,
// or a flow-rate sweep is secretly a burst-intensity sweep too.
function burstStats(intensity, samples = 400000) {
  const n2 = new Nozzle(new Rng(3), new Noise(3));
  const v = { ...values, surgeDepth: intensity };
  let sum = 0, sumSq = 0, lo = Infinity, hi = 0;
  for (let i = 0; i < samples; i++) {
    const f = n2.burstFactor(i * 0.01, v);
    sum += f; sumSq += f * f;
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  const mean = sum / samples;
  return { mean, cv: Math.sqrt(sumSq / samples - mean * mean) / mean, lo, hi };
}
const b0 = burstStats(0), b5 = burstStats(0.5), b10 = burstStats(1.0);
check('mean rate is 1.000 at intensity 0', Math.abs(b0.mean - 1) < 0.001, b0.mean.toFixed(4));
check('mean rate unchanged at intensity 0.5', Math.abs(b5.mean - 1) < 0.02, b5.mean.toFixed(4));
check('mean rate unchanged at intensity 1.0', Math.abs(b10.mean - 1) < 0.02, b10.mean.toFixed(4));
check('intensity increases unevenness', b0.cv < 1e-9 && b5.cv > 0.1 && b10.cv > b5.cv,
  `cv ${b0.cv.toFixed(3)} -> ${b5.cv.toFixed(3)} -> ${b10.cv.toFixed(3)}`);
check('chokes and surges are dramatic at full intensity', b10.lo < 0.35 && b10.hi > 2.5,
  `range ${b10.lo.toFixed(3)} .. ${b10.hi.toFixed(2)}`);

// Backdating must spread grains vertically within a frame, not stack them in a
// pancake at the nozzle plane.
const P3 = new Particles(200000);
const nz3 = new Nozzle(new Rng(5), new Noise(5));
nz3.step(dt, dt, P3, values);
let ymin = Infinity, ymax = -Infinity;
for (let k = 0; k < P3.count; k++) {
  const y = P3.py[P3.live[k]];
  if (y < ymin) ymin = y;
  if (y > ymax) ymax = y;
}
const spread = ymax - ymin;
check('one frame of emission is spread vertically', P3.count > 5 && spread > 1e-4, `spread ${spread.toExponential(2)} over ${P3.count} grains`);
check('no grain is above the nozzle', ymax <= values.nozzleHeight + 1e-9, `${ymax} vs ${values.nozzleHeight}`);

// Grains are always solid particles. Size never promotes one to a clump --
// clumps are a separate thing representing many grains bound together, and the
// only threshold in play is the fragmentation floor, which is about breaking a
// clump *down*, not about how big a grain got.
function grainStats(maxRatio, n = 300000) {
  const saved = { max: values.maxGrainRatio, sorting: values.sorting };
  values.maxGrainRatio = maxRatio;
  values.sorting = 0.8;                 // wide enough that the tail is reachable
  try {
    const nz2 = new Nozzle(new Rng(99), new Noise(99));
    let maxSeen = 0, over = 0;
    const capD = maxRatio * values.medianDiameter;
    for (let i = 0; i < n; i++) {
      const d = nz2.sampleDiameter(values);
      if (d > maxSeen) maxSeen = d;
      if (d > capD + 1e-15) over++;
    }
    return { maxSeen, over, capD };
  } finally {
    values.maxGrainRatio = saved.max;
    values.sorting = saved.sorting;
  }
}
const wide = grainStats(48);
const tight = grainStats(4);
check('grain size cap is respected', tight.over === 0 && wide.over === 0, `${tight.over} over cap`);
check('lowering the cap trims the tail', tight.maxSeen < wide.maxSeen,
  `${(tight.maxSeen * 1000).toFixed(2)} vs ${(wide.maxSeen * 1000).toFixed(2)} mm`);
check('the cap does not distort the bulk of the distribution',
  Math.abs(tight.maxSeen / tight.capD - 1) < 0.05, `max reached ${(tight.maxSeen / tight.capD).toFixed(3)} of cap`);

// A grain must never come out flagged as a clump, at any sorting.
{
  const P4 = new Particles(60000);
  const nz4 = new Nozzle(new Rng(21), new Noise(21));
  const v = { ...values, sorting: Math.log(3.7) / 2, clumpFraction: 0, surgeDepth: 0 };
  for (let f = 0; f < 120; f++) nz4.step(dt, f * dt, P4, v);
  let flagged = 0;
  for (let k = 0; k < P4.count; k++) if (P4.isAgg[P4.live[k]]) flagged++;
  check('no grain is ever flagged as a clump', flagged === 0, `${flagged} of ${P4.count}`);
  check('the widest sorting still produced grains', P4.count > 1000, String(P4.count));
}

console.log('\nsandbox reality check');
const gv = (Math.PI / 6) * values.medianDiameter ** 3;
console.log(`  median grain     ${(values.medianDiameter * 1000).toFixed(2)} mm  (${(gv * 1e9).toFixed(2)} mm^3)`);
console.log(`  flow rate        ${(values.flowRate * 2650 * 1000).toFixed(0)} g/s`);
console.log(`  bucket           ${values.dropMass} kg = ${(values.dropMass / 2650 / gv / 1e6).toFixed(1)}M grains`);
console.log(`  200k grains      ${(200000 * gv * 2650 * 1000).toFixed(0)} g  (${(200000 * gv / values.flowRate).toFixed(1)} s of pouring)`);
console.log(`  domain           ${(CONFIG.domainWidth * 100).toFixed(0)} x ${(CONFIG.domainDepth * 100).toFixed(0)} cm`);
console.log(`  pour height      ${(values.nozzleHeight * 100).toFixed(0)} cm, free fall ${Math.sqrt(2 * values.nozzleHeight / values.gravity).toFixed(2)} s`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
