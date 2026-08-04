// The nozzle: volumetric, uneven flow.

import { PHASE_BALLISTIC } from './particles.js';

const PI_6 = Math.PI / 6;

export class Nozzle {
  constructor(rng, noise, gravity) {
    this.rng = rng;
    this.noise = noise;
    this.gravity = gravity;
    this.reset();

    // Calibration samples for the rate modulation, so that raising
    // burstIntensity changes how uneven the flow is without also changing how
    // much sand comes out. Without this the two knobs are coupled and a flow
    // rate sweep would be measuring burst intensity as well.
    //
    // These are kept rather than reduced to a mean and variance because the
    // correction needs E[exp(k*n)], and Perlin noise is not Gaussian -- the
    // closed-form lognormal mean is noticeably wrong for it. Computing the
    // expectation directly from samples is exact for whatever the distribution
    // actually is, and only runs when the intensity slider moves.
    this.noiseSamples = new Float64Array(4096);
    for (let i = 0; i < this.noiseSamples.length; i++) {
      this.noiseSamples[i] = noise.noise1(i * 0.37);
    }
    this._cachedK = NaN;
    this._meanFactor = 1;
  }

  _normaliser(k) {
    if (k === this._cachedK) return this._meanFactor;
    const s = this.noiseSamples;
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += Math.exp(k * s[i]);
    this._cachedK = k;
    this._meanFactor = sum / s.length;
    return this._meanFactor;
  }

  reset() {
    this.debt = 0;
    this.emittedVolume = 0;
    this.emittedCount = 0;
  }

  // Instantaneous rate multiplier. Choking is correlated in time -- the flow
  // starves for a while, then releases -- so this is low-frequency gradient
  // noise, not per-spawn jitter. Exponentiating gives heavier tails and more
  // dramatic chokes than the raw noise would.
  burstFactor(t, v) {
    if (v.burstIntensity <= 0) return 1;
    const k = v.burstIntensity * 3;
    const n = this.noise.noise1(t / Math.max(v.burstTimescale, 1e-3));
    // Divide out E[exp(k*n)] so only the variance of the rate is being dialled,
    // not its mean.
    return Math.exp(k * n) / this._normaliser(k);
  }

  // Grain diameter, log-normal and truncated.
  //
  // The truncation rule matters more than it looks. Resampling an over-cap draw
  // from the full distribution would return a sub-threshold grain almost every
  // time, so raising or lowering maxGrainDiameter would quietly change how
  // *often* clumps appear rather than only how big they get. Redrawing within
  // the clump range instead conserves the clump count exactly.
  sampleDiameter(v) {
    const d = v.medianDiameter * Math.exp(v.sorting * this.rng.gaussian());
    if (d <= v.maxGrainDiameter) return d;
    return this.rng.range(v.clumpThreshold, v.maxGrainDiameter);
  }

  /**
   * Emit one frame's worth of grains.
   *
   * Sub-frame emission is backdated rather than jittered: a grain conceptually
   * emitted partway through the frame is placed where it would actually have
   * fallen to by frame end, and given the velocity it would have accumulated.
   * Spawning them all at the nozzle plane instead would emit a visible
   * horizontal pancake, and vertical random jitter would not be
   * framerate-independent the way this is.
   */
  step(dt, t, particles, v) {
    if (!v.continuousPour && this.emittedVolume >= v.dropVolume) return 0;

    const rate = v.flowRate * this.burstFactor(t, v);
    const budget = rate * dt;
    if (budget <= 0) return 0;

    this.debt += budget;
    // Bound the backlog so a rate spike cannot queue up an unbounded burst.
    if (this.debt > budget * 4) this.debt = budget * 4;

    const g = this.gravity;
    const y0 = v.nozzleHeight;
    const vy0 = -v.initialSpeed;
    const clumpPack = Math.max(v.packingFraction, 0.05);
    let consumed = 0;
    let spawned = 0;

    while (this.debt > 0) {
      const d = this.sampleDiameter(v);
      const vol = PI_6 * d * d * d;

      if (!v.continuousPour && this.emittedVolume + vol > v.dropVolume) break;

      const i = particles.alloc();
      if (i < 0) break;  // store full; leave the debt for later

      // Where in the frame this grain conceptually left the nozzle.
      const frac = Math.min(consumed / budget, 1);
      const delta = (1 - frac) * dt;

      const [ox, oz] = this.rng.disc(v.apertureRadius);
      particles.px[i] = ox;
      particles.py[i] = y0 + vy0 * delta - 0.5 * g * delta * delta;
      particles.pz[i] = oz;
      particles.vx[i] = 0;
      particles.vy[i] = vy0 - g * delta;
      particles.vz[i] = 0;

      const isAgg = d > v.clumpThreshold;
      particles.vol[i] = vol;
      // A clump is porous, so its bulk radius exceeds the solid-equivalent
      // sphere. That is also what makes its fragments fit inside it later.
      particles.radius[i] = isAgg
        ? 0.5 * d / Math.cbrt(clumpPack)
        : 0.5 * d;
      particles.isAgg[i] = isAgg ? 1 : 0;
      particles.colorSeed[i] = this.rng.next() * 1000;
      particles.restTimer[i] = 0;
      particles.phase[i] = PHASE_BALLISTIC;

      this.debt -= vol;
      consumed += vol;
      this.emittedVolume += vol;
      this.emittedCount++;
      spawned++;
    }
    return spawned;
  }
}
