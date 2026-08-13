// Broad phase for the contact solver: a hierarchical uniform grid, rebuilt
// from scratch each substep by counting sort.
//
// Pure over flat typed arrays, with no DOM or GL references, and it takes the
// grain store as an argument rather than importing one -- same reason
// `ballistic.js` is its own module. The pair enumeration below has an exactly-
// once contract that is only checkable against a brute-force sweep, and a test
// has to be able to reach it.
//
// ## Why hierarchical rather than one grid
//
// A single grid has to choose a cell size, and both ends of that choice fail
// once grains vary in size:
//
// - **Cell sized to the largest grain**, which is what makes a 3x3x3 search
//   sufficient, is catastrophically coarse for the median one. At a 12x size
//   ratio the cell is 12 mm against a 1 mm grain, 200k grains land in a couple
//   hundred cells at ~1000 grains each, and a 27-cell neighbourhood is ~30k
//   candidates per grain.
// - **Cell sized to the median** puts ~9 grains per cell, but then a grain
//   larger than the cell has to be found some other way. The design this
//   replaced kept those in a separate large-body list, on the stated
//   assumption that there would be "tens of them against hundreds of
//   thousands of grains". That holds only while the size distribution is
//   narrow. Measured against the real sampler, the fraction of grains above
//   3x the median is 0.08% at the default 2x sorting but **8.7% at 5x and 14%
//   at 8x** -- 17k and 28k bodies out of 200k, at which point the list is a
//   second population and sweeping it linearly is quadratic.
//
// Grain size distribution is one of the things this project exists to sweep,
// so the broad phase has to survive the sorting slider rather than assume it
// stays near its default.
//
// ## The structure
//
// Level `L` has cells of `baseCell * 2^L`. A grain is inserted at the finest
// level whose cell is at least its diameter, so at every level every resident
// grain fits inside one cell.
//
// ## The query rule, which is the part worth reading twice
//
// A grain at level `Li` searches levels `Li` and **coarser only**, 3x3x3 cells
// at each. That is sufficient, not an approximation: for a resident `j` of
// level `Lj >= Li`, contact needs `|pi - pj| <= ri + rj`, and both radii are
// at most half of `cellSize(Lj)`, so the centres are at most one cell of that
// level apart and their cell indices differ by at most one per axis.
//
// Searching coarser-only is also what makes each pair appear exactly once:
// a cross-level pair is found by the finer member, which is the one whose
// search includes the other's level. Same-level pairs would be found twice,
// so those are broken by index. Getting this wrong is silent -- a pair
// enumerated twice gets its position correction applied twice, which reads as
// mysteriously stiff contacts rather than as a broad-phase bug.

// Cell coordinates are packed into one float64 key so a candidate can be
// checked against the exact cell being queried. Without it, two distinct cells
// that collide in the hash would hand back each other's grains: harmless for
// correctness once the narrow phase runs, but it also means the same grain can
// arrive twice from two different query cells, which breaks the once-only
// contract above.
//
// 17 bits per axis biased to unsigned, so the key stays exact: the largest
// value is about 2.3e15, inside float64's 9.0e15 integer range. 65536 cells
// per axis either side of the origin is far beyond any grid this uses -- the
// finest level over the whole domain is ~1200 cells across.
const BIAS = 1 << 16;
const SHIFT_X = 2 ** 34;
const SHIFT_Y = 2 ** 17;
const COORD_MIN = -BIAS;
const COORD_MAX = BIAS - 1;

// Arbitrary large primes; the usual choice for spatial hashing.
const P1 = 73856093;
const P2 = 19349663;
const P3 = 83492791;

const clampCoord = (c) => (c < COORD_MIN ? COORD_MIN : c > COORD_MAX ? COORD_MAX : c);

export function packKey(ix, iy, iz) {
  return (ix + BIAS) * SHIFT_X + (iy + BIAS) * SHIFT_Y + (iz + BIAS);
}

export function bucketOf(ix, iy, iz, mask) {
  return (Math.imul(ix, P1) ^ Math.imul(iy, P2) ^ Math.imul(iz, P3)) & mask;
}

export class GrainHash {
  /**
   * `tableSize` is per level and must be a power of two. Levels share one
   * `counts` array indexed by `level * tableSize + bucket`, and one `sorted`
   * array, since every grain lives at exactly one level and the totals add up
   * to the population rather than to a multiple of it.
   */
  constructor(capacity, { tableSize = 1 << 16, maxLevels = 12 } = {}) {
    if ((tableSize & (tableSize - 1)) !== 0) throw new Error('tableSize must be a power of two');
    this.capacity = capacity;
    this.tableSize = tableSize;
    this.mask = tableSize - 1;
    this.maxLevels = maxLevels;

    this.level = new Uint8Array(capacity);
    this.key = new Float64Array(capacity);
    this.sorted = new Int32Array(capacity);
    this.cellStart = new Int32Array(maxLevels * tableSize + 1);
    this.levelBase = new Int32Array(maxLevels + 1);

    this.baseCell = 0;
    this.activeLevels = 0;
    this.count = 0;
  }

  cellSize(level) {
    return this.baseCell * (1 << level);
  }

  levelFor(radius) {
    const d = radius * 2;
    let L = Math.max(0, Math.ceil(Math.log2(d / this.baseCell)));
    // Nudge for the float edge: the log can land a hair under an exact power
    // of two and leave a grain one level too fine, where it would not fit its
    // own cell and the 3x3x3 argument above would no longer hold.
    while (L + 1 < this.maxLevels && this.cellSize(L) < d) L++;
    if (L >= this.maxLevels) L = this.maxLevels - 1;
    return L;
  }

