// Every tunable in one place.
//
// `values` holds SI internally -- metres, seconds, m^3 of *solid* grain volume.
// `SCHEMA` describes each key for the UI, including the unit it should be shown
// in, so the panel can read in grams per second while the simulation reads in
// cubic metres and neither has to know about the other.
//
// Slider ranges are chosen so the 50% mark is roughly a real situation: a child
// tipping a 2.5 litre beach bucket of play sand into a sandbox from about half a
// metre up. That makes the midpoint of every slider a physical reference point
// rather than an arbitrary middle.
//
// There is no measurement readout in v1 by request, which makes this panel the
// only instrument for the project's question, so it covers every parameter
// rather than a curated subset.

const SQRT3_2 = Math.sqrt(3) / 2;

// Quartz sand. Particle density is the density of the mineral itself; bulk
// density is what a scoop of loose dry sand weighs, voids included. Mass flow
// uses the particle density because `flowRate` is solid volume; the bulk figure
// only appears when converting a displayed volume back to something you could
// measure with a jug.
export const SAND_PARTICLE_DENSITY = 2650;  // kg/m^3
export const SAND_BULK_DENSITY = 1600;      // kg/m^3

export const CONFIG = {
  // 192 x 192 cells at 3 mm spacing -> a 58 x 50 cm patch, which comfortably
  // holds the pile a bucket of sand actually makes (~31 cm across, 10 cm tall).
  gridW: 192,
  gridH: 192,
  cellSpacing: 0.003,

  grainCapacity: 200000,

  substepHz: 240,
  maxSubstepsPerFrame: 8,
  frameBudgetMs: 12,

  // Ballistic integration is per frame, but the simulation-speed slider can
  // stretch a frame to 10x. Subdivide so a fast run does not also become an
  // inaccurate one -- at 10x a single 1/60 step would move a grain 8 cm.
  maxBallisticStep: 1 / 120,
  maxBallisticIters: 32,

  // Turbulence lookup grid. Node budget rather than a fixed per-axis count, so
  // the cells stay roughly cubic as the field's aspect ratio changes with pour
  // height. See CurlField for why the curl is gridded at all.
  // ~7000 nodes gives roughly 3 cm cells over the sandbox, about seven per
  // eddy at the default eddy size -- ample, and it keeps a rebuild near 2 ms.
  turbNodeBudget: 7000,
  turbMaxRes: 48,
  turbRebuildFrames: 3,
};

CONFIG.domainWidth = CONFIG.gridW * CONFIG.cellSpacing;
CONFIG.domainDepth = CONFIG.gridH * CONFIG.cellSpacing * SQRT3_2;

// Domain is centred on the origin in x/z, floor at y = 0. The vertical extent
// is not fixed: it tracks the pour height, because that slider spans 2 cm to
// 12.5 m and sizing the turbulence field for the tallest pour would leave it
// absurdly coarse for the shortest one.
export function domainBounds(height) {
  const h = Math.max(height, CONFIG.cellSpacing * 4);
  return {
    min: [-CONFIG.domainWidth / 2, 0, -CONFIG.domainDepth / 2],
    size: [CONFIG.domainWidth, h, CONFIG.domainDepth],
  };
}

export const values = {
  seed: 1,

  // --- Run ---
  simSpeed: 1,
  gravity: 9.81,
  autoRestart: true,
  autoRestartDelay: 2,

  // --- Source ---
  // Solid volume per second. 1.509e-4 m^3/s = 400 g/s = a 4 kg bucket in 10 s.
  flowRate: 400 / (SAND_PARTICLE_DENSITY * 1000),
  apertureRadius: 0.02,
  nozzleHeight: 0.5,
  initialSpeed: 0.4,
  surgePeriod: 0.6,
  surgeDepth: 0.5,
  continuousPour: true,
  // 4 kg, the mass of a 2.5 litre bucket of loose dry sand.
  dropMass: 4,

  // --- Grain ---
  medianDiameter: 0.001,
  // Stored as log-sigma; shown as the coarse:fine size ratio, which is what a
  // sieve analysis reports and what a person can actually picture.
  sorting: Math.log(2) / 2,
  // Multiples of the median, so they keep their meaning when grain size moves.
  clumpThreshold: 2.55,
  maxGrainRatio: 12,
  // Impact speed at which a median clump breaks. Replaces a raw cohesion gain,
  // which had no physical unit at all -- the model carries no mass or density,
  // so "cohesion" was an abstract number nobody could calibrate against
  // anything. M5 converts this into the impulse threshold.
  shatterSpeed: 1.5,

  // --- Air ---
  turbAmplitude: 0.3,
  eddySize: 0.2,
  eddyLifetime: 0.7,
  // Terminal velocity of a *median* grain. Drag is derived from it, rather than
  // the other way round, so the number on the panel is one you can look up.
  fallSpeed: 6,

  // --- Pile (M2) ---
  reposeAngle: 32,
  // Degrees above the repose angle at which a slope starts avalanching. Stored
  // as a gap rather than an absolute static angle so static > repose is
  // structural instead of something the code silently clamps.
  avalancheGap: 3,
  slumpHalfLife: 0.1,

  // --- Exchange (M4) ---
  // In grain diameters, so it keeps its meaning as grain size changes. 0 is
  // meaningful: absorb as soon as a grain is covered.
  activeLayerDepth: 2,
  pureDEM: false,
  sizeMemory: true,
  // Bootstrap only; packing fraction becomes a measured per-cell output at M4.
  packingFraction: 0.62,

  // --- Render ---
  grainScale: 1.0,
};

