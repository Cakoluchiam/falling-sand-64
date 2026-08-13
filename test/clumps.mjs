const base = new URL('../src/', import.meta.url).href;
const { Rng } = await import(base + 'rng.js');
const { Noise } = await import(base + 'noise.js');
const { values, derived, SAND_PARTICLE_DENSITY } = await import(base + 'params.js');
const { Particles, PHASE_BALLISTIC, PHASE_RESTING } = await import(base + 'particles.js');
const { Nozzle } = await import(base + 'source.js');

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

// This suite is minutes long where every other one is seconds, so CI runs it
// as three jobs and the matrix wall clock becomes the slowest part rather than
// their sum. `node test/clumps.mjs` with no argument still runs everything,
// which is what you want while iterating.
//
// ⚠ Deliberately one file with three entry points rather than three files.
// Every tolerance below is a counting tolerance calibrated against the pinned
// values above, and copying those pins into three files is how they drift
// apart -- this suite has already been broken once by a pin it did not have.
// One place for them, whatever the CI matrix does.
//
//   stream  ~20% of the runtime   the two regressions, and resting inside a lump
//   rate    ~37%                  pooled rate, volume fraction, slider scaling
//   spread  ~41%                  run-to-run consistency against Poisson
const only = process.argv[2];
if (only && !['stream', 'rate', 'spread'].includes(only)) {
  console.error(`unknown part "${only}". Known: stream, rate, spread`);
  process.exit(2);
}
const wants = (name) => !only || only === name;

