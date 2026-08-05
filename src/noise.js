// Gradient noise, and the divergence-free turbulence field built from it.
//
// The flow the grains fall through must be divergence-free. A field with
// divergence would artificially compress or rarefy the falling stream, which is
// exactly the sort of tuned-looking artifact this project exists to measure
// around rather than produce. Taking the curl of a vector potential guarantees
// that identically, whatever the potential happens to look like.

import { Rng } from './rng.js';

// The 12 cube-edge vectors, flattened. Classic Perlin gradient set.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class Noise {
  constructor(seed = 1) {
    this.reseed(seed);
  }

  reseed(seed) {
    const rng = new Rng(seed >>> 0);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng.next() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.gradIdx = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.gradIdx[i] = this.perm[i] % 12;
    }
  }

  _grad(hash, x, y, z) {
    const g = this.gradIdx[hash] * 3;
    return GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z;
  }

  // Classic Perlin gradient noise, roughly [-1, 1].
  noise3(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = fade(x), v = fade(y), w = fade(z);
    const p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;

    const x00 = this._grad(AA, x, y, z);
    const x10 = this._grad(BA, x - 1, y, z);
    const x01 = this._grad(AB, x, y - 1, z);
    const x11 = this._grad(BB, x - 1, y - 1, z);
    const y00 = this._grad(AA + 1, x, y, z - 1);
    const y10 = this._grad(BA + 1, x - 1, y, z - 1);
    const y01 = this._grad(AB + 1, x, y - 1, z - 1);
    const y11 = this._grad(BB + 1, x - 1, y - 1, z - 1);

    const a = x00 + u * (x10 - x00);
    const b = x01 + u * (x11 - x01);
    const c = y00 + u * (y10 - y00);
    const d = y01 + u * (y11 - y01);
    const e = a + v * (b - a);
    const f = c + v * (d - c);
    return e + w * (f - e);
  }

  // 1D slice, used to modulate the nozzle's flow rate over time. Choking is a
  // correlated low-frequency process, not white noise, which is why this is
  // gradient noise over time rather than independent per-step jitter.
  noise1(x) {
    return this.noise3(x, 17.31, 41.77);
  }
}

// Offsets that decorrelate the three potential components from each other.
const POT_OFFSET = [0, 0, 0, 31.416, 17.708, 92.653, 71.828, 53.105, 12.911];

// Per-component drift directions for animating the field over time.
//
// Honest note: this translates the potential through the noise field rather
// than genuinely evolving it, which real 4D noise would do. The pattern drifts
// instead of boiling. It is cheap, it looks like moving air, and critically it
// does not affect the divergence-free property -- the curl of any potential is
// divergence-free regardless of how that potential is animated. Upgrading to 4D
// noise is a contained change to this table and _potential() below.
const POT_DRIFT = [0.37, 0.11, 0.92, 0.88, 0.31, -0.35, -0.29, 0.94, 0.18];

/**
 * Curl noise evaluated on a coarse grid and interpolated per grain.
 *
 * Why a grid rather than evaluating the curl directly per grain: the curl needs
 * three potential components, each differenced along three axes, which is 12
 * Perlin evaluations per query. At the 100k-grain target that is 1.2M
 * evaluations per frame -- tens of milliseconds, several times the entire frame
 * budget, and it would fail the 60fps gate on its own.
 *
 * Sampling the potential once per grid node instead costs 3 evaluations per
 * node, the curl comes from neighbour differences for free, and each grain pays
 * only a trilinear interpolation. Interpolating a discretely divergence-free
 * field is not exactly divergence-free in the continuum, but the error is
 * second order in cell size and does not produce the systematic stream
 * compression the curl formulation exists to avoid.
 */
export class CurlField {
  constructor(noise, nodeBudget, maxRes) {
    this.noise = noise;
    this.nodeBudget = nodeBudget;
    this.maxRes = maxRes;
    this.min = new Float64Array(3);
    this.size = new Float64Array(3);
    this.h = new Float64Array(3);
    this.res = new Int32Array([2, 2, 2]);
    this.curl = null;
    this._pot = null;
    this.builtAt = -Infinity;
  }