// Derived quantities the simulation wants but the panel should not show,
// because they are consequences of the sliders rather than independent knobs.
export const derived = {
  // Drag acts as -dragCoef * v / radius. Fixing terminal velocity of the median
  // grain pins it: at terminal, g = dragCoef * v / r_median.
  dragCoef() {
    return values.gravity * (values.medianDiameter * 0.5) / Math.max(values.fallSpeed, 1e-6);
  },
  turbTimeScale() {
    return 1 / Math.max(values.eddyLifetime, 1e-6);
  },
  staticAngle() {
    return values.reposeAngle + values.avalancheGap;
  },
  clumpDiameter() {
    return values.clumpThreshold * values.medianDiameter;
  },
  maxDiameter() {
    return values.maxGrainRatio * values.medianDiameter;
  },
  activeLayerMetres() {
    return values.activeLayerDepth * values.medianDiameter;
  },
  dropVolume() {
    return values.dropMass / SAND_PARTICLE_DENSITY;
  },
};

// Unit descriptors. `scale` converts SI -> display. Entries with more than one
// unit get a click-to-cycle toggle on the panel.
const G_PER_S = { unit: 'g/s', scale: SAND_PARTICLE_DENSITY * 1000 };
const ML_PER_S = { unit: 'mL/s', scale: (SAND_PARTICLE_DENSITY / SAND_BULK_DENSITY) * 1e6 };

