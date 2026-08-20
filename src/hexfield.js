// The hex heightfield: a ledger of buried, stable sand.
//
// Hex rather than square because a square lattice bakes 4-fold anisotropy into
// anything that moves sand between cells, and yields square pyramids -- which
// would corrupt the exact thing this project measures. Cell centres on a
// triangular lattice also triangulate straight into a smooth surface.
//
// **By default the field never moves sand sideways.** It records what was
// absorbed and hands back a surface to stand on; the repose angle is whatever
// the contact solver produces, not a number typed into a toppling rule.
// `relax()` is the opt-in comparison arm that exists to test that claim, and
// running it is a deliberate departure from the model, not a refinement of it.
//
// Pure over flat typed arrays -- no DOM, no GL -- so the renderer reads these
// arrays and nothing else touches them.

import { allocBuffer } from './shared.js';

const SQRT3_2 = Math.sqrt(3) / 2;

// The six neighbours, in a fixed order shared by three tables: the world-space
// offset (in units of the spacing) and the odd-r (dq, dr) step for each row
// parity. Odd-r storage keeps the array rectangular in world space, at the cost
// of the neighbour step depending on which row you are standing in.
//
// Derived from the axial steps (+1,0) (-1,0) (0,+1) (0,-1) (+1,-1) (-1,+1),
// which is why the six directions come out 60 degrees apart -- that regularity
// is what makes the gradient fit below a one-liner.
const NB_DX = [1, -1, 0.5, -0.5, 0.5, -0.5];
const NB_DZ = [0, 0, SQRT3_2, -SQRT3_2, -SQRT3_2, SQRT3_2];
const NB_DR = [0, 0, 1, -1, -1, 1];
const NB_DQ_EVEN = [1, -1, 0, -1, 0, -1];
const NB_DQ_ODD = [1, -1, 1, 0, 1, 0];

// Ceiling on how much of a slope's excess one relaxation pass may move. Six
// neighbours each taking `k * excess * 0.5` lets a cell shed `3k * excess` in a
// pass, so anything past 1/3 overshoots and rings; a quarter leaves margin.
// Reached only at the short end of the slump half-life slider, where the
// requested rate is faster than the substep can represent.
const RELAX_MAX_STEP = 0.25;

// Below this much height per pair, in fractions of the cell spacing, a flux is
// not sand and is dropped. The flux is proportional to how far over the limit a
// slope is, so a settling pile approaches its repose angle exponentially and
// never exactly arrives -- without a floor the active set never empties and a
// pile that stopped moving to the eye keeps a thousand cells awake forever. At
// a 3 mm spacing this is three nanometres, or about three millionths of a grain.
const FLUX_EPSILON = 1e-6;

const F64_FIELDS = ['solidVolume', 'logVolSum', 'logVolSqSum', 'absorbCount'];
const F32_FIELDS = ['height', 'grainTop', 'grainBottom'];

