const base = new URL('../src/', import.meta.url).href;
const { HexField, relaxRateFromHalfLife } = await import(base + 'hexfield.js');
const { buildTerrainIndices } = await import(base + 'gl/terrain.js');
const { Rng } = await import(base + 'rng.js');

let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

const S = 0.003;
const mk = (w = 48, h = 48) => new HexField(w, h, S);

// ---------------------------------------------------------------------------
console.log('lattice geometry');
{
  const f = mk();
  // Every neighbour of an interior cell sits exactly one spacing away. If this
  // slips, every slope in the relaxation arm is measured over the wrong
  // baseline and the repose angle comes out wrong by a constant factor.
  let worst = 0;
  for (const [q, r] of [[10, 10], [10, 11], [1, 1], [20, 7]]) {
    const x = f.cellX(q, r), z = f.cellZ(r);
    let found = 0;
    for (let nr = r - 1; nr <= r + 1; nr++) {
      for (let nq = q - 2; nq <= q + 2; nq++) {
        if (nq === q && nr === r) continue;
        const d = Math.hypot(f.cellX(nq, nr) - x, f.cellZ(nr) - z);
        if (d < S * 1.01) { found++; worst = Math.max(worst, Math.abs(d / S - 1)); }
      }
    }
    check(`cell (${q},${r}) has exactly 6 neighbours at spacing`, found === 6, `found ${found}`);
  }
  check('neighbour distance is the spacing', worst < 1e-12, worst.toExponential(2));

  const area = Math.sqrt(3) / 2 * S * S;
  check('cell area is the hexagon area', Math.abs(f.cellArea - area) < 1e-18);
  // The lattice must straddle the origin, since the nozzle and the domain
  // bounds are both centred there.
  const spanX = f.cellX(f.W - 1, 0) + f.cellX(0, 1) - 2 * f.cellX(0, 0);
  check('lattice is centred on the origin',
    Math.abs(f.cellX(0, 0) + f.cellX(f.W - 1, 1)) < 1e-12 &&
    Math.abs(f.cellZ(0) + f.cellZ(f.H - 1)) < 1e-12, spanX.toExponential(2));
}

// ---------------------------------------------------------------------------
console.log('\nsampleTriangle');
{
  const f = mk();
  const t = {};
  let worstSum = 0, negWeights = 0, badAdjacency = 0, exact = 0;
  for (let r = 1; r < f.H - 1; r++) {
    for (let q = 1; q < f.W - 1; q++) {
      f.sampleTriangle(f.cellX(q, r), f.cellZ(r), t);
      // A query at a cell centre must resolve to that cell with full weight,
      // or deposition would smear a grain that is squarely inside one cell.
      const w = [t.w0, t.w1, t.w2];
      const i = [t.i0, t.i1, t.i2];
      const k = w.indexOf(Math.max(...w));
      if (i[k] === r * f.W + q && w[k] > 1 - 1e-9) exact++;
    }
  }
  check('a cell centre resolves to its own cell', exact === (f.H - 2) * (f.W - 2),
    `${exact} of ${(f.H - 2) * (f.W - 2)}`);

  const rng = new Rng(7);
  const x0 = f.cellX(2, 2), x1 = f.cellX(f.W - 3, 2);
  const z0 = f.cellZ(2), z1 = f.cellZ(f.H - 3);
  for (let n = 0; n < 200000; n++) {
    const x = rng.range(x0, x1), z = rng.range(z0, z1);
    f.sampleTriangle(x, z, t);
    worstSum = Math.max(worstSum, Math.abs(t.w0 + t.w1 + t.w2 - 1));
    if (t.w0 < -1e-12 || t.w1 < -1e-12 || t.w2 < -1e-12) negWeights++;
    // The three cells must be mutually adjacent, otherwise the "triangle" is
    // not a face of the lattice and interpolating across it is meaningless.
    const pts = [t.i0, t.i1, t.i2].map((c) => {
      const q = c % f.W, r = (c / f.W) | 0;
      return [f.cellX(q, r), f.cellZ(r)];
    });
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      if (Math.abs(Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]) / S - 1) > 1e-9) badAdjacency++;
    }
  }
  check('weights sum to 1', worstSum < 1e-12, worstSum.toExponential(2));
  check('weights are non-negative', negWeights === 0, `${negWeights} bad`);
  check('the three cells are mutually adjacent', badAdjacency === 0, `${badAdjacency} bad edges`);
}

