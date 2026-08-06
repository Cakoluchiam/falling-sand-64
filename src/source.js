// The nozzle: volumetric, uneven flow.

import { PHASE_BALLISTIC } from './particles.js';
import { derived } from './params.js';

const PI_6 = Math.PI / 6;

// Floor on how downward a launch direction must be, so a wide scatter draw
// cannot send a grain up out of the nozzle. sin(5 degrees).
const MIN_DOWNWARD = Math.sin(5 * Math.PI / 180);

// Clumps have to be metered against something. Past this fraction there is not
// enough sand left to meter them against, and the slider stops at 10% anyway.
const MAX_CLUMP_FRACTION = 0.9;

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
    this._ball = [0, 0, 0];
    this._turb = new Float64Array(3);
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
  step(dt, t, particles, v, curl = null) {
    const dropVolume = derived.dropVolume();
    if (!v.continuousPour && this.emittedVolume >= dropVolume) return 0;

    const rate = v.flowRate * this.burstFactor(t, v);
    if (rate <= 0) return 0;

    // Clumpiness is a property of the sand, not a second stream metered
    // alongside it. Every body emitted credits `clumpOwed` with its share of
    // the clump fraction; when enough has built up, a clump comes out of the
    // nozzle alongside the sand, and its full volume is deducted.
    //
    // Three earlier designs were worse. A separate volume jar filled on its own
    // schedule and, because it kept accruing after the store was full, went on
    // releasing clumps long after the sand had stopped -- clumps trailing the
    // pour, which looks nothing like sand. A fixed per-body probability fixed
    // the trailing but is memoryless, and with clumps this rare that means a
    // pour of a few hundred thousand grains shows three clumps or none purely
    // by luck.
    //
    // ⚠ The third took the clump's volume out of the *same* budget as the
    // grains, which made a clump a hole in the stream: one clump is 5000 grains
    // and 139 ms of flow at a slow pour, so the sand visibly thinned behind it.
    // Spreading the repayment only stretched the hole out. What is supposed to
    // absorb a large body is the **likelihood of the next one**, not the sand
    // -- so the two streams are metered separately below, and the clump ledger
    // going sharply negative is the only thing that compensates.
    const f = Math.min(Math.max(v.clumpFraction, 0), MAX_CLUMP_FRACTION);
    if (f > 0 && this.pendingClumpVol <= 0) this._armClump(v);

    // Grains carry the rest of the flow. Steady, not transient: the flow rate
    // slider is the total, so a tenth of it arriving as lumps means the sand
    // between them runs at nine tenths -- constantly, with no stutter around
    // any particular clump.
    const budget = rate * (1 - f) * dt;
    if (budget <= 0) return 0;
    this.debt += budget;
    // Bound the backlog so a rate spike cannot queue up an unbounded burst.
    if (this.debt > budget * 4) this.debt = budget * 4;

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
      // The backdate is a step of the flight integrator, so it needs everything
      // the integrator would have used: the same drag coefficient, and the same
      // air moving past the grain.
      dragCoef: derived.dragCoef(),
      curl: v.turbAmplitude > 0 ? curl : null,
      turbAmp: v.turbAmplitude,
      budget,
      dt,
      consumed: 0,
    };
    let spawned = 0;

    while (this.debt > 0) {
      // A clump falls in among the sand rather than in place of it, so it takes
      // nothing from the grain budget and does not advance the sub-frame clock.
      // What it does take is its own volume back out of the ledger, which is
      // what pushes the next clump away.
      if (f > 0 && this.clumpOwed >= this.pendingThreshold) {
        const cv = this.pendingClumpVol;
        if (!v.continuousPour && this.emittedVolume + cv > dropVolume) break;
        if (!this._spawn(particles, v, ctx, cv, true)) break;
        // Deduct the exact volume, not the jittered threshold, so the timing
        // jitter cannot drift the long-run fraction.
        this.clumpOwed += f * cv - cv;
        this._armClump(v);
        this.clumpCount++;
        spawned++;
        continue;
      }

      const d = this.sampleDiameter(v);
      // Always solid. Size does not make a grain a clump.
      const vol = PI_6 * d * d * d;
      if (!v.continuousPour && this.emittedVolume + vol > dropVolume) break;
      // Store full: stop, and leave the debt for later. Crucially the ledger is
      // not credited either, so a blocked nozzle cannot bank clumps to release
      // once space frees up.
      if (!this._spawn(particles, v, ctx, vol, false)) break;

      this.debt -= vol;
      ctx.consumed += vol;
      // Every body that actually came out credits the ledger with its share.
      this.clumpOwed += f * vol;
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

    // Where in the aperture this body starts.
    //
    // The disc is **square to the stream axis**, so tipping the pour tips the
    // nozzle mouth with it, the way a bucket lip turns to face where it is
    // throwing. Held horizontal instead -- which is what it was, because the
    // pour angle arrived after the aperture did -- a tilted stream gets cut
    // obliquely and its cross-section squashes by cos(angle), a factor of two
    // at 60 degrees. At zero tilt the two are identical.
    //
    // The ball has no orientation to get wrong, being isotropic, but it is not
    // the same source: projected onto the perpendicular plane its density goes
    // as the chord, so it is peaked at the centre where the disc is flat, and
    // it gives the source depth along the flow as well.
    let ox, oy, oz;
    if (v.apertureBall) {
      const b = this.rng.ball(v.apertureRadius, this._ball);
      ox = b[0]; oy = b[1]; oz = b[2];
    } else {
      // u lies in the xy-plane and w is the z axis -- the same perpendicular
      // basis the scatter above uses.
      const [ou, ow] = this.rng.disc(v.apertureRadius);
      ox = ou * ctx.axisCos; oy = ou * ctx.axisSin; oz = ow;
    }

    // Solid-equivalent diameter; a clump is then drawn larger because it is
    // porous, which is also what makes its fragments fit inside it later. Sized
    // before the backdate because the backdate needs the radius: drag goes as
    // 1/r, so a clump is carried differently from a grain even in its first
    // fraction of a step.
    const dSolid = Math.cbrt(vol / PI_6);
    const rad = isAgg ? 0.5 * dSolid / Math.cbrt(ctx.clumpPack) : 0.5 * dSolid;
    particles.vol[i] = vol;
    particles.radius[i] = rad;

    // ⚠ The backdate is **one step of the flight integrator**, of length
    // `delta`, and not the analytic free-fall it looks like it should be.
    //
    // What the stream needs is not an accurate backdate but an *identical* one.
    // Ribbons tile seamlessly exactly when a grain emitted at age h, then
    // stepped j times, sits where a grain emitted at age ~0 and stepped j+1
    // times sits -- and applying the same map makes those two the same
    // composition, whatever the map's own error. Any formula that merely
    // approximates the integrator leaves a step at every ribbon boundary.
    //
    // The vacuum formula `y -= v0*d + g*d*d/2` was that mistake. It ignores
    // drag, so every ribbon was injected a little too fast, by an amount
    // growing across it -- the ribbon stretched, overlapped the one ahead, and
    // the overlap read as a bright band every couple of centimetres. Measured
    // at the default step it put a 21% density ripple through the whole stream,
    // rising to 29% at four times the drag and falling to 1.5% with drag off,
    // which is what identified it.
    // Same reasoning for the air: the integrator pushes a grain toward the
    // local flow every step, so a backdate that leaves it out reproduces the
    // drag mistake in a different variable. Sampled where the step starts,
    // which is the nozzle -- that is where the integrator would have sampled it
    // for a grain of age zero. Left on its own it put an 8% ripple through the
    // stream at the default turbulence.
    let fx = 0, fy = 0, fz = 0;
    if (ctx.curl) {
      ctx.curl.sample(ox, ctx.y0 + oy, oz, this._turb);
      fx = this._turb[0] * ctx.turbAmp;
      fy = this._turb[1] * ctx.turbAmp;
      fz = this._turb[2] * ctx.turbAmp;
    }
    const kr = ctx.dragCoef / rad;
    const denom = 1 / (1 + delta * kr);
    const nvx = (vx0 + delta * kr * fx) * denom;
    const nvy = (vy0 + delta * (kr * fy - ctx.g)) * denom;
    const nvz = (vz0 + delta * kr * fz) * denom;
    particles.px[i] = ox + 0.5 * (vx0 + nvx) * delta;
    particles.py[i] = ctx.y0 + oy + 0.5 * (vy0 + nvy) * delta;
    particles.pz[i] = oz + 0.5 * (vz0 + nvz) * delta;
    particles.vx[i] = nvx;
    particles.vy[i] = nvy;
    particles.vz[i] = nvz;
    particles.isAgg[i] = isAgg ? 1 : 0;
    if (isAgg) particles.markAggregate(i);
    particles.colorSeed[i] = this.rng.next() * 1000;
    particles.restTimer[i] = 0;
    particles.phase[i] = PHASE_BALLISTIC;

    // `consumed` is the caller's sub-frame clock and tracks the grain stream
    // only, so it is advanced there rather than here.
    this.emittedVolume += vol;
    this.emittedCount++;
    return true;
  }
}