export class HexField {
  constructor(gridW, gridH, spacing) {
    this.W = gridW;
    this.H = gridH;
    this.s = spacing;
    this.n = gridW * gridH;

    // Voronoi cell of a triangular lattice: a hexagon whose width across the
    // flats is the centre spacing.
    this.cellArea = SQRT3_2 * spacing * spacing;

    // Centre the lattice on the origin, matching the domain bounds the rest of
    // the simulation uses. Odd rows are offset half a cell, so the occupied x
    // span is (W - 0.5) cells rather than (W - 1).
    this.originX = -(gridW - 0.5) * spacing / 2;
    this.originZ = -(gridH - 1) * spacing * SQRT3_2 / 2;

    const f64Bytes = F64_FIELDS.length * this.n * 8;
    const f32Bytes = F32_FIELDS.length * this.n * 4;
    this.buffer = allocBuffer(f64Bytes + f32Bytes);

    let off = 0;
    for (const name of F64_FIELDS) {
      this[name] = new Float64Array(this.buffer, off, this.n);
      off += this.n * 8;
    }
    for (const name of F32_FIELDS) {
      this[name] = new Float32Array(this.buffer, off, this.n);
      off += this.n * 4;
    }

    // Volume is f64 because it is the standing volume audit's accumulator, and
    // an f32 running sum drifts by ~1e-5 relative over the hundreds of
    // thousands of deposits a long pour makes -- enough to swamp the thing the
    // audit is looking for. Height is f32 because it is uploaded verbatim as an
    // R32F texture, and 1e-8 m of resolution over a 10 cm pile is ample.

    // Bootstrap only; packing fraction becomes a measured per-cell output at
    // M4, at which point height comes from the observed underside of resting
    // grains and this is the fallback for cells that have none.
    this.packingFraction = 0.62;

    // ⚠ Off, and it stays off: M4 measured observation-driven elevation and
    // took the plan's pre-approved retreat. The flag survives because the
    // measurement that justified the retreat has to stay reproducible -- see
    // the note at the top of exchange.js for the four rules and their numbers.
    this.observedElevation = false;

    // Running total, so the audit does not sweep 37k cells every frame.
    // `sumVolume()` recomputes it from scratch, and the tests check they agree.
    this.volume = 0;
    // Sand that left the domain over the edge. Only relaxation can do this;
    // deposition always lands inside.
    this.escapedVolume = 0;

    this.dirty = { minQ: 0, maxQ: -1, minR: 0, maxR: -1 };

    // Relaxation's working set. Allocated on first use so the default path --
    // where the arm is off and the field is a pure ledger -- pays nothing.
    this._relax = null;

    this._tri = { i0: 0, i1: 0, i2: 0, w0: 0, w1: 0, w2: 0 };
    this._nrm = new Float64Array(3);
    this.reset();
  }

  reset() {
    this.solidVolume.fill(0);
    this.logVolSum.fill(0);
    this.logVolSqSum.fill(0);
    this.absorbCount.fill(0);
    this.height.fill(0);
    // Sentinels for "no grain in this cell". M3's hash rebuild fills both, and
    // M4 reads them: grainTop is the burial reference surface, grainBottom is
    // what stops an absorption engulfing a grain that is still live.
    this.grainTop.fill(-Infinity);
    this.grainBottom.fill(Infinity);

    this.volume = 0;
    this.escapedVolume = 0;
    this._relax = null;
    this.markAllDirty();
  }

  // --- Geometry -----------------------------------------------------------

  index(q, r) { return r * this.W + q; }
  cellQ(c) { return c % this.W; }
  cellR(c) { return (c / this.W) | 0; }
  cellX(q, r) { return this.originX + this.s * (q + 0.5 * (r & 1)); }
  cellZ(r) { return this.originZ + this.s * SQRT3_2 * r; }

  // Odd-r offset <-> axial. Axial is the coordinate the lattice is actually
  // regular in, so every derivation happens there and converts back.
  axialToIndex(i, j) {
    const r = Math.min(Math.max(j, 0), this.H - 1);
    // floor(j / 2), written so it also holds for negative rows.
    const q = Math.min(Math.max(i + ((j - (j & 1)) / 2), 0), this.W - 1);
    return r * this.W + q;
  }

  inBounds(q, r) { return q >= 0 && q < this.W && r >= 0 && r < this.H; }

