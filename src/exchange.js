// Exchange: the two mass paths between the grains and the heightfield.
//
// Absorption retires buried, quiescent grains into the continuum; emission
// puts them back when the active layer runs thin. Together they are what
// bounds the solver's population independently of how long the pour runs, and
// -- more importantly than the cost -- what makes the body of the pile
// continuous, so an arriving grain cannot tunnel through it.
//
// Pure over flat typed arrays, taking the grain store, the heightfield and the
// broad phase as arguments, for the same reason `contact.js` and `ballistic.js`
// are separate modules: every measure below is a claim about geometry, and a
// test has to be able to check it against a packing whose answer is known.
//
// ## ⚠ How deep a grain is buried, and why this is not what the plan says
//
// The plan specifies **direction coverage over a grain's contacts**: take an
// icosahedral set of directions, ask whether any neighbour's cap contains
// each one, and read the uncovered fraction as the burial score. It rejects
// two earlier formulations on the way there and is emphatic about the reason
// -- a measure of burial must not depend on which way the free surface
// happens to face, or a grain on a flank vanishes in plain sight.
//
// **The reasoning is right and the measure does not work.** Five measurements,
// on ideal packings and on a settled polydisperse pile in a bowl where the
// flat top makes vertical depth ground truth:
//
//  1. Twelve contacts of a densest packing subtend caps summing to 10.1 sr
//     against 4π. They *cannot* cover an interior grain's sky, and measured, a
//     deep grain in ideal HCP scores 0.167 uncovered -- the same figure the
//     plan cites as disqualifying for the cap-weighted scheme it rejected.
//     The gaps are the pore space, and they are real.
//  2. Under polydispersity it inverts. At ±15% radius jitter the top layer
//     scored 0.583 and the layer beneath it 0.583; at ±40%, the surface 0.667
//     and a grain three layers down 0.667. There is no threshold, because an
//     interior grain in a loose polydisperse packing *touches* only four or
//     five neighbours and they occlude less of its sky than a surface grain's
//     do.
//  3. Widening the occluder set past touching does fix the ideal lattice --
//     0.000 for an interior grain at 1.45x the contact distance -- and does
//     **not** fix a real pile: at 95% surface recall the interior misread rate
//     sits at 13-21% for every reach from 1.0 to 2.0 and for 12 directions or
//     32. It merely rescales both distributions.
//  4. Reach costs about tenfold. Finding neighbours at 2x the contact distance
//     needs the broad phase to place grains at levels sized to 2x their
//     diameter, which is a full level coarser, eight times the cell volume and
//     eight times the candidates.
//  5. End to end it fails outright. Seeding depth propagation from coverage,
//     no threshold both retires the interior and leaves the surface alone: at
//     0.42 it absorbed 39.6% of genuinely deep grains, and at 0.50 it managed
//     89.2% while absorbing **9.1% of surface grains** -- a visible pop on one
//     exposed grain in eleven. Scattered false seeds keep the whole pile
//     shallow, because depth is a minimum over paths and one wrong seed drags
//     its entire neighbourhood down with it.
//
// **What replaces it keeps the plan's distinction and drops its mechanism.**
// The plan's real insight is that *depth* must not be measured vertically. It
// does not follow that *which grains are on the surface* must be found without
// reference to up, and that conflation is what cost the measure. A sloped
// surface still has, in every cell, a topmost grain that is on it.
//
//  - **The surface is `grainTop`,** barycentrically blended at the grain's own
//    position rather than taken as the maximum of its three cells. Blending
//    follows the slope; the maximum does not, and measured on a packing tilted
//    through 45° the maximum popped 89% of surface grains where the blend
//    popped 43%.
//  - **A seed's depth is measured, not assumed zero,** as the drop from that
//    surface to the grain's centre, projected onto the surface normal -- which
//    comes from the same six-neighbour plane fit `cellNormal` uses, applied to
//    `grainTop` instead of to height. That projection is the whole of the
//    orientation independence, and measuring rather than assuming is what
//    stops the seed window from silently becoming the active layer depth: with
//    it, results are identical for windows of 4, 6 and 8 grain diameters.
//  - **Below the window, depth propagates geodesically through contacts,**
//    which is where a vertical measure would go wrong and where nothing
//    vertical is used.
//
// The window has to cover the surface's own rise across one cell,
// `spacing · tan θ`, or grains on the low side of a cell are never seeded --
// measured, a 2-diameter window popped 25.7% of surface grains at 32° tilt and
// 89.1% at 45°, and the failure appears exactly where that product exceeds it.

