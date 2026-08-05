const base = new URL('../src/', import.meta.url).href;
const { Rng } = await import(base + 'rng.js');
const { Noise } = await import(base + 'noise.js');
const { values, derived, SAND_PARTICLE_DENSITY } = await import(base + 'params.js');
const { Particles } = await import(base + 'particles.js');
const { Nozzle } = await import(base + 'source.js');

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

values.medianDiameter = 0.001;
values.sorting = Math.log(1.4) / 2;
values.minClumpSize = 3.5;
values.maxGrainRatio = 48;
values.clumpFraction = 0.01;
values.clumpSize = 17.1;
values.clumpSorting = Math.log(1.5) / 2;
values.continuousPour = true;
values.surgeDepth = 0;
const dt = 1 / 60;

console.log('setup');
console.log(`  clump ${(derived.clumpMetres() * 1000).toFixed(1)} mm, ${derived.clumpGrains().toFixed(0)} grains of sand, ${(derived.clumpVolume() * SAND_PARTICLE_DENSITY * 1000).toFixed(2)} g`);
console.log(`  one clump = ${(derived.meanClumpVolume() / (values.flowRate * dt)).toFixed(2)} frames of flow\n`);

// Runs a continuous pour, freeing everything so the store never fills.
function pour(seed, seconds) {
  const P = new Particles(200000);
  const nz = new Nozzle(new Rng(seed), new Noise(seed));
  let clumpVol = 0, grainVol = 0, clumps = 0, grains = 0;
  const diams = [], arrivals = [];
  let prev = 0;
  for (let f = 0; f < seconds * 60; f++) {
    nz.step(dt, f * dt, P, values);
    while (nz.clumpCount > prev) { arrivals.push(f * dt); prev++; }
    for (let k = P.count - 1; k >= 0; k--) {
      const i = P.live[k];
      if (P.isAgg[i]) { clumps++; clumpVol += P.vol[i]; diams.push(Math.cbrt(P.vol[i] / (Math.PI / 6)) / values.medianDiameter); }
      else { grains++; grainVol += P.vol[i]; }
      P.free(i);
    }
  }
  return { clumps, grains, clumpVol, grainVol, diams, arrivals, emitted: nz.emittedVolume };
}

// ---- REGRESSION: clumps must not trail the sand ----
console.log('clumps arrive with the sand, not after it');
{
  const P = new Particles(200000);
  const nz = new Nozzle(new Rng(7), new Noise(7));
  let lastGrain = -1, lastClump = -1, fill = -1, prevCount = 0, prevClumps = 0;
  for (let f = 0; f < 1800; f++) {
    nz.step(dt, f * dt, P, values);
    const newClumps = nz.clumpCount - prevClumps;
    if (newClumps > 0) lastClump = f;
    if (P.count - prevCount - newClumps > 0) lastGrain = f;
    if (fill < 0 && P.count >= P.capacity) fill = f;
    prevCount = P.count; prevClumps = nz.clumpCount;
  }
  console.log(`  store filled on frame ${fill} (${(fill * dt).toFixed(2)} s)`);
  console.log(`  last grain frame ${lastGrain}, last clump frame ${lastClump}`);
  check('no clump is emitted after the sand stops', lastClump <= lastGrain, `${lastClump} vs ${lastGrain}`);
  check('nothing is emitted once the store is full', lastGrain <= fill + 1, `${lastGrain} vs ${fill}`);
}

