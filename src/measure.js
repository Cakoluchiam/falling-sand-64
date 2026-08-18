// Readouts over the finished pile: the angle its flanks stand at, and whether
// its footprint is round.
//
// Separate from `hexfield.js` because that file is a ledger of mass and this
// one only ever reads, and separate from `exchange.js` because nothing here
// moves sand. Pure over the field's flat arrays, so a test can build a surface
// with a known answer and check the answer comes back.
//
// ## ⚠ Repose is the project's headline output, so these are not conveniences
//
// The whole design rests on the pile's angle being something the simulation
// *produces* rather than something it was told. That makes the measurement
// itself load-bearing: a fit that quietly reads a different quantity -- the
// apex, the skirt of scattered strays, the lattice -- would look like a
// physics result and be an artifact of the estimator.
//
// Three choices here exist for that reason:
//
//  - **The centre is the volume centroid, not the origin.** The default pour
//    is tilted 30 degrees off vertical, so the pile builds downrange. Fitting
//    radii from the origin would measure a cone sliced off-centre, which
//    reads as a shallower flank on one side and a steeper one on the other and
//    averages to neither.
//  - **The fit takes the upper envelope per radial bin**, not the mean height.
//    A mean mixes the flank with whatever lies beyond the pile's edge in the
//    same annulus and bends the profile toward flat as the radius grows.
//  - **The apex and the skirt are both excluded.** The apex is a handful of
//    cells and the skirt is scattered arrivals; the flank is the band between
//    them. This uses 25% to 85% of peak height, which is the band M3's heap
//    fit already used.
//
// ⚠ Every function here reports how many samples the statistic came from, and
// callers must check it. This project has already shipped a distribution
// statistic computed from an empty set and reported as `NaN% rms`, and a
// broad-phase check that passed over a field holding one contact. A fit over
// three bins is not a repose angle.

const DEG = 180 / Math.PI;

// Cells holding less than this fraction of the peak height are not pile. Low
// enough to keep the toe of the flank, high enough to drop the single-cell
// dusting that a few strays leave far out.
const EDGE_FRACTION = 0.02;

/** Volume-weighted centre of the buried pile, or null if nothing is buried. */
export function pileCentre(field) {
  let sx = 0, sz = 0, total = 0;
  for (let c = 0; c < field.n; c++) {
    const v = field.solidVolume[c];
    if (!(v > 0)) continue;
    const q = c % field.W, r = (c / field.W) | 0;
    sx += field.cellX(q, r) * v;
    sz += field.cellZ(r) * v;
    total += v;
  }
  if (!(total > 0)) return null;
  return { x: sx / total, z: sz / total, volume: total };
}

/**
 * The angle the pile's flanks stand at, in degrees, fitted from the buried
 * surface.
 *
 * Returns `{ angle, peak, reach, samples, centre }`. **`angle` is `NaN` unless
 * `samples` is at least `minSamples`** -- a caller that reads the angle without
 * checking the count is reading noise on a pile that has barely started.
 */
export function reposeAngle(field, { bins = 32, loFrac = 0.25, hiFrac = 0.85, minSamples = 5 } = {}) {
  const centre = pileCentre(field);
  const out = { angle: NaN, peak: 0, reach: 0, samples: 0, centre };
  if (!centre) return out;

  const h = field.height;
  let peak = 0;
  for (let c = 0; c < field.n; c++) if (h[c] > peak) peak = h[c];
  out.peak = peak;
  if (!(peak > 0)) return out;

  const edge = peak * EDGE_FRACTION;
  let reach = 0;
  for (let c = 0; c < field.n; c++) {
    if (h[c] <= edge) continue;
    const q = c % field.W, r = (c / field.W) | 0;
    const d = Math.hypot(field.cellX(q, r) - centre.x, field.cellZ(r) - centre.z);
    if (d > reach) reach = d;
  }
  out.reach = reach;
  if (!(reach > 0)) return out;

  // Upper envelope per radial bin: the surface, not the average of everything
  // in the annulus.
  const env = new Float64Array(bins).fill(-1);
  for (let c = 0; c < field.n; c++) {
    if (h[c] <= 0) continue;
    const q = c % field.W, r = (c / field.W) | 0;
    const d = Math.hypot(field.cellX(q, r) - centre.x, field.cellZ(r) - centre.z);
    const b = Math.min(bins - 1, Math.floor((d / reach) * bins));
    if (h[c] > env[b]) env[b] = h[c];
  }

  const lo = peak * loFrac, hi = peak * hiFrac;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let b = 0; b < bins; b++) {
    const y = env[b];
    if (y < 0 || y < lo || y > hi) continue;
    const x = ((b + 0.5) / bins) * reach;
    sx += x; sy += y; sxx += x * x; sxy += x * y; m++;
  }
  out.samples = m;
  if (m < minSamples) return out;

  const denom = m * sxx - sx * sx;
  if (!(Math.abs(denom) > 0)) return out;
  const slope = (m * sxy - sx * sy) / denom;
  out.angle = Math.atan(Math.abs(slope)) * DEG;
  return out;
}

