// Every tunable in one place.
//
// `values` is the flat object the simulation reads each frame. `SCHEMA`
// describes those same keys for the UI to build sliders from, so adding a
// parameter never means touching the panel code. `CONFIG` holds the structural
// constants that are not sliders -- changing one means restarting the sim, not
// dragging something.
//
// There is no measurement readout in v1 by request, which makes the panel the
// only instrument for the project's actual question. So it covers every
// parameter rather than a curated subset.

const SQRT3_2 = Math.sqrt(3) / 2;

export const CONFIG = {
  // Hex heightfield dimensions. Unused until M2, but the domain extent derives
  // from them and the turbulence field and camera both need that now.
  gridW: 192,
  gridH: 192,
  cellSpacing: 0.06,

  // Tallest the domain gets, which is the nozzle height slider's maximum plus
  // headroom. Bounds the turbulence field.
  domainHeight: 9,

  grainCapacity: 200000,

  gravity: 9.81,

  // Fixed simulation substep. The contact solver (M3) needs this rate; the
  // ballistic phase integrates once per frame instead.
  substepHz: 240,
  // Overload has to degrade into slow motion rather than a frozen tab, so the
  // accumulator is capped by both a step count and a wall-clock budget.
  maxSubstepsPerFrame: 8,
  frameBudgetMs: 12,

  // Turbulence lookup grid. See CurlField in noise.js for why the curl is
  // precomputed on a grid instead of evaluated per grain.
  turbGridRes: 24,
  turbRebuildFrames: 3,
};

CONFIG.domainWidth = CONFIG.gridW * CONFIG.cellSpacing;
CONFIG.domainDepth = CONFIG.gridH * CONFIG.cellSpacing * SQRT3_2;

// Domain is centred on the origin in x/z, floor at y = 0.
export function domainBounds() {
  return {
    min: [-CONFIG.domainWidth / 2, 0, -CONFIG.domainDepth / 2],
    size: [CONFIG.domainWidth, CONFIG.domainHeight, CONFIG.domainDepth],
  };
}

export const values = {
  seed: 1,

  // --- Source ---
  // Volumetric, not per-count: that is what a real nozzle delivers, and it
  // keeps the stream physically constant when the size distribution is retuned.
  flowRate: 0.02,
  apertureRadius: 0.15,
  nozzleHeight: 3.0,
  initialSpeed: 0.5,
  // Choking is correlated in time -- the flow starves, then releases -- so the
  // rate is driven by low-frequency gradient noise rather than per-spawn jitter,
  // which would give an uncorrelated and much milder Poisson process.
  burstTimescale: 1.5,
  burstIntensity: 0.5,
  continuousPour: true,
  dropVolume: 0.05,

  // --- Grain ---
  // Parameterised the way sediment actually is characterised. Polydispersity is
  // load-bearing: monodisperse spheres crystallise into regular packings, which
  // depresses the repose angle and puts lattice ordering on the flanks.
  medianDiameter: 0.02,
  sorting: 0.35,
  clumpThreshold: 0.06,
  maxGrainDiameter: 0.12,
  cohesion: 50,

  // --- Turbulence ---
  turbAmplitude: 0.6,
  turbLengthScale: 0.8,
  turbTimeScale: 0.5,
  // Drag is -dragK * (v - vFluid) / radius. The 1/r is what makes size matter:
  // small grains are strongly deflected by turbulence, large grains and clumps
  // punch through it. Default gives sand-like terminal velocity at the median
  // diameter.
  dragK: 0.02,

  // --- Repose (M2) ---
  reposeStatic: 34,
  reposeAngle: 30,
  relaxRate: 0.3,

  // --- Exchange (M4) ---
  // 0 is meaningful and is the low end of the sweep: absorb as soon as a grain
  // is covered, collapsing the active layer to the topmost shell so the pile is
  // almost entirely continuum. The maximum is the opposite pole, pure DEM.
  activeLayerDepth: 0.06,
  sizeMemory: true,
  // Bootstrap only. Packing fraction is measured per cell once grains exist;
  // this is the fallback for cells that have none to observe yet.
  packingFraction: 0.62,

  // --- Render ---
  grainScale: 1.0,
};