  // The enclosing lattice triangle and its barycentric weights, which sum to 1
  // exactly by construction. This is the single resolution rule: surface
  // sampling and absorption deposition both go through it, so the height a
  // grain stands on and the cells its volume lands in can never disagree.
  //
  // Indices are clamped to the grid, so a query off the edge reads the boundary
  // cell rather than a hole. The domain is sized to hold the pile and grains
  // that leave it are freed, so what happens outside is cosmetic.
  sampleTriangle(x, z, out = this._tri) {
    // Shear world space into the lattice basis a = (s, 0), b = (s/2, s*root3/2),
    // where the triangulation is just the unit square cut along its short
    // diagonal and the affine coordinates *are* the barycentric weights.
    const jf = (z - this.originZ) / (this.s * SQRT3_2);
    const if_ = (x - this.originX) / this.s - jf * 0.5;
    const i0 = Math.floor(if_);
    const j0 = Math.floor(jf);
    const u = if_ - i0;
    const v = jf - j0;

    // The rhombus splits along u + v = 1, the diagonal that is a lattice edge.
    // The other diagonal is root3 times longer and is not an edge at all.
    if (u + v <= 1) {
      out.i0 = this.axialToIndex(i0, j0);
      out.i1 = this.axialToIndex(i0 + 1, j0);
      out.i2 = this.axialToIndex(i0, j0 + 1);
      out.w0 = 1 - u - v; out.w1 = u; out.w2 = v;
    } else {
      out.i0 = this.axialToIndex(i0 + 1, j0);
      out.i1 = this.axialToIndex(i0, j0 + 1);
      out.i2 = this.axialToIndex(i0 + 1, j0 + 1);
      out.w0 = 1 - v; out.w1 = 1 - u; out.w2 = u + v - 1;
    }
    return out;
  }

  heightAt(x, z) {
    const t = this.sampleTriangle(x, z, this._tri);
    const h = this.height;
    return t.w0 * h[t.i0] + t.w1 * h[t.i1] + t.w2 * h[t.i2];
  }

  // Surface normal at a cell centre, from a least-squares plane fit over the
  // six neighbours. Because the six directions are 60 degrees apart the normal
  // equations collapse: sum(d d^T) = 3 s^2 I, so the gradient is one weighted
  // sum with no matrix to invert.
  //
  // Missing neighbours off the edge are read as this cell's own height, which
  // flattens the normal toward vertical at the boundary rather than inventing a
  // cliff there.
  cellNormal(q, r, out = this._nrm) {
    const c = r * this.W + q;
    const h = this.height;
    const h0 = h[c];
    const dq = (r & 1) ? NB_DQ_ODD : NB_DQ_EVEN;
    let gx = 0, gz = 0;
    for (let k = 0; k < 6; k++) {
      const nq = q + dq[k], nr = r + NB_DR[k];
      const hn = this.inBounds(nq, nr) ? h[nr * this.W + nq] : h0;
      const d = hn - h0;
      gx += d * NB_DX[k];
      gz += d * NB_DZ[k];
    }
    // One factor of the spacing cancels against the offsets being in cell units.
    const inv = 1 / (3 * this.s);
    gx *= inv; gz *= inv;
    const len = Math.sqrt(gx * gx + 1 + gz * gz);
    out[0] = -gx / len; out[1] = 1 / len; out[2] = -gz / len;
    return out;
  }

  // Height and normal together. The normal is the barycentric blend of the
  // three cell normals, NOT the facet normal of the triangle: facet normals
  // step discontinuously across every triangle edge, which would give a grain
  // rolling over one a sideways kick out of nowhere. This is also exactly what
  // the vertex shader interpolates, so the surface a grain rests on and the
  // surface you can see are the same surface.
  sampleSurface(x, z, out) {
    const t = this.sampleTriangle(x, z, this._tri);
    const h = this.height;
    const W = this.W;
    const tmp = this._nrm;
    let nx = 0, ny = 0, nz = 0;
    // Unrolled: this is the per-contact path in M3, and three iterations are
    // not worth a pair of allocated arrays per grain.
    this.cellNormal(t.i0 % W, (t.i0 / W) | 0, tmp);
    nx += t.w0 * tmp[0]; ny += t.w0 * tmp[1]; nz += t.w0 * tmp[2];
    this.cellNormal(t.i1 % W, (t.i1 / W) | 0, tmp);
    nx += t.w1 * tmp[0]; ny += t.w1 * tmp[1]; nz += t.w1 * tmp[2];
    this.cellNormal(t.i2 % W, (t.i2 / W) | 0, tmp);
    nx += t.w2 * tmp[0]; ny += t.w2 * tmp[1]; nz += t.w2 * tmp[2];
    const len = Math.hypot(nx, ny, nz) || 1;
    out[0] = t.w0 * h[t.i0] + t.w1 * h[t.i1] + t.w2 * h[t.i2];
    out[1] = nx / len; out[2] = ny / len; out[3] = nz / len;
    return out;
  }

