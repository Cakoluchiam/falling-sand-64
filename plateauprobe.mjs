import { CONFIG, values, derived, domainBounds } from './src/params.js';
import { Rng } from './src/rng.js';
import { Noise, CurlField } from './src/noise.js';
import { Particles, PHASE_BALLISTIC } from './src/particles.js';
import { Nozzle } from './src/source.js';
import { stepBallistic } from './src/ballistic.js';
import { ContactSolver } from './src/contact.js';
import { ExchangeSolver } from './src/exchange.js';
import { HexField } from './src/hexfield.js';
const CAP = 60000;
values.seed = 1;
values.flowRate = 6 / (2650 * 1000);
values.nozzleHeight = 0.05; values.pourAngle = 0; values.pourSpread = 4;
values.turbAmplitude = 0.05; values.clumpFraction = 0; values.activeLayerDepth = 2;
const field = new HexField(CONFIG.gridW, CONFIG.gridH, CONFIG.cellSpacing);
const P = new Particles(CAP), solver = new ContactSolver(CAP), ex = new ExchangeSolver(CAP);
const rng = new Rng(1), noise = new Noise(1);
const curl = new CurlField(noise, CONFIG.turbNodeBudget, CONFIG.turbMaxRes);
const nozzle = new Nozzle(rng, noise);
const tmp = new Float64Array(3), surf = new Float64Array(4);
const hz = CONFIG.substepHz, h = 1 / hz, per = Math.round(hz / 60);
const db = domainBounds(values.nozzleHeight * 1.15); curl.setBounds(db.min, db.size);
let simTime = 0, lost = 0, eaten = 0, prev = 0;
console.log('   t   live   d(live)/5s  absorbed  emitted  buried_mm3  terrain_mm  reach_mm  audit');
for (let f = 0; f < 60 * 90; f++) {
  simTime += 1 / 60;
  if (f % CONFIG.turbRebuildFrames === 0) curl.rebuild(simTime * derived.turbTimeScale(), values.eddySize);
  const r = stepBallistic(P, field, 1 / 60, { gravity: values.gravity, dragCoef: derived.dragCoef(),
    turbAmplitude: values.turbAmplitude, curl, halfW: CONFIG.domainWidth / 2,
    halfD: CONFIG.domainDepth / 2, handoffDepth: CONFIG.handoffDepth, tmp, surf });
  lost += r.lost; eaten += r.eaten;
  nozzle.step(1 / 60, simTime, P, values, curl);
  for (let k = 0; k < per; k++) solver.step(P, field, h, {
    gravity: values.gravity, friction: values.friction, restitution: values.restitution,
    iterations: CONFIG.contactIterations, sleepSpeed: CONFIG.sleepSpeed,
    sleepSubsteps: CONFIG.sleepSubsteps, stirSpeed: CONFIG.sleepSpeed * CONFIG.stirFactor,
    stillFraction: CONFIG.stillFraction, wakeDepth: CONFIG.wakeDepthFactor * values.gravity * h * h,
    baseCell: values.medianDiameter });
  const hash = solver.hash;
  hash.rebuild(P, values.medianDiameter, (i) => P.phase[i] !== PHASE_BALLISTIC);
  hash.buildAdjacency(P);
  ex.absorb(P, field, hash, { activeLayerMetres: derived.activeLayerMetres(),
    seedWindow: CONFIG.absorbSeedWindow * values.medianDiameter,
    quiescenceMode: CONFIG.quiescenceMode,
    quiescenceSubsteps: Math.ceil(CONFIG.quiescenceSeconds * hz),
    minContacts: CONFIG.minAbsorbContacts,
    engulfTolerance: CONFIG.engulfTolerance * values.medianDiameter,
    maxRise: CONFIG.maxSurfaceRise * values.medianDiameter });
  ex.emit(P, field, { activeLayerMetres: derived.activeLayerMetres(), rng,
    sizeMemory: values.sizeMemory,
    minGrainVolume: derived.volumeOfDiameter(derived.minGrainDiameter()),
    maxEmitVolume: derived.volumeOfDiameter(derived.maxEmitDiameter()) });
  if (f % 300 === 299) {
    let terr = 0, reach = 0;
    for (let c = 0; c < field.n; c++) {
      if (field.height[c] > terr) terr = field.height[c];
      if (field.solidVolume[c] > 0) {
        const q = c % field.W, rr = (c / field.W) | 0;
        const d = Math.hypot(field.cellX(q, rr), field.cellZ(rr));
        if (d > reach) reach = d;
      }
    }
    const em = nozzle.emittedVolume;
    const resid = em - (P.totalVolume() + field.volume + field.escapedVolume + lost + eaten);
    console.log(simTime.toFixed(0).padStart(4) + String(P.count).padStart(7) +
      String(P.count - prev).padStart(12) + String(ex.absorbedCount).padStart(10) +
      String(ex.emittedCount).padStart(9) + (field.volume * 1e9).toFixed(0).padStart(12) +
      (terr * 1000).toFixed(2).padStart(12) + (reach * 1000).toFixed(0).padStart(10) +
      (em > 0 ? Math.abs(resid / em) : 0).toExponential(1).padStart(9));
    prev = P.count;
  }
}