// ## ⚠ Elevation stays volume-derived: the plan's pre-approved retreat, taken
//
// The plan decouples elevation from volume and drives the surface to the
// *observed* underside of resting grains, `min(py − radius)`, with the
// volume-derived height kept in parallel as a diagnostic. It also records a
// retreat: "If observation-driven elevation proves unstable at M4, reverting
// to volume-derived height with a fixed φ is an accepted outcome, not a
// failure." It is unstable, and this is that retreat.
//
// Four rules were built and measured on the same confined pour, 9000 grains
// into a bowl, against a ledger that implies a 14.5 mm surface:
//
//  - **Pure observation collapses.** Terrain and grains define each other, so
//    letting height follow the undersides down is a runaway: the surface
//    drops, the grains resting on it fall, the undersides drop again. The pile
//    never builds at all -- peak 0.00 mm after 8000 absorptions.
//  - **A monotone ratchet over-reads by half.** Taking the running maximum of
//    the observed underside climbs on transient highs and can never come back,
//    landing the surface at 22.07 mm where the volume supports 14.5 -- a pile
//    visibly taller than the sand poured into it, and a φ readout of nonsense.
//  - **Capping the ratchet by the ledger pins it at zero**, 0.20 mm, for the
//    same reason the collapse happens.
//  - **Volume-derived tracks the ledger**, 13.78 mm against 14.5 predicted.
//
// The common cause is that `grainBottom` is a **minimum**, so a single
// straggler settled low in a cell pins that whole cell's surface however much
// has been buried under the rest of it. That is not numerical instability in
// the sense the plan anticipated; it is the statistic being the wrong one, and
// no amount of care in the update rule repairs it.
//
// What the decoupling decision was protecting against still stands -- a fixed
// φ that disagrees with the real local packing drifts the surface away from
// the grains, cumulatively and in one direction. So the parallel computation
// survives as `elevationDivergence`, which is that drift in metres and is the
// measurement the whole decision existed to make. φ_local remains a readout
// and never an input, which is also what keeps relaxation's transport rule
// exactly volume-conserving.
//
// ## Which makes the engulfment invariant a real gate again
//
// With height driven by volume there *is* a prediction to check, so the plan's
// original formulation applies as written, including both its amendments. The
// deadlock it warns about is real and the fix is the one it names: the
// comparison **excludes the grains being absorbed in this batch**, because
// those are precisely the ones whose undersides currently define the surface,
// and it carries a **tolerance**, because "flush" and "below" are separated by
// float noise on a Float32 height.

import { PHASE_AWAKE, PHASE_BALLISTIC, PHASE_RESTING } from './particles.js';

const SQRT3_2 = Math.sqrt(3) / 2;
const NB_DX = [1, -1, 0.5, -0.5, 0.5, -0.5];
const NB_DZ = [0, 0, SQRT3_2, -SQRT3_2, -SQRT3_2, SQRT3_2];
const NB_DR = [0, 0, 1, -1, -1, 1];
const NB_DQ_EVEN = [1, -1, 0, -1, 0, -1];
const NB_DQ_ODD = [1, -1, 1, 0, 1, 0];

// How far above the local surface a per-cell maximum sits, in cell spacings
// per unit of surface gradient. See the note where it is applied.
const TOP_MAX_BIAS = 0.6;

export class ExchangeSolver {
  constructor(capacity) {
    this.capacity = capacity;
    // Distance through the pile from the free surface to a grain's centre, in
    // metres. Float64 because it accumulates along a path of many hops.
    this.depth = new Float64Array(capacity);
    // Dijkstra's frontier: a binary min-heap of (depth, grain).
    this._heapKey = new Float64Array(capacity + 1);
    this._heapVal = new Int32Array(capacity + 1);
    this._settled = new Uint8Array(capacity);
    // The y component of the grain-top surface normal, per cell. Allocated on
    // first use, since only the field knows how many cells there are.
    this.topNy = null;
    this.topGrad = null;
    this._batch = new Int32Array(capacity);
    this._skip = new Uint8Array(capacity);
    // Scratch for `sampleSurface`, which returns height and normal together.
    this._surf = new Float64Array(4);
    this.extremaCounted = 0;
    this.seeds = 0;
    this.reached = 0;
    // Counters the panel and the tests read. `absorbedVolume` is cumulative;
    // the rest describe the last frame.
    this.absorbedCount = 0;
    this.absorbedVolume = 0;
    this.lastAbsorbed = 0;
    this.lastCandidates = 0;
    this.lastDeferred = 0;
    this.lastWoken = 0;
    this.lastEmitted = 0;
    this.emittedCount = 0;
    this.emitBlocked = 0;
    this._moved = null;
    this._frame = 0;
  }

  /**
   * Whether grain `i` counts as quiescent, under one of the four modes the
   * plan requires be available rather than chosen in advance.
   *
   * `self` is rest duration, `contact` is "everything I touch has stopped".
   * They fail in opposite directions -- contact-quiescence can starve under a
   * continuous pour, self-duration can retire a grain still carrying load --
   * so which is right is an empirical question, and `and`/`or` are the
   * strictest and the release valve.
   *
   * ⚠ `contact` cannot be computed in the solver's pair loop, which is where
   * the plan puts it. That loop returns early when both grains are asleep, so
   * the contacts of exactly the grains this asks about are the ones it never
   * enumerates. It comes off the frame's adjacency instead.
   */
  _quiescent(P, hash, i, mode, substeps) {
    const self = () => P.stillTimer[i] >= substeps;
    const contact = () => {
      const { adjStart, adjList } = hash;
      for (let a = adjStart[i]; a < adjStart[i + 1]; a++) {
        if (P.stillTimer[adjList[a]] < substeps) return false;
      }
      return true;
    };
    switch (mode) {
      case 'self': return self();
      case 'contact': return contact();
      case 'or': return self() || contact();
      default: return self() && contact();     // 'and', the strictest
    }
  }

