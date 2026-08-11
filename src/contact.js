// Grain-surface contact, solved by projecting positions rather than by
// integrating forces.
//
// Pure over flat typed arrays, taking the heightfield as an argument, for the
// same reason `ballistic.js` is separate: the friction law below has an exact
// analytic answer -- a grain on a slope of angle θ stays put iff tan θ ≤ μ and
// slides at g(sin θ − μ cos θ) above it -- and a test has to be able to reach
// the solver to check it against arithmetic. That check is the entire point of
// building surface contact before grain-grain contact: once pairs are in the
// picture, a discrepancy has two possible homes.
//
// ## ⚠ Friction is positional, not a velocity damping
//
// The plan specified "damp tangential velocity for Coulomb friction". That is
// viscous friction: resistance proportional to sliding speed, with a
// coefficient that carries the timestep in it. Coulomb friction is a
// *threshold* -- below μN nothing moves at all, above it the resistance is
// constant and speed-independent -- and the difference is the whole project.
// Repose angle is the output this simulator exists to measure, and a pile's
// flank angle is exactly where the friction threshold balances gravity. With
// viscous damping there is no threshold, so a grain on any slope creeps at
// some rate, the pile keeps settling, and the angle you finally measure is set
// by how long you waited and how big `dt` was. It would look plausible near
// 32° and be a property of the integrator.
//
// The positional form below is threshold-correct and, more importantly,
// timestep-independent, which is checkable. Working one substep of a grain at
// rest on a slope of angle θ: gravity moves it g·dt² downward, the normal
// projection pushes it back out by d = g·dt²·cos θ, and the tangential
// remainder is g·dt²·sin θ. The friction budget is μ·d = μ·g·dt²·cos θ, so the
// grain sticks exactly when g·dt²·sin θ ≤ μ·g·dt²·cos θ. **The dt² cancels**,
// leaving tan θ ≤ μ. Above the threshold the surplus per substep is
// g·dt²(sin θ − μ cos θ), which is an acceleration of g(sin θ − μ cos θ).
// Both are what the textbook says, and neither mentions the timestep.

import { PHASE_AWAKE } from './particles.js';
import { GrainHash } from './hash.js';

// Below this multiple of the per-substep gravity impulse, an impact is not an
// impact. See the note on restitution in `step`.
const BOUNCE_FLOOR = 2;

export class ContactSolver {
  constructor(capacity) {
    this.capacity = capacity;
    // Position at the start of the substep. Float64 because the whole friction
    // law is a difference of two nearby positions, and in Float32 a millimetre
    // grain moving g·dt² -- about 170 nm at 240 Hz -- lands near the resolution
    // limit of the coordinate it is being subtracted from.
    this.xprev = new Float64Array(capacity * 3);
    this.approachVn = new Float64Array(capacity);
    this.touching = new Uint8Array(capacity);
    // The local surface plane under each grain, as a normal and an offset
    // (`n·x = d`). Sampled once per substep and reused by the projection, the
    // friction and the restitution: the heightfield does not move within a
    // substep, and `sampleSurface` blends three six-neighbour plane fits, so
    // calling it four times per grain per substep was three quarters of the
    // solver's cost for nothing.
    //
    // ⚠ Stored as an offset rather than as the sampled height, and the
    // difference is not cosmetic. Height is the surface *at one (x, z)*, so it
    // goes stale the moment friction slides the grain along the slope, and the
    // next iteration then measures depth against a plane the grain has left.
    // Caching the height cost 3.2% on the fastest-sliding case tested -- 50° at
    // μ 0.2, where the tangential step per substep is largest -- while the
    // slower cases stayed exact and hid it. An offset has no such position:
    // sliding along the plane leaves `n·x` unchanged, so depth stays correct
    // however far the grain travels within the substep.
    this.plane = new Float64Array(capacity * 4);
    // Velocity at the start of the substep. Restitution between grains needs
    // the speed they were closing at, and the velocity rebuilt from positions
    // has had exactly that removed by the projection.
    this.vprev = new Float64Array(capacity * 3);
    this.hash = new GrainHash(capacity);
    this._surf = new Float64Array(4);
    this.contacts = 0;
    this.pairs = 0;
    // Hoisted so the rebuild does not allocate a closure every substep.
    this._accept = null;
  }