  // --- Mass ---------------------------------------------------------------

  // ⚠ Height follows volume only while `observedElevation` is off. With it on
  // -- which is what M4's absorption runs under -- a deposit changes the
  // *ledger* and nothing else, and the surface is driven separately from the
  // observed undersides of the grains that remain.
  //
  // Leaving this coupled was a real bug and not a tidiness point: absorption
  // then raised the terrain twice, once by `volume / (area * phi)` and again to
  // the observed surface, and the volume-derived half does not know where the
  // grains are. Measured, it drove live grains up to 782 µm inside the terrain
  // in a confined pour -- more than a grain diameter -- which is exactly the
  // engulfment the invariant forbids, arriving through the one path that never
  // consults `grainBottom`.
  _syncHeight(c) {
    if (!this.observedElevation) {
      this.height[c] = this.solidVolume[c] / (this.cellArea * this.packingFraction);
    }
    this._markDirty(c);
  }

  // Volume-derived height, kept as a function so M4 can compare it against the
  // observed one without a second array shadowing this one.
  volumeHeightOf(c) {
    return this.solidVolume[c] / (this.cellArea * this.packingFraction);
  }

  // The height this cell *would* reach if `extra` more solid volume landed in
  // it. M4's engulfment gate asks this before depositing, which is the only
  // way to refuse an absorption that would lift the surface over a live grain.
  volumeHeightOf2(c, extra) {
    return (this.solidVolume[c] + extra) / (this.cellArea * this.packingFraction);
  }

  _addTo(c, w, volume, logV) {
    this.solidVolume[c] += w * volume;
    this.logVolSum[c] += w * logV;
    this.logVolSqSum[c] += w * logV * logV;
    // A weight sum rather than an integer count: one grain spread over three
    // cells contributes a total of 1, so the per-cell mean and variance below
    // stay properly weighted.
    this.absorbCount[c] += w;
    this._syncHeight(c);
    if (this._relax) this._touch(c);
  }

  // Add one grain's solid volume to the field. `splatRadius` is the footprint;
  // pass max(spacing, grainRadius) so an ordinary grain lands in its triangle
  // and a clump spreads over the cells it actually covers.
  //
  // Volume-conserving in every case: the weights are normalised, and cells off
  // the edge are folded onto the boundary rather than dropped.
  deposit(x, z, volume, splatRadius = this.s) {
    if (!(volume > 0)) return;
    const logV = Math.log(volume);

    if (splatRadius <= this.s) {
      const t = this.sampleTriangle(x, z, this._tri);
      this._addTo(t.i0, t.w0, volume, logV);
      this._addTo(t.i1, t.w1, volume, logV);
      this._addTo(t.i2, t.w2, volume, logV);
    } else {
      const cells = this.discCells(x, z, splatRadius);
      for (let k = 0; k < cells.length; k += 2) {
        this._addTo(cells[k], cells[k + 1], volume, logV);
      }
    }
    this.volume += volume;
  }

  _takeFrom(c, want) {
    const have = this.solidVolume[c];
    if (!(have > 0) || !(want > 0)) return 0;
    const take = Math.min(want, have);
    const keep = 1 - take / have;
    this.solidVolume[c] = have - take;
    // Scale the moments by the same fraction: what is removed is a
    // representative sample of what is there, so the remembered mean and
    // spread are unchanged by removing it. Anything else would make emission
    // silently re-sort the cell.
    this.logVolSum[c] *= keep;
    this.logVolSqSum[c] *= keep;
    this.absorbCount[c] *= keep;
    this._syncHeight(c);
    if (this._relax) this._touch(c);
    return take;
  }