// ---------------------------------------------------------------------------
console.log('\nsampling is continuous across cell and triangle boundaries');
{
  // A seam in the height is a step a grain would fall down; a seam in the
  // normal is a sideways kick out of nowhere. This is what grain-surface
  // contact stands on at M3, so it is checked against a random field rather
  // than a smooth one -- a smooth field can hide a seam under its own gradient.
  const f = mk(64, 64);
  const rng = new Rng(11);
  for (let c = 0; c < f.n; c++) f.height[c] = rng.range(0, 0.02);

  // Analytic bound on how fast height can change: the steepest edge in the
  // field, since the surface is linear inside every triangle.
  let maxSlope = 0;
  for (let r = 0; r < f.H; r++) {
    for (let q = 0; q < f.W; q++) {
      const c = r * f.W + q;
      for (const [dq, dr] of ((r & 1)
        ? [[1, 0], [-1, 0], [1, 1], [0, -1], [1, -1], [0, 1]]
        : [[1, 0], [-1, 0], [0, 1], [-1, -1], [0, -1], [-1, 1]])) {
        if (!f.inBounds(q + dq, r + dr)) continue;
        const s = Math.abs(f.height[(r + dr) * f.W + q + dq] - f.height[c]) / S;
        if (s > maxSlope) maxSlope = s;
      }
    }
  }

  const step = 1e-7;
  const a = new Float64Array(4), b = new Float64Array(4);
  const nrm = new Float64Array(3);
  let worstH = 0, worstN = 0, minBlend = Infinity;
  const x0 = f.cellX(3, 3), x1 = f.cellX(f.W - 4, 3);
  for (let line = 0; line < 40; line++) {
    const z = f.cellZ(3) + (f.cellZ(f.H - 4) - f.cellZ(3)) * (line / 39);
    for (let x = x0; x < x1; x += step * 37) {
      f.sampleSurface(x, z, a);
      f.sampleSurface(x + step, z, b);
      worstH = Math.max(worstH, Math.abs(b[0] - a[0]) / step);
      worstN = Math.max(worstN, Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) / step);
      // How far the blend of the three cell normals shrinks before it is
      // renormalised. Three unit vectors pointing apart can average to
      // something short, and dividing by that is what amplifies the rate.
      const t = f.sampleTriangle(x, z);
      let bx = 0, by = 0, bz = 0;
      for (const [c, w] of [[t.i0, t.w0], [t.i1, t.w1], [t.i2, t.w2]]) {
        f.cellNormal(c % f.W, (c / f.W) | 0, nrm);
        bx += w * nrm[0]; by += w * nrm[1]; bz += w * nrm[2];
      }
      minBlend = Math.min(minBlend, Math.hypot(bx, by, bz));
    }
  }
  // These are Lipschitz bounds, not equality checks. The point is the gap in
  // scale: a continuous surface tracks its own gradient, while a seam moves a
  // finite amount over a 1e-7 m step and reads four or more orders of magnitude
  // above the bound. Bounding by zero instead would only be testing that
  // floating point is exact, which it is not.
  console.log(`  steepest lattice edge ${maxSlope.toFixed(2)}, worst measured height rate ${worstH.toFixed(2)}`);
  check('height has no seam', worstH <= maxSlope * 1.01, `${worstH.toFixed(3)} vs ${maxSlope.toFixed(3)}`);
  // Each barycentric weight changes at 1/(triangle altitude) = 2/(root3 * s)
  // per metre, the three sum to zero so two of them drive the blend, and each
  // unit normal can differ from another by 2 -- then the blend is divided by
  // its own length, which is the part that has to be measured rather than
  // assumed.
  const normalBound = (2 * (2 / Math.sqrt(3) / S) * 2) / minBlend;
  console.log(`  worst measured normal rate ${worstN.toFixed(1)} / m, bound ${normalBound.toFixed(0)}` +
    ` (blend shrinks to ${minBlend.toFixed(3)})`);
  check('normal has no seam', worstN <= normalBound, worstN.toExponential(2));

  // Straddle the diagonal exactly, which is the boundary the two triangles of
  // a rhombus share and the one an off-by-one in the split would break. This
  // is the sharp version of the two checks above: the probes sit either side of
  // a known seam location rather than sweeping for one.
  const eps = 1e-9;
  const diagBound = maxSlope * 2 * eps * 1.5;
  let worstDiagH = 0, worstDiagN = 0;
  for (let r = 4; r < f.H - 4; r++) {
    for (let q = 4; q < f.W - 4; q++) {
      const mx = (f.cellX(q + 1, r) + f.cellX(q + (r & 1), r + 1)) / 2;
      const mz = (f.cellZ(r) + f.cellZ(r + 1)) / 2;
      f.sampleSurface(mx - eps, mz, a);
      f.sampleSurface(mx + eps, mz, b);
      worstDiagH = Math.max(worstDiagH, Math.abs(b[0] - a[0]));
      worstDiagN = Math.max(worstDiagN, Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]));
    }
  }
  check('the two triangles of a rhombus agree on height across their shared edge',
    worstDiagH <= diagBound, `${worstDiagH.toExponential(2)} vs ${diagBound.toExponential(2)}`);
  check('and on the normal', worstDiagN <= normalBound * 2 * eps * 1.5,
    `${worstDiagN.toExponential(2)} vs ${(normalBound * 2 * eps * 1.5).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log('\nthe rendered mesh is the collision mesh');
{
  // If these two triangulations disagree, grains rest on a surface that is not
  // the one being drawn -- which reads as a physics bug and is not one.
  const f = mk(32, 32);
  const idx = buildTerrainIndices(f.W, f.H);
  const t = {};
  let mismatched = 0, nonLattice = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const cs = [idx[i], idx[i + 1], idx[i + 2]];
    const pts = cs.map((c) => {
      const q = c % f.W, r = (c / f.W) | 0;
      return [f.cellX(q, r), f.cellZ(r)];
    });
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      if (Math.abs(Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]) / S - 1) > 1e-9) nonLattice++;
    }
    const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
    const cz = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    f.sampleTriangle(cx, cz, t);
    const got = [t.i0, t.i1, t.i2].sort((p, q) => p - q).join(',');
    if (got !== cs.slice().sort((p, q) => p - q).join(',')) mismatched++;
  }
  console.log(`  ${idx.length / 3} triangles`);
  check('every rendered triangle is a lattice face', nonLattice === 0, `${nonLattice} bad edges`);
  check('every rendered triangle is what sampleTriangle returns for its centroid',
    mismatched === 0, `${mismatched} mismatched`);
  // Two triangles per rhombus, minus the ragged ends of each row pair.
  check('the mesh covers the lattice', idx.length / 3 === 2 * (f.W - 1) * (f.H - 1),
    `${idx.length / 3} vs ${2 * (f.W - 1) * (f.H - 1)}`);
}

// ---------------------------------------------------------------------------
console.log('\nvolume through deposit and debit');
{
  const f = mk();
  const rng = new Rng(3);
  const grain = (Math.PI / 6) * 1e-9;   // a 1 mm grain
  let put = 0;
  const halfW = f.W * S * 0.5, halfD = f.H * S * (Math.sqrt(3) / 2) * 0.5;
  for (let i = 0; i < 20000; i++) {
    // Deliberately includes points past the rim: deposition must fold them
    // onto the boundary rather than losing them.
    const x = rng.range(-halfW * 1.1, halfW * 1.1);
    const z = rng.range(-halfD * 1.1, halfD * 1.1);
    const v = grain * rng.range(0.3, 3);
    const splat = i % 7 === 0 ? S * 4 : S;   // clump-sized footprints too
    f.deposit(x, z, v, splat);
    put += v;
  }
  const swept = f.sumVolume();
  check('nothing is lost or invented by deposit', Math.abs(swept / put - 1) < 1e-12,
    `${put.toExponential(6)} in, ${swept.toExponential(6)} held`);
  check('the running total matches a full sweep', Math.abs(f.volume - swept) < 1e-15 * put,
    `${(f.volume - swept).toExponential(2)}`);

  // Height and volume must stay in step while elevation is volume-derived --
  // this is the invariant M4's observed elevation has to be checked against.
  let hv = 0;
  for (let c = 0; c < f.n; c++) hv += f.height[c] * f.cellArea * f.packingFraction;
  check('height and volume agree', Math.abs(hv / swept - 1) < 1e-6, `${(hv / swept).toFixed(9)}x`);

  let removed = 0;
  for (let i = 0; i < 20000; i++) {
    const x = rng.range(-halfW, halfW), z = rng.range(-halfD, halfD);
    removed += f.debit(x, z, grain * rng.range(0.3, 3));
  }
  const after = f.sumVolume();
  check('debit removes exactly what it reports', Math.abs((swept - removed) - after) < 1e-12 * put,
    `${((swept - removed) - after).toExponential(2)}`);
  check('the running total still matches', Math.abs(f.volume - after) < 1e-15 * put);

  // Draining a cell must not go negative, whatever is asked of it.
  const f2 = mk();
  f2.deposit(0, 0, grain);
  const got = f2.debit(0, 0, grain * 1000);
  check('debit cannot overdraw', Math.abs(got - grain) < 1e-18 && f2.sumVolume() < 1e-18,
    `took ${got.toExponential(3)} of ${grain.toExponential(3)}`);
}

// ---------------------------------------------------------------------------
console.log('\nburied size memory');
{
  // Mean alone would make a cell that buried a chaotic mix and one that buried
  // a well-sorted layer re-emit identically. The variance is the half that
  // carries the difference, so it is checked separately.
  const f = mk();
  const vols = [1e-9, 2e-9, 5e-9, 1.2e-8];
  for (const v of vols) for (let i = 0; i < 25; i++) f.deposit(0, 0, v);
  const c = f.sampleTriangle(0, 0).i0;
  const m = f.sizeMoments(c);
  const logs = [];
  for (const v of vols) for (let i = 0; i < 25; i++) logs.push(Math.log(v));
  const wantMean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const wantVar = logs.reduce((a, b) => a + (b - wantMean) ** 2, 0) / logs.length;
  check('mean log-volume is remembered', Math.abs(m.meanLogVol - wantMean) < 1e-9,
    `${m.meanLogVol.toFixed(6)} vs ${wantMean.toFixed(6)}`);
  check('variance is remembered', Math.abs(m.varLogVol - wantVar) < 1e-9,
    `${m.varLogVol.toFixed(6)} vs ${wantVar.toFixed(6)}`);

  // Removing a representative sample must not shift the distribution.
  f.debit(0, 0, f.solidVolume[c] * 0.5);
  const m2 = f.sizeMoments(c);
  check('debit does not re-sort the cell',
    Math.abs(m2.meanLogVol - wantMean) < 1e-9 && Math.abs(m2.varLogVol - wantVar) < 1e-9);

  const f3 = mk();
  f3.deposit(0, 0, 1e-9);
  check('one grain is not a distribution', f3.sizeMoments(f3.sampleTriangle(0, 0).i0) === null);

  // A single size must read as zero spread, not as float noise.
  const f4 = mk();
  for (let i = 0; i < 500; i++) f4.deposit(0, 0, 3e-9);
  const m4 = f4.sizeMoments(f4.sampleTriangle(0, 0).i0);
  check('uniform sand remembers zero spread', m4.varLogVol >= 0 && m4.varLogVol < 1e-12,
    m4.varLogVol.toExponential(2));
}

// ---------------------------------------------------------------------------
console.log('\nrelaxation arm: volume is conserved');
{
  const f = mk(64, 64);
  const grain = (Math.PI / 6) * 1e-9;
  // A tall narrow column, well clear of the rim so nothing can spill off it.
  for (let i = 0; i < 40000; i++) f.deposit(0, 0, grain, S * 2);
  const before = f.sumVolume();
  const tanR = Math.tan(32 * Math.PI / 180);
  const tanS = Math.tan(35 * Math.PI / 180);
  const rate = relaxRateFromHalfLife(0.05);
  for (let i = 0; i < 20000; i++) if (f.relax(1 / 240, tanR, tanS, rate) === 0) break;
  const after = f.sumVolume();
  check('relaxation moves sand without creating or destroying it',
    Math.abs(after / before - 1) < 1e-12 && f.escapedVolume === 0,
    `${before.toExponential(6)} -> ${after.toExponential(6)}, escaped ${f.escapedVolume}`);
  // The running total is millions of signed increments while the sweep is a few
  // thousand cell values, so the two round differently. 1e-11 relative is
  // ordinary float noise and still eight orders of magnitude tighter than any
  // dropped-flux bug, which shows up at O(1).
  check('the running total survives relaxation', Math.abs(f.volume - after) < 1e-11 * before,
    `${((f.volume - after) / before).toExponential(2)} relative`);

  // Open boundary: a pile against the rim must spill off it, and the sand that
  // leaves has to be booked rather than vanishing.
  const g = mk(32, 32);
  for (let i = 0; i < 20000; i++) g.deposit(g.cellX(1, 1), g.cellZ(1), grain, S * 2);
  const gBefore = g.sumVolume();
  for (let i = 0; i < 20000; i++) if (g.relax(1 / 240, tanR, tanS, rate) === 0) break;
  check('sand spills over the rim and is accounted for',
    g.escapedVolume > 0 && Math.abs((g.sumVolume() + g.escapedVolume) / gBefore - 1) < 1e-11,
    `${(100 * g.escapedVolume / gBefore).toFixed(1)}% left the domain, ` +
    `balance off by ${((g.sumVolume() + g.escapedVolume) / gBefore - 1).toExponential(2)}`);
}

// ---------------------------------------------------------------------------
console.log('\nrelaxation arm: a spike relaxes to a round cone, not a hex pyramid');
{
  // The anisotropy test the whole milestone was written to isolate. A square
  // lattice gives square pyramids here; hex should give something round. A
  // regular hexagon's circumradius exceeds its inradius by 15.5%, so a 6-fold
  // ripple anywhere near that size means the flux rule is leaking lattice
  // directions into the pile shape. Both rules that came before this one
  // failed here: thresholding on each neighbour's height difference left a
  // 4.1% ripple, and transporting down the fitted gradient instead left none
  // but settled into a checkerboard.
  const reposeDeg = 32;
  const f = mk(96, 96);
  const grain = (Math.PI / 6) * 1e-9;
  for (let i = 0; i < 300000; i++) f.deposit(0, 0, grain, S * 3);

  const tanR = Math.tan(reposeDeg * Math.PI / 180);
  const tanS = Math.tan((reposeDeg + 3) * Math.PI / 180);
  const rate = relaxRateFromHalfLife(0.05);
  let moving = 1, passes = 0;
  while (moving > 0 && passes < 60000) { moving = f.relax(1 / 240, tanR, tanS, rate); passes++; }
  check('the pile settles', moving === 0, `still moving ${moving.toExponential(2)} m after ${passes} passes`);
  console.log(`  settled after ${passes} passes`);

  const peak = f.heightAt(0, 0);
  // Radius at half height, in 72 directions. Hexagonal anisotropy would show
  // up as a clean 6-fold ripple in this profile.
  const N = 72;
  const radii = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const th = (2 * Math.PI * k) / N;
    const cx = Math.cos(th), cz = Math.sin(th);
    let lo = 0, hi = f.W * S * 0.5;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (f.heightAt(cx * mid, cz * mid) > peak * 0.5) lo = mid; else hi = mid;
    }
    radii[k] = (lo + hi) / 2;
  }
  let mean = 0;
  for (const r of radii) mean += r;
  mean /= N;
  // Amplitude of the 6-fold harmonic, which is the shape a hex lattice would
  // print onto the pile.
  let c6 = 0, s6 = 0;
  for (let k = 0; k < N; k++) {
    const th = (2 * Math.PI * k) / N;
    c6 += radii[k] * Math.cos(6 * th);
    s6 += radii[k] * Math.sin(6 * th);
  }
  const amp6 = 2 * Math.hypot(c6, s6) / N / mean;
  let spread = 0;
  for (const r of radii) spread = Math.max(spread, Math.abs(r / mean - 1));
  console.log(`  peak ${(peak * 100).toFixed(2)} cm, half-height radius ${(mean * 100).toFixed(2)} cm`);
  console.log(`  6-fold ripple ${(amp6 * 100).toFixed(3)}% (a hexagon would be 15.5%), worst deviation ${(spread * 100).toFixed(3)}%`);
  check('the footprint is round, not hexagonal', amp6 < 0.005, `${(amp6 * 100).toFixed(3)}%`);
  check('and round in every other way too', spread < 0.02, `${(spread * 100).toFixed(3)}%`);

  // And the flank has to sit at the angle it was told to, or the arm is not
  // even a faithful implementation of the rule it is meant to represent.
  let angleSum = 0;
  for (let k = 0; k < N; k++) {
    const th = (2 * Math.PI * k) / N;
    const cx = Math.cos(th), cz = Math.sin(th);
    const r1 = mean * 0.6, r2 = mean * 1.4;
    const drop = f.heightAt(cx * r1, cz * r1) - f.heightAt(cx * r2, cz * r2);
    angleSum += Math.atan2(drop, r2 - r1) * 180 / Math.PI;
  }
  const flank = angleSum / N;
  console.log(`  measured flank ${flank.toFixed(2)}°, asked for ${reposeDeg}°`);
  check('the flank sits at the repose angle', Math.abs(flank - reposeDeg) < 0.5,
    `${flank.toFixed(2)}° vs ${reposeDeg}°`);

  // And it has to track the slider rather than landing on 32 by luck.
  for (const deg of [20, 42]) {
    const g = mk(96, 96);
    for (let i = 0; i < 300000; i++) g.deposit(0, 0, grain, S * 3);
    const tr = Math.tan(deg * Math.PI / 180), ts = Math.tan((deg + 3) * Math.PI / 180);
    let mv = 1, p = 0;
    while (mv > 0 && p < 60000) { mv = g.relax(1 / 240, tr, ts, rate); p++; }
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const th = (2 * Math.PI * k) / N, cx = Math.cos(th), cz = Math.sin(th);
      const r1 = mean * 0.6, r2 = mean * 1.4;
      sum += Math.atan2(g.heightAt(cx * r1, cz * r1) - g.heightAt(cx * r2, cz * r2), r2 - r1) * 180 / Math.PI;
    }
    check(`  and at ${deg}°`, mv === 0 && Math.abs(sum / N - deg) < 0.5,
      `measured ${(sum / N).toFixed(2)}° in ${p} passes`);
  }
}

// ---------------------------------------------------------------------------
console.log('\ndirty tracking');
{
  const f = mk();
  f.clearDirty();
  check('a clean field reports nothing to upload', !f.hasDirty());
  const x = f.cellX(20, 20), z = f.cellZ(20);
  f.deposit(x, z, 1e-9);
  check('a deposit dirties a rect around it', f.hasDirty() &&
    f.dirty.minQ <= 20 && f.dirty.maxQ >= 20 && f.dirty.minR <= 20 && f.dirty.maxR >= 20,
    JSON.stringify(f.dirty));
  const wide = (f.dirty.maxQ - f.dirty.minQ + 1) * (f.dirty.maxR - f.dirty.minR + 1);
  check('and only a rect around it', wide <= 6, `${wide} cells`);
  f.clearDirty();
  f.deposit(x, z, 1e-9);
  f.deposit(f.cellX(40, 40), f.cellZ(40), 1e-9);
  check('two deposits share one bounding rect',
    f.dirty.minQ <= 20 && f.dirty.maxQ >= 40 && f.dirty.minR <= 20 && f.dirty.maxR >= 40);
  f.reset();
  check('reset dirties everything', f.hasDirty() &&
    f.dirty.minQ === 0 && f.dirty.maxQ === f.W - 1 && f.dirty.maxR === f.H - 1);
  check('and empties the field', f.sumVolume() === 0 && f.volume === 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