  /**
   * Separate every overlapping pair, and apply the same friction cone between
   * grains that the surface gets. Returns the number of overlaps found.
   *
   * ## Volume weighting, and why it is inverse mass and not volume
   *
   * The share of a correction each grain takes is its *inverse* mass over the
   * pair's total inverse mass, and at one density mass is proportional to
   * volume — so the grain that moves is the one with the **other** grain's
   * volume on top: `share_i = vol_j / (vol_i + vol_j)`. Reaching for
   * `vol_i / (vol_i + vol_j)` is the natural mistake and is exactly backwards:
   * it would make the boulder jump aside when a fine grain brushed it.
   *
   * That weighting also conserves the pair's centre of mass exactly, since
   * `vol_i·Δ_i + vol_j·Δ_j` cancels by construction. Nothing external acts in
   * this pass, so any drift in the centre of mass would be the solver quietly
   * pushing the pile somewhere, and the test suite checks it directly.
   */
  _solvePairs(P, mu) {
    const { px, py, pz, vol, radius } = P;
    const xprev = this.xprev;
    const hash = this.hash;
    const sorted = hash.sorted;
    let overlaps = 0;

    // Iterating the sorted order rather than `live` walks the pairs in the
    // order the counting sort laid them out, so neighbours tend to be adjacent
    // in memory. Gauss-Seidel: corrections land immediately and the next pair
    // sees them, which converges faster per iteration than accumulating.
    for (let s = 0; s < hash.count; s++) {
      const i = sorted[s];
      hash.forEachNeighbour(P, i, (j) => {
        const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
        const sum = radius[i] + radius[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= sum * sum) return;
        overlaps++;
        // Coincident centres have no separating direction. Two grains emitted
        // at the same instant from the same point really can land here, so
        // pick an arbitrary axis rather than dividing by zero.
        const dist = Math.sqrt(d2);
        let nx, ny, nz;
        if (dist > 1e-12) { nx = dx / dist; ny = dy / dist; nz = dz / dist; }
        else { nx = 0; ny = 1; nz = 0; }
        const depth = sum - dist;

        const total = vol[i] + vol[j];
        const si = total > 0 ? vol[j] / total : 0.5;
        const sj = 1 - si;
        px[i] += nx * depth * si; py[i] += ny * depth * si; pz[i] += nz * depth * si;
        px[j] -= nx * depth * sj; py[j] -= ny * depth * sj; pz[j] -= nz * depth * sj;

        // Friction on the *relative* tangential travel of the two grains,
        // against the same cone the surface uses.
        const bi = i * 3, bj = j * 3;
        let rx = (px[i] - xprev[bi]) - (px[j] - xprev[bj]);
        let ry = (py[i] - xprev[bi + 1]) - (py[j] - xprev[bj + 1]);
        let rz = (pz[i] - xprev[bi + 2]) - (pz[j] - xprev[bj + 2]);
        const along = rx * nx + ry * ny + rz * nz;
        rx -= along * nx; ry -= along * ny; rz -= along * nz;
        const slide = Math.hypot(rx, ry, rz);
        if (slide <= 1e-18) return;
        const budget = mu * depth;
        const f = slide <= budget ? 1 : budget / slide;
        px[i] -= rx * f * si; py[i] -= ry * f * si; pz[i] -= rz * f * si;
        px[j] += rx * f * sj; py[j] += ry * f * sj; pz[j] += rz * f * sj;
      });
    }
    return overlaps;
  }

