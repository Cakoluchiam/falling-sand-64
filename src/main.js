// Bootstrap and the frame loop.

import { CONFIG, values, derived, SCHEMA, domainBounds, enforceConstraints, SAND_PARTICLE_DENSITY } from './params.js';
import { Rng } from './rng.js';
import { Noise, CurlField } from './noise.js';
import { SHARED_MEMORY_AVAILABLE } from './shared.js';
import { Particles, PHASE_RESTING } from './particles.js';
import { Nozzle } from './source.js';
import { HexField, relaxRateFromHalfLife } from './hexfield.js';
import { initGL, GLUnavailableError, resizeToDisplay } from './gl/context.js';
import { OrbitCamera } from './gl/camera.js';
import { GrainRenderer, INSTANCE_FLOATS } from './gl/grains.js';
import { TerrainRenderer } from './gl/terrain.js';
import { buildPanel } from './ui.js';

const DEG = Math.PI / 180;

const LIGHT_DIR = (() => {
  const d = new Float32Array([0.45, 0.82, 0.35]);
  const len = Math.hypot(d[0], d[1], d[2]);
  d[0] /= len; d[1] /= len; d[2] /= len;
  return d;
})();

class App {
  constructor(canvas, hud) {
    this.canvas = canvas;
    this.hud = hud;
    this.gl = initGL(canvas);

    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.09, 0.10, 0.12, 1);

    const span = Math.max(CONFIG.domainWidth, CONFIG.domainDepth);
    this.camera = new OrbitCamera(canvas, {
      distance: span * 0.6,
      target: [0, span * 0.08, 0],
      sceneSpan: span,
      // The scene is centimetres across and a grain is a millimetre, so zoom
      // has to reach close enough to inspect one -- about 5 mm out -- while
      // still pulling back far enough to frame a 12.5 m pour.
      minDistance: span * 0.008,
      maxDistance: span * 40,
    });

    this.particles = new Particles(CONFIG.grainCapacity);
    this.field = new HexField(CONFIG.gridW, CONFIG.gridH, CONFIG.cellSpacing);
    this.renderer = new GrainRenderer(gl, CONFIG.grainCapacity);
    this.terrain = new TerrainRenderer(gl, this.field);
    this._surf = new Float64Array(4);

    this.rng = new Rng(values.seed);
    this.noise = new Noise(values.seed);
    this.curl = new CurlField(this.noise, CONFIG.turbNodeBudget, CONFIG.turbMaxRes);
    this.nozzle = new Nozzle(this.rng, this.noise);

    this._tmp = new Float64Array(3);
    this.paused = false;
    this.stepOnce = false;
    this.lastSubsteps = 0;
    this.restarts = 0;
    this.reset();

