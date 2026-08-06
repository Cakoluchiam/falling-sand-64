// Backing allocation for the simulation's typed arrays.
//
// SharedArrayBuffer needs cross-origin isolation. It buys nothing on the main
// thread -- it is identical in speed to ArrayBuffer there -- but allocating
// over it now means a later worker migration is a scheduling change with no
// data restructuring. Fall back rather than fail when isolation is absent.

export const SHARED_MEMORY_AVAILABLE =
  typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;

export function allocBuffer(bytes) {
  return SHARED_MEMORY_AVAILABLE ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}
