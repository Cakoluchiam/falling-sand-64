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
// are separate modules: every measure below is a claim about geometry that a
// test has to be able to check directly.
//
// ## ⚠ Depth is measured through the material, not down a column
//
// The plan's original burial test was `grainTop(x,z) - (py + radius)`, a purely
// vertical measure, and it misreads slopes in both directions: on a 32° flank
// the column above a grain includes material resting on the slope beside it
// rather than on the grain, so an exposed grain reads buried and vanishes in
// plain sight, while a genuinely interior grain under a falling surface reads
// exposed and never retires. Direction coverage fixes the orientation problem
// but cannot replace the measure, because coverage saturates about one grain
// below the surface -- it can say "this grain has no free sky" and cannot tell
// two diameters deep from eight. An active layer one grain thick is precisely
// the "material frozen mid-slide" failure the activeLayerDepth sweep exists to
// detect.
//
// So the two are split, and each does the job it can do. **Coverage identifies
// the free surface**; **depth is the shortest distance through touching grains
// from that surface**, accumulated centre to centre. Orientation-free by
// construction, in metres, so `derived.activeLayerMetres()` and both slider
// sentinels keep working unchanged -- no finite depth exceeds Infinity, and a
// threshold of zero absorbs anything not on the surface itself.
//
// It errs by *over*-stating depth where the path through the pile wiggles,
// which absorbs marginally early rather than late. That is the direction the
// engulfment invariant and the quiescence test are there to catch.

import { PHASE_BALLISTIC } from './particles.js';

export class ExchangeSolver {
  constructor(capacity) {
    this.capacity = capacity;
    // Distance through the pile to the nearest free surface, in metres.
    // Float64 because it is accumulated along a path of many hops.
    this.depth = new Float64Array(capacity);
    // Fraction of the direction set no neighbour covers: 1 for a grain alone
    // in space, ~0 for a grain in the interior.
    this.uncovered = new Float32Array(capacity);
    this.extremaCounted = 0;
  }

  /**
   * Fill the field's per-cell `grainTop` and `grainBottom` from the live
   * contact-phase population. One sweep, once per frame.
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
    return counted;
  }
}