  // Remove volume from the field. Returns how much was actually removed, which
  // is less than requested when the cells run dry -- the caller owns the
  // shortfall, since silently inventing sand is how a volume audit rots.
  debit(x, z, volume, splatRadius = this.s) {
    if (!(volume > 0)) return 0;
    let removed = 0;
    if (splatRadius <= this.s) {
      const t = this.sampleTriangle(x, z, this._tri);
      removed += this._takeFrom(t.i0, volume * t.w0);
      removed += this._takeFrom(t.i1, volume * t.w1);
      removed += this._takeFrom(t.i2, volume * t.w2);
    } else {
      const cells = this.discCells(x, z, splatRadius);
      for (let k = 0; k < cells.length; k += 2) {
        removed += this._takeFrom(cells[k], volume * cells[k + 1]);
      }
    }
    this.volume -= removed;
    return removed;
  }

  // Cells within `radius`, as [index, weight, index, weight, ...] with weights
  // summing to 1. Cells off the edge are simply not enumerated and the
  // remaining weights absorb their share, which keeps deposition exact at the
  // boundary. Falls back to the triangle when the disc catches no centre.
  //
  // Public because M4's extrema pass needs the *same* set of cells a deposit
  // spreads over, weights ignored: a grain must register its underside across
  // every cell its volume would land in, or the engulfment guard has a hole
  // exactly under the rim of the large grains it was written for. Two
  // enumerations that agree on paper are how the one-resolution rule rots.
  discCells(x, z, radius) {
    const out = [];
    const s = this.s, rowH = s * SQRT3_2;
    const r0 = Math.max(0, Math.ceil((z - radius - this.originZ) / rowH));
    const r1 = Math.min(this.H - 1, Math.floor((z + radius - this.originZ) / rowH));
    const invR2 = 1 / (radius * radius);
    let total = 0;
    for (let r = r0; r <= r1; r++) {
      const dz = this.cellZ(r) - z;
      const half2 = radius * radius - dz * dz;
      if (half2 <= 0) continue;
      const half = Math.sqrt(half2);
      const off = 0.5 * (r & 1);
      const q0 = Math.max(0, Math.ceil((x - half - this.originX) / s - off));
      const q1 = Math.min(this.W - 1, Math.floor((x + half - this.originX) / s - off));
      for (let q = q0; q <= q1; q++) {
        const dx = this.cellX(q, r) - x;
        const t = 1 - (dx * dx + dz * dz) * invR2;
        if (t <= 0) continue;
        const w = t * t;
        out.push(r * this.W + q, w);
        total += w;
      }
    }
    if (total <= 0) {
      const t = this.sampleTriangle(x, z, this._tri);
      return [t.i0, t.w0, t.i1, t.w1, t.i2, t.w2];
    }
    const inv = 1 / total;
    for (let k = 1; k < out.length; k += 2) out[k] *= inv;
    return out;
  }

  // Remembered grain-size distribution for a cell, as the mean and variance of
  // log volume. Null when too little has been buried here to say anything --
  // the caller falls back to the global sorting rather than trusting a sample
  // of one.
  sizeMoments(c) {
    const n = this.absorbCount[c];
    if (n < 2) return null;
    const mean = this.logVolSum[c] / n;
    // Clamp against float cancellation: the two-moment form can go slightly
    // negative when the spread is near zero.
    const varLog = Math.max(0, this.logVolSqSum[c] / n - mean * mean);
    return { meanLogVol: mean, varLogVol: varLog };
  }

  // Independent recomputation of the running total, for the audit to check
  // itself against.
  sumVolume() {
    let sum = 0;
    for (let c = 0; c < this.n; c++) sum += this.solidVolume[c];
    return sum;
  }

  // --- Dirty tracking -----------------------------------------------------

  _markDirty(c) {
    const q = c % this.W, r = (c / this.W) | 0;
    const d = this.dirty;
    if (d.maxQ < d.minQ) { d.minQ = d.maxQ = q; d.minR = d.maxR = r; return; }
    if (q < d.minQ) d.minQ = q; else if (q > d.maxQ) d.maxQ = q;
    if (r < d.minR) d.minR = r; else if (r > d.maxR) d.maxR = r;
  }

