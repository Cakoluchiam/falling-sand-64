// The nozzle: volumetric, uneven flow.

import { PHASE_BALLISTIC } from './particles.js';
import { derived } from './params.js';

const PI_6 = Math.PI / 6;

// Share of a step's volume budget that may go to paying back what a clump
// borrowed. Below 1 so the stream always keeps flowing behind a clump.
const ARREARS_RATE = 0.5;

// Floor on how downward a launch direction must be, so a wide scatter draw
// cannot send a grain up out of the nozzle. sin(5 degrees).
const MIN_DOWNWARD = Math.sin(5 * Math.PI / 180);

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
    this.arrears = 0;
    this.clumpOwed = 0;
    this.pendingClumpVol = 0;
    this.pendingThreshold = 0;
    this.emittedVolume = 0;
    this.emittedCount = 0;
    this.clumpCount = 0;
  }

  // Size and trigger point for the next clump. The threshold is jittered so
  // clumps do not arrive on a metronome, but the *subtraction* when one is
  // emitted is the exact clump volume, so the jitter shifts timing without
  // touching the long-run rate.
  _armClump(v) {
    this.pendingClumpVol = this._drawClumpVolume(v);
    this.pendingThreshold = this.pendingClumpVol * (0.5 + this.rng.next());
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

  /**
   * Grain diameter: log-normal about the median, truncated to the size limits.
   *
   * Grains are always solid particles, however large they come out. Size never
   * promotes a grain to a clump -- clumps are a separate thing representing
   * many grains bound together, and they come from the clump ledger.
   *
   * Both limits matter. A log-normal is unbounded in *both* directions: without
   * an upper limit a long pour eventually draws something the spatial hash
   * cannot size cells for, and without a lower one it draws grains tens of
   * times finer than the median, which behave as airborne dust because terminal
   * velocity falls off with radius.
   *
   * Sampling is by inverting the CDF between the limits rather than redrawing
   * until a draw fits, so the limits stay exact no matter how tightly they are
   * closed up.
   */
  sampleDiameter(v) {
    const s = v.sorting;
    // Zero spread is a legitimate setting, not an edge case: it is how you ask
    // for perfectly uniform sand.
    if (s <= 0) return v.medianDiameter;
    const lo = Math.log(v.minGrainRatio) / s;
    const hi = Math.log(v.maxGrainRatio) / s;
    return v.medianDiameter * Math.exp(s * this.rng.truncatedGaussian(lo, hi));
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

    this.debt += budget;
    // Bound the backlog so a rate spike cannot queue up an unbounded burst.
    if (this.debt > budget * 4) this.debt = budget * 4;

    // Work off what a recent clump borrowed from the stream, capped so the sand
    // thins rather than stopping. See the clamp below for why this exists.
    if (this.arrears > 0) {
      const payment = Math.min(this.arrears, budget * ARREARS_RATE);
      this.arrears -= payment;
      this.debt -= payment;
    }

    // Clumpiness is a property of the sand, not a second stream metered
    // alongside it. Every body emitted credits `clumpOwed` with its share of
    // the clump fraction; when enough has built up, the next body out of the
    // nozzle is a clump instead of a grain, and its full volume is deducted.
    //
    // Two earlier designs were worse. A separate volume jar filled on its own
    // schedule and, because it kept accruing after the store was full, went on
    // releasing clumps long after the sand had stopped -- clumps trailing the
    // pour, which looks nothing like sand. A fixed per-body probability fixed
    // the trailing but is memoryless, and with clumps this rare that means a
    // pour of a few hundred thousand grains shows three clumps or none purely
    // by luck.
    //
    // Crediting per emitted body fixes both. Nothing accrues while the nozzle
    // is blocked, because accrual only happens when a body actually comes out.
    // And the ledger is self-correcting: emitting a clump drives `clumpOwed`
    // sharply negative, suppressing further clumps until the sand flow has paid
    // it back, so a short pour still shows close to the requested proportion
    // instead of a Poisson lottery.
    const f = Math.min(Math.max(v.clumpFraction, 0), 1);
    if (f > 0 && this.pendingClumpVol <= 0) this._armClump(v);

    const ctx = {
      g: v.gravity,
      y0: v.nozzleHeight,
      speed: v.initialSpeed,
      // Stream axis: vertical tilted by pourAngle toward +x. One fixed
      // direction for the whole pour, not a per-grain bearing.
      axisSin: Math.sin(Math.min(v.pourAngle, 85) * Math.PI / 180),
      axisCos: Math.cos(Math.min(v.pourAngle, 85) * Math.PI / 180),
      // Tangent-plane scale for the per-grain scatter. tan() so the parameter
      // reads as the angle it actually produces.
      spreadTan: v.pourSpread > 0 ? Math.tan(Math.min(v.pourSpread, 80) * Math.PI / 180) : 0,
      clumpPack: Math.max(v.packingFraction, 0.05),
      budget,
      dt,
      consumed: 0,
    };
    let spawned = 0;

    while (this.debt > 0) {
      let vol, isAgg, fromClumpLedger = false;
      if (f > 0 && this.clumpOwed >= this.pendingThreshold) {
        vol = this.pendingClumpVol;
        isAgg = true;
        fromClumpLedger = true;
      } else {
        const d = this.sampleDiameter(v);
        vol = PI_6 * d * d * d;
        // Always solid. Size does not make a grain a clump.
        isAgg = false;
      }

      if (!v.continuousPour && this.emittedVolume + vol > dropVolume) break;
      // Store full: stop, and leave the debt for later. Crucially the ledger is
      // not credited either, so a blocked nozzle cannot bank clumps to release
      // once space frees up.
      if (!this._spawn(particles, v, ctx, vol, isAgg)) break;

      this.debt -= vol;
      // Every body that actually came out credits the ledger with its share.
      this.clumpOwed += f * vol;
      if (fromClumpLedger) {
        // Deduct the exact volume, not the jittered threshold, so the timing
        // jitter cannot drift the long-run fraction.
        this.clumpOwed -= vol;
        this._armClump(v);

        // A clump is a large slug of volume relative to a frame. Charging it to
        // the stream all at once stops the sand dead for as long as the clump
        // represents -- 21 ms at the reference pour rate, which is invisible,
        // but 139 ms at a slow pour, which reads as the clump leading a hole in
        // the stream. Cap how far one clump can drive the stream negative and
        // carry the rest as arrears, so the sand thins for a moment instead of
        // stopping. Volume still balances: arrears are paid out of the same
        // budget, just spread over the following steps.
        const floor = -budget;
        if (this.debt < floor) {
          this.arrears += floor - this.debt;
          this.debt = floor;
        }
      }
      if (isAgg) this.clumpCount++;
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

    // Launch direction. The stream axis is fixed -- vertical tilted by the pour
    // angle toward +x -- and each grain scatters off it in its own random
    // direction. Speed is preserved and only the direction changes: a grain
    // shoved sideways in the orifice is redirected, not accelerated.
    //
    // The scatter is a pair of independent gaussians in the plane perpendicular
    // to the axis, which is uniformly random in bearing about that axis without
    // needing to draw one, and fills the cone rather than leaving a hollow ring
    // the way a fixed scatter angle would. Normalising afterwards maps the
    // tangent plane onto the sphere, so even a large draw bends toward
    // horizontal instead of flipping past it.
    let dx = ctx.axisSin, dy = -ctx.axisCos, dz = 0;
    if (ctx.spreadTan > 0) {
      const su = ctx.spreadTan * this.rng.gaussian();
      const sw = ctx.spreadTan * this.rng.gaussian();
      // Orthonormal basis perpendicular to the axis.
      // u lies in the xy-plane, w is the z axis.
      dx += ctx.axisCos * su;
      dy += ctx.axisSin * su;
      dz += sw;
      // Never launch upward, or level enough to leave the domain before landing.
      if (dy > -MIN_DOWNWARD) dy = -MIN_DOWNWARD;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len; dy /= len; dz /= len;
    }
    const vx0 = ctx.speed * dx, vy0 = ctx.speed * dy, vz0 = ctx.speed * dz;

    // Backdating has to move all three axes now. Only gravity is left out of
    // the horizontal, which is exact -- it has no horizontal component.
    const [ox, oz] = this.rng.disc(v.apertureRadius);
    particles.px[i] = ox + vx0 * delta;
    particles.py[i] = ctx.y0 + vy0 * delta - 0.5 * ctx.g * delta * delta;
    particles.pz[i] = oz + vz0 * delta;
    particles.vx[i] = vx0;
    particles.vy[i] = vy0 - ctx.g * delta;
    particles.vz[i] = vz0;

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
