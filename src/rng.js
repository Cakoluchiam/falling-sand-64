// Seeded PRNG (mulberry32) plus distribution helpers.
// Everything stochastic in the sim routes through one of these so a run is
// fully reproducible from a single seed.

// Abramowitz-Stegun style erfc, good to about 1.2e-7 -- ample for locating
// truncation bounds on a distribution.
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + z / 2);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2);
}

// Acklam's rational approximation to the inverse normal CDF, ~1e-9 relative.
const AQ = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
const BQ = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1];
const CQ = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
  -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
const DQ = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
  3.754408661907416e0];

export function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let q, r;
  if (p < 0.02425) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((CQ[0] * q + CQ[1]) * q + CQ[2]) * q + CQ[3]) * q + CQ[4]) * q + CQ[5]) /
      ((((DQ[0] * q + DQ[1]) * q + DQ[2]) * q + DQ[3]) * q + 1);
  }
  if (p > 1 - 0.02425) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((CQ[0] * q + CQ[1]) * q + CQ[2]) * q + CQ[3]) * q + CQ[4]) * q + CQ[5]) /
      ((((DQ[0] * q + DQ[1]) * q + DQ[2]) * q + DQ[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((AQ[0] * r + AQ[1]) * r + AQ[2]) * r + AQ[3]) * r + AQ[4]) * r + AQ[5]) * q /
    (((((BQ[0] * r + BQ[1]) * r + BQ[2]) * r + BQ[3]) * r + BQ[4]) * r + 1);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small stateful RNG object with the helpers the sim needs.
export class Rng {
  constructor(seed = 1) {
    this.next = mulberry32(seed);
    this._spare = null;
  }

  reseed(seed) {
    this.next = mulberry32(seed >>> 0);
    this._spare = null;
  }

  // Uniform in [a, b).
  range(a, b) {
    return a + (b - a) * this.next();
  }

  // Standard normal via Box-Muller, caching the second deviate.
  gaussian() {
    if (this._spare !== null) {
      const s = this._spare;
      this._spare = null;
      return s;
    }
    let u = 0, v = 0;
    // avoid log(0)
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    this._spare = mag * Math.sin(2.0 * Math.PI * v);
    return mag * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Standard normal restricted to [lo, hi], by inverting the CDF between the
   * bounds.
   *
   * Rejection sampling would be simpler but fails exactly where this is needed:
   * with a tight window it rejects almost every draw, and any fallback after N
   * attempts piles a spike of probability against the boundary. Inverting the
   * CDF costs one uniform draw and is exact for any window, however narrow.
   */
  truncatedGaussian(lo, hi) {
    if (!(hi > lo)) return Number.isFinite(lo) ? lo : 0;
    const a = normalCdf(lo), b = normalCdf(hi);
    // Both bounds out in the same tail: the CDF gap underflows and the inverse
    // is meaningless, so take the nearer bound rather than returning garbage.
    if (!(b - a > 1e-12)) return Math.abs(lo) < Math.abs(hi) ? lo : hi;
    const u = a + (b - a) * this.next();
    return normalQuantile(Math.min(Math.max(u, 1e-12), 1 - 1e-12));
  }

  // Point uniformly distributed on a disc of the given radius. Returns [x, y].
  disc(radius) {
    const r = radius * Math.sqrt(this.next());
    const t = 2 * Math.PI * this.next();
    return [r * Math.cos(t), r * Math.sin(t)];
  }

  // Gamma deviate, Marsaglia-Tsang. Exists only to build dirichlet() below.
  gamma(k) {
    // The method needs k >= 1; boost a smaller shape and correct for it.
    if (k < 1) return this.gamma(k + 1) * Math.pow(this.next(), 1 / k);
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        x = this.gaussian();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      const xx = x * x;
      if (u < 1 - 0.0331 * xx * xx) return d * v;
      if (Math.log(u) < 0.5 * xx + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // n positive shares summing to 1.
  //
  // `concentration` controls evenness: low values put nearly all the mass in
  // one share, high values approach an even split. That is the knob the
  // fragmentation split needs -- a gentle impact should shear one small chunk
  // off a large surviving remainder, a hard one should burst into near-equal
  // pieces -- so it is driven by how far the impact impulse exceeded the break
  // threshold.
  //
  // The residue left by normalising is folded into the largest share. That
  // removes any *systematic* bias, so a million breaks do not walk the volume
  // audit in one direction -- but it does not make the sum bit-exact, and
  // cannot: float addition is not associative, so a caller summing in a
  // different order sees a different last bit. Callers needing exact
  // conservation must not rely on these shares summing to 1; they should size
  // all but one child from the shares and give the remaining child the
  // subtracted remainder.
  dirichlet(n, concentration, out = new Float64Array(n)) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const g = this.gamma(concentration);
      out[i] = g;
      sum += g;
    }
    let largest = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      out[i] /= sum;
      total += out[i];
      if (out[i] > out[largest]) largest = i;
    }
    out[largest] += 1 - total;
    return out;
  }
}