  /**
   * Point the field at a region of world space.
   *
   * Resolution is allocated per axis in proportion to extent rather than as a
   * fixed cube, so cells stay roughly isotropic. That matters here because the
   * region is 58 cm wide but its height follows the pour-height slider across
   * nearly three orders of magnitude; a cubic grid would be either wastefully
   * fine horizontally or uselessly coarse vertically depending on which end you
   * tuned it for.
   *
   * Cheap when the bounds have not meaningfully changed, so callers can invoke
   * it every frame.
   */
  setBounds(min, size) {
    const changed =
      Math.abs(size[1] - this.size[1]) > this.size[1] * 0.02 ||
      this.size[0] !== size[0] || this.size[2] !== size[2] || this.curl === null;
    if (!changed) return false;

    for (let i = 0; i < 3; i++) {
      this.min[i] = min[i];
      this.size[i] = size[i];
    }

    // Pick per-axis counts proportional to extent, normalised to the node
    // budget, then clamp. Recompute the budget-fill after clamping so a very
    // elongated region does not silently lose resolution on its short axes.
    const vol = size[0] * size[1] * size[2];
    let scale = Math.cbrt(this.nodeBudget / Math.max(vol, 1e-12));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 3; i++) {
        this.res[i] = Math.max(2, Math.min(this.maxRes, Math.round(size[i] * scale)));
      }
      const used = this.res[0] * this.res[1] * this.res[2];
      if (used >= this.nodeBudget * 0.5) break;
      scale *= Math.cbrt(this.nodeBudget / Math.max(used, 1));
    }

    const [rx, ry, rz] = this.res;
    for (let i = 0; i < 3; i++) this.h[i] = size[i] / this.res[i];
    this.curl = new Float32Array(rx * ry * rz * 3);
    this._pot = new Float32Array((rx + 2) * (ry + 2) * (rz + 2) * 3);
    this.builtAt = -Infinity;
    return true;
  }

  _potential(comp, x, y, z, t) {
    const o = comp * 3;
    return this.noise.noise3(
      x + POT_OFFSET[o] + POT_DRIFT[o] * t,
      y + POT_OFFSET[o + 1] + POT_DRIFT[o + 1] * t,
      z + POT_OFFSET[o + 2] + POT_DRIFT[o + 2] * t,
    );
  }

  /**
   * Resample the field. `lengthScale` is in world units; the resulting curl is
   * normalised by it so the field's magnitude stays roughly O(1) as the scale
   * slider moves, leaving `amplitude` at the call site to mean what it says.
   */
  rebuild(t, lengthScale) {
    const [rx, ry, rz] = this.res;
    const nx = rx + 2, ny = ry + 2, nz = rz + 2;
    const P = this._pot;
    const invL = 1 / lengthScale;
    const [minX, minY, minZ] = this.min;
    const [hx, hy, hz] = this.h;

    // Potential at every node, including the halo. Node i maps to cell i-1, so
    // its centre sits at min + (i - 0.5) * h.
    for (let i = 0; i < nx; i++) {
      const wx = (minX + (i - 0.5) * hx) * invL;
      for (let j = 0; j < ny; j++) {
        const wy = (minY + (j - 0.5) * hy) * invL;
        for (let k = 0; k < nz; k++) {
          const wz = (minZ + (k - 0.5) * hz) * invL;
          const o = ((i * ny + j) * nz + k) * 3;
          P[o] = this._potential(0, wx, wy, wz, t);
          P[o + 1] = this._potential(1, wx, wy, wz, t);
          P[o + 2] = this._potential(2, wx, wy, wz, t);
        }
      }
    }

    // curl = (dP3/dy - dP2/dz, dP1/dz - dP3/dx, dP2/dx - dP1/dy)
    const C = this.curl;
    const sx = lengthScale / (2 * hx);
    const sy = lengthScale / (2 * hy);
    const sz = lengthScale / (2 * hz);
    const pI = ny * nz * 3, pJ = nz * 3, pK = 3;
    const cI = ry * rz * 3, cJ = rz * 3;
    for (let a = 0; a < rx; a++) {
      const i = a + 1;
      for (let b = 0; b < ry; b++) {
        const j = b + 1;
        for (let c = 0; c < rz; c++) {
          const o = ((i * ny + j) * nz + (c + 1)) * 3;
          const dP3dy = (P[o + pJ + 2] - P[o - pJ + 2]) * sy;
          const dP2dz = (P[o + pK + 1] - P[o - pK + 1]) * sz;
          const dP1dz = (P[o + pK] - P[o - pK]) * sz;
          const dP3dx = (P[o + pI + 2] - P[o - pI + 2]) * sx;
          const dP2dx = (P[o + pI + 1] - P[o - pI + 1]) * sx;
          const dP1dy = (P[o + pJ] - P[o - pJ]) * sy;
          const q = a * cI + b * cJ + c * 3;
          C[q] = dP3dy - dP2dz;
          C[q + 1] = dP1dz - dP3dx;
          C[q + 2] = dP2dx - dP1dy;
        }
      }
    }
    this.builtAt = t;
  }

  // Trilinear lookup. Writes into `out` and returns it. Clamps at the domain
  // border rather than wrapping, so grains outside the field just see its edge
  // value instead of teleporting to the far side of the turbulence.
  sample(x, y, z, out) {
    const C = this.curl;
    const rx = this.res[0], ry = this.res[1], rz = this.res[2];
    let fx = (x - this.min[0]) / this.h[0] - 0.5;
    let fy = (y - this.min[1]) / this.h[1] - 0.5;
    let fz = (z - this.min[2]) / this.h[2] - 0.5;
    if (!(fx > 0)) fx = 0; else if (fx > rx - 1) fx = rx - 1;
    if (!(fy > 0)) fy = 0; else if (fy > ry - 1) fy = ry - 1;
    if (!(fz > 0)) fz = 0; else if (fz > rz - 1) fz = rz - 1;

    const a0 = Math.min(fx | 0, rx - 2), b0 = Math.min(fy | 0, ry - 2), c0 = Math.min(fz | 0, rz - 2);
    const tx = fx - a0, ty = fy - b0, tz = fz - c0;

    const sI = ry * rz * 3, sJ = rz * 3, sK = 3;
    const base = a0 * sI + b0 * sJ + c0 * 3;

    for (let d = 0; d < 3; d++) {
      const o = base + d;
      const c000 = C[o], c001 = C[o + sK];
      const c010 = C[o + sJ], c011 = C[o + sJ + sK];
      const c100 = C[o + sI], c101 = C[o + sI + sK];
      const c110 = C[o + sI + sJ], c111 = C[o + sI + sJ + sK];
      const c00 = c000 + tz * (c001 - c000);
      const c01 = c010 + tz * (c011 - c010);
      const c10 = c100 + tz * (c101 - c100);
      const c11 = c110 + tz * (c111 - c110);
      const c0v = c00 + ty * (c01 - c00);
      const c1v = c10 + ty * (c11 - c10);
      out[d] = c0v + tx * (c1v - c0v);
    }
    return out;
  }
}