  /**
   * Retire every grain that is buried deep enough and quiet enough, into the
   * heightfield. Returns how many were absorbed.
   *
   * Order is load-bearing: select, deposit, free, *then* re-read the extrema
   * and set elevation from them. Reading the undersides before the batch is
   * gone would drive the surface to the very grains being removed.
   */
  absorb(P, field, hash, o) {
    const { py, radius, vol, phase, live } = P;
    const cutoff = o.activeLayerMetres;
    this.lastAbsorbed = 0;
    this.lastCandidates = 0;

    // The ∞ detent, and the whole of what it means. Not "absorb at a very
    // large depth" -- the depth pass would then walk the entire pile every
    // frame to establish that nothing qualifies.
    if (!Number.isFinite(cutoff)) return 0;

    this.updateExtrema(P, field);
    this.updateDepth(P, field, hash, { seedWindow: o.seedWindow, cutoff });

    // Prefilter, then the real test. ⚠ Every term here has to be monotone in
    // burial: a prefilter is only sound if it never rejects what the real test
    // would accept. The plan originally kept the column-depth measure as the
    // prefilter, which is exactly wrong -- that measure produces false
    // *negatives* on slopes, so gating on it would preserve the failure the
    // whole burial measure exists to remove, on the flanks where absorption
    // matters most.
    const batch = this._batch;
    let n = 0;
    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      // ⚠ Not gated on PHASE_RESTING, and that is the correction that made
      // absorption fire at all. See particles.js: sleeping is a performance
      // device whose wake rule is contagious by design, and under a continuous
      // pour it retires almost nothing -- 3 grains of 3000, measured. Gating
      // here on it made the plan's own mitigation order circular. What
      // absorption actually requires is that the grain be still, which
      // `stillTimer` measures directly and the sleep phase only approximates.
      if (phase[i] === PHASE_BALLISTIC) continue;
      if (hash.adjStart[i + 1] - hash.adjStart[i] < o.minContacts) continue;
      if (!this._quiescent(P, hash, i, o.quiescenceMode, o.quiescenceSubsteps)) continue;
      this.lastCandidates++;
      if (!(this.depth[i] > cutoff)) continue;
      batch[n++] = i;
    }

    if (n === 0) return 0;