values.medianDiameter = 0.001;
values.sorting = Math.log(1.4) / 2;
values.minClumpSize = 3.5;
values.maxGrainRatio = 48;
values.clumpFraction = 0.01;
values.clumpSize = 17.1;
values.clumpSorting = Math.log(1.5) / 2;
values.continuousPour = true;
values.surgeDepth = 0;
// ⚠ Pinned like the rest, and it is the one that was missing. Every tolerance
// below is a counting tolerance, and clump counts scale with the volume poured
// -- so this suite's entire error budget rode on a panel default. When the
// user-facing flow rate dropped from 400 g/s to 50 for watchability, counts
// fell eightfold and three unrelated checks failed at once, none of them
// because anything about clumps had changed. Sections that deliberately vary
// the rate save and restore it around themselves.
values.flowRate = 400 / (SAND_PARTICLE_DENSITY * 1000);
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
if (wants('stream')) {
  console.log('clumps arrive with the sand, not after it');
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

// ---- REGRESSION: a clump must not punch a hole in the sand ----
// The whole point of metering the two streams separately. When the clump came
// out of the same volume budget as the grains, one clump was 5000 grains' worth
// of it, and the sand behind it visibly thinned for a tenth of a second. What
// absorbs a large body is the likelihood of the next one, not the flow.
// Body left at its original indentation rather than shifted a level, so the
// gate reads as a gate and the diff stays about the split.
if (wants('stream')) {
console.log('\na clump does not interrupt the sand');
// Run it at the reference pour and at a slow one. A clump is a fixed slug of
// volume, so the slower the sand the longer the hole: 1.25 frames of flow at
// 400 g/s, but 8 at 60 g/s, which is where it was obvious.
const referenceFlow = values.flowRate;
for (const [label, gramsPerSecond] of [['400 g/s', 400], ['60 g/s', 60]]) {
  values.flowRate = gramsPerSecond / (SAND_PARTICLE_DENSITY * 1000);
  console.log(`  --- ${label} (one clump = ` +
    `${(derived.meanClumpVolume() / (values.flowRate * dt)).toFixed(1)} frames of flow) ---`);
  const P = new Particles(200000);
  const nz = new Nozzle(new Rng(19), new Noise(19));
  const FRAMES = 30000, WINDOW = 30;
  const grainVolPerFrame = new Float64Array(FRAMES);
  const clumpFrames = [];
  let prevClumps = 0;
  for (let f = 0; f < FRAMES; f++) {
    nz.step(dt, f * dt, P, values);
    let gv = 0;
    for (let k = P.count - 1; k >= 0; k--) {
      const i = P.live[k];
      if (!P.isAgg[i]) gv += P.vol[i];
      P.free(i);
    }
    grainVolPerFrame[f] = gv;
    if (nz.clumpCount > prevClumps) { clumpFrames.push(f); prevClumps = nz.clumpCount; }
  }
  let all = 0;
  for (const g of grainVolPerFrame) all += g;
  const baseline = all / FRAMES;

  // Every frame from a clump's own frame to WINDOW frames after it -- the
  // stretch the old design spent paying the clump back.
  const after = new Uint8Array(FRAMES);
  for (const f of clumpFrames) {
    for (let d = 0; d < WINDOW && f + d < FRAMES; d++) after[f + d] = 1;
  }
  let wake = 0, wakeN = 0, worstFrame = Infinity;
  for (let f = 0; f < FRAMES; f++) {
    if (!after[f]) continue;
    wake += grainVolPerFrame[f]; wakeN++;
    worstFrame = Math.min(worstFrame, grainVolPerFrame[f]);
  }
  const ratio = (wake / wakeN) / baseline;
  // And the single leanest frame anywhere, clump or not, as a floor check.
  let leanest = Infinity;
  for (const g of grainVolPerFrame) leanest = Math.min(leanest, g);

  console.log(`  ${clumpFrames.length} clumps over ${FRAMES} frames, ${wakeN} frames within ${WINDOW} of one`);
  console.log(`  sand in those frames ${(ratio * 100).toFixed(2)}% of baseline`);
  console.log(`  leanest frame behind a clump ${(worstFrame / baseline * 100).toFixed(1)}% of baseline` +
    `, leanest frame overall ${(leanest / baseline * 100).toFixed(1)}%`);
  check('the sand behind a clump flows at the same rate as anywhere else',
    Math.abs(ratio - 1) < 0.02, `${(ratio * 100).toFixed(2)}%`);
  check('no frame behind a clump is starved', worstFrame > baseline * 0.5,
    `${(worstFrame / baseline * 100).toFixed(1)}%`);

  // The flow rate slider still means the total, lumps included, so the grain
  // stream runs a steady (1 - clumpFraction) of it rather than dipping.
  const total = nz.emittedVolume / (FRAMES * dt);
  console.log(`  total flow ${(total / values.flowRate * 100).toFixed(2)}% of the slider` +
    `, sand alone ${(baseline / dt / values.flowRate * 100).toFixed(2)}%`);
  check('total flow matches the slider', Math.abs(total / values.flowRate - 1) < 0.01,
    `${(total / values.flowRate).toFixed(4)}x`);
  check('the sand alone runs at one minus the clump fraction',
    Math.abs(baseline / dt / values.flowRate - (1 - values.clumpFraction)) < 0.005,
    `${(baseline / dt / values.flowRate).toFixed(4)} vs ${1 - values.clumpFraction}`);
}
values.flowRate = referenceFlow;
}

// ---- Rate and volume fraction, pooled ----
if (wants('rate')) {
  console.log('\npooled over 8 x 120 s');
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
if (wants('spread')) {
  console.log('\nconsistency across 40 separate 30 s pours');
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

// ---- Nothing comes to rest inside a lump ----
// The two streams pass through each other on the way down, which is what lets
// them be metered separately -- there is no contact physics in freefall, so a
// clump and the sand it left the nozzle with need not take turns. It only
// becomes wrong once they stop.
if (wants('stream')) {
  console.log('\nnothing comes to rest inside a lump');
  const P = new Particles(1000);
  const place = (x, y, z, r, agg, phase) => {
    const i = P.alloc();
    P.px[i] = x; P.py[i] = y; P.pz[i] = z;
    P.radius[i] = r; P.vol[i] = (Math.PI / 6) * (2 * r) ** 3;
    P.isAgg[i] = agg ? 1 : 0;
    if (agg) P.markAggregate(i);
    P.phase[i] = phase;
    return i;
  };
  const R = 0.0085, gr = 0.0005;

  const falling = place(0, 0.2, 0, R, true, PHASE_BALLISTIC);
  const inside = place(0.002, 0.2, 0, gr, false, PHASE_RESTING);
  const beside = place(R + gr + 1e-4, 0.2, 0, gr, false, PHASE_RESTING);
  const touching = place(R + gr * 0.9, 0.2, 0, gr, false, PHASE_RESTING);
  check('a grain inside a falling lump is caught', P.fallingClumpContaining(inside) === falling);
  check('a grain clear of it is not', P.fallingClumpContaining(beside) === -1);
  check('nor is one resting against it', P.fallingClumpContaining(touching) === -1,
    'centre-inside, not spheres-touching');

  // The rule that would run away: a lump parked on the pile must not keep
  // eating sand that lands on it. Nothing removes clumps until M4 and nothing
  // stacks them until M3, so they heap up where the sand is landing; applied to
  // resting lumps this drained an 80 s pour from 1% to 27% and climbing.
  P.phase[falling] = PHASE_RESTING;
  check('a lump at rest catches nothing', P.fallingClumpContaining(inside) === -1);

  // What does the work instead: one sweep when the lump arrives. A clump falls
  // at something like seventeen times a grain's terminal velocity, so it lands
  // on the sand it was poured with rather than beside it.
  const before = P.count, lumpVol = P.vol[falling];
  const eaten = P.eatGrainsInside(falling);
  check('landing swallows what is inside it', Math.abs(eaten - P.vol[inside]) < 1e-18,
    `${eaten.toExponential(3)}`);
  check('and leaves what is not', P.count === before - 1 && P.slot[beside] >= 0 && P.slot[touching] >= 0);
  check('the lump does not grow', P.vol[falling] === lumpVol);
  check('it does not eat itself', P.slot[falling] >= 0 && P.aggCount === 1);

  // Freeing a lump has to take it out of the aggregate list, or a stale index
  // gets reused as a grain and every landing grain is measured against it.
  P.free(falling);
  check('freeing a lump drops it from the aggregate list', P.aggCount === 0);
  const reused = place(0, 0.2, 0, gr, false, PHASE_BALLISTIC);
  check('and its slot comes back as an ordinary grain',
    reused === falling && P.aggCount === 0 && P.fallingClumpContaining(beside) === -1);
}

// ---- Controls ----
// Indentation left alone here too; see the note on the first gated section.
if (wants('rate')) {
console.log('\ncontrols');
function rateAt(frac, secs = 120, seeds = 4) {
  values.clumpFraction = frac;
  let n = 0;
  for (let s = 1; s <= seeds; s++) n += pour(s * 13, secs).clumps;
  return { perSec: n / (secs * seeds), n };
}
// ⚠ Pinned, not inherited from the panel defaults.
//
// This statistic is a ratio of two clump counts, so its precision is set by
// how many clumps get counted -- which depends on flow rate and clump size.
// Leaving those on the UI defaults means a cosmetic change to the panel
// silently changes this test's error bar, and that is exactly how it came to
// be flaky: it carried a band that was comfortable under one set of defaults
// and 1.6 sigma under the next. Measured here rather than assumed, so these
// three lines are part of the measurement and not decoration.
values.flowRate = 50 / (SAND_PARTICLE_DENSITY * 1000);
values.clumpSize = 12;
values.clumpSorting = Math.log(1.5) / 2;

// Measured at 10% -> 40%. The window is chosen for precision, not realism:
// the run cost is grain emission and does not vary with clump fraction, so
// counting where clumps are plentiful is strictly cheaper per unit precision.
//
// Pooled ratio over five independent 4-seed groups, at the flow rate above:
//
//     0.5% ->  2%   sd 0.25   (at the old 400 g/s flow)
//       2% ->  8%   sd 0.45
//      10% -> 40%   sd 0.10
//
// The middle row is the trap. It was sd 0.15 at 400 g/s, and dropping the
// user-facing flow rate to 50 g/s costs eight-fold in clump counts -- so
// keeping that window would have left a +-0.45 band sitting at one sigma,
// failing about a third of runs, purely because a presentation default moved.
//
// +-0.4 against sd 0.10 is nominally four sigma. That deliberately exceeds
// three: an sd estimated from five groups is itself uncertain by roughly a
// third, so a band drawn tight against the point estimate would be a band
// drawn against noise. It is still a 10% claim about a scaling law, and every
// window measured is unbiased -- means of 3.995, 4.139 and 4.018 against 4.00.
const r0 = rateAt(0, 30, 2), r1 = rateAt(0.10), r2 = rateAt(0.40);
const ratio = r2.perSec / r1.perSec;
console.log(`  0% -> ${r0.perSec.toFixed(2)}/s,  10% -> ${r1.perSec.toFixed(2)}/s (n=${r1.n}),  40% -> ${r2.perSec.toFixed(2)}/s (n=${r2.n})`);
console.log(`  ratio ${ratio.toFixed(2)}  (want 4.00, measured sd 0.10, band 0.40)`);
check('zero emits no clumps', r0.n === 0);
check('rate scales with the fraction slider', Math.abs(ratio - 4) < 0.4, ratio.toFixed(2));
values.clumpFraction = 0.01;
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
