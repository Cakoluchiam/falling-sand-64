// Seeded PRNG (mulberry32) plus distribution helpers.
// Everything stochastic in the sim routes through one of these so a run is
// fully reproducible from a single seed.

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
