// The contact broad phase: hierarchical grid, counting sort, pair enumeration.
//
// The property worth testing is the one that cannot be seen by reading the
// code: that a full sweep enumerates every touching pair, and enumerates each
// of them exactly once. A miss is a contact that silently never resolves; a
// duplicate applies the same position correction twice, which reads as
// mysteriously stiff sand rather than as a broad-phase bug. Both are checked
// against a brute-force O(n^2) sweep over the same grains.

import { GrainHash, packKey } from '../src/hash.js';
import { Particles, PHASE_AWAKE, PHASE_BALLISTIC } from '../src/particles.js';
import { Rng } from '../src/rng.js';

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

const CONTACT = (P) => (i) => P.phase[i] !== PHASE_BALLISTIC;

// A population with a deliberately wide size range, since a narrow one would
// collapse the hierarchy to a single level and test nothing it exists for.
//
// ⚠ The box is sized from the grain volume so the field is genuinely packed,
// not scattered. This matters more than it looks: an arbitrary box of 20 cm
// held these same 1200 grains far enough apart that only *one pair anywhere in
// the field was touching*, so "no touching pair missed" passed while checking
// essentially nothing. A broad-phase test with no contacts in it is not a
// weaker test, it is a vacuous one -- the enumeration could return the empty
// set and still pass.
function makeField(seed, n, { spread = 8, packing = 0.5, ballisticEvery = 0 } = {}) {
  const rng = new Rng(seed);
  const P = new Particles(n + 16);
  const median = 0.001;

  const radii = new Float64Array(n);
  let solid = 0;
  for (let k = 0; k < n; k++) {
    const t = rng.next();
    radii[k] = 0.5 * median * Math.exp(Math.log(spread) * (t - 0.5));
    solid += (4 / 3) * Math.PI * radii[k] ** 3;
  }
  // Cube that holds this much solid at the requested fraction. Grains are
  // placed independently, so they interpenetrate freely -- which is the point,
  // since overlapping pairs are exactly what the narrow phase will be handed.
  const box = Math.cbrt(solid / packing);

  for (let k = 0; k < n; k++) {
    const i = P.alloc();
    P.radius[i] = radii[k];
    P.px[i] = (rng.next() - 0.5) * box;
    P.py[i] = (rng.next() - 0.5) * box;
    P.pz[i] = (rng.next() - 0.5) * box;
    P.phase[i] = (ballisticEvery && k % ballisticEvery === 0) ? PHASE_BALLISTIC : PHASE_AWAKE;
  }
  return { P, median, box };
}

function hashPairs(hash, P) {
  const counts = new Map();
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    if (P.phase[i] === PHASE_BALLISTIC) continue;
    hash.forEachNeighbour(P, i, (j) => {
      const a = Math.min(i, j), b = Math.max(i, j);
      const key = a * 1e7 + b;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  }
  return counts;
}

function brutePairs(P) {
  const out = new Set();
  const live = [];
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    if (P.phase[i] !== PHASE_BALLISTIC) live.push(i);
  }
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const i = live[a], j = live[b];
      const dx = P.px[i] - P.px[j], dy = P.py[i] - P.py[j], dz = P.pz[i] - P.pz[j];
      const r = P.radius[i] + P.radius[j];
      if (dx * dx + dy * dy + dz * dz <= r * r) out.add(Math.min(i, j) * 1e7 + Math.max(i, j));
    }
  }
  return out;
}

console.log('every grain is bucketed once, and only contact-phase grains');
{
  const { P, median } = makeField(7, 3000, { ballisticEvery: 5 });
  const hash = new GrainHash(P.capacity, { tableSize: 1 << 12 });
  const kept = hash.rebuild(P, median, CONTACT(P));

  let expected = 0;
  for (let k = 0; k < P.count; k++) if (P.phase[P.live[k]] !== PHASE_BALLISTIC) expected++;
  check('rebuild returns the accepted population', kept === expected, `${kept} vs ${expected}`);

  const seen = new Set();
  let dupes = 0, strays = 0;
  for (let s = 0; s < kept; s++) {
    const i = hash.sorted[s];
    if (seen.has(i)) dupes++;
    seen.add(i);
    if (P.phase[i] === PHASE_BALLISTIC) strays++;
  }
  check('each accepted grain appears exactly once in the sort', seen.size === kept && dupes === 0, `${dupes} dupes`);
  check('no grain in flight was bucketed', strays === 0, `${strays} strays`);
}

console.log('\nevery grain fits inside its own level cell');
{
  // The 3x3x3 search is only sufficient because of this. If a grain is one
  // level too fine it can touch a neighbour two cells away and be missed.
  const { P, median } = makeField(11, 4000, { spread: 40 });
  const hash = new GrainHash(P.capacity, { tableSize: 1 << 12 });
  hash.rebuild(P, median, CONTACT(P));
  let bad = 0, worstRatio = 0;
  for (let k = 0; k < P.count; k++) {
    const i = P.live[k];
    const cs = hash.cellSize(hash.level[i]);
    const ratio = (P.radius[i] * 2) / cs;
    if (ratio > worstRatio) worstRatio = ratio;
    if (ratio > 1 + 1e-12) bad++;
  }
  check('diameter never exceeds its cell', bad === 0, `${bad} oversized, worst ratio ${worstRatio.toFixed(4)}`);
  check('the hierarchy actually has depth', hash.activeLevels >= 3, `levels=${hash.activeLevels}`);
}