  /**
   * Set the normal relative velocity of every contacting pair to what the
   * collision justifies: `-e ×` the closing speed for a real impact, and zero
   * otherwise. Separate from the position solve for the same reason as the
   * surface case -- the projection is what removes the approach, so the
   * closing speed has to come from `vprev`.
   */
  _resolvePairVelocities(P, e, bounceFloor) {
    const { px, py, pz, vx, vy, vz, vol, radius } = P;
    const vprev = this.vprev;
    const hash = this.hash;
    const sorted = hash.sorted;

    for (let s = 0; s < hash.count; s++) {
      const i = sorted[s];
      hash.forEachNeighbour(P, i, (j) => {
        const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
        const sum = radius[i] + radius[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        // Just-separated pairs still count: the projection has already pushed
        // them apart, and their collision is the thing being restituted.
        if (d2 >= sum * sum * 1.0201 || d2 <= 1e-24) return;
        const dist = Math.sqrt(d2);
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;

        const bi = i * 3, bj = j * 3;
        const approach = (vprev[bi] - vprev[bj]) * nx +
                         (vprev[bi + 1] - vprev[bj + 1]) * ny +
                         (vprev[bi + 2] - vprev[bj + 2]) * nz;
        // A pair that was not closing hard still has to be damped, not
        // skipped: the projection has just converted their overlap into
        // separating velocity, and leaving it in is how a pile breathes itself
        // apart. Below the impact floor the target is simply zero.
        const vn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny + (vz[i] - vz[j]) * nz;
        const target = approach < -bounceFloor ? -e * approach : 0;
        const add = target - vn;
        if (add === 0) return;
        const total = vol[i] + vol[j];
        const si = total > 0 ? vol[j] / total : 0.5;
        const sj = 1 - si;
        vx[i] += nx * add * si; vy[i] += ny * add * si; vz[i] += nz * add * si;
        vx[j] -= nx * add * sj; vy[j] -= ny * add * sj; vz[j] -= nz * add * sj;
      });
    }
  }

  /**
   * One substep for every grain in the contact phase. `o` carries `gravity`,
   * `friction`, `restitution`, `iterations` and `baseCell`.
   */
  step(P, field, dt, o) {
    const { px, py, pz, vx, vy, vz, radius, phase, live } = P;
    const g = o.gravity;
    const mu = Math.max(o.friction, 0);
    const e = Math.min(Math.max(o.restitution, 0), 1);
    const iterations = o.iterations ?? 2;
    const xprev = this.xprev, vprev = this.vprev;
    const approachVn = this.approachVn, touching = this.touching;
    const surf = this._surf;
    const n = P.count;
    const bounceFloor = BOUNCE_FLOOR * g * dt;
    let contacts = 0;

    // --- Predict. Save where each grain started; the friction law reads it.
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (phase[i] !== PHASE_AWAKE) continue;
      const b = i * 3;
      xprev[b] = px[i]; xprev[b + 1] = py[i]; xprev[b + 2] = pz[i];
      vprev[b] = vx[i]; vprev[b + 1] = vy[i]; vprev[b + 2] = vz[i];
      vy[i] -= g * dt;
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
    }

    // --- Broad phase over the predicted positions, so the pairs solved below
    // are the ones that will actually be overlapping.
    if (!this._accept) this._accept = (i) => phase[i] === PHASE_AWAKE;
    this.hash.rebuild(P, o.baseCell, this._accept);

    // --- Record the approach speed *before* any projection. Restitution
    // cannot be recovered afterwards: the projection is what removes the
    // approach, and the velocity rebuilt from positions below has no memory
    // of how hard the grain arrived. Scaling the post-solve normal velocity by
    // `restitution`, which is what "scale the normal component" invites, scales
    // a number that is already zero and produces no bounce at any setting.
    const plane = this.plane;
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (phase[i] !== PHASE_AWAKE) continue;
      field.sampleSurface(px[i], pz[i], surf);
      const p = i * 4;
      const nx = surf[1], ny = surf[2], nz = surf[3];
      // The plane through the sampled surface point, in `n·x = d` form.
      plane[p] = nx * px[i] + ny * surf[0] + nz * pz[i];
      plane[p + 1] = nx; plane[p + 2] = ny; plane[p + 3] = nz;
      const depth = radius[i] - (nx * px[i] + ny * py[i] + nz * pz[i] - plane[p]);
      if (depth > 0) {
        touching[i] = 1;
        approachVn[i] = vx[i] * surf[1] + vy[i] * surf[2] + vz[i] * surf[3];
        contacts++;
      } else {
        touching[i] = 0;
        approachVn[i] = 0;
      }
    }
    this.contacts = contacts;

