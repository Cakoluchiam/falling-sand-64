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

// How far past touching two grains still count as in contact, as a fraction of
// the sum of their radii. See `buildAdjacency`: a held contact oscillates about
// the contact distance by the substep's gravity impulse, so a strict test would
// flicker. Matches the slack the solver's restitution pass already allows.
// Exported so a test can brute-force the same set rather than a nearby one: a
// contact predicate checked against a slightly different tolerance agrees on
// almost every pair and disagrees exactly on the marginal ones, which are the
// pairs any bug here would live in.
export const CONTACT_SLACK = 0.01;

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

    // Adjacency, allocated on first use. Nothing in the substep path touches
    // it -- it is M4's structure, built once a frame -- so a run without
    // absorption pays nothing for it.
    this.adjStart = null;
    this.adjCursor = null;
    this.adjList = null;
    this.adjPairBuf = null;
    this.adjPairs = 0;
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

  /**
   * Symmetric adjacency over the *touching* pairs, in CSR form: the
   * neighbours of grain `i` are `adjList[adjStart[i] .. adjStart[i+1])`, and
   * `adjStart[i+1] - adjStart[i]` is its contact count. Returns the number of
   * distinct pairs.
   *
   * ## Why this exists rather than calling forEachNeighbour per grain
   *
   * `forEachNeighbour` is a *pair* primitive, not a neighbourhood query, and
   * the difference is easy to miss because the name reads like the latter. It
   * searches coarser levels only and drops same-level lower indices, both so
   * that one sweep of the population yields each pair exactly once. Ask it for
   * "grain i's neighbours" and it answers with a subset: every grain finer
   * than `i` is missing, which for a clump resting in sand is most of what is
   * touching it. M4's burial measure asks whether a grain's sky is covered in
   * every direction, so a subset is not an approximation of the answer -- it
   * is a different question.
   *
   * Widening the search downward is not the fix. The 3x3x3 bound holds only
   * toward coarser levels, because it rests on the *resident's* radius being
   * at most half its own cell. Searching level `L` from a grain at `Li > L`
   * needs radius `ceil(r_i / cellSize(L)) + 1` cells, which grows as
   * `2^(Li-L)` -- 15 cubed at a 12x size ratio, per candidate.
   *
   * So the pairs are enumerated exactly as they always were, and each is
   * pushed into *both* rows. Symmetric by construction, and it reuses the
   * once-only contract instead of working around it.
   *
   * Row lengths are not known in advance, so this is a count-then-scatter like
   * the rebuild above -- but the counting pass **keeps the pairs it found**
   * rather than re-deriving them. Measured, one broad-phase sweep of a settled
   * 3000-grain heap is 3.3 ms and the narrow phase inside it is noise: the
   * cost is candidate enumeration, roughly fifty per grain, and running it
   * twice doubled the whole build. Scattering from a flat pair buffer instead
   * makes the second pass linear in the *contacts*, which is an order of
   * magnitude smaller than the candidates.
   */
  buildAdjacency(P, tolerance = CONTACT_SLACK) {
    const cap = this.capacity;
    if (!this.adjStart) {
      this.adjStart = new Int32Array(cap + 1);
      this.adjCursor = new Int32Array(cap);
      this.adjList = new Int32Array(1024);
      this.adjPairBuf = new Int32Array(2048);
    }
    const start = this.adjStart;
    start.fill(0);
    this.adjPairs = 0;
    if (this.count === 0) return 0;

    const { px, py, pz, radius } = P;
    const sorted = this.sorted, n = this.count;
    // A settled contact is not at exactly touching: gravity drives it g*dt^2
    // in and the projection pushes it back out, so it breathes about the
    // contact distance. Judging contact on `<` alone would drop half a
    // settled pile's contacts at random every frame, which the burial score
    // would read as a surface opening and closing.
    const slack = (1 + tolerance) * (1 + tolerance);
    let pairs = 0;
    let cur = -1, xi = 0, yi = 0, zi = 0, ri = 0;

    // One closure for the whole build rather than one per grain. `cur` is
    // captured by reference, so reassigning it below re-aims the same closure.
    const collect = (j) => {
      const dx = xi - px[j], dy = yi - py[j], dz = zi - pz[j];
      const sum = ri + radius[j];
      if (dx * dx + dy * dy + dz * dz >= sum * sum * slack) return;
      if (pairs * 2 >= this.adjPairBuf.length) {
        const grown = new Int32Array(this.adjPairBuf.length * 2);
        grown.set(this.adjPairBuf);
        this.adjPairBuf = grown;
      }
      const buf = this.adjPairBuf;
      buf[pairs * 2] = cur; buf[pairs * 2 + 1] = j;
      pairs++;
      start[cur + 1]++; start[j + 1]++;
    };

    for (let s = 0; s < n; s++) {
      cur = sorted[s];
      xi = px[cur]; yi = py[cur]; zi = pz[cur]; ri = radius[cur];
      this.forEachNeighbour(P, cur, collect);
    }

    for (let k = 0; k < cap; k++) start[k + 1] += start[k];
    const need = pairs * 2;
    if (this.adjList.length < need) this.adjList = new Int32Array(need * 2);
    const list = this.adjList, cursor = this.adjCursor, buf = this.adjPairBuf;
    cursor.set(start.subarray(0, cap));

    for (let p = 0; p < pairs; p++) {
      const i = buf[p * 2], j = buf[p * 2 + 1];
      list[cursor[i]++] = j;
      list[cursor[j]++] = i;
    }

    this.adjPairs = pairs;
    return pairs;
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