console.log('\npair enumeration is complete and exactly once');
{
  for (const [seed, n, spread] of [[1, 1200, 2], [2, 1200, 8], [3, 1200, 40], [4, 600, 1.001]]) {
    const { P, median } = makeField(seed, n, { spread });
    const hash = new GrainHash(P.capacity, { tableSize: 1 << 12 });
    hash.rebuild(P, median, CONTACT(P));

    const got = hashPairs(hash, P);
    const want = brutePairs(P);

    let missing = 0;
    for (const key of want) if (!got.has(key)) missing++;
    let repeated = 0;
    for (const c of got.values()) if (c !== 1) repeated++;

    // Guards the test against becoming vacuous again if the field generator
    // is ever retuned: with no contacts to find, "found them all" is free.
    check(`spread ${spread}x: the field actually has contacts to find`, want.size > n / 4, `only ${want.size}`);
    check(`spread ${spread}x: no touching pair missed (${want.size} contacts)`, missing === 0, `${missing} missed`);
    check(`spread ${spread}x: no candidate delivered twice (${got.size} candidates)`, repeated === 0, `${repeated} repeated`);
  }
}

console.log('\nhash collisions do not leak grains between cells');
{
  // A table far too small for the population forces heavy collision, which is
  // exactly when the exact-key check earns its place. Candidate count may rise
  // in a broken implementation; correctness must not move.
  const { P, median } = makeField(5, 2000, { spread: 8 });
  const tiny = new GrainHash(P.capacity, { tableSize: 1 << 5 });
  tiny.rebuild(P, median, CONTACT(P));
  const roomy = new GrainHash(P.capacity, { tableSize: 1 << 14 });
  roomy.rebuild(P, median, CONTACT(P));

  const a = hashPairs(tiny, P), b = hashPairs(roomy, P);
  const want = brutePairs(P);
  let missA = 0, missB = 0;
  for (const key of want) { if (!a.has(key)) missA++; if (!b.has(key)) missB++; }
  let dupA = 0;
  for (const c of a.values()) if (c !== 1) dupA++;

  check('a 32-bucket table still misses nothing', missA === 0, `${missA} missed`);
  check('a 16384-bucket table still misses nothing', missB === 0, `${missB} missed`);
  check('collisions produce no duplicate pairs', dupA === 0, `${dupA} repeated`);
  check('both tables agree on the candidate set', a.size === b.size, `${a.size} vs ${b.size}`);
}

console.log('\ndegenerate inputs');
{
  const P = new Particles(64);
  const hash = new GrainHash(64, { tableSize: 1 << 6 });
  check('an empty store rebuilds to nothing', hash.rebuild(P, 0.001, CONTACT(P)) === 0 && hash.activeLevels === 0);

  const i = P.alloc();
  P.radius[i] = 0.0005; P.px[i] = 0; P.py[i] = 0; P.pz[i] = 0; P.phase[i] = PHASE_AWAKE;
  hash.rebuild(P, 0.001, CONTACT(P));
  let neighbours = 0;
  hash.forEachNeighbour(P, i, () => neighbours++);
  check('a lone grain has no neighbours and is not its own', neighbours === 0, `${neighbours}`);

  // Coincident grains are a real case -- two grains emitted at the same
  // instant from the same point -- and must not be dropped or double-counted.
  const j = P.alloc();
  P.radius[j] = 0.0005; P.px[j] = 0; P.py[j] = 0; P.pz[j] = 0; P.phase[j] = PHASE_AWAKE;
  hash.rebuild(P, 0.001, CONTACT(P));
  const pairs = hashPairs(hash, P);
  check('coincident grains pair exactly once', pairs.size === 1 && [...pairs.values()][0] === 1);
}

console.log('\nkey packing is injective over the grid range');
{
  let clashes = 0;
  const seen = new Set();
  for (let ix = -300; ix <= 300; ix += 7) {
    for (let iy = -300; iy <= 300; iy += 11) {
      for (let iz = -300; iz <= 300; iz += 13) {
        const k = packKey(ix, iy, iz);
        if (seen.has(k)) clashes++;
        seen.add(k);
        if (!Number.isSafeInteger(k)) clashes++;
      }
    }
  }
  check(`distinct cells give distinct exact keys (${seen.size} probed)`, clashes === 0, `${clashes} clashes`);
}

console.log('\noccupancy at the default size range');
{
  // The number the design turns on: mean grains per occupied cell, which is
  // what a 27-cell neighbourhood gets multiplied by.
  const { P, median } = makeField(21, 40000, { spread: 8, packing: 0.55 });
  const hash = new GrainHash(P.capacity, { tableSize: 1 << 16 });
  hash.rebuild(P, median, CONTACT(P));
  const st = hash.stats();
  console.log(`       ${st.count} grains, ${st.activeLevels} levels, ${st.occupiedCells} cells, ` +
    `${st.meanPerOccupiedCell.toFixed(2)} per cell, worst bucket ${st.worstBucket}`);
  check('occupancy stays in single digits per cell', st.meanPerOccupiedCell < 10, st.meanPerOccupiedCell.toFixed(2));
  check('no single bucket collects a large fraction', st.worstBucket < st.count / 50, `${st.worstBucket}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