  /**
   * Bucket every grain the predicate accepts. `baseCell` sets the finest
   * level; anything smaller than it still lands at level 0, which is fine --
   * the fit requirement is one-sided, a cell must be at least a diameter.
   *
   * `accept(i)` selects the contact-phase population. Grains in flight are
   * deliberately not in here: keeping them out is half of what bounds the
   * solver's cost.
   */
  rebuild(P, baseCell, accept) {
    this.baseCell = baseCell;
    const { live } = P;
    const n = P.count;

    // How many levels the current population actually needs. Sizing to the
    // largest grain present rather than to the slider's ceiling keeps the
    // zeroing below proportional to what is in use.
    let maxRadius = 0, kept = 0;
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (!accept(i)) continue;
      kept++;
      if (P.radius[i] > maxRadius) maxRadius = P.radius[i];
    }
    this.count = kept;
    this.activeLevels = kept === 0
      ? 0
      : Math.min(this.maxLevels, this.levelFor(maxRadius) + 1);
    if (kept === 0) return 0;

    const slots = this.activeLevels * this.tableSize;
    const cellStart = this.cellStart;
    cellStart.fill(0, 0, slots + 1);

    // Pass one: count into slot+1, so the prefix sum below lands the start of
    // each slot in its own cell rather than needing a shift afterwards.
    const { px, py, pz, radius } = P;
    const level = this.level, key = this.key, mask = this.mask, ts = this.tableSize;
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (!accept(i)) continue;
      const L = this.levelFor(radius[i]);
      const cs = this.cellSize(L);
      const ix = clampCoord(Math.floor(px[i] / cs));
      const iy = clampCoord(Math.floor(py[i] / cs));
      const iz = clampCoord(Math.floor(pz[i] / cs));
      level[i] = L;
      key[i] = packKey(ix, iy, iz);
      cellStart[L * ts + bucketOf(ix, iy, iz, mask) + 1]++;
    }

    for (let s = 1; s <= slots; s++) cellStart[s] += cellStart[s - 1];
    for (let L = 0; L <= this.activeLevels; L++) this.levelBase[L] = cellStart[L * ts];

    // Pass two scatters with `cellStart[slot]++`, which leaves each entry
    // holding what the *next* slot's start was. That is why the reader below
    // takes the start of slot s as cellStart[s-1] -- it avoids copying a
    // 260 kB cursor array on every substep, at the cost of an index that has
    // to be read one place to the left.
    const sorted = this.sorted;
    for (let k = 0; k < n; k++) {
      const i = live[k];
      if (!accept(i)) continue;
      const L = level[i];
      const cs = this.cellSize(L);
      const ix = clampCoord(Math.floor(px[i] / cs));
      const iy = clampCoord(Math.floor(py[i] / cs));
      const iz = clampCoord(Math.floor(pz[i] / cs));
      sorted[cellStart[L * ts + bucketOf(ix, iy, iz, mask)]++] = i;
    }
    return kept;
  }

  /**
   * Every candidate neighbour of `i`, each pair delivered exactly once across
   * a full sweep of the population. Candidates are cell-exact but not
   * distance-tested; the caller does that, since it needs the separation
   * anyway.
   */
  forEachNeighbour(P, i, cb) {
    const Li = this.level[i];
    const { px, py, pz } = P;
    const x = px[i], y = py[i], z = pz[i];
    const sorted = this.sorted, cellStart = this.cellStart, key = this.key;
    const level = this.level, mask = this.mask, ts = this.tableSize;

    for (let L = Li; L < this.activeLevels; L++) {
      const cs = this.cellSize(L);
      const cx = Math.floor(x / cs), cy = Math.floor(y / cs), cz = Math.floor(z / cs);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const ix = clampCoord(cx + dx), iy = clampCoord(cy + dy), iz = clampCoord(cz + dz);
            const want = packKey(ix, iy, iz);
            const slot = L * ts + bucketOf(ix, iy, iz, mask);
            const from = slot === 0 ? 0 : cellStart[slot - 1];
            const to = cellStart[slot];
            for (let s = from; s < to; s++) {
              const j = sorted[s];
              // Hash collision, or a clamped coordinate: this bucket holds a
              // grain from some other cell.
              if (key[j] !== want) continue;
              if (j === i) continue;
              // Same level would otherwise yield the pair from both ends.
              if (level[j] === Li && j < i) continue;
              cb(j);
            }
          }
        }
      }
    }
  }

  /** Occupancy, for the perf work and for the tests. */
  stats() {
    const perLevel = [];
    let occupied = 0, worst = 0;
    for (let L = 0; L < this.activeLevels; L++) {
      let cells = 0, grains = 0;
      for (let b = 0; b < this.tableSize; b++) {
        const slot = L * this.tableSize + b;
        const size = this.cellStart[slot] - (slot === 0 ? 0 : this.cellStart[slot - 1]);
        if (size > 0) { cells++; grains += size; if (size > worst) worst = size; }
      }
      occupied += cells;
      perLevel.push({ level: L, cellSize: this.cellSize(L), cells, grains });
    }
    return {
      count: this.count,
      activeLevels: this.activeLevels,
      occupiedCells: occupied,
      worstBucket: worst,
      meanPerOccupiedCell: occupied ? this.count / occupied : 0,
      perLevel,
    };
  }
}