  markAllDirty() {
    this.dirty.minQ = 0; this.dirty.maxQ = this.W - 1;
    this.dirty.minR = 0; this.dirty.maxR = this.H - 1;
  }

  clearDirty() {
    this.dirty.minQ = 0; this.dirty.maxQ = -1;
    this.dirty.minR = 0; this.dirty.maxR = -1;
  }

  hasDirty() { return this.dirty.maxQ >= this.dirty.minQ; }

  // --- Relaxation: the comparison arm, off by default ---------------------
  //
  // This is the mesh second-guessing the solver, and the default is not to run
  // it. It exists so "emergent repose vs dialed repose" is a runtime toggle
  // rather than an argument -- see the M6 experiment. When it is on, the number
  // on the repose slider is largely the number that comes back out, which is
  // the whole reason the pile does not slump by default.
  //
  // **The threshold is on the gradient, not on each neighbour's height
  // difference.** The obvious rule -- let sand move whenever a neighbour is
  // more than `tan(repose) * spacing` below you -- is anisotropic, and
  // measurably so. It constrains six directions rather than all of them, so a
  // flank pointing between two neighbours can stand at `tan(repose) / cos 30`
  // before anything fires. Built that way and measured, this field settled a
  // spike into a cone with a 4.1% six-fold ripple in its footprint and a flank
  // of 34.1 degrees when asked for 32. Small, but it is exactly the lattice
  // printing itself onto the pile shape, which is the one thing a hex lattice
  // was chosen to avoid. Gating on |grad h| instead is isotropic by
  // construction, and the transport stays an antisymmetric pair flux, so there
  // is still no sweep-order bias.

  _initRelax() {
    this._relax = {
      delta: new Float64Array(this.n),
      touched: new Int32Array(this.n),
      touchedMark: new Uint8Array(this.n),
      active: new Int32Array(this.n),
      activeMark: new Uint8Array(this.n),
      activeCount: 0,
      // Surface gradient per active cell, cached for one pass so each pair does
      // not refit both of its plane fits.
      gx: new Float64Array(this.n),
      gz: new Float64Array(this.n),
      gmag: new Float64Array(this.n),
      scratch: new Float64Array(2),
      // Hysteresis: a cell starts letting go above the static angle and does
      // not stop until it is back under the repose angle. Without the gap,
      // slopes creep continuously instead of avalanching in bursts.
      sliding: new Uint8Array(this.n),
    };
    // Seed with every cell that holds anything, since the arm may have been
    // switched on long after the pile was built.
    for (let c = 0; c < this.n; c++) if (this.solidVolume[c] > 0) this._touch(c);
  }

  // Surface gradient at a cell, for the relaxation arm only. Same six-neighbour
  // plane fit as `cellNormal`, but everything past the rim reads as the floor:
  // the domain edge is a cliff sand spills over, where for rendering it is a
  // boundary that should not sprout a cliff of its own.
  _relaxGradient(c, out) {
    const q = c % this.W, r = (c / this.W) | 0;
    const h = this.height, h0 = h[c];
    const dq = (r & 1) ? NB_DQ_ODD : NB_DQ_EVEN;
    let gx = 0, gz = 0;
    for (let k = 0; k < 6; k++) {
      const nq = q + dq[k], nr = r + NB_DR[k];
      const d = (this.inBounds(nq, nr) ? h[nr * this.W + nq] : 0) - h0;
      gx += d * NB_DX[k];
      gz += d * NB_DZ[k];
    }
    const inv = 1 / (3 * this.s);
    out[0] = gx * inv; out[1] = gz * inv;
  }