/**
 * How round the footprint is, as the spread of the pile's reach across a ring
 * of bearings, plus the amplitude of its six-fold component.
 *
 * The six-fold term is the one that matters: the lattice has six directions,
 * so anisotropy leaking out of it shows up there specifically rather than as
 * general noise. M2 measured a relaxation rule at 4.1% six-fold and rejected
 * it for that alone.
 *
 * ## ⚠ Thirty-six bearings, not twelve, and twelve cannot work
 *
 * Twelve bearings is exactly Nyquist for a six-cycle signal, and worse, the
 * bin centres land on its zero crossings: `cos(6a)` at 15°, 45°, 75° ... is
 * zero every time. Built with twelve, this reported **0.00% six-fold on a
 * footprint constructed to have 8%**, which is the estimator returning a clean
 * result while measuring nothing.
 *
 * Each sector's reach is also a *maximum* over its width, so a sector as wide
 * as half a lobe picks up that lobe's peak whichever phase it straddles, which
 * flattens the signal independently of the sampling argument. Thirty-six gives
 * six samples per cycle and recovers 8.6% from that same footprint.
 *
 * M3's anisotropy check used twelve bearings and reported "no six-fold
 * signature". On this evidence it could not have found one, and the result
 * should be read as "no gross asymmetry" rather than as a bound on the mode
 * the hex lattice was chosen to avoid.
 *
 * Returns `{ spread, sixfold, mean, samples }`, with `samples` the number of
 * bearings that found any pile at all.
 */
export function footprintAnisotropy(field, { bearings = 36, atFrac = 0.1 } = {}) {
  const centre = pileCentre(field);
  const out = { spread: NaN, sixfold: NaN, mean: 0, samples: 0 };
  if (!centre) return out;

  const h = field.height;
  let peak = 0;
  for (let c = 0; c < field.n; c++) if (h[c] > peak) peak = h[c];
  if (!(peak > 0)) return out;
  const level = peak * atFrac;

  // Furthest cell above `level` within each bearing sector.
  const reach = new Float64Array(bearings);
  for (let c = 0; c < field.n; c++) {
    if (h[c] <= level) continue;
    const q = c % field.W, r = (c / field.W) | 0;
    const dx = field.cellX(q, r) - centre.x, dz = field.cellZ(r) - centre.z;
    const d = Math.hypot(dx, dz);
    if (!(d > 0)) continue;
    let a = Math.atan2(dz, dx);
    if (a < 0) a += Math.PI * 2;
    const b = Math.min(bearings - 1, Math.floor((a / (Math.PI * 2)) * bearings));
    if (d > reach[b]) reach[b] = d;
  }

  let sum = 0, found = 0;
  for (let b = 0; b < bearings; b++) if (reach[b] > 0) { sum += reach[b]; found++; }
  out.samples = found;
  if (found < bearings) return out;          // a gap in the ring is not a shape
  const mean = sum / bearings;
  out.mean = mean;
  if (!(mean > 0)) return out;

  let dev = 0;
  for (let b = 0; b < bearings; b++) dev += (reach[b] - mean) ** 2;
  out.spread = Math.sqrt(dev / bearings) / mean;

  // Amplitude of the 6-per-revolution Fourier component, normalised the same
  // way, so it is directly comparable with the spread above.
  let cs = 0, sn = 0;
  for (let b = 0; b < bearings; b++) {
    const a = ((b + 0.5) / bearings) * Math.PI * 2;
    cs += reach[b] * Math.cos(6 * a);
    sn += reach[b] * Math.sin(6 * a);
  }
  out.sixfold = (2 / bearings) * Math.hypot(cs, sn) / mean;
  return out;
}
