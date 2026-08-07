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

// The only import here, for the truncated-lognormal correction in
// `meanGrainVolume`. `rng.js` imports nothing, so this cannot cycle.
import { normalCdf } from './rng.js';

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

  // How close to the surface, in grain diameters, a grain gets handed from
  // free flight to the contact solver. A numerical safety margin rather than a
  // physical knob, which is why it lives here and not on the panel: too small
  // and a grain resolves its first contact already deep inside the surface,
  // too large and grains join the solver long before they need to be there and
  // pay for it every substep. The handoff also carries a speed term, so this
  // only has to cover size.
  handoffDepth: 2,
  // Constraint iterations per substep. Two is the plan's figure; one is
  // visibly softer under stacking and three buys little.
  contactIterations: 2,

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
  targetFps: 60,
  gravity: 9.81,
  autoRestart: true,
  autoRestartDelay: 2,

  // --- Source ---
  // Solid volume per second, defaulted for a *watchable* pour rather than a
  // fast one. 400 g/s empties the grain budget in about 1.2 s, which is less
  // time than it takes to see anything happen; 50 g/s spreads the same 200k
  // grains over about ten seconds. The slider still reaches 20 kg/s. Note the
  // test suites that care about throughput set this themselves rather than
  // inheriting it, so this is a presentation choice and not a physics one.
  flowRate: 50 / (SAND_PARTICLE_DENSITY * 1000),
  apertureRadius: 0.01,
  // A flat opening the sand passes through, versus a source with volume. The
  // disc is the cleaner instrument -- one knob, one effect -- so it is the
  // default; see the note in Nozzle._spawn for how they differ.
  apertureBall: false,
  nozzleHeight: 0.5,
  initialSpeed: 0.4,
  // Sand is turbulent while it is being poured, not only while it falls. Grains
  // shed off a lip or squeeze past each other in the orifice and leave with
  // real sideways velocity, so the stream diverges instead of falling as a
  // cylinder. Without this the stream stays exactly as wide as the aperture all
  // the way down, which makes a clump look enormous: it holds the same
  // fraction of the stream at the floor as it did at the nozzle.
  //
  // Two separate things. `pourAngle` tilts the whole stream off vertical in one
  // fixed direction, the way tipping a bucket sends sand a particular way, and
  // moves where the pile builds. `pourSpread` is how far individual grains
  // scatter about that axis, and it is what actually makes the stream diverge.
  // Divergence comes from the spread, not the tilt. The defaults are
  // nonetheless a tilted, well-spread pour: a straight vertical fall into a
  // circular landing zone is the symmetric case, and symmetric is exactly what
  // hides an asymmetric bug. A hand tipping a bucket is both the more
  // realistic starting point and the more revealing one.
  pourAngle: 30,
  pourSpread: 15,
  surgePeriod: 0.6,
  surgeDepth: 0.5,
  continuousPour: true,
  // 4 kg, the mass of a 2.5 litre bucket of loose dry sand.
  dropMass: 4,

  // --- Grain ---
  medianDiameter: 0.001,
  // Stored as log-sigma; shown as the coarse:fine size ratio, which is what a
  // sieve analysis reports and what a person can actually picture. Zero is
  // reachable and means every grain is exactly the median size.
  sorting: Math.log(2) / 2,
  // Size limits, as multiples of the median. A log-normal is unbounded both
  // ways, so both ends need a stop: unbounded below draws grains tens of times
  // finer than the median that drift like dust instead of landing, and
  // unbounded above draws grains that dominate the contact broad phase.
  //
  // Defaulted narrow (0.5x - 4x) rather than to the full slider range, because
  // that is the window a wide pour is actually set to and the wide default was
  // being closed by hand every session. The sliders still reach 0.02x and 48x.
  // Note this window interacts with `sorting`: at the 2x default the stops sit
  // about 2 sigma below and 4 above, so the low tail is genuinely trimmed, and
  // at high sorting the window binds well before the sorting figure implies.
  // The Derived block prints the resulting diameter range, which is the number
  // to read when the two disagree.
  minGrainRatio: 0.5,
  // Smallest a clump can be, as a multiple of the median grain. This is a
  // property of *fragmentation*, not of grain size: when a clump shatters, a
  // piece larger than this is still a clump and can shatter again, while a
  // smaller piece becomes ordinary sand. It is what stops fragmentation
  // recursing forever, and it is the only reason the threshold exists -- a
  // large grain is simply a large grain and is never promoted to a clump.
  minClumpSize: 3.5,
  maxGrainRatio: 4,
  // --- Clumps ---
  // Clumps get their own population rather than being drawn from the tail of
  // the grain distribution. That earlier design bundled two claims: that a
  // clump is one rigid body rather than a cluster of stuck-together grains, and
  // that its size comes from the same distribution. All the benefit -- implicit
  // intra-clump contacts, no burst-spawn mechanism -- comes from the first,
  // which is untouched here. Only the sampling changes.
  //
  // It had to change because the two are a bimodal request and a log-normal has
  // one hump: reaching a lump of a few thousand grains out in the tail means
  // widening the whole distribution, which drags every ordinary grain with it.
  // Measured, that route gave 1.4 usable clumps per fill alongside 1387
  // mid-sized lumps and sand that no longer looked sorted.
  //
  // Fraction of poured volume that arrives as clumps. Frequency falls out of
  // this and the clump size, which is more intuitive than setting a rate.
  //
  // Defaulted high, at 10%, because 1% puts a clump on screen every few
  // seconds and the clump path is the least-exercised part of the source.
  // Something a viewer sees only occasionally is also something a bug hides
  // in. The slider reaches 50%.
  clumpFraction: 0.1,
  // Diameter as a multiple of the median grain, so it keeps its meaning as
  // grain size moves. Shown in mm, which updates with the median.
  //
  // 12x the median is 12 mm of default sand. Smaller than the 17.1x this used
  // to be, and chosen for frequency rather than realism: volume is cubic, so
  // dropping the width by a third gives nearly three times as many clumps out
  // of the same volume fraction. More arrivals is what makes the behaviour
  // observable, both on screen and in the statistics the clumps suite pools.
  clumpSize: 12,
  clumpSorting: Math.log(1.5) / 2,

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

  // --- Pile ---
  // The mesh does not slump. Repose is whatever the contact solver produces,
  // which is the point of the whole project -- building a toppling rule into
  // the heightfield would make the measured repose angle largely the number
  // typed in below. The three sliders under it drive that comparison arm only,
  // and mean nothing while it is off.
  relaxation: false,
  reposeAngle: 32,
  // Degrees above the repose angle at which a slope starts avalanching. Stored
  // as a gap rather than an absolute static angle so static > repose is
  // structural instead of something the code silently clamps.
  avalancheGap: 3,
  slumpHalfLife: 0.1,

  // --- Contacts (M3) ---
  // Coulomb ratio at a grain-grain contact, dimensionless. Quartz on quartz is
  // around 0.5. This is an *input*; the pile's repose angle is the output, and
  // the two are not the same number -- see the help text.
  friction: 0.5,
  restitution: 0.2,

  // --- Exchange (M4) ---
  // In grain diameters, so it keeps its meaning as grain size changes. Both
  // ends of the slider are meaningful sentinels: 0 absorbs as soon as a grain
  // is covered, Infinity never absorbs at all and is the pure-DEM reference
  // run. A boolean for the latter would admit a state that contradicts this.
  activeLayerDepth: 2,
  sizeMemory: true,
  // Live now -- it is what converts absorbed volume into surface height. At M4
  // height comes from the observed underside of the resting grains instead and
  // this drops back to a bootstrap for cells that have none, with the measured
  // value shown alongside it.
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
  minClumpDiameter() {
    return values.minClumpSize * values.medianDiameter;
  },
  // How many minimum-size clumps one spawned clump could break down into. The
  // ceiling on fragmentation depth, and a useful sanity read: if it is near 1,
  // clumps turn straight to sand on their first impact.
  fragmentsPerClump() {
    const r = values.clumpSize / Math.max(values.minClumpSize, 1e-6);
    return r * r * r;
  },
  maxDiameter() {
    return values.maxGrainRatio * values.medianDiameter;
  },
  activeLayerMetres() {
    return values.activeLayerDepth * values.medianDiameter;
  },
  grainVolume() {
    const d = values.medianDiameter;
    return (Math.PI / 6) * d * d * d;
  },
  // Mean, not median. Volume cubes the size spread, so at 2x sorting the
  // average grain holds 72% more sand than the median one -- which is what any
  // "how many grains in a bucket" figure has to divide by.
  // ⚠ The size limits are part of this, and leaving them out is wrong by a
  // factor rather than by a rounding.
  //
  // A grain is `median * exp(s*Z)` for standard normal Z, so its volume is
  // `Vmedian * exp(3s*Z)` and the untruncated mean is `exp(4.5 s^2)` times the
  // median's. But Z is drawn truncated to the size limits, and volume cubes
  // the spread, so the tails the limits remove are exactly the ones carrying
  // the mean. The correction is the standard truncated-lognormal one: shift
  // the bounds by the exponent and take the ratio of normal masses.
  //
  // This read correctly for years only because the default limits, 0.1x to
  // 12x, sat at -6.6 and +7.2 sigma and truncated nothing. It was always
  // wrong for a narrowed window, which is the configuration a wide pour is
  // actually run in, and it became wrong by default when the limits moved to
  // 0.5x-4x. At 5x sorting in that window the untruncated formula claims a
  // mean of 18.4 median volumes against a true 5.9 -- a three-fold error in
  // every "how many grains is that" figure on the panel.
  meanGrainVolume() {
    const s = values.sorting;
    const Vmed = derived.grainVolume();
    if (s <= 1e-9) return Vmed;                     // uniform sand: no spread
    const a = 3 * s;
    const lo = Math.log(values.minGrainRatio) / s;
    const hi = Math.log(values.maxGrainRatio) / s;
    const mass = normalCdf(hi) - normalCdf(lo);
    if (mass <= 1e-12) return Vmed;                 // degenerate window
    const shifted = normalCdf(hi - a) - normalCdf(lo - a);
    return Vmed * Math.exp(4.5 * s * s) * (shifted / mass);
  },
  minGrainDiameter() {
    return values.minGrainRatio * values.medianDiameter;
  },
  // Rough width of the stream where it lands, ignoring drag and turbulence.
  // Enough to answer "is a clump a big fraction of the stream or a small one",
  // which is the question the pour angle exists to change.
  //
  // The aperture offset and the sideways throw are independent and point in
  // independent directions, so they combine in quadrature, not by adding.
  // Adding them overstates the width by 44% at small angles, where the aperture
  // still dominates. Quoted as an RMS diameter: the aperture contributes
  // R/sqrt(2), the RMS radius of a uniformly filled disc.
  landingSpread() {
    const g = values.gravity, h = values.nozzleHeight, v0 = values.initialSpeed;
    const t = (Math.sqrt(v0 * v0 + 2 * g * h) - v0) / g;
    // Only the scatter widens the stream. The pour angle aims it, moving where
    // the pile lands without changing how broad it is.
    //
    // The scatter is two independent gaussians in the tangent plane, so its RMS
    // magnitude is sigma*sqrt(2), not sigma -- omitting that understates the
    // width by 22%. The second step converts the tangent offset back to an
    // actual angle, which matters once the spread is wide.
    const tangent = Math.tan(Math.min(values.pourSpread, 80) * Math.PI / 180) * Math.SQRT2;
    const sinAngle = tangent / Math.sqrt(1 + tangent * tangent);
    const scatter = v0 * sinAngle * t;
    // RMS distance from the axis. A uniform disc gives R/sqrt(2); a uniform
    // ball spreads a third of its variance along the flow instead, leaving
    // R*sqrt(2/5) across it, so the same slider makes a 12% narrower stream.
    const fromAperture = values.apertureRadius *
      (values.apertureBall ? Math.sqrt(0.4) : 1 / Math.SQRT2);
    return 2 * Math.hypot(fromAperture, scatter);
  },
  // How far downrange a tilted pour puts the pile, measured from directly under
  // the nozzle.
  landingOffset() {
    const g = values.gravity, h = values.nozzleHeight, v0 = values.initialSpeed;
    const t = (Math.sqrt(v0 * v0 + 2 * g * h) - v0) / g;
    return v0 * Math.sin(Math.min(values.pourAngle, 85) * Math.PI / 180) * t;
  },
  clumpMetres() {
    return values.clumpSize * values.medianDiameter;
  },
  clumpVolume() {
    const d = derived.clumpMetres();
    return (Math.PI / 6) * d * d * d;
  },
  // How many median grains' worth of sand is in one clump. Cubic, so a 17x
  // diameter is 5000x the sand -- the relationship people consistently
  // underestimate.
  clumpGrains() {
    return derived.clumpVolume() / derived.grainVolume();
  },
  // Mean, not median, clump volume. Sizes are log-normal, so the mean sits
  // above the median by exp(4.5*sigma^2) -- the cube in the volume amplifies
  // the spread. Dividing the volume budget by the median instead would
  // overstate the clump rate by 20% at the default spread.
  meanClumpVolume() {
    const s = values.clumpSorting;
    return derived.clumpVolume() * Math.exp(4.5 * s * s);
  },
  clumpsPerSecond() {
    return (values.clumpFraction * values.flowRate) / derived.meanClumpVolume();
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
const SOON = ' Not implemented yet — dimmed controls are waiting on a later milestone.';

export const SCHEMA = [
  {
    key: 'simSpeed', group: 'Run', label: 'Simulation speed',
    units: [{ unit: 'x', scale: 1 }], min: 0.1, max: 10, log: true,
    help: 'How fast the simulation runs against the wall clock. Drop below 1x to watch grains in flight. The physics is unchanged — only the clock moves.',
  },
  {
    key: 'targetFps', group: 'Run', label: 'Frame rate cap',
    units: [{ unit: 'fps', scale: 1 }], min: 2, max: 240, log: true,
    help: 'Draw no more often than this. The simulation clock is untouched, so the sand falls at the same speed — you are only seeing fewer of its moments. Drop it to a handful of frames a second to check the pour looks the same as it does at 60: the stream should stay a continuous ribbon rather than breaking into per-frame discs, and the pile should come out the same shape. Your monitor still caps the top end.',
  },
  {
    key: 'gravity', group: 'Run', label: 'Gravity',
    units: [{ unit: 'm/s²', scale: 1 }], min: 0.62, max: 24.79, log: true,
    help: 'Surface gravity. The range runs Pluto to Jupiter, which puts the Moon at 25%, Mars at 50% and Earth at 75%.',
  },
  {
    key: 'autoRestart', group: 'Run', label: 'Auto restart when settled', type: 'bool',
    help: 'Empty the sandbox and pour again once everything has landed and no more sand can come out.',
  },
  {
    key: 'autoRestartDelay', group: 'Run', label: 'Restart after',
    units: [{ unit: 's', scale: 1 }], min: 0.5, max: 10,
    help: 'How long to wait after the sand settles before restarting. Real seconds, so simulation speed does not change it.',
  },

  {
    key: 'flowRate', group: 'Source', label: 'Flow rate',
    units: [G_PER_S, ML_PER_S], min: 8, max: 20000, log: true, logZero: true,
    help: 'How much sand leaves the nozzle per second. Measured by volume rather than grain count, so changing grain size does not change how much sand comes out. Click the unit to switch between weight and volume.',
  },
  {
    key: 'dropMass', group: 'Source', label: 'Bucket size',
    units: [{ unit: 'kg', scale: 1 }], min: 0.4, max: 40, log: true,
    help: 'How much sand one pour delivers, when Continuous pour is off. A 2.5 litre beach bucket holds about 4 kg.',
  },
  {
    key: 'continuousPour', group: 'Source', label: 'Continuous pour', type: 'bool',
    help: 'Pour without stopping, instead of delivering one bucket and finishing.',
  },
  {
    key: 'apertureRadius', group: 'Source', label: 'Aperture radius',
    units: [{ unit: 'cm', scale: 100 }], min: 0.2, max: 20, log: true,
    help: 'Radius of the opening the sand falls through. The stream off a tipped bucket lip is roughly 2 cm. The opening turns to face the pour direction, so tilting the pour does not squash it.',
  },
  {
    key: 'apertureBall', group: 'Source', label: 'Ball-shaped aperture', type: 'bool',
    help: 'Release the sand from throughout a ball the size of the aperture, instead of across a flat opening. Two things change. Sand comes out thickest down the middle and thins toward the edge, where a flat opening releases it evenly across its whole width — so the stream is centre-heavy and lands about 12% narrower for the same setting. And the source gains depth along the flow, meaning the aperture slider now sets how far the sand is smeared lengthwise as well as how wide it is, which is worth knowing before reading a sweep of it.',
  },
  {
    key: 'nozzleHeight', group: 'Source', label: 'Pour height',
    units: [{ unit: 'cm', scale: 100 }], min: 2, max: 1250, log: true,
    help: 'How high above the floor the sand is released. One of the things this project exists to measure — dropping from higher spreads the pile wider.',
  },
  {
    key: 'initialSpeed', group: 'Source', label: 'Initial speed',
    units: [{ unit: 'm/s', scale: 1 }], min: 0.04, max: 4, log: true, logZero: true,
    help: 'Speed the sand already carries as it leaves the nozzle, before gravity adds any. Pour angle tilts this away from straight down without changing how fast it is going.',
  },
  {
    key: 'pourAngle', group: 'Source', label: 'Pour angle',
    units: [{ unit: '° off vertical', scale: 1 }], min: 0, max: 60,
    help: 'Tilts the whole stream off vertical, in one fixed direction, the way tipping a bucket throws sand a particular way rather than straight down. This aims the stream and moves where the pile builds; it does not make the stream any wider — that is Pour spread. Orbit the camera to see it from the side.',
  },
  {
    key: 'pourSpread', group: 'Source', label: 'Pour spread',
    units: [{ unit: '°', scale: 1 }], min: 1, max: 45, log: true, logZero: true,
    help: 'How far individual grains scatter about the pour direction. This is what makes the stream fan out. Real sand is turbulent while it is being poured, not only while it falls — grains shed off the lip and shove past each other in the opening. At 0 the stream is a perfect cylinder that stays exactly as wide as the aperture the whole way down, which is what makes a clump look enormous: it covers the same fraction of the stream where it lands as it did at the nozzle. The Derived panel shows how wide the stream lands and how much of it a clump covers.',
  },
  {
    key: 'surgePeriod', group: 'Source', label: 'Surge period',
    units: [{ unit: 's', scale: 1 }], min: 0.06, max: 6, log: true,
    help: 'How long one choke-and-release cycle lasts. Real pours glug rather than running steady.',
  },
  {
    key: 'surgeDepth', group: 'Source', label: 'Surge depth',
    units: [{ unit: '', scale: 1 }], min: 0, max: 1,
    help: 'How uneven the flow is. Raising it changes only the variability — the average flow rate stays where you set it.',
  },

  {
    key: 'medianDiameter', group: 'Grain', label: 'Median diameter',
    units: [{ unit: 'mm', scale: 1000 }], min: 0.05, max: 5, log: true,
    help: 'The middle grain size — half the grains come out larger, half smaller. Play sand is about 0.5 mm; 1 mm is coarse sand; 5 mm is fine gravel.',
  },
  {
    key: 'sorting', group: 'Grain', label: 'Sorting (coarse:fine)',
    // Linear in log-sigma, which IS log-uniform in the displayed ratio, since
    // ratio = exp(2*sigma). Marking this `log` would double the transform and
    // land the midpoint at 1.4x instead of 2x. Bottom of the range is sigma = 0
    // exactly, so uniform sand is reachable rather than merely approached.
    units: [{ unit: '×', scale: 1 }], min: 1, max: 4,
    toDisplay: (s) => Math.exp(2 * s),
    fromDisplay: (r) => Math.log(Math.max(r, 1)) / 2,
    help: 'How mixed the grain sizes are, as the ratio of the coarse quarter to the fine quarter. Turn it fully down to 1.0x and every grain is exactly the median size. 2x is washed play sand, 4x is unsorted river gravel. Note that perfectly uniform spheres pack into regular crystalline patterns, which flattens the pile — some spread is what stops that.',
  },
  {
    key: 'minGrainRatio', group: 'Grain', label: 'Smallest grain',
    units: [{ unit: '× median', scale: 1 }], min: 0.02, max: 0.95, log: true,
    help: 'Floor on the grain size lottery. Grain sizes are unbounded below as well as above, and very fine grains behave as airborne dust — terminal velocity falls off with size, so a grain a tenth the median falls a tenth as fast and blows out of the domain instead of landing. Raise it to cut the fines, or leave it low to keep them.',
  },
  {
    key: 'maxGrainRatio', group: 'Grain', label: 'Largest grain',
    units: [{ unit: '× median', scale: 1 }], min: 1.05, max: 48, log: true,
    help: 'Ceiling on the grain size lottery, which is otherwise unbounded above. Grains are always solid particles no matter how large, so this only trims the tail — it has nothing to do with clumps. Close it and the floor up together for a tightly bounded size range, or leave both wide and let Sorting do the shaping.',
  },

  {
    key: 'clumpFraction', group: 'Clumps', label: 'Sand arriving as clumps',
    units: [{ unit: '%', scale: 100 }], min: 0.05, max: 50, log: true, logZero: true,
    help: 'How much of the poured sand arrives already stuck together. How often clumps appear follows from this and the clump size — the Derived panel shows the resulting rate.',
  },
  // Stored as a multiple of the median so the slider range is scale-free, but
  // displayed in mm, which is what you can actually picture. `dynamic` exists
  // because that conversion depends on another parameter, so it cannot be a
  // fixed scale factor. Bounds are in stored units (scale 1).
  {
    key: 'clumpSize', group: 'Clumps', label: 'Clump size',
    units: [{ unit: 'mm', scale: 1 }], min: 4, max: 64, log: true,
    dynamic: (mult) => ({ value: mult * values.medianDiameter * 1000, unit: 'mm' }),
    help: 'How big one clump is. Set as a multiple of the grain size, so it follows the median slider, and shown in mm. Volume grows as the cube of width, so a clump 17x wider than a grain holds around 5000 grains worth of sand — the Derived panel does that arithmetic for you.',
  },
  {
    key: 'clumpSorting', group: 'Clumps', label: 'Clump size spread',
    units: [{ unit: '×', scale: 1 }], min: 1.05, max: 3,
    toDisplay: (s) => Math.exp(2 * s),
    fromDisplay: (r) => Math.log(Math.max(r, 1.0001)) / 2,
    help: 'How much clumps vary in size, coarse to fine. Keep it narrow and they stay recognisably clump-sized instead of blending into the sand.',
  },
  {
    key: 'shatterSpeed', group: 'Clumps', label: 'Shatter speed',
    units: [{ unit: 'm/s', scale: 1 }], min: 0.15, max: 15, log: true, logZero: true,
    pending: true,
    help: 'Impact speed at which a clump breaks apart. Low and they burst on landing; high and they survive to sit on the pile intact.' + SOON,
  },
  {
    key: 'minClumpSize', group: 'Clumps', label: 'Smallest clump',
    units: [{ unit: '× median', scale: 1 }], min: 1.3, max: 5, log: true,
    pending: true,
    help: 'When a clump shatters, a piece bigger than this is still a clump and can shatter again later; anything smaller becomes ordinary sand and is done. This is purely what stops fragmentation recursing forever — it says nothing about grain sizes. Lower it and a clump can break down through more generations before its pieces turn to sand.' + SOON,
  },

  {
    key: 'turbAmplitude', group: 'Air', label: 'Turbulence',
    units: [{ unit: 'm/s', scale: 1 }], min: 0.01, max: 9, log: true, logZero: true,
    help: 'How strongly the air stirs the falling sand. A light outdoor breeze moves air at about 0.3 m/s. This is what broadens and flattens the pile.',
  },
  {
    key: 'eddySize', group: 'Air', label: 'Eddy size',
    units: [{ unit: 'cm', scale: 100 }], min: 0.5, max: 800, log: true,
    help: 'How large the swirls in the air are. Eddies tend to match whatever is shedding them, so a bucket makes bucket-sized ones. Small eddies scatter grains individually; large ones push the whole stream sideways.',
  },
  {
    key: 'eddyLifetime', group: 'Air', label: 'Eddy lifetime',
    units: [{ unit: 's', scale: 1 }], min: 0.07, max: 7, log: true,
    help: 'How long a swirl lasts before the pattern rearranges. Long values behave like a steady wind, short ones like flickering gusts.',
  },
  {
    key: 'fallSpeed', group: 'Air', label: 'Fall speed (median)',
    units: [{ unit: 'm/s', scale: 1 }], min: 0.5, max: 50, log: true,
    help: 'Terminal velocity of a median grain in still air, which is how air resistance is set. Bigger grains fall faster and smaller ones slower in proportion, which is why fine sand drifts and clumps punch straight through.',
  },

  {
    key: 'friction', group: 'Pile', label: 'Grain friction',
    units: [{ unit: '', scale: 1 }], min: 0.05, max: 1.5, log: true, logZero: true,
    pending: true,
    help: 'How strongly two grains resist sliding past each other, as a Coulomb ratio: the sideways force a contact can carry before it slips, divided by the force pressing the grains together. Quartz sand on quartz sand is about 0.5. This is the input the whole project turns on — the pile\'s repose angle is a result of it rather than a setting, and how the two relate is the thing being measured, so they are deliberately not the same number. Zero is reachable and worth trying: frictionless grains should spread into a puddle rather than a pile.' + SOON,
  },
  {
    key: 'restitution', group: 'Pile', label: 'Bounciness',
    units: [{ unit: '', scale: 1 }], min: 0, max: 0.9,
    pending: true,
    help: 'How much of an impact a grain keeps: 0 stops it dead, 1 would send it back up at the speed it arrived. Sand is low, around 0.1 to 0.3, but not zero — this is what produces the splash of grains scattering outward where the stream meets the pile. Pour spread cannot stand in for it, because that widens the stream in the air rather than at the point of impact.' + SOON,
  },
  {
    key: 'relaxation', group: 'Pile', label: 'Slump the surface (comparison arm)', type: 'bool',
    help: 'Let the pile surface collapse toward the repose angle on its own, instead of leaving it to the grains. Off by default and deliberately so: this project exists to find out what shape sand makes, and a surface that slumps to a dialed angle mostly hands that angle straight back. It is here so the two can be compared rather than argued about — pour the same sand twice and see whether the angle the friction produces agrees with the angle this rule was told to produce. The three sliders below drive this arm and nothing else.',
  },
  {
    key: 'reposeAngle', group: 'Pile', label: 'Repose angle',
    units: [{ unit: '°', scale: 1 }], min: 15, max: 49,
    help: 'The steepest slope the surface settles back to, when the comparison arm above is on. Dry sand rests near 32°. With the arm off this does nothing — the angle is then a readout of what friction and restitution produced, not an input.',
  },
  {
    key: 'avalancheGap', group: 'Pile', label: 'Avalanche gap',
    units: [{ unit: '° over repose', scale: 1 }], min: 0, max: 6,
    help: 'How much steeper than the repose angle a slope gets before it lets go, when the comparison arm is on. This gap is what makes avalanches happen in bursts rather than as a constant smooth trickle.',
  },
  {
    key: 'slumpHalfLife', group: 'Pile', label: 'Slump half-life',
    units: [{ unit: 's', scale: 1 }], min: 0.01, max: 1, log: true,
    help: 'How quickly a too-steep slope collapses once it starts moving, when the comparison arm is on. Measured on one pair of neighbouring cells; a real slope has six pulling at once and settles faster.',
  },

  {
    key: 'activeLayerDepth', group: 'Exchange', label: 'Active layer',
    units: [{ unit: ' grains', scale: 1 }], min: 0.2, max: 20, log: true,
    logZero: true, logInf: true,
    pending: true,
    help: 'How deep the layer of individually simulated grains goes, counted in grain diameters. Anything buried deeper is absorbed into the pile surface to keep the grain budget bounded. Both ends of this slider are special: 0 absorbs a grain as soon as it is covered, and ∞ never absorbs anything, which is pure DEM — every grain simulated forever. That end is the reference run for checking that absorption is not changing the pile shape, and it is a diagnostic rather than a usable setting, since the grain budget fills in seconds. Note the depth is a multiple of grain size while a pile is not, so no finite setting here means "never absorb" — only the ∞ detent does.' + SOON,
  },
  {
    key: 'sizeMemory', group: 'Exchange', label: 'Size memory', type: 'bool', pending: true,
    help: 'Remember which grain sizes were buried where, so a disturbed pile re-exposes the sizes that were actually there instead of average ones.' + SOON,
  },
  {
    key: 'packingFraction', group: 'Exchange', label: 'Packing fraction',
    units: [{ unit: '', scale: 1 }], min: 0.45, max: 0.74,
    help: 'How much of the buried pile is sand rather than air, which is what turns absorbed volume into surface height. Loose dry sand is about 0.55, well-shaken sand about 0.64, and 0.74 is the densest equal spheres can be stacked. This becomes a measurement rather than a setting once grains are being absorbed — the solver produces whatever local packing it produces, and a single number here cannot be right everywhere.',
  },

  {
    key: 'grainScale', group: 'Render', label: 'Grain scale',
    units: [{ unit: '×', scale: 1 }], min: 0.5, max: 2, log: true,
    help: 'Draws grains larger or smaller than they really are. Purely visual — it changes nothing in the simulation.',
  },
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
  if (values.clumpSize <= values.minClumpSize) {
    // A clump that spawns smaller than the smallest allowed clump is a
    // contradiction: it would be born already too small to exist.
    values.minClumpSize = values.clumpSize / 1.5;
  }
  if (values.minGrainRatio >= values.maxGrainRatio) {
    // The size window must stay open, and must contain the median -- otherwise
    // "median diameter" would name a size that can never be drawn.
    values.minGrainRatio = Math.min(values.maxGrainRatio / 2, 0.95);
  }
}