    // --- Separate pairs, then project out of the surface.
    //
    // ⚠ The surface goes last, and the order is not arbitrary. These are
    // Gauss-Seidel passes, so whichever runs last has the final say, and a
    // pair correction can shove a grain straight through the floor. Solving
    // pairs last left grains up to 571 µm inside the terrain -- more than a
    // grain diameter -- in a pile that otherwise had zero remaining overlaps.
    // The terrain is effectively infinite mass and cannot yield, so it is the
    // constraint that must be satisfied at the end of the substep. It also has
    // to be, for M4: absorption's engulfment invariant assumes no live grain is
    // ever below the surface, and that assumption is established here.
    for (let it = 0; it < iterations; it++) {
      const found = this._solvePairs(P, mu);
      // The first iteration's count is the real overlap population; later
      // iterations find only what the earlier ones left, so reporting the last
      // would always read near zero and look like nothing was in contact.
      if (it === 0) this.pairs = found;

      for (let k = 0; k < n; k++) {
        const i = live[k];
        // ⚠ Not gated on `touching`. That flag records whether the grain was
        // already in the surface when the substep began, and it exists for the
        // restitution pass, which needs an approach velocity sampled before
        // anything moved. Using it here as well made it do double duty and
        // silently wrong duty: a grain that started clear of the surface and
        // was then driven into it by a pair correction never got projected
        // out, because the flag had been decided before that correction
        // existed. In a pile deep enough for the pairs to press hard -- a
        // 5.6 cm heap -- that left 344 grains sitting inside the terrain while
        // the unit tests, whose piles are two to four grains deep, reported
        // none. The plane is cached for every awake grain, touching or not, so
        // there is nothing to gain by skipping them.
        if (phase[i] !== PHASE_AWAKE) continue;
        const p = i * 4;
        const nx = plane[p + 1], ny = plane[p + 2], nz = plane[p + 3];
        // Perpendicular distance from the centre to the cached plane.
        //
        // Recomputed each iteration against that plane rather than resampled.
        // For surface contact alone this makes every iteration past the first
        // a no-op, which is correct: one projection satisfies one constraint
        // exactly. The loop is here for the pair constraints of the next step,
        // where corrections genuinely fight each other.
        const depth = radius[i] - (nx * px[i] + ny * py[i] + nz * pz[i] - plane[p]);
        if (depth <= 0) continue;
        px[i] += nx * depth; py[i] += ny * depth; pz[i] += nz * depth;

        // Tangential travel since the substep began, measured after the normal
        // correction so the two are consistent.
        const b = i * 3;
        let dx = px[i] - xprev[b], dy = py[i] - xprev[b + 1], dz = pz[i] - xprev[b + 2];
        const along = dx * nx + dy * ny + dz * nz;
        dx -= along * nx; dy -= along * ny; dz -= along * nz;
        const slide = Math.hypot(dx, dy, dz);
        if (slide <= 1e-18) continue;

        // The cone. Below the budget the tangential motion is cancelled
        // outright -- that is static friction, and it is what a threshold
        // means. Above it, exactly the budget is removed and the remainder
        // survives as sliding.
        const budget = mu * depth;
        const scale = slide <= budget ? 1 : budget / slide;
        px[i] -= dx * scale; py[i] -= dy * scale; pz[i] -= dz * scale;
      }
    }

    // --- Velocity from the position change, then put the bounce back.
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (phase[i] !== PHASE_AWAKE) continue;
      const b = i * 3;
      vx[i] = (px[i] - xprev[b]) / dt;
      vy[i] = (py[i] - xprev[b + 1]) / dt;
      vz[i] = (pz[i] - xprev[b + 2]) / dt;

      if (!touching[i]) continue;
      const approach = approachVn[i];
      if (approach >= 0) continue;                 // leaving, or grazing
      const p = i * 4;
      const nx = plane[p + 1], ny = plane[p + 2], nz = plane[p + 3];
      const vn = vx[i] * nx + vy[i] * ny + vz[i] * nz;
      // ⚠ Only a real impact bounces. A grain resting on the surface still
      // "approaches" it by g·dt every substep, and reflecting that gives it a
      // permanent upward twitch of e·g·dt that never settles -- the pile
      // simmers forever at any non-zero restitution. Below the floor the
      // normal velocity is simply not allowed to be negative, which is the
      // resting contact behaving as a contact.
      // ⚠ Set the normal velocity, do not merely raise it toward the target.
      // The projection converts whatever penetration it removed into
      // separating velocity, so a contact that was not an impact still comes
      // out of the solve moving apart -- a grain resolved out of a deep
      // overlap leaves at penetration/dt and keeps going, because nothing
      // downstream has any reason to stop it. Clamping only upward leaves that
      // energy in; clamping both ways makes a zero-restitution contact
      // genuinely inelastic, which is what sand is.
      const target = -approach < bounceFloor ? 0 : -e * approach;
      const add = target - vn;
      if (add !== 0) { vx[i] += nx * add; vy[i] += ny * add; vz[i] += nz * add; }
    }

    // ⚠ Always, including at zero restitution. This pass is not only the
    // bounce -- it is also what removes the separating velocity the position
    // solve manufactured, and at `restitution = 0` that is the whole of its
    // job. Gating it on `e > 0` as an optimisation left zero-restitution
    // contacts as the *only* ones that sprang apart, which is precisely
    // backwards from what the setting means.
    this._resolvePairVelocities(P, e, bounceFloor);
  }
}