    this.frameTimes = [];
    this.lastHud = 0;
    this.lastTime = performance.now();
    this.frame = this.frame.bind(this);
  }

  reset() {
    this.rng.reseed(values.seed);
    this.noise.reseed(values.seed);
    this.particles.reset();
    this.field.reset();
    this.nozzle.reset();
    this.simTime = 0;
    this.accumulator = 0;
    this.lostVolume = 0;
    this.frameIndex = 0;
    this.idleSeconds = 0;
    this.curl.builtAt = -Infinity;
  }

  // Reserved for the contact solver (M3). The accumulator around it is live now
  // so the timing machinery -- including degrading to slow motion under
  // overload rather than freezing -- is verified before the expensive thing
  // goes inside it.
  //
  // The relaxation arm runs here rather than per frame because its step is an
  // explicit one: at the short end of the half-life slider a 1/60 s step
  // overshoots and rings, where 1/240 s does not.
  substep(h) {
    if (!values.relaxation) return;
    this.field.relax(
      h,
      Math.tan(values.reposeAngle * DEG),
      Math.tan(derived.staticAngle() * DEG),
      relaxRateFromHalfLife(values.slumpHalfLife),
    );
  }

  // Nothing left to watch: everything has landed and no more sand can come out,
  // either because the store is full or the pour has finished.
  isSettled() {
    if (values.flowRate <= 0) return false;   // an empty nozzle is not a finished run
    const P = this.particles;
    for (let k = 0; k < P.count; k++) {
      if (P.phase[P.live[k]] !== PHASE_RESTING) return false;
    }
    const storeFull = P.count >= P.capacity;
    const pourDone = !values.continuousPour && this.nozzle.emittedVolume >= derived.dropVolume();
    return (storeFull || pourDone) && P.count > 0;
  }

  simulate(rawDt) {
    const h = 1 / CONFIG.substepHz;
    this.field.packingFraction = values.packingFraction;
    this.accumulator += rawDt;
    const start = performance.now();
    let steps = 0;
    while (this.accumulator >= h && steps < CONFIG.maxSubstepsPerFrame) {
      this.substep(h);
      this.accumulator -= h;
      steps++;
      if (performance.now() - start > CONFIG.frameBudgetMs) break;
    }
    // Shed any backlog past the cap. Without this an overloaded frame queues
    // work that makes the next frame worse, and the tab spirals instead of
    // simply running slow.
    const maxBacklog = h * CONFIG.maxSubstepsPerFrame;
    if (this.accumulator > maxBacklog) this.accumulator = maxBacklog;
    this.lastSubsteps = steps;

    // The turbulence field follows the pour height, since that slider spans
    // three orders of magnitude and a fixed box would be far too coarse at the
    // short end.
    const { min, size } = domainBounds(values.nozzleHeight * 1.15);
    if (this.curl.setBounds(min, size)) this.curl.builtAt = -Infinity;
    if (values.turbAmplitude > 0) {
      if (this.frameIndex % CONFIG.turbRebuildFrames === 0 || this.curl.builtAt === -Infinity) {
        this.curl.rebuild(this.simTime * derived.turbTimeScale(), values.eddySize);
      }
    }

    // Simulation speed stretches the frame, but a 10x frame integrated in one
    // step would move a grain several centimetres between samples. Subdivide so
    // running fast does not also mean running wrong.
    let remaining = rawDt * values.simSpeed;
    let iters = 0;
    while (remaining > 1e-9 && iters < CONFIG.maxBallisticIters) {
      const step = Math.min(remaining, CONFIG.maxBallisticStep);
      this.simTime += step;
      // Order matters: existing grains advance first, then the nozzle adds new
      // ones already backdated to step end. Emitting first would integrate the
      // new grains a second time and double-count their fall.
      this.integrateBallistic(step);
      this.nozzle.step(step, this.simTime, this.particles, values);
      remaining -= step;
      iters++;
    }
    this.frameIndex++;
  }

  integrateBallistic(dt) {
    const P = this.particles;
    const { px, py, pz, vx, vy, vz, radius, vol, phase, live } = P;
    const field = this.field;
    const g = values.gravity;
    const dragCoef = derived.dragCoef();
    const amp = values.turbAmplitude;
    const useTurb = amp > 0;
    const curl = this.curl;
    const tmp = this._tmp;
    const halfW = CONFIG.domainWidth / 2;
    const halfD = CONFIG.domainDepth / 2;
    let lost = 0;

    // Backwards, because free() swap-removes from the tail of `live`.
    for (let k = P.count - 1; k >= 0; k--) {
      const i = live[k];
      if (phase[i] === PHASE_RESTING) continue;

      let fx = 0, fy = 0, fz = 0;
      if (useTurb) {
        curl.sample(px[i], py[i], pz[i], tmp);
        fx = tmp[0] * amp; fy = tmp[1] * amp; fz = tmp[2] * amp;
      }

      // Drag is solved implicitly so it cannot go unstable for fine grains,
      // where the coefficient over radius gets large. The 1/r is what makes
      // size matter: fine grains are strongly deflected by the turbulence,
      // clumps punch through it.
      const kr = dragCoef / radius[i];
      const denom = 1 / (1 + dt * kr);
      const nvx = (vx[i] + dt * kr * fx) * denom;
      const nvy = (vy[i] + dt * (kr * fy - g)) * denom;
      const nvz = (vz[i] + dt * kr * fz) * denom;

      vx[i] = nvx; vy[i] = nvy; vz[i] = nvz;
      px[i] += nvx * dt;
      py[i] += nvy * dt;
      pz[i] += nvz * dt;

      const r = radius[i];
      // The surface is sampled rather than assumed flat, which is the only
      // thing standing on the heightfield until M3 builds the contact solver.
      // Grains still stop dead where they meet it and will visibly
      // interpenetrate each other; that is the motivation for M3, not a bug.
      const surf = field.heightAt(px[i], pz[i]);
      if (py[i] - r <= surf) {
        py[i] = surf + r;
        vx[i] = 0; vy[i] = 0; vz[i] = 0;
        phase[i] = PHASE_RESTING;
        continue;
      }
      if (px[i] < -halfW || px[i] > halfW || pz[i] < -halfD || pz[i] > halfD) {
        lost += vol[i];
        P.free(i);
      }
    }
    this.lostVolume += lost;
  }

  fillInstances() {
    const P = this.particles;
    const buf = this.renderer.staging;
    const scale = values.grainScale;
    let o = 0;
    for (let k = 0; k < P.count; k++) {
      const i = P.live[k];
      buf[o] = P.px[i];
      buf[o + 1] = P.py[i];
      buf[o + 2] = P.pz[i];
      buf[o + 3] = P.radius[i] * scale;
      buf[o + 4] = P.colorSeed[i];
      o += INSTANCE_FLOATS;
    }
    return P.count;
  }

  render() {
    const gl = this.gl;
    resizeToDisplay(gl, this.canvas);
    this.camera.update(this.canvas.width / this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.terrain.draw(this.camera, { lightDir: LIGHT_DIR });
    const n = this.fillInstances();
    this.renderer.draw(this.camera, n, {
      lightDir: LIGHT_DIR,
      medianRadius: values.medianDiameter * 0.5,
    });
  }

  peakHeight() {
    const h = this.field.height;
    let m = 0;
    for (let c = 0; c < h.length; c++) if (h[c] > m) m = h[c];
    return m;
  }

  // Absorption is M4, so nothing puts sand into the heightfield during a normal
  // run and the terrain stays flat. This drops a cone into it directly so the
  // surface, its shading and the relaxation arm can be looked at now. It is a
  // console tool, not a feature: the volume it invents was never poured, so it
  // deliberately shows up in the audit as a discrepancy.
  seedCone(peak = 0.06, radius = 0.08) {
    const f = this.field;
    for (let r = 0; r < f.H; r++) {
      for (let q = 0; q < f.W; q++) {
        const dx = f.cellX(q, r), dz = f.cellZ(r);
        const d = Math.hypot(dx, dz);
        if (d >= radius) continue;
        const height = peak * (1 - d / radius);
        f.deposit(dx, dz, height * f.cellArea * f.packingFraction);
      }
    }
    return f.volume;
  }

  updateHud(now) {
    if (now - this.lastHud < 250) return;
    this.lastHud = now;

    const ft = this.frameTimes;
    const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
    const fps = avg > 0 ? 1000 / avg : 0;

    const P = this.particles;
    const phases = P.countByPhase();
    const grainVol = P.totalVolume();
    const field = this.field;
    const emitted = this.nozzle.emittedVolume;
    // The audit that matters. Note there is no packing-fraction term: the
    // heightfield's `solidVolume` is solid grain volume, the same currency the
    // grains are counted in, which is exactly why elevation and volume were
    // decoupled. Absorption, emission and fragmentation each get a chance to
    // break this later.
    const residual = emitted - (grainVol + field.volume + field.escapedVolume + this.lostVolume);
    const rel = emitted > 0 ? Math.abs(residual) / emitted : 0;
    const grams = emitted * SAND_PARTICLE_DENSITY * 1000;

    const lines = [
      `${fps.toFixed(0)} fps   ${avg.toFixed(1)} ms   sim ${values.simSpeed.toFixed(2)}x`,
      `grains ${P.count} / ${P.capacity}   flight ${phases.ballistic}   resting ${phases.resting}`,
      `poured ${grams < 1000 ? grams.toFixed(1) + ' g' : (grams / 1000).toFixed(2) + ' kg'}` +
        `   sim clock ${this.simTime.toFixed(2)} s`,
      `pile peak ${(this.peakHeight() * 100).toFixed(2)} cm` +
        `   buried ${(field.volume * SAND_PARTICLE_DENSITY * 1000).toFixed(1)} g` +
        (values.relaxation ? '   SLUMPING' : ''),
      `volume audit ${residual.toExponential(2)}  (${(rel * 100).toFixed(4)}%)`,
    ];
    if (values.autoRestart && this.idleSeconds > 0) {
      lines.push(`settled - restarting in ${Math.max(0, values.autoRestartDelay - this.idleSeconds).toFixed(1)} s`);
    }
    if (this.restarts > 0) lines.push(`restarts ${this.restarts}`);
    lines.push(this.paused ? 'PAUSED  (space run, s step, r reset)' : '(space pause, s step, r reset)');
    this.hud.textContent = lines.join('\n');
  }

  frame(now) {
    const raw = now - this.lastTime;
    this.lastTime = now;
    this.frameTimes.push(raw);
    if (this.frameTimes.length > 30) this.frameTimes.shift();

    if (!this.paused || this.stepOnce) {
      // Cap the step so a backgrounded tab does not resume with a huge jump.
      const dt = Math.min(raw / 1000, 0.1);
      this.simulate(dt);
      this.stepOnce = false;

      if (values.autoRestart) {
        // Idle time is measured on the wall clock, not the simulation clock, so
        // "restart after 2 seconds" means 2 seconds of watching regardless of
        // the speed multiplier.
        if (this.isSettled()) {
          this.idleSeconds += dt;
          if (this.idleSeconds >= values.autoRestartDelay) {
            this.reset();
            this.restarts++;
          }
        } else {
          this.idleSeconds = 0;
        }
      }
    }
    this.render();
    this.updateHud(now);
    requestAnimationFrame(this.frame);
  }
}