// group/label/min/max/step, plus `log` for logarithmic sliders and `logZero`
// for a log slider whose bottom detent is an exact 0.
export const SCHEMA = [
  { key: 'flowRate', group: 'Source', label: 'Flow rate (vol/s)', min: 0, max: 0.2, step: 0.0005 },
  { key: 'apertureRadius', group: 'Source', label: 'Aperture radius', min: 0.01, max: 1, step: 0.01 },
  { key: 'nozzleHeight', group: 'Source', label: 'Nozzle height', min: 0.2, max: 8, step: 0.05 },
  { key: 'initialSpeed', group: 'Source', label: 'Initial speed', min: 0, max: 5, step: 0.05 },
  { key: 'burstTimescale', group: 'Source', label: 'Burst timescale', min: 0.1, max: 10, step: 0.1, log: true },
  { key: 'burstIntensity', group: 'Source', label: 'Burst intensity', min: 0, max: 1, step: 0.01 },
  { key: 'continuousPour', group: 'Source', label: 'Continuous pour', type: 'bool' },

  { key: 'medianDiameter', group: 'Grain', label: 'Median diameter', min: 0.002, max: 0.1, step: 0.0005, log: true },
  { key: 'sorting', group: 'Grain', label: 'Sorting (log-sigma)', min: 0.05, max: 1.2, step: 0.01 },
  { key: 'clumpThreshold', group: 'Grain', label: 'Clump threshold', min: 0.02, max: 0.3, step: 0.001, log: true },
  // Separate from clumpThreshold on purpose, so "how big do clumps get" and
  // "how rare are clumps" stay independently sweepable.
  { key: 'maxGrainDiameter', group: 'Grain', label: 'Max diameter', min: 0.03, max: 0.5, step: 0.001, log: true },
  { key: 'cohesion', group: 'Grain', label: 'Cohesion', min: 0, max: 500, step: 1 },

  { key: 'turbAmplitude', group: 'Turbulence', label: 'Amplitude', min: 0, max: 5, step: 0.01 },
  { key: 'turbLengthScale', group: 'Turbulence', label: 'Length scale', min: 0.05, max: 5, step: 0.01, log: true },
  { key: 'turbTimeScale', group: 'Turbulence', label: 'Time scale', min: 0, max: 5, step: 0.01 },
  { key: 'dragK', group: 'Turbulence', label: 'Drag', min: 0, max: 0.2, step: 0.001 },

  { key: 'reposeStatic', group: 'Repose', label: 'Static angle (deg)', min: 5, max: 60, step: 0.5 },
  { key: 'reposeAngle', group: 'Repose', label: 'Repose angle (deg)', min: 5, max: 60, step: 0.5 },
  { key: 'relaxRate', group: 'Repose', label: 'Relax rate', min: 0.01, max: 1, step: 0.01 },

  { key: 'activeLayerDepth', group: 'Exchange', label: 'Active layer depth', min: 0.005, max: 20, step: 0.001, log: true, logZero: true },
  { key: 'sizeMemory', group: 'Exchange', label: 'Size memory', type: 'bool' },

  { key: 'grainScale', group: 'Render', label: 'Grain scale', min: 0.5, max: 2, step: 0.01 },
];

// Clamp cross-parameter constraints that a plain slider range cannot express.
export function enforceConstraints() {
  if (values.maxGrainDiameter <= values.clumpThreshold) {
    // A clump-preserving resample draws uniformly on [clumpThreshold,
    // maxGrainDiameter]; if that interval collapses there is nothing to draw.
    values.maxGrainDiameter = values.clumpThreshold * 1.5;
  }
  if (values.reposeAngle > values.reposeStatic) {
    // Hysteresis only means anything if the repose angle sits below the static
    // angle -- that gap is what makes avalanches intermittent.
    values.reposeAngle = values.reposeStatic;
  }
}