  // Wake a cell and its neighbours. Called whenever a height changes, so the
  // active set follows the sand instead of sweeping 37k cells a substep.
  _touch(c) {
    const R = this._relax;
    const q = c % this.W, r = (c / this.W) | 0;
    if (!R.activeMark[c]) { R.activeMark[c] = 1; R.active[R.activeCount++] = c; }
    const dq = (r & 1) ? NB_DQ_ODD : NB_DQ_EVEN;
    for (let k = 0; k < 6; k++) {
      const nq = q + dq[k], nr = r + NB_DR[k];
      if (!this.inBounds(nq, nr)) continue;
      const nc = nr * this.W + nq;
      if (!R.activeMark[nc]) { R.activeMark[nc] = 1; R.active[R.activeCount++] = nc; }
    }
  }

  // One relaxation pass. `rate` is a per-second relaxation rate; the flux for
  // each pair is symmetric by construction, so no sweep order can bias which
  // way sand travels.
  //
  // Returns the total height moved this pass, in metres summed over cells --
  // an avalanche-activity readout, and how a caller tells settled from still
  // sliding. Zero means the pile has stopped.
  relax(dt, tanRepose, tanStatic, rate) {
    if (!this._relax) this._initRelax();
    const R = this._relax;
    if (R.activeCount === 0) return 0;

    const h = this.height;
    const s = this.s;
    const fluxFloor = s * FLUX_EPSILON;
    const k = Math.min(rate * dt, RELAX_MAX_STEP);
    if (!(k > 0)) return 0;

    const active = R.active, count = R.activeCount;
    const delta = R.delta, touched = R.touched, mark = R.touchedMark;
    const gx = R.gx, gz = R.gz, gmag = R.gmag, g2 = R.scratch;
    let touchedCount = 0;

    // Pass 1: fit the surface gradient at every active cell and update the
    // sliding flags, so a pair's threshold is settled before any sand moves and
    // cannot depend on which cell is visited first.
    for (let a = 0; a < count; a++) {
      const c = active[a];
      this._relaxGradient(c, g2);
      gx[c] = g2[0]; gz[c] = g2[1];
      const m = Math.hypot(g2[0], g2[1]);
      gmag[c] = m;
      if (m > tanStatic) R.sliding[c] = 1;
      else if (m <= tanRepose) R.sliding[c] = 0;
    }

    // Pass 2: gather. Each pair is visited exactly once -- from `c` when the
    // neighbour is not itself active, and from the lower index when both are.
    for (let a = 0; a < count; a++) {
      const c = active[a];
      const q = c % this.W, r = (c / this.W) | 0;
      const dq = (r & 1) ? NB_DQ_ODD : NB_DQ_EVEN;
      for (let j = 0; j < 6; j++) {
        const nq = q + dq[j], nr = r + NB_DR[j];
        const inside = this.inBounds(nq, nr);
        const nc = inside ? nr * this.W + nq : -1;
        if (inside && R.activeMark[nc] && nc < c) continue;

        let ngx, ngz, nmag;
        if (!inside) {
          // Past the rim there is no cell to fit a plane to, so the pair runs
          // on this cell's own gradient -- which already sees the drop to the
          // floor, because _relaxGradient reads the outside as zero.
          ngx = gx[c]; ngz = gz[c]; nmag = gmag[c];
        } else if (R.activeMark[nc]) {
          ngx = gx[nc]; ngz = gz[nc]; nmag = gmag[nc];
        } else {
          this._relaxGradient(nc, g2);
          ngx = g2[0]; ngz = g2[1]; nmag = Math.hypot(ngx, ngz);
        }

        const limit = (R.sliding[c] || (inside && R.sliding[nc])) ? tanRepose : tanStatic;
        // The isotropic gate: is this patch of surface over-steep, whichever
        // way it happens to face? A per-neighbour height test here instead is
        // what makes the naive rule hexagonal.
        if ((gmag[c] + nmag) * 0.5 <= limit) continue;

        // Transport is the actual drop to this neighbour, against a threshold
        // scaled by how squarely the pair faces down the slope. A plane of
        // gradient g drops g*s*cos(a) to a neighbour at angle a off the fall
        // line, so thresholding at limit*s*cos(a) settles at |grad h| = limit
        // in every direction rather than in six.
        //
        // The drop has to be the real one and not the gradient's estimate of
        // it. Transporting down the fitted gradient alone pushes sand at a
        // neighbour that may not actually be lower, and the six-neighbour plane
        // fit cannot see the resulting checkerboard to correct it: built that
        // way, this settled into a jagged surface with centimetre steps between
        // adjacent cells while every fitted gradient read plausibly close to
        // the repose angle.
        const mx = (gx[c] + ngx) * 0.5, mz = (gz[c] + ngz) * 0.5;
        const gLen = Math.hypot(mx, mz);
        const cosA = gLen > 0 ? Math.abs(NB_DX[j] * mx + NB_DZ[j] * mz) / gLen : 1;
        const dh = h[c] - (inside ? h[nc] : 0);
        const excess = Math.abs(dh) - limit * s * cosA;
        if (excess <= 0) continue;

        // Halved because both sides move, so the pair closes its excess at
        // `rate` rather than twice it.
        let flux = k * excess * 0.5 * (dh > 0 ? 1 : -1);

        // No cell may be asked for more sand than it has. The gate is on the
        // gradient, so a nearly empty cell beside a tall one carries a large
        // gradient and would otherwise be told to hand over height it does not
        // own -- the shortfall would be clamped at apply time, the receiving
        // cell would keep the full amount, and the arm would quietly mint sand.
        // A seventh apiece leaves a cell with a fraction of itself after all
        // six pairs have taken their share.
        const donor = flux > 0 ? h[c] : (inside ? h[nc] : 0);
        const cap = donor / 7;
        if (flux > cap) flux = cap; else if (flux < -cap) flux = -cap;
        if (Math.abs(flux) < fluxFloor) continue;

        if (!mark[c]) { mark[c] = 1; touched[touchedCount++] = c; }
        delta[c] -= flux;
        if (inside) {
          if (!mark[nc]) { mark[nc] = 1; touched[touchedCount++] = nc; }
          delta[nc] += flux;
        } else {
          // Over the rim and gone.
          this.escapedVolume += flux * this.cellArea * this.packingFraction;
        }
      }
    }

    // Pass 3: apply, and rebuild the active set from what actually moved.
    // Height is a pure function of volume while elevation is volume-derived, so
    // move the volume and let the height follow -- that keeps the two exactly
    // consistent instead of nearly so.
    const scale = this.cellArea * this.packingFraction;
    let moved = 0;   // total |dh|, the activity readout
    for (let t = 0; t < touchedCount; t++) {
      const c = touched[t];
      mark[c] = 0;
      const dh = delta[c];
      delta[c] = 0;
      if (dh === 0) continue;
      // Book the change that actually happened, not the one that was asked
      // for. The clamp cannot fire -- six neighbours can drain at most 3k of a
      // cell's excess and k is capped at a quarter -- but the accumulator must
      // not be able to drift away from the array even if it did.
      const before = this.solidVolume[c];
      const after = Math.max(0, before + dh * scale);
      this.solidVolume[c] = after;
      this.volume += after - before;
      this.height[c] = after / scale;
      this._markDirty(c);
      moved += Math.abs(dh);
    }
    // Rebuild the active set from what moved. Clear the old marks through the
    // old list rather than wiping the whole array, which would cost more than
    // the pass itself once the pile is small relative to the grid.
    for (let a = 0; a < count; a++) R.activeMark[active[a]] = 0;
    R.activeCount = 0;
    for (let t = 0; t < touchedCount; t++) this._touch(touched[t]);
    return moved;
  }
}

// Relaxation rate from the half-life slider. A pair of cells closes the excess
// part of its height difference exponentially, so a half-life T means ln2 / T.
// With six neighbours interacting a real slope settles faster than that, which
// is why the panel calls it a half-life rather than promising one.
export function relaxRateFromHalfLife(halfLife) {
  return Math.LN2 / Math.max(halfLife, 1e-4);
}
