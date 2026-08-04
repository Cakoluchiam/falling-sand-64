// The nozzle: volumetric, uneven flow.

import { PHASE_BALLISTIC } from './particles.js';
import { derived, CONFIG } from './params.js';

const PI_6 = Math.PI / 6;

export class Nozzle {
  constructor(rng, noise) {
    this.rng = rng;
    this.noise = noise;
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
    this.clumpDebt = 0;
    this.pendingClumpVol = 0;
    this.emittedVolume = 0;
    this.emittedCount = 0;
    this.clumpCount = 0;
  }

  // Instantaneous rate multiplier. Choking is correlated in time -- the flow
  // starves for a while, then releases -- so this is low-frequency gradient
  // noise, not per-spawn jitter. Exponentiating gives heavier tails and more
  // dramatic chokes than the raw noise would.
  burstFactor(t, v) {
    if (v.surgeDepth <= 0) return 1;
    const k = v.surgeDepth * 3;
    const n = this.noise.noise1(t / Math.max(v.surgePeriod, 1e-3));
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
    const maxD = derived.maxDiameter();
    if (d <= maxD) return d;
    return this.rng.range(derived.clumpDiameter(), maxD);
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
    const dropVolume = derived.dropVolume();
    if (!v.continuousPour && this.emittedVolume >= dropVolume) return 0;

    const rate = v.flowRate * this.burstFactor(t, v);
    const budget = rate * dt;
    if (budget <= 0) return 0;

    // Split the incoming volume between the two populations. Both jars use the
    // same carry-the-remainder pattern, so the totals stay exact and the split
    // is honoured over time even though a clump is thousands of grains' worth
    // of sand and only becomes affordable every few seconds.
    const clumpShare = budget * Math.min(Math.max(v.clumpFraction, 0), 1);
    this.clumpDebt += clumpShare;
    this.debt += budget - clumpShare;
    // Bound the backlog so a rate spike cannot queue up an unbounded burst.
    if (this.debt > budget * 4) this.debt = budget * 4;

    const ctx = {
      g: v.gravity,
      y0: v.nozzleHeight,
      vy0: -v.initialSpeed,
      clumpPack: Math.max(v.packingFraction, 0.05),
      clumpD: derived.clumpDiameter(),
      budget,
      dt,
      consumed: 0,
    };
    let spawned = 0;

    // Clumps first, so a clump lands at the head of its frame's sand rather
    // than trailing it.
    //
    // The pending draw is held rather than resampled each frame. Redrawing
    // would bias the population small, because a smaller clump becomes
    // affordable sooner and would win the race disproportionately often.
    if (v.clumpFraction > 0) {
      if (this.pendingClumpVol <= 0) this.pendingClumpVol = this._drawClumpVolume(v);
      while (this.clumpDebt >= this.pendingClumpVol) {
        const vol = this.pendingClumpVol;
        if (!v.continuousPour && this.emittedVolume + vol > dropVolume) break;
        if (!this._spawn(particles, v, ctx, vol, true)) break;
        this.clumpDebt -= vol;
        this.clumpCount++;
        spawned++;
        this.pendingClumpVol = this._drawClumpVolume(v);
      }
    }

    // Leave headroom so pending clumps can still be placed once the store is
    // otherwise full.
    const grainLimit = v.clumpFraction > 0
      ? particles.capacity - CONFIG.clumpReserveSlots
      : particles.capacity;

    while (this.debt > 0) {
      if (particles.count >= grainLimit) break;
      const d = this.sampleDiameter(v);
      const vol = PI_6 * d * d * d;
      if (!v.continuousPour && this.emittedVolume + vol > dropVolume) break;
      if (!this._spawn(particles, v, ctx, vol, d > ctx.clumpD)) break;
      this.debt -= vol;
      spawned++;
    }
    return spawned;
  }

  // Clump diameters are log-normal around their own target size with their own
  // spread, independent of the grain distribution.
  _drawClumpVolume(v) {
    const d = derived.clumpMetres() * Math.exp(v.clumpSorting * this.rng.gaussian());
    return PI_6 * d * d * d;
  }

  // Places one body, backdated to where it would have fallen by frame end.
  // Returns false when the store is full, leaving the debt for later.
  _spawn(particles, v, ctx, vol, isAgg) {
    const i = particles.alloc();
    if (i < 0) return false;

    // Where in the frame this body conceptually left the nozzle.
    const frac = Math.min(ctx.consumed / ctx.budget, 1);
    const delta = (1 - frac) * ctx.dt;

    const [ox, oz] = this.rng.disc(v.apertureRadius);
    particles.px[i] = ox;
    particles.py[i] = ctx.y0 + ctx.vy0 * delta - 0.5 * ctx.g * delta * delta;
    particles.pz[i] = oz;
    particles.vx[i] = 0;
    particles.vy[i] = ctx.vy0 - ctx.g * delta;
    particles.vz[i] = 0;

    // Solid-equivalent diameter; a clump is then drawn larger because it is
    // porous, which is also what makes its fragments fit inside it later.
    const dSolid = Math.cbrt(vol / PI_6);
    particles.vol[i] = vol;
    particles.radius[i] = isAgg
      ? 0.5 * dSolid / Math.cbrt(ctx.clumpPack)
      : 0.5 * dSolid;
    particles.isAgg[i] = isAgg ? 1 : 0;
    particles.colorSeed[i] = this.rng.next() * 1000;
    particles.restTimer[i] = 0;
    particles.phase[i] = PHASE_BALLISTIC;

    ctx.consumed += vol;
    this.emittedVolume += vol;
    this.emittedCount++;
    return true;
  }
}