// ---- Rate and volume fraction, pooled ----
console.log('\npooled over 8 x 120 s');
{
  const SECONDS = 120, SEEDS = 8;
  let clumps = 0, grains = 0, clumpVol = 0, grainVol = 0, emitted = 0;
  let diams = [], gaps = [];
  for (let s = 1; s <= SEEDS; s++) {
    const r = pour(s, SECONDS);
    clumps += r.clumps; grains += r.grains;
    clumpVol += r.clumpVol; grainVol += r.grainVol; emitted += r.emitted;
    diams = diams.concat(r.diams);
    // Gaps within a run only -- a gap spanning two seeds is meaningless. One
    // run yields ~57 clumps, so a cv estimated from a single seed carries about
    // 9% noise; pool them.
    for (let i = 1; i < r.arrivals.length; i++) gaps.push(r.arrivals[i] - r.arrivals[i - 1]);
  }
  const want = derived.clumpsPerSecond();
  const expected = want * SECONDS * SEEDS;
  const sd = (clumps - expected) / Math.sqrt(expected);
  const volFrac = clumpVol / (clumpVol + grainVol);
  console.log(`  clumps           ${clumps}  expected ${expected.toFixed(0)}  (${sd >= 0 ? '+' : ''}${sd.toFixed(2)} sd if Poisson)`);
  console.log(`  rate             ${(clumps / (SECONDS * SEEDS)).toFixed(3)}/s, panel predicts ${want.toFixed(3)}/s`);
  console.log(`  one clump per    ${Math.round(grains / clumps).toLocaleString()} grains`);
  console.log(`  volume in clumps ${(volFrac * 100).toFixed(3)}%  (asked 1.000%)`);
  check('rate matches the panel prediction', Math.abs(clumps / expected - 1) < 0.05, `${(clumps / expected).toFixed(3)}x`);
  check('volume fraction matches the slider', Math.abs(volFrac - 0.01) / 0.01 < 0.05, `${(volFrac * 100).toFixed(3)}%`);
  check('volume audit closes', Math.abs(emitted - (clumpVol + grainVol)) / emitted < 1e-9);

  diams.sort((a, b) => a - b);
  const med = diams[diams.length >> 1];
  console.log(`  clump sizes      ${diams[0].toFixed(1)}x .. ${diams[diams.length - 1].toFixed(1)}x, middle ${med.toFixed(1)}x`);
  check('clumps centre on the requested size', Math.abs(med - 17.1) / 17.1 < 0.06, `${med.toFixed(2)}x`);

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const cv = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) / mean;
  // Expected around 0.83: the gap is set by a jittered threshold on a
  // log-normal clump volume, and the previous clump's overshoot carries into
  // the next interval. Bounds are generous because this is a shape check, not
  // a precise one.
  console.log(`  arrival gaps     mean ${mean.toFixed(2)} s, spread ${cv.toFixed(2)} over ${gaps.length} gaps`);
  check('arrivals are jittered, not a metronome', cv > 0.3, `cv ${cv.toFixed(2)}`);
  check('arrivals are not wildly bunched', cv < 1.4, `cv ${cv.toFixed(2)}`);
}

// ---- The point of the self-correcting ledger: consistency run to run ----
// A pour is short. Under a memoryless trigger the clump count per pour is
// Poisson, so variance equals the mean and one pour shows three clumps while
// the next shows none. Crediting per emitted body should tighten that a lot.
console.log('\nconsistency across 40 separate 30 s pours');
{
  const RUNS = 40, SECS = 30;
  const counts = [];
  for (let s = 1; s <= RUNS; s++) counts.push(pour(s * 31, SECS).clumps);
  const mean = counts.reduce((a, b) => a + b, 0) / RUNS;
  const varr = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / RUNS;
  const poissonSd = Math.sqrt(mean);
  const sd = Math.sqrt(varr);
  counts.sort((a, b) => a - b);
  console.log(`  clumps per pour  min ${counts[0]}, median ${counts[RUNS >> 1]}, max ${counts[RUNS - 1]}`);
  console.log(`  mean ${mean.toFixed(2)}, sd ${sd.toFixed(2)}`);
  console.log(`  a memoryless trigger would give sd ${poissonSd.toFixed(2)} (variance = mean)`);
  console.log(`  variance ratio   ${(varr / mean).toFixed(3)}  (1.0 = Poisson, lower = self-correcting)`);
  check('self-correction beats Poisson variance', varr / mean < 0.6, `${(varr / mean).toFixed(3)}`);
  check('every pour shows at least one clump', counts[0] >= 1, `worst run had ${counts[0]}`);
}

// ---- Controls ----
console.log('\ncontrols');
function rateAt(frac, secs = 120, seeds = 4) {
  values.clumpFraction = frac;
  let n = 0;
  for (let s = 1; s <= seeds; s++) n += pour(s * 13, secs).clumps;
  return { perSec: n / (secs * seeds), n };
}
const r0 = rateAt(0, 30, 2), r1 = rateAt(0.005), r2 = rateAt(0.02);
const ratio = r2.perSec / r1.perSec;
console.log(`  0% -> ${r0.perSec.toFixed(2)}/s,  0.5% -> ${r1.perSec.toFixed(2)}/s (n=${r1.n}),  2% -> ${r2.perSec.toFixed(2)}/s (n=${r2.n})`);
console.log(`  ratio ${ratio.toFixed(2)}  (want 4.00)`);
check('zero emits no clumps', r0.n === 0);
check('rate scales with the fraction slider', Math.abs(ratio - 4) < 0.4, ratio.toFixed(2));
values.clumpFraction = 0.01;

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
