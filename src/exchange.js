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

import { PHASE_BALLISTIC } from './particles.js';

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
    this.extremaCounted = 0;
    this.seeds = 0;
    this.reached = 0;
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
  updateExtrema(P, field) {
    const { px, py, pz, radius, phase, live } = P;
    const top = field.grainTop, bottom = field.grainBottom;
    top.fill(-Infinity);
    bottom.fill(Infinity);
    const s = field.s;
    let counted = 0;

    for (let k = 0; k < P.count; k++) {
      const i = live[k];
      if (phase[i] === PHASE_BALLISTIC) continue;
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