function fail(message, detail) {
  const el = document.getElementById('error');
  el.hidden = false;
  el.querySelector('h1').textContent = message;
  el.querySelector('p').textContent = detail || '';
  document.getElementById('canvas').hidden = true;
}

function main() {
  const canvas = document.getElementById('canvas');
  const hud = document.getElementById('hud');

  let app;
  try {
    app = new App(canvas, hud);
  } catch (err) {
    if (err instanceof GLUnavailableError) {
      fail('WebGL2 unavailable', err.message);
    } else {
      fail('Failed to start', String((err && err.message) || err));
      console.error(err);
    }
    return;
  }

  const sync = buildPanel(document.getElementById('panel'), SCHEMA, values, () => {
    enforceConstraints();
    sync();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Space') { e.preventDefault(); app.paused = !app.paused; }
    else if (e.key === 's') { app.paused = true; app.stepOnce = true; }
    else if (e.key === 'r') { app.reset(); }
  });

  document.getElementById('reset').addEventListener('click', () => app.reset());

  // Handy from the console for the verification pass, and for scripting a
  // parameter sweep without dragging sliders.
  globalThis.sim = app;
  globalThis.params = values;
  globalThis.field = app.field;
  globalThis.syncPanel = sync;

  console.log(
    `crossOriginIsolated=${!!globalThis.crossOriginIsolated}, ` +
    `SharedArrayBuffer=${SHARED_MEMORY_AVAILABLE}, ` +
    `grain arrays backed by ${app.particles.buffer.constructor.name}`,
  );

  requestAnimationFrame(app.frame);
}

main();
