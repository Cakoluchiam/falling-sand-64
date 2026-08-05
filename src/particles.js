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
    this.reset();
  }

  reset() {
    const n = this.capacity;
    this.count = 0;
    this.freeTop = n;
    for (let i = 0; i < n; i++) {
      this.freeStack[i] = n - 1 - i;   // pop order 0, 1, 2, ...
      this.slot[i] = -1;
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

  free(i) {
    const s = this.slot[i];
    if (s < 0) return;
    const last = this.live[--this.count];
    this.live[s] = last;
    this.slot[last] = s;
    this.slot[i] = -1;
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
