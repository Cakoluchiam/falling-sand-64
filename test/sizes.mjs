const base = new URL('../src/', import.meta.url).href;
const { Rng, normalCdf, normalQuantile } = await import(base + 'rng.js');
const { Noise } = await import(base + 'noise.js');
const { values, derived, SCHEMA, enforceConstraints } = await import(base + 'params.js');
const { Nozzle } = await import(base + 'source.js');

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

console.log('inverse normal CDF round-trips');
let worst = 0;
for (let i = 1; i < 1000; i++) { const p = i / 1000; worst = Math.max(worst, Math.abs(normalCdf(normalQuantile(p)) - p)); }
check('quantile inverts the CDF', worst < 1e-6, worst.toExponential(2));

values.medianDiameter = 0.001;
const nz = new Nozzle(new Rng(5), new Noise(5));
const N = 400000;
function sample(n = N) {
  let min = Infinity, max = 0, sum = 0;
  const all = [];
  for (let i = 0; i < n; i++) {
    const d = nz.sampleDiameter(values);
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
    if (i < 50000) all.push(d);
  }
  all.sort((a, b) => a - b);
  return { min, max, mean: sum / n, median: all[all.length >> 1] };
}

console.log('\nuniform sand is reachable');
values.sorting = 0;
values.minGrainRatio = 0.1; values.maxGrainRatio = 12;
const uni = sample(50000);
check('sorting 0 gives one exact size', uni.min === uni.max && uni.min === values.medianDiameter,
  `${(uni.min * 1000).toFixed(4)} .. ${(uni.max * 1000).toFixed(4)} mm`);
const s = SCHEMA.find((x) => x.key === 'sorting');
check('the slider can reach it', s.minSI === 0 && Math.abs(s.toDisplay(s.minSI) - 1) < 1e-9,
  `min sigma ${s.minSI}, shows ${s.toDisplay(s.minSI)}x`);
check('slider midpoint is still 2.0x', Math.abs(s.toDisplay((s.minSI + s.maxSI) / 2) - 2) < 0.01);

console.log('\nboth limits are honoured, however tight');
for (const [lo, hi, sortRatio] of [[0.1, 12, 2.0], [0.5, 2, 3.7], [0.9, 1.1, 3.7], [0.02, 48, 4.0]]) {
  values.minGrainRatio = lo; values.maxGrainRatio = hi;
  values.sorting = Math.log(sortRatio) / 2;
  const r = sample(200000);
  const loD = lo * values.medianDiameter, hiD = hi * values.medianDiameter;
  const ok = r.min >= loD - 1e-12 && r.max <= hiD + 1e-12;
  console.log(`  [${lo}x, ${hi}x] at ${sortRatio}x sorting -> ${(r.min / values.medianDiameter).toFixed(3)}x .. ${(r.max / values.medianDiameter).toFixed(3)}x`);
  check(`  limits honoured for [${lo}, ${hi}]`, ok);
  // A tight window must fill, not pile against one edge.
  if (hi / lo < 2) {
    const span = (r.max - r.min) / (hiD - loD);
    check('  a tight window is filled, not spiked at an edge', span > 0.9, `spans ${(span * 100).toFixed(1)}% of it`);
  }
}

console.log('\nno airborne dust once the floor is raised');
values.sorting = Math.log(3.7) / 2; values.maxGrainRatio = 48;
values.minGrainRatio = 0.02;
const wide = sample();
values.minGrainRatio = 0.5;
const floored = sample();
const vTerm = (d) => values.fallSpeed * (d / values.medianDiameter);
console.log(`  floor 0.02x -> smallest ${(wide.min * 1000).toFixed(4)} mm, falls at ${vTerm(wide.min).toFixed(2)} m/s`);
console.log(`  floor 0.50x -> smallest ${(floored.min * 1000).toFixed(4)} mm, falls at ${vTerm(floored.min).toFixed(2)} m/s`);
check('raising the floor removes the slow fines', vTerm(floored.min) > vTerm(wide.min) * 5);

console.log('\nconstraints');
values.minGrainRatio = 0.95; values.maxGrainRatio = 1.05;
enforceConstraints();
check('window stays open and contains the median',
  values.minGrainRatio < 1 && values.maxGrainRatio > 1 && values.minGrainRatio < values.maxGrainRatio,
  `[${values.minGrainRatio}, ${values.maxGrainRatio}]`);
values.minGrainRatio = 2; values.maxGrainRatio = 1.5;
enforceConstraints();
check('an inverted window is repaired', values.minGrainRatio < values.maxGrainRatio,
  `[${values.minGrainRatio}, ${values.maxGrainRatio}]`);

console.log('\nmean grain volume drives the bucket count');
values.minGrainRatio = 0.1; values.maxGrainRatio = 12;
values.sorting = Math.log(2) / 2;
const r = sample(300000);
let vs = 0;
{
  const n2 = new Nozzle(new Rng(9), new Noise(9));
  for (let i = 0; i < 300000; i++) { const d = n2.sampleDiameter(values); vs += (Math.PI / 6) * d * d * d; }
}
const measured = vs / 300000;
console.log(`  measured mean volume ${measured.toExponential(4)}, derived ${derived.meanGrainVolume().toExponential(4)}`);
check('derived mean volume matches sampling', Math.abs(measured / derived.meanGrainVolume() - 1) < 0.03,
  `${(measured / derived.meanGrainVolume()).toFixed(3)}x`);
check('mean exceeds median volume', derived.meanGrainVolume() > derived.grainVolume());

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