    // Recompute the undersides with the batch held out. Without this the check
    // below compares the new surface against the very grains being removed,
    // `height == grainBottom` holds by construction, and absorption never
    // fires -- the deadlock the plan warns about, reached exactly as described.
    // ⚠ The exclusion set is every grain **deeper than the active layer**, not
    // merely the ones being absorbed this pass. The plan says to exclude "the
    // grains being absorbed in this batch", and that is not enough: a grain
    // deep enough to qualify but not yet quiescent stays in the extrema, and
    // since `grainBottom` is a minimum, one of them holds its whole cell's
    // reference down at the floor. Every later absorption in that cell is then
    // refused for as long as it lingers.
    //
    // Measured with batch-only exclusion, the gate deferred 46,297 times in
    // five seconds at 960 Hz and let the surface reach 0.5 mm where the sand
    // implies fifteen -- and no setting of φ or the tolerance moved it, because
    // the blocker was not a margin but a grain.
    //
    // Excluding by depth states the invariant's real intent: never bury a
    // grain that is going to *stay* live. One that is already past the active
    // layer is destined for the continuum whether it has settled yet or not,
    // so the surface advancing to meet it is the mechanism working rather than
    // a violation of it.
    const skip = this._skip;
    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      if (phase[i] !== PHASE_BALLISTIC && this.depth[i] > cutoff) skip[i] = 1;
    }
    this.updateExtrema(P, field, skip);

    // Which cells this pass raises, stamped with a frame counter rather than
    // cleared -- 37k cells zeroed every frame to record a few dozen would cost
    // more than the deposits do.
    if (!this._moved || this._moved.length !== field.n) {
      this._moved = new Int32Array(field.n);
      this._frame = 0;
    }
    const moved = this._moved, frame = ++this._frame;

    // Where every cell's surface stood before this pass, so the rise can be
    // bounded below.
    if (!this._riseBase || this._riseBase.length !== field.n) {
      this._riseBase = new Float64Array(field.n);
    }
    const base = this._riseBase;
    for (let c = 0; c < field.n; c++) base[c] = field.height[c];

    let done = 0, deferred = 0;
    for (let b = 0; b < n; b++) {
      const i = batch[b];
      const splat = Math.max(field.s, radius[i]);
      const cells = field.discCells(P.px[i], P.pz[i], splat);
      // Would depositing this grain lift the surface over something still
      // live? One comparison per affected cell, against the undersides that
      // will still be there afterwards.
      let blocked = false;
      for (let c = 0; c < cells.length; c += 2) {
        const idx = cells[c];
        const after = field.volumeHeightOf2(idx, cells[c + 1] * vol[i]);
        // ⚠ Against the raw minimum, deliberately, and it costs absorption
        // rate. Flooring the reference at the current surface -- on the
        // argument that a straggler already inside the terrain is the solver's
        // problem and should not veto its cell forever -- does unblock it:
        // deferrals fall from 148,606 to zero and the surface reaches 11.2 mm
        // instead of 1.1. But penetration goes from 597 um with two grains
        // past 200 um to 1664 um with fifty-three, and at that tolerance the
        // gate never fires at all, so the invariant stops being enforced by
        // anything. The strict form is kept until the substep rate is settled;
        // see the note on the rate limit below.
        if (after > field.grainBottom[idx] + o.engulfTolerance) { blocked = true; break; }
        // ⚠ And a ceiling on how far the surface may climb in one pass. The
        // gate above can only refuse to bury a grain that is *already there*;
        // it cannot see one that settles into the cell next frame, and the
        // terrain never comes back down. So a cell that absorbs a whole column
        // at once leaves a step for the next arrival to land inside. Capping
        // the rise bounds that step by construction, and the deferred grains
        // are absorbed a frame or two later rather than lost -- absorption is
        // rate-limited here, not refused.
        if (after - base[idx] > o.maxRise) { blocked = true; break; }
      }
      if (blocked) {
        // ⚠ Put its underside back into the extrema before moving on. It was
        // held out so the gate could see past it, and a deferred grain is one
        // that is *staying* -- leaving it out means every later deposit in
        // this pass is checked against a surface that has forgotten it, and it
        // gets buried by a neighbour it just successfully blocked. Measured,
        // that alone drove grains 1.6 mm under the terrain.
        // ⚠ Not re-registered. It was held out because it is deeper than the
        // active layer, which is still true -- it was refused this pass only
        // because the surface would have climbed too far in one go. Putting it
        // back would restore exactly the blocker the depth exclusion removes.
        deferred++;
        continue;
      }
      field.deposit(P.px[i], P.pz[i], vol[i], splat);
      for (let c = 0; c < cells.length; c += 2) moved[cells[c]] = frame;
      this.absorbedVolume += vol[i];
      P.free(i);
      done++;
    }
    for (let k = 0; k < P.count; k++) skip[live[k]] = 0;

    this.absorbedCount += done;
    this.lastAbsorbed = done;
    this.lastDeferred = deferred;
    this.lastWoken = done > 0 ? this.wakeOverMovedCells(P, field) : 0;
    return done;
  }

  /**
   * Put sand back where the active layer has run thin. Returns how many grains
   * were emitted.
   *
   * ## The trigger is layer thickness alone, never a slope angle
   *
   * That is what keeps an angle constant out of the mass path entirely, and it
   * is self-regulating: if a surface is too steep its grains slide, the layer
   * thins, emission refills it, and those slide too. Repose stays an output.
   *
   * ## ⚠ The infinite active layer has to be refused before the arithmetic
   *
   * The plan flags this as a claim to check rather than inherit: with an
   * infinite target the layer is *always* thinner than target, so the gate
   * reads the other way round from the absorption side. Checked, and it is not
   * merely harmless as the plan guesses. The deficit is `(target - layer) *
   * area * phi`, which is `Infinity`, and a debt accumulator carrying that
   * value is poisoned for the rest of the run -- `Infinity - anything` stays
   * infinite, so the cell would emit forever once any sand reached it. The
   * outcome the plan predicts (nothing to emit, because nothing was absorbed)
   * holds only for a cell that is still empty. Refusing the whole pass at the
   * detent is the honest guard, and it is also what the detent means.
   *
   * ## ⚠ No debt accumulator, and this deviates from the plan deliberately
   *
   * The plan specifies a per-cell volume debt so a fractional remainder can
   * carry to the next step. That treats the deficit as a *flow* to be
   * integrated, and it is not one -- it is a standing quantity, re-derived
   * from the geometry every frame as `target - (grainTop - height)`. Adding a
   * freshly measured deficit to a running total every frame double-counts it,
   * because the layer does not change until something is actually emitted, and
   * the accumulator runs away.
   *
   * The slicing problem the debt was introduced to solve does not arise under
   * a standing deficit: when the gap is smaller than a whole grain, nothing is
   * emitted and the gap simply stays measured. It grows on its own as
   * absorption retires more from underneath, until it covers a grain. That is
   * the same "conserve by construction rather than by tolerance" the rest of
   * the mass path follows -- there is no accumulator here that could drift.
   */
  emit(P, field, o) {
    const target = o.activeLayerMetres;
    this.lastEmitted = 0;
    if (!Number.isFinite(target) || !(target > 0)) return 0;

    const top = field.grainTop, height = field.height;
    const scale = field.cellArea * field.packingFraction;
    const surf = this._surf;
    let made = 0;

    for (let c = 0; c < field.n; c++) {
      if (!(field.solidVolume[c] > 0)) continue;
      const t = top[c];
      const layer = Number.isFinite(t) ? t - height[c] : 0;
      if (layer >= target) continue;
      const gap = (target - layer) * scale;
      if (!(gap > 0)) continue;

      const q = c % field.W, r = (c / field.W) | 0;
      const x = field.cellX(q, r), z = field.cellZ(r);
      const want = this._sampleEmitVolume(field, c, o);
      if (!(want > 0) || want > gap) continue;
      if (field.solidVolume[c] < want) continue;

      // ⚠ Take from the field first and build the grain out of what was
      // actually paid. `debit` spreads over the same triangle `deposit` does,
      // so a neighbouring cell running dry returns less than was asked for --
      // and a grain sized to the request rather than the payment is the field
      // minting sand. If the payment is too small to be a grain, it goes
      // straight back, to the same position and therefore the same cells.
      const paid = field.debit(x, z, want, field.s);
      if (paid < o.minGrainVolume) {
        if (paid > 0) field.deposit(x, z, paid, field.s);
        continue;
      }

      const i = P.alloc();
      if (i < 0) { field.deposit(x, z, paid, field.s); this.emitBlocked++; break; }

      const radius = 0.5 * Math.cbrt((6 * paid) / Math.PI);
      P.vol[i] = paid;
      P.radius[i] = radius;
      const a = o.rng.next() * Math.PI * 2;
      const rad = Math.sqrt(o.rng.next()) * field.s * 0.4;
      P.px[i] = x + Math.cos(a) * rad;
      P.pz[i] = z + Math.sin(a) * rad;
      field.sampleSurface(P.px[i], P.pz[i], surf);
      // Resting on the surface it came out of, along its normal.
      P.py[i] = surf[0] + radius / Math.max(surf[2], 1e-6);
      P.vx[i] = 0; P.vy[i] = 0; P.vz[i] = 0;
      P.colorSeed[i] = o.rng.next();
      P.restTimer[i] = 0; P.stillTimer[i] = 0;
      P.ax[i] = P.px[i]; P.ay[i] = P.py[i]; P.az[i] = P.pz[i];
      P.isAgg[i] = 0;
      P.phase[i] = PHASE_AWAKE;
      made++;
    }

    this.lastEmitted = made;
    this.emittedCount += made;
    return made;
  }

  /**
   * A grain volume for cell `c`, drawn from what that cell remembers burying.
   *
   * ⚠ Clamped below the clump threshold, which is the one place this design is
   * knowingly less faithful than the alternative: a cell that buried clumps
   * re-emits coarse sand rather than clumps. The cost is accepted so a boulder
   * cannot pop out of a smooth surface. Open concern 1 asks whether emission
   * fires often enough for that to matter, which is what `emittedCount` is for.
   */
  _sampleEmitVolume(field, c, o) {
    const lo = Math.log(o.minGrainVolume);
    const hi = Math.log(o.maxEmitVolume);
    if (!(hi > lo)) return Math.exp(lo);
    const m = o.sizeMemory ? field.sizeMoments(c) : null;
    if (!m) {
      // Nothing remembered here, so fall back to the global distribution --
      // uniform in log volume between the limits is the least-committal draw
      // that still respects them.
      return Math.exp(lo + o.rng.next() * (hi - lo));
    }
    const sigma = Math.sqrt(m.varLogVol);
    if (!(sigma > 1e-12)) {
      return Math.min(Math.max(Math.exp(m.meanLogVol), Math.exp(lo)), Math.exp(hi));
    }
    // Invert the CDF between the limits rather than redrawing, for the same
    // reason `Rng.truncatedGaussian` exists: a tight window would otherwise
    // pile a spike against whichever boundary the rejections bounce off.
    const zlo = (lo - m.meanLogVol) / sigma;
    const zhi = (hi - m.meanLogVol) / sigma;
    return Math.exp(m.meanLogVol + sigma * o.rng.truncatedGaussian(zlo, zhi));
  }

  /**
   * Wake any sleeper standing over a cell this pass raised, and return how
   * many. Called only when something was actually absorbed.
   *
   * ## ⚠ Why this is not optional, and why `wakeAll` will not do
   *
   * The contact solver's surface projection skips everything that is not
   * PHASE_AWAKE, so a sleeping grain is never pushed back out of the terrain.
   * That is correct while the terrain is a static ledger -- nothing can move
   * underneath a sleeper -- and absorption breaks the premise, because it
   * raises the surface every frame. A sleeper over a rising cell is buried and
   * stays buried, with no mechanism anywhere that would notice.
   *
   * Measured before this existed, the exposure was one grain at 231 µm, which
   * looks negligible and is only that small because sleeping barely fires yet:
   * 22 grains of 3,993 in that run. The whole point of absorption is that the
   * active layer thins until the solver converges and sleeping *starts*
   * working, at which point this scales with it. Fixing it while it is cheap
   * to see beats finding it once the pile is mostly asleep.
   *
   * `ContactSolver.wakeAll` is the blunt version and stays for the relaxation
   * arm, which is off by default and can afford it. Absorption moves the
   * surface every frame, so waking the whole pile every frame would defeat
   * sleeping outright -- exactly the thing this is trying to protect.
   */
  wakeOverMovedCells(P, field) {
    const { px, pz, phase, live } = P;
    const moved = this._moved, frame = this._frame;
    let woken = 0;
    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      if (phase[i] !== PHASE_RESTING) continue;
      const t = field.sampleTriangle(px[i], pz[i]);
      if (moved[t.i0] !== frame && moved[t.i1] !== frame && moved[t.i2] !== frame) continue;
      // Phase and timers only. The next substep's predict pass sets `xprev`
      // for every awake grain, and a sleeper's velocity is already zero, so
      // there is nothing else to restore.
      phase[i] = PHASE_AWAKE;
      P.restTimer[i] = 0;
      P.stillTimer[i] = 0;
      woken++;
    }
    return woken;
  }

  /** One grain's contribution to the per-cell extrema, added back in. */
  _register(P, field, i) {
    const r = P.radius[i];
    const hi = P.py[i] + r, lo = P.py[i] - r;
    const top = field.grainTop, bottom = field.grainBottom;
    if (r <= field.s) {
      const t = field.sampleTriangle(P.px[i], P.pz[i]);
      for (const idx of [t.i0, t.i1, t.i2]) {
        if (top[idx] < hi) top[idx] = hi;
        if (bottom[idx] > lo) bottom[idx] = lo;
      }
    } else {
      const cells = field.discCells(P.px[i], P.pz[i], r);
      for (let c = 0; c < cells.length; c += 2) {
        const idx = cells[c];
        if (top[idx] < hi) top[idx] = hi;
        if (bottom[idx] > lo) bottom[idx] = lo;
      }
    }
  }

  /**
   * Drive the collision surface to the observed underside of the grains that
   * remain, falling back to the volume-derived height where a cell has none.
   *
   * Monotone by construction. The heightfield is a ledger of buried material
   * and burying is not reversible except through emission, so a cell whose
   * grains merely wandered off laterally must not drop its surface out from
   * under whatever is still standing on it.
   */
  /** @deprecated kept for `seedCone`, which deposits with no grains at all. */
  settleElevation(field, { volumeFallback = false } = {}) {
    const bottom = field.grainBottom, height = field.height;
    for (let c = 0; c < field.n; c++) {
      const observed = bottom[c];
      let target;
      if (Number.isFinite(observed)) {
        target = observed;
      } else if (volumeFallback) {
        target = field.volumeHeightOf(c);
      } else {
        // ⚠ A cell with volume but no grains over it keeps the surface it had.
        // Deriving one from its volume here is what the plan calls the
        // fallback, and in the absorption path it is a hazard rather than a
        // safety net: `volume / (area * phi)` knows nothing about where the
        // grains are, so a column whose whole stack was absorbed in one batch
        // gets a tall spike that a neighbouring grain then blends into and
        // ends up inside. Measured, penetration grew with pile depth --
        // 315 µm, 801 µm, 1147 µm for caps of 3k, 6k and 8k -- which is the
        // signature of a fault that scales with how much has been buried
        // rather than with the substep.
        //
        // It also cannot bite: absorption only ever retires grains deeper than
        // the active layer, so the top couple of diameters of every occupied
        // column stay as grains and every cell holding sand has something over
        // it to observe. The fallback is for callers that deposit without
        // grains at all, which is `seedCone` and nothing else.
        continue;
      }
      if (target > height[c]) {
        height[c] = target;
        field._markDirty(c);
      }
    }
  }

  /**
   * How far the observed surface has drifted from the height a single packing
   * fraction would predict, over the cells holding sand. **This divergence is
   * the measurement the elevation decision exists to make** -- it is φ being
   * wrong, in metres, and its sign says which way.
   *
   * Returned as the worst and the mean absolute difference, plus the packing
   * fraction actually observed. φ_local is a readout here and never an input:
   * feeding it back into height is what makes relaxation's transport rule
   * unsolvable, and nothing needs it to.
   */
  elevationDivergence(field) {
    let worst = 0, sum = 0, cells = 0, phiSum = 0, phiCells = 0;
    for (let c = 0; c < field.n; c++) {
      if (!(field.solidVolume[c] > 0)) continue;
      // ⚠ Against the **observed** underside, not against `volumeHeightOf`.
      // Elevation is volume-derived now, so comparing height to the volume it
      // came from is comparing a number with itself: it read exactly zero
      // drift and exactly the bootstrap φ, which looks like a clean result and
      // is a measurement of nothing. What the decoupling decision wanted to
      // know is whether one packing fraction keeps the surface under the
      // grains, and only the grains can answer that.
      const observed = field.grainBottom[c];
      if (!Number.isFinite(observed)) continue;
      const a = Math.abs(field.height[c] - observed);
      if (a > worst) worst = a;
      sum += a; cells++;
      if (observed > 0) {
        phiSum += field.solidVolume[c] / (observed * field.cellArea);
        phiCells++;
      }
    }
    return {
      worst,
      mean: cells ? sum / cells : 0,
      cells,
      // ⚠ Guarded against a zero height, which is every cell the pile has not
      // reached. An Infinity here would reach the terrain texture as a NaN and
      // render as a black hole with no stack trace attached.
      phi: phiCells ? phiSum / phiCells : 0,
    };
  }

  /**
   * The engulfment invariant, as an assertion: no live grain may sit
   * materially below the terrain. Returns the worst penetration in metres.
   *
   * Sampled through `sampleTriangle` like everything else that turns a
   * position into cells, so this measures the surface a grain would actually
   * collide with rather than a nearby cell's value.
   */
  worstPenetration(P, field) {
    const { px, py, pz, radius, phase, live } = P;
    let worst = 0;
    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      if (phase[i] === PHASE_BALLISTIC) continue;
      const h = field.heightAt(px[i], pz[i]);
      const below = h - (py[i] - radius[i]);
      if (below > worst) worst = below;
    }
    return worst;
  }

  /**
   * Fill the field's per-cell `grainTop` and `grainBottom` from the live
   * contact-phase population, and the surface normal that goes with them.
   * One sweep, once per frame.
   *
   * ## ⚠ These are extrema, and all the cells a grain covers take one value
   *
   * `sampleTriangle` hands back three cells *and* the barycentric weights that
   * blend them, and the weights are right there and wrong for this. A maximum
   * is not a distributed quantity: weighting it would let a grain straddling a
   * boundary register a fraction of its own underside in each cell, so the
   * surface would sag under exactly the grains that sit between cell centres.
   *
   * The value registered off-centre is the whole grain's extreme rather than
   * the sphere's silhouette there, which over-states the top and under-states
   * the bottom away from the centre. Both errors point the same way -- a
   * thicker apparent active layer defers emission, a lower apparent underside
   * defers absorption -- so the constant is the conservative choice for both
   * consumers, which is why it is not worth the square root.
   *
   * Note the *blend* is used when reading this surface back in `updateDepth`,
   * which is not a contradiction: writing an extremum and reading a smoothed
   * estimate of where the surface lies are different operations, and the trap
   * above is about the write.
   *
   * ## Why ballistic grains are excluded
   *
   * A grain twenty centimetres up would set `grainTop` twenty centimetres
   * above the pile, and emission reads that as an active layer far too thick
   * to ever refill. It cannot matter to `grainBottom` in the other direction:
   * a falling grain low enough to be the minimum in its cell is inside the
   * handoff band and has already joined the contact phase.
   */
  updateExtrema(P, field, skip = null) {
    const { px, py, pz, radius, phase, live } = P;
    const top = field.grainTop, bottom = field.grainBottom;
    top.fill(-Infinity);
    bottom.fill(Infinity);
    const s = field.s;
    let counted = 0;

    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      if (phase[i] === PHASE_BALLISTIC) continue;
      if (skip && skip[i]) continue;
      const r = radius[i];
      const hi = py[i] + r, lo = py[i] - r;
      if (r <= s) {
        const t = field.sampleTriangle(px[i], pz[i]);
        if (top[t.i0] < hi) top[t.i0] = hi;
        if (top[t.i1] < hi) top[t.i1] = hi;
        if (top[t.i2] < hi) top[t.i2] = hi;
        if (bottom[t.i0] > lo) bottom[t.i0] = lo;
        if (bottom[t.i1] > lo) bottom[t.i1] = lo;
        if (bottom[t.i2] > lo) bottom[t.i2] = lo;
      } else {
        // Only bodies wider than a cell get here -- at the default size window
        // that is clumps and nothing else, tens of them against a hundred
        // thousand grains, so the array this allocates is not in any hot path.
        const cells = field.discCells(px[i], pz[i], r);
        for (let c = 0; c < cells.length; c += 2) {
          const idx = cells[c];
          if (top[idx] < hi) top[idx] = hi;
          if (bottom[idx] > lo) bottom[idx] = lo;
        }
      }
      counted++;
    }

    this.extremaCounted = counted;
    this._fitTopNormal(field);
    return counted;
  }

  /**
   * The y component of the unit normal to the grain-top surface, per cell.
   * Same six-neighbour least-squares plane fit as `HexField.cellNormal`, which
   * collapses to one weighted sum because the six directions are 60° apart --
   * applied to `grainTop` rather than to height, so it describes the surface
   * the *grains* make and not the one the continuum has reached.
   *
   * Only the y component is kept, because the only consumer projects a
   * vertical drop onto the normal, and `n̂·ŷ` is that whole projection.
   * Cells with no grains, and neighbours with none, read as this cell's own
   * top -- flattening the fit toward vertical at the pile's edge rather than
   * inventing a cliff where the data simply stops.
   */
  _fitTopNormal(field) {
    if (!this.topNy || this.topNy.length !== field.n) {
      this.topNy = new Float64Array(field.n);
      this.topGrad = new Float64Array(field.n);
    }
    const ny = this.topNy, grad = this.topGrad, top = field.grainTop;
    const W = field.W, H = field.H, inv = 1 / (3 * field.s);
    for (let r = 0; r < H; r++) {
      const dq = (r & 1) ? NB_DQ_ODD : NB_DQ_EVEN;
      for (let q = 0; q < W; q++) {
        const c = r * W + q;
        const h0 = top[c];
        if (!Number.isFinite(h0)) { ny[c] = 1; grad[c] = 0; continue; }
        let gx = 0, gz = 0;
        for (let k = 0; k < 6; k++) {
          const nq = q + dq[k], nr = r + NB_DR[k];
          const inside = nq >= 0 && nq < W && nr >= 0 && nr < H;
          const hn = inside ? top[nr * W + nq] : h0;
          const d = (Number.isFinite(hn) ? hn : h0) - h0;
          gx += d * NB_DX[k];
          gz += d * NB_DZ[k];
        }
        gx *= inv; gz *= inv;
        grad[c] = Math.hypot(gx, gz);
        ny[c] = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      }
    }
  }

  /**
   * Fill `depth[i]`: the distance through touching grains from the free
   * surface to grain `i`'s centre, in metres. Grains further than `cutoff`
   * are left at `Infinity`, which is all a threshold test needs to know.
   * Needs `updateExtrema` and `hash.buildAdjacency` to have run against
   * current positions.
   *
   * ## The cutoff is what makes this affordable, and it is not an approximation
   *
   * Work is proportional to the population *within* the active layer rather
   * than to the pile, because nothing below the threshold needs an exact
   * depth -- only the fact that it is past it. That is the same argument the
   * hybrid rests on, arriving one level down.
   *
   * At the slider's ∞ detent the cutoff is infinite, and a caller that ran
   * this anyway would traverse the whole pile to establish that nothing is
   * eligible. The caller skips absorption outright there; that detent *is*
   * "never absorb", not "absorb at a very large depth".
   */
  updateDepth(P, field, hash, { seedWindow, cutoff }) {
    const { radius, phase, live, px, py, pz } = P;
    const { adjStart, adjList } = hash;
    const depth = this.depth, settled = this._settled;
    const ny = this.topNy, grad = this.topGrad;
    const top = field.grainTop;
    let key = this._heapKey, val = this._heapVal;
    let n = 0;

    // ⚠ The heap can hold more entries than there are grains. This is a lazy-
    // deletion Dijkstra -- a shorter route to an unsettled grain pushes a
    // second entry rather than sifting the old one down -- so the bound is one
    // entry per *edge* relaxed, not one per grain, and a heap sized to the
    // population overruns on any pile with more than one contact per grain.
    // Which is every pile.
    const grow = () => {
      const nk = new Float64Array(key.length * 2);
      const nv = new Int32Array(val.length * 2);
      nk.set(key); nv.set(val);
      key = this._heapKey = nk; val = this._heapVal = nv;
    };

    const push = (d, i) => {
      if (n + 2 >= key.length) grow();
      let c = ++n;
      key[c] = d; val[c] = i;
      while (c > 1) {
        const p = c >> 1;
        if (key[p] <= key[c]) break;
        const tk = key[p], tv = val[p];
        key[p] = key[c]; val[p] = val[c];
        key[c] = tk; val[c] = tv;
        c = p;
      }
    };
    const pop = () => {
      const top1 = val[1];
      key[1] = key[n]; val[1] = val[n]; n--;
      let c = 1;
      for (;;) {
        const l = c << 1, r = l + 1;
        let m = c;
        if (l <= n && key[l] < key[m]) m = l;
        if (r <= n && key[r] < key[m]) m = r;
        if (m === c) break;
        const tk = key[m], tv = val[m];
        key[m] = key[c]; val[m] = val[c];
        key[c] = tk; val[c] = tv;
        c = m;
      }
      return top1;
    };

    let seeds = 0;
    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      settled[i] = 0;
      // Zero, emphatically not Infinity. A grain in flight is not in the
      // adjacency, so nothing would ever relax it, and leaving it at the
      // "unreached" sentinel would make every consumer testing `depth > cutoff`
      // read a grain in mid-air as infinitely buried.
      if (phase[i] === PHASE_BALLISTIC) { depth[i] = 0; continue; }
      depth[i] = Infinity;

      const t = field.sampleTriangle(px[i], pz[i]);
      const t0 = top[t.i0], t1 = top[t.i1], t2 = top[t.i2];
      if (!Number.isFinite(t0) && !Number.isFinite(t1) && !Number.isFinite(t2)) continue;
      // An empty cell contributes nothing rather than -Infinity, which would
      // poison the blend for a grain at the edge of the pile.
      const w0 = Number.isFinite(t0) ? t.w0 : 0;
      const w1 = Number.isFinite(t1) ? t.w1 : 0;
      const w2 = Number.isFinite(t2) ? t.w2 : 0;
      const wsum = w0 + w1 + w2;
      if (!(wsum > 0)) continue;
      let ref = 0;
      if (w0) ref += w0 * t0;
      if (w1) ref += w1 * t1;
      if (w2) ref += w2 * t2;
      ref /= wsum;
      // ⚠ `grainTop` is a per-cell **maximum**, so on a slope it does not read
      // the surface at this point -- it reads the highest grain anywhere in the
      // cell, which sits above the cell centre by roughly the cell radius times
      // the gradient. Blending three cells cancels some of that and not all: on
      // a packing tilted 45° the uncorrected reference put exposed grains
      // 2.11 diameters down, and at 32° it put them 1.70 down, both deep enough
      // for the active layer to swallow a grain sitting in plain sight.
      //
      // Subtracting the expected overshoot removes the tilt dependence rather
      // than trading it for a tolerance. The coefficient is a cell radius in
      // units of the spacing; measured across 16°, 32° and 45° the residual
      // wants 0.72, 0.64 and 0.54 of it, so one value cannot cancel all three
      // and 0.6 is taken as the middle. Erring high leaves the reference
      // slightly *below* the true surface, which reads grains as shallower than
      // they are -- absorbing late rather than exposing a grain, which is the
      // direction to be wrong in.
      const gradient = (w0 * grad[t.i0] + w1 * grad[t.i1] + w2 * grad[t.i2]) / wsum;
      ref -= TOP_MAX_BIAS * field.s * gradient;
      const drop = ref - py[i];
      if (!(drop < seedWindow)) continue;
      // Project the vertical drop onto the surface normal. On level ground
      // this changes nothing; on a flank it is the entire difference between a
      // depth and a column height.
      const slope = (w0 * ny[t.i0] + w1 * ny[t.i1] + w2 * ny[t.i2]) / wsum;
      // A grain cannot be less than its own radius below the surface it is
      // sitting on, and `drop` goes slightly negative for whichever grain in a
      // cell defines the maximum.
      depth[i] = Math.max(radius[i], drop * slope);
      push(depth[i], i);
      seeds++;
    }
    this.seeds = seeds;

    let reached = 0;
    while (n > 0) {
      const i = pop();
      if (settled[i]) continue;
      if (depth[i] > cutoff) break;          // the heap is ordered; so is everything after
      settled[i] = 1;
      reached++;
      const xi = px[i], yi = py[i], zi = pz[i];
      for (let a = adjStart[i]; a < adjStart[i + 1]; a++) {
        const j = adjList[a];
        if (settled[j]) continue;
        const w = Math.hypot(px[j] - xi, py[j] - yi, pz[j] - zi);
        const cand = depth[i] + w;
        if (cand < depth[j]) { depth[j] = cand; push(cand, j); }
      }
    }
    this.reached = reached;
    return reached;
  }
}
