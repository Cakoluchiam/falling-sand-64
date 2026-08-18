// Readouts over a finished pile, checked against surfaces whose answer is
// known in advance.
//
// Repose angle is this project's headline output, so the estimator is itself
// load-bearing: a fit that quietly reads the apex, the skirt, or the lattice
// would look like a physics result. Every case here builds a surface with an
// arithmetic answer and asks for it back.

import { HexField } from '../src/hexfield.js';
import { reposeAngle, footprintAnisotropy, pileCentre } from '../src/measure.js';

let failures = 0, ran = 0;
const check = (n, c, x = '') => { ran++; console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

const DEG = Math.PI / 180;
const SPACING = 0.003;

// A cone of a given flank angle, centred where you ask. Written straight into
// the height array, with `solidVolume` kept consistent so the centroid has
// something to weigh.
function cone({ deg = 32, radius = 0.06, cx = 0, cz = 0, shape = null } = {}) {
  const f = new HexField(160, 160, SPACING);
  const tan = Math.tan(deg * DEG);
  for (let r = 0; r < f.H; r++) {
    for (let q = 0; q < f.W; q++) {
      const x = f.cellX(q, r), z = f.cellZ(r);
      const dx = x - cx, dz = z - cz;
      const d = Math.hypot(dx, dz);
      // `shape` lets the footprint be something other than a circle, so the
      // anisotropy detector can be shown to fire when it should.
      const rad = shape ? radius * shape(Math.atan2(dz, dx)) : radius;
      if (d >= rad) continue;
      const h = (rad - d) * tan;
      const c = f.index(q, r);
      f.height[c] = h;
      f.solidVolume[c] = h * f.cellArea * f.packingFraction;
    }
  }
  f.markAllDirty();
  return f;
}

console.log('a cone of a known angle measures back as that angle');
for (const deg of [18, 26, 32, 41]) {
  const f = cone({ deg });
  const m = reposeAngle(f);
  check(`  ${deg}° cone reads ${m.angle.toFixed(2)}° over ${m.samples} bins`,
    Math.abs(m.angle - deg) < 0.6, `off by ${(m.angle - deg).toFixed(2)}°`);
}

console.log('');
console.log('and still does when the pile is not at the origin');
// The default pour is tilted 30° off vertical, so the pile builds downrange.
// Fitting radii from the origin would slice the cone off-centre and read a
// different angle on each side.
{
  const f = cone({ deg: 32, cx: 0.05, cz: -0.04 });
  const c = pileCentre(f);
  const m = reposeAngle(f);
  check('  the centroid finds the pile', Math.hypot(c.x - 0.05, c.z + 0.04) < SPACING);
  check(`  the offset cone still reads ${m.angle.toFixed(2)}°`,
    Math.abs(m.angle - 32) < 0.6, `off by ${(m.angle - 32).toFixed(2)}°`);
}

console.log('');
console.log('a statistic with nothing behind it reports so, rather than a number');
// ⚠ The recurring defect in this project's tests is a statistic computed over
// an empty set and reported as though it meant something -- a banding metric
// that printed `NaN% rms`, a broad-phase check over one contact. The angle is
// NaN until the sample count justifies it, and the count is returned so a
// caller has to look.
{
  const empty = new HexField(64, 64, SPACING);
  const m = reposeAngle(empty);
  check('  an empty field has no angle', Number.isNaN(m.angle));
  check('  and says it took no samples', m.samples === 0);
  check('  its centre is null rather than the origin', pileCentre(empty) === null);

  // A pile two cells across: real height, far too little of it to fit.
  const tiny = new HexField(64, 64, SPACING);
  const c = tiny.index(32, 32);
  tiny.height[c] = 0.004;
  tiny.solidVolume[c] = 0.004 * tiny.cellArea * tiny.packingFraction;
  const t = reposeAngle(tiny);
  check('  a two-cell pile has no angle either', Number.isNaN(t.angle),
    `got ${t.angle} from ${t.samples} bins`);
}

console.log('');
console.log('the angle is the pile’s, not the buried fraction’s');
{
  // ⚠ `height` is only what has been absorbed; the grains standing on it are
  // the rest of the pile. Fitting the flank off `height` alone measures
  // whatever fraction happens to be buried, so the answer moves with the
  // absorption rate rather than with the physics -- a heightfield-only fit read
  // 22.5° at a 2-diameter active layer and 6.8° at 4, where the deeper setting
  // simply had most of its pile still in grains.
  const f = cone({ deg: 32, radius: 0.06 });
  // Bury only a third of it, and let `grainTop` carry the rest.
  for (let c = 0; c < f.n; c++) {
    if (f.height[c] <= 0) continue;
    f.grainTop[c] = f.height[c];
    f.height[c] *= 1 / 3;
  }
  const buriedOnly = reposeAngle(f, { surface: f.height });
  const whole = reposeAngle(f);
  console.log(`    buried third alone reads ${buriedOnly.angle.toFixed(1)}°,` +
    ` the whole pile ${whole.angle.toFixed(1)}°`);
  check('  the buried fraction alone under-reads badly',
    Math.abs(buriedOnly.angle - 32) > 8, `read ${buriedOnly.angle.toFixed(1)}°`);
  check('  the pile surface still reads its true angle',
    Math.abs(whole.angle - 32) < 0.8, `read ${whole.angle.toFixed(1)}°`);
}

console.log('');
console.log('a round footprint reads round, and a six-fold one does not');
{
  const round = footprintAnisotropy(cone({ deg: 32 }));
  console.log(`    circular cone: spread ${(round.spread * 100).toFixed(2)}%,` +
    ` six-fold ${(round.sixfold * 100).toFixed(2)}%`);
  check('  every bearing found the pile', round.samples === 36);
  check('  a circular footprint spreads under 2%', round.spread < 0.02,
    `${(round.spread * 100).toFixed(2)}%`);
  check('  and shows no six-fold component', round.sixfold < 0.02,
    `${(round.sixfold * 100).toFixed(2)}%`);

  // ⚠ The positive control. Without it this only proves the detector is quiet,
  // which a function returning zero would also manage -- and the whole reason
  // the lattice is hexagonal is that this measurement can catch it printing
  // itself onto the pile.
  const hex = footprintAnisotropy(cone({ deg: 32, shape: (a) => 1 + 0.08 * Math.cos(6 * a) }));
  console.log(`    8% six-fold footprint: spread ${(hex.spread * 100).toFixed(2)}%,` +
    ` six-fold ${(hex.sixfold * 100).toFixed(2)}%`);
  check('  an 8% six-fold footprint is detected as six-fold',
    hex.sixfold > 0.05, `only ${(hex.sixfold * 100).toFixed(2)}%`);
  check('  and reported near its true amplitude',
    Math.abs(hex.sixfold - 0.08) < 0.03, `${(hex.sixfold * 100).toFixed(2)}% against 8%`);
}

if (ran === 0) { console.log('\nFAIL the suite ran no checks at all'); process.exit(1); }
console.log(failures === 0 ? `\nall ${ran} measure checks passed` : `\n${failures} of ${ran} FAILED`);
process.exit(failures === 0 ? 0 : 1);
