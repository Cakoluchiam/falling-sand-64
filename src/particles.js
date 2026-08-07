// Structure-of-arrays grain store.
//
// Kept pure over flat typed arrays with no DOM or GL references. That is what
// keeps a later move into a Web Worker a contained change: the renderer reads
// these arrays and nothing else touches them.
//
// Indices are stable. A dense `live` list gives cache-friendly iteration while
// a free stack recycles slots, so an index handed out at spawn stays valid
// until that grain is freed -- which matters once the large-body list (M3)
// starts holding references.

export const PHASE_BALLISTIC = 0;
export const PHASE_AWAKE = 1;
export const PHASE_RESTING = 2;
export const PHASE_FREE = 255;

import { allocBuffer } from './shared.js';

const F32_FIELDS = [
  'px', 'py', 'pz',
  'vx', 'vy', 'vz',
  'vol', 'radius', 'colorSeed', 'restTimer',
];
const U8_FIELDS = ['phase', 'isAgg'];

export class Particles {
  constructor(capacity) {
    this.capacity = capacity;

    const f32Bytes = F32_FIELDS.length * capacity * 4;
    const u8Bytes = U8_FIELDS.length * capacity;
    this.buffer = allocBuffer(f32Bytes + u8Bytes);

    let off = 0;
    for (const name of F32_FIELDS) {
      this[name] = new Float32Array(this.buffer, off, capacity);
      off += capacity * 4;
    }
    for (const name of U8_FIELDS) {
      this[name] = new Uint8Array(this.buffer, off, capacity);
      off += capacity;
    }

    this.live = new Int32Array(capacity);   // dense list of live indices
    this.slot = new Int32Array(capacity);   // slot[i] = where i sits in `live`
    this.freeStack = new Int32Array(capacity);

    // Aggregates again, separately. They are rare -- tens of them against
    // hundreds of thousands of grains -- and everything that has to consider
    // them one by one would otherwise sweep the whole store to find them. M3's
    // broad phase wants the same list, for the same reason: a clump is large
    // enough that it needs its own search radius.
    this.aggs = new Int32Array(capacity);
    this.aggSlot = new Int32Array(capacity);
    this.reset();
  }

  reset() {
    const n = this.capacity;
    this.count = 0;
    this.aggCount = 0;
    this.freeTop = n;
    for (let i = 0; i < n; i++) {
      this.freeStack[i] = n - 1 - i;   // pop order 0, 1, 2, ...
      this.slot[i] = -1;
      this.aggSlot[i] = -1;
      this.phase[i] = PHASE_FREE;
    }
  }

  // Returns a stable index, or -1 when the store is full.
  alloc() {
    if (this.freeTop === 0) return -1;
    const i = this.freeStack[--this.freeTop];
    this.slot[i] = this.count;
    this.live[this.count++] = i;
    return i;
  }

  // Called after `isAgg` is set, since alloc() runs before the caller knows
  // what it is making.
  markAggregate(i) {
    if (this.aggSlot[i] >= 0) return;
    this.aggSlot[i] = this.aggCount;
    this.aggs[this.aggCount++] = i;
  }

  free(i) {
    const s = this.slot[i];
    if (s < 0) return;
    const last = this.live[--this.count];
    this.live[s] = last;
    this.slot[last] = s;
    this.slot[i] = -1;
    const a = this.aggSlot[i];
    if (a >= 0) {
      const lastAgg = this.aggs[--this.aggCount];
      this.aggs[a] = lastAgg;
      this.aggSlot[lastAgg] = a;
      this.aggSlot[i] = -1;
    }
    this.phase[i] = PHASE_FREE;
    this.freeStack[this.freeTop++] = i;
  }

  // Total solid volume currently held as grains. One half of the volume audit;
  // the heightfield's solidVolume is the other (M4).
  totalVolume() {
    let sum = 0;
    for (let k = 0; k < this.count; k++) sum += this.vol[this.live[k]];
    return sum;
  }

  // Index of a lump still in flight whose sphere contains this grain's centre,
  // or -1. See eatGrainsInside for why "still in flight" is load-bearing.
  //
  // Centre-inside rather than spheres-touching, so a grain resting *against* a
  // lump -- a full radius outside it -- is never caught.
  //
  // ⚠ "In flight" means BALLISTIC specifically, not merely "not resting". Once
  // the contact solver existed there was a third phase in between, and a lump
  // sitting on the pile being solved rather than asleep is exactly the case
  // this must not catch: lumps heap up where the sand is landing, so a lump
  // that goes on eating after it arrives drains the pour without bound. That
  // was measured at 1% climbing to 27% over 80 s before the rule was
  // restricted to falling lumps, and reading the phase as "not resting" would
  // have quietly reintroduced it the moment PHASE_AWAKE started being used.
  fallingClumpContaining(i) {
    const { px, py, pz, radius, phase, aggs } = this;
    const x = px[i], y = py[i], z = pz[i];
    for (let a = 0; a < this.aggCount; a++) {
      const c = aggs[a];
      if (phase[c] !== PHASE_BALLISTIC) continue;
      const R = radius[c];
      const dy = py[c] - y;
      if (dy > R || dy < -R) continue;   // cheap reject: most lumps are elsewhere
      const dx = px[c] - x, dz = pz[c] - z;
      if (dx * dx + dy * dy + dz * dz < R * R) return c;
    }
    return -1;
  }

  // Free every grain whose centre is inside lump `c`, and return their total
  // volume. A clump's own volume already stands for the grains that stuck
  // together to make it, so sand travelling with one is double-counted rather
  // than new -- which is why this does not add to the lump's mass.
  //
  // Called when a lump reaches the pile. A clump has something like seventeen
  // times a grain's terminal velocity, so it outruns the sand it left the
  // nozzle with and lands on whatever got there first. Rare enough -- tens of
  // clumps in a pour -- that sweeping the store beats indexing for it.
  eatGrainsInside(c) {
    const { px, py, pz, radius, vol, isAgg, live } = this;
    const R = radius[c], x = px[c], y = py[c], z = pz[c];
    let eaten = 0;
    // Backwards, because free() swap-removes from the tail of `live`.
    for (let k = this.count - 1; k >= 0; k--) {
      const i = live[k];
      if (i === c || isAgg[i]) continue;
      const dx = px[i] - x, dy = py[i] - y, dz = pz[i] - z;
      if (dx * dx + dy * dy + dz * dz >= R * R) continue;
      eaten += vol[i];
      this.free(i);
    }
    return eaten;
  }

  countByPhase() {
    let ballistic = 0, awake = 0, resting = 0;
    for (let k = 0; k < this.count; k++) {
      const p = this.phase[this.live[k]];
      if (p === PHASE_BALLISTIC) ballistic++;
      else if (p === PHASE_AWAKE) awake++;
      else if (p === PHASE_RESTING) resting++;
    }
    return { ballistic, awake, resting };
  }
}
