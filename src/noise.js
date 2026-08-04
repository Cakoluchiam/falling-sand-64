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
  constructor(noise, res, min, size) {
    if (res < 2) throw new Error('CurlField needs res >= 2');
    this.noise = noise;
    this.res = res;
    this.min = Float64Array.from(min);
    this.size = Float64Array.from(size);
    this.h = new Float64Array([size[0] / res, size[1] / res, size[2] / res]);

    this.curl = new Float32Array(res * res * res * 3);
    // Potential is sampled on a grid extended by one cell on every side, so
    // every interior cell has neighbours to difference against.
    const n = res + 2;
    this.n = n;
    this._pot = new Float32Array(n * n * n * 3);
    this.builtAt = -Infinity;
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
    const R = this.res, n = this.n, P = this._pot;
    const invL = 1 / lengthScale;
    const [minX, minY, minZ] = this.min;
    const [hx, hy, hz] = this.h;

    // Potential at every node, including the halo. Node i maps to cell i-1, so
    // its centre sits at min + (i - 0.5) * h.
    for (let i = 0; i < n; i++) {
      const wx = (minX + (i - 0.5) * hx) * invL;
      for (let j = 0; j < n; j++) {
        const wy = (minY + (j - 0.5) * hy) * invL;
        for (let k = 0; k < n; k++) {
          const wz = (minZ + (k - 0.5) * hz) * invL;
          const o = ((i * n + j) * n + k) * 3;
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
    const strideI = n * n * 3, strideJ = n * 3, strideK = 3;
    for (let a = 0; a < R; a++) {
      const i = a + 1;
      for (let b = 0; b < R; b++) {
        const j = b + 1;
        for (let c = 0; c < R; c++) {
          const k = c + 1;
          const o = ((i * n + j) * n + k) * 3;
          const dP3dy = (P[o + strideJ + 2] - P[o - strideJ + 2]) * sy;
          const dP2dz = (P[o + strideK + 1] - P[o - strideK + 1]) * sz;
          const dP1dz = (P[o + strideK] - P[o - strideK]) * sz;
          const dP3dx = (P[o + strideI + 2] - P[o - strideI + 2]) * sx;
          const dP2dx = (P[o + strideI + 1] - P[o - strideI + 1]) * sx;
          const dP1dy = (P[o + strideJ] - P[o - strideJ]) * sy;
          const q = ((a * R + b) * R + c) * 3;
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
    const R = this.res, C = this.curl;
    let fx = (x - this.min[0]) / this.h[0] - 0.5;
    let fy = (y - this.min[1]) / this.h[1] - 0.5;
    let fz = (z - this.min[2]) / this.h[2] - 0.5;
    if (!(fx > 0)) fx = 0; else if (fx > R - 1) fx = R - 1;
    if (!(fy > 0)) fy = 0; else if (fy > R - 1) fy = R - 1;
    if (!(fz > 0)) fz = 0; else if (fz > R - 1) fz = R - 1;

    const a0 = Math.min(fx | 0, R - 2), b0 = Math.min(fy | 0, R - 2), c0 = Math.min(fz | 0, R - 2);
    const tx = fx - a0, ty = fy - b0, tz = fz - c0;

    const sI = R * R * 3, sJ = R * 3, sK = 3;
    const base = ((a0 * R + b0) * R + c0) * 3;

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