// min/max are given in the FIRST unit listed and converted to SI on load, so
// the slider curve does not move when the display unit is toggled.
export const SCHEMA = [
  { key: 'simSpeed', group: 'Run', label: 'Simulation speed', units: [{ unit: 'x', scale: 1 }], min: 0.1, max: 10, log: true },
  { key: 'gravity', group: 'Run', label: 'Gravity', units: [{ unit: 'm/s²', scale: 1 }], min: 0.62, max: 24.79, log: true },
  { key: 'autoRestart', group: 'Run', label: 'Auto restart when settled', type: 'bool' },
  { key: 'autoRestartDelay', group: 'Run', label: 'Restart after', units: [{ unit: 's', scale: 1 }], min: 0.5, max: 10 },

  { key: 'flowRate', group: 'Source', label: 'Flow rate', units: [G_PER_S, ML_PER_S], min: 8, max: 20000, log: true, logZero: true },
  { key: 'dropMass', group: 'Source', label: 'Bucket size', units: [{ unit: 'kg', scale: 1 }], min: 0.4, max: 40, log: true },
  { key: 'continuousPour', group: 'Source', label: 'Continuous pour', type: 'bool' },
  { key: 'apertureRadius', group: 'Source', label: 'Aperture radius', units: [{ unit: 'cm', scale: 100 }], min: 0.2, max: 20, log: true },
  { key: 'nozzleHeight', group: 'Source', label: 'Pour height', units: [{ unit: 'cm', scale: 100 }], min: 2, max: 1250, log: true },
  { key: 'initialSpeed', group: 'Source', label: 'Initial speed', units: [{ unit: 'm/s', scale: 1 }], min: 0.04, max: 4, log: true, logZero: true },
  { key: 'surgePeriod', group: 'Source', label: 'Surge period', units: [{ unit: 's', scale: 1 }], min: 0.06, max: 6, log: true },
  { key: 'surgeDepth', group: 'Source', label: 'Surge depth', units: [{ unit: '', scale: 1 }], min: 0, max: 1 },

  { key: 'medianDiameter', group: 'Grain', label: 'Median diameter', units: [{ unit: 'mm', scale: 1000 }], min: 0.05, max: 5, log: true },
  {
    key: 'sorting', group: 'Grain', label: 'Sorting (coarse:fine)',
    // Linear in log-sigma, which IS log-uniform in the displayed ratio, since
    // ratio = exp(2*sigma). Marking this `log` would double the transform and
    // land the midpoint at 1.4x instead of 2x.
    units: [{ unit: '×', scale: 1 }], min: 1.1, max: 3.7,
    toDisplay: (s) => Math.exp(2 * s),
    fromDisplay: (r) => Math.log(Math.max(r, 1.0001)) / 2,
  },
  { key: 'clumpThreshold', group: 'Grain', label: 'Clump threshold', units: [{ unit: '× median', scale: 1 }], min: 1.3, max: 5, log: true },
  { key: 'maxGrainRatio', group: 'Grain', label: 'Max diameter', units: [{ unit: '× median', scale: 1 }], min: 3, max: 48, log: true },
  { key: 'shatterSpeed', group: 'Grain', label: 'Shatter speed', units: [{ unit: 'm/s', scale: 1 }], min: 0.15, max: 15, log: true, logZero: true },

  { key: 'turbAmplitude', group: 'Air', label: 'Turbulence', units: [{ unit: 'm/s', scale: 1 }], min: 0.01, max: 9, log: true, logZero: true },
  { key: 'eddySize', group: 'Air', label: 'Eddy size', units: [{ unit: 'cm', scale: 100 }], min: 0.5, max: 800, log: true },
  { key: 'eddyLifetime', group: 'Air', label: 'Eddy lifetime', units: [{ unit: 's', scale: 1 }], min: 0.07, max: 7, log: true },
  { key: 'fallSpeed', group: 'Air', label: 'Fall speed (median)', units: [{ unit: 'm/s', scale: 1 }], min: 0.5, max: 50, log: true },

  { key: 'reposeAngle', group: 'Pile', label: 'Repose angle', units: [{ unit: '°', scale: 1 }], min: 15, max: 49 },
  { key: 'avalancheGap', group: 'Pile', label: 'Avalanche gap', units: [{ unit: '° over repose', scale: 1 }], min: 0, max: 6 },
  { key: 'slumpHalfLife', group: 'Pile', label: 'Slump half-life', units: [{ unit: 's', scale: 1 }], min: 0.01, max: 1, log: true },

  { key: 'activeLayerDepth', group: 'Exchange', label: 'Active layer', units: [{ unit: ' grains', scale: 1 }], min: 0.2, max: 20, log: true, logZero: true },
  { key: 'pureDEM', group: 'Exchange', label: 'Pure DEM (no absorption)', type: 'bool' },
  { key: 'sizeMemory', group: 'Exchange', label: 'Size memory', type: 'bool' },

  { key: 'grainScale', group: 'Render', label: 'Grain scale', units: [{ unit: '×', scale: 1 }], min: 0.5, max: 2, log: true },
];

// Convert the display-unit bounds to SI once, so slider mapping is always in SI
// and toggling a unit changes only the label and the number.
for (const s of SCHEMA) {
  if (s.type === 'bool') continue;
  const scale = s.units[0].scale;
  const inv = s.fromDisplay ? s.fromDisplay : (d) => d / scale;
  s.minSI = inv(s.min);
  s.maxSI = inv(s.max);
}

export function toDisplay(s, si, unitIndex = 0) {
  if (s.toDisplay) return s.toDisplay(si);
  return si * s.units[unitIndex].scale;
}

export function fromDisplay(s, display, unitIndex = 0) {
  if (s.fromDisplay) return s.fromDisplay(display);
  return display / s.units[unitIndex].scale;
}

// Cross-parameter constraints a plain slider range cannot express.
export function enforceConstraints() {
  if (values.maxGrainRatio <= values.clumpThreshold) {
    // The clump-preserving resample draws uniformly on
    // [clumpThreshold, maxGrainRatio]; if that interval collapses there is
    // nothing to draw from.
    values.maxGrainRatio = values.clumpThreshold * 1.5;
  }
}
