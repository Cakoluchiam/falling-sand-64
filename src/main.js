// Bootstrap and the frame loop.

import { CONFIG, values, SCHEMA, domainBounds, enforceConstraints } from './params.js';
import { Rng } from './rng.js';
import { Noise, CurlField } from './noise.js';
import { Particles, PHASE_RESTING, SHARED_MEMORY_AVAILABLE } from './particles.js';
import { Nozzle } from './source.js';
import { initGL, GLUnavailableError, resizeToDisplay } from './gl/context.js';
import { OrbitCamera } from './gl/camera.js';
import { GrainRenderer, INSTANCE_FLOATS } from './gl/grains.js';
import { buildPanel } from './ui.js';

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

    this.camera = new OrbitCamera(canvas, {
      distance: Math.max(CONFIG.domainWidth, CONFIG.domainDepth) * 0.55,
      target: [0, 1.2, 0],
      far: Math.max(CONFIG.domainWidth, CONFIG.domainDepth) * 6,
    });

    this.particles = new Particles(CONFIG.grainCapacity);
    this.renderer = new GrainRenderer(gl, CONFIG.grainCapacity);

    this.rng = new Rng(values.seed);
    this.noise = new Noise(values.seed);
    const { min, size } = domainBounds();
    this.curl = new CurlField(this.noise, CONFIG.turbGridRes, min, size);
    this.nozzle = new Nozzle(this.rng, this.noise, CONFIG.gravity);

    this._tmp = new Float64Array(3);
    this.paused = false;
    this.stepOnce = false;
    this.lastSubsteps = 0;
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
    this.nozzle.reset();
    this.simTime = 0;
    this.accumulator = 0;
    this.lostVolume = 0;
    this.frameIndex = 0;
    this.curl.builtAt = -Infinity;
  }

  // Reserved for the contact solver (M3). The accumulator around it is live now
  // so the timing machinery -- including degrading to slow motion under
  // overload rather than freezing -- is verified before the expensive thing
  // goes inside it.
  substep(_h) {}

  simulate(dt) {
    const h = 1 / CONFIG.substepHz;
    this.accumulator += dt;
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

    this.simTime += dt;

    if (values.turbAmplitude > 0) {
      const stale = this.frameIndex % CONFIG.turbRebuildFrames === 0;
      if (stale || this.curl.builtAt === -Infinity) {
        this.curl.rebuild(this.simTime * values.turbTimeScale, values.turbLengthScale);
      }
    }

    // Order matters: existing grains advance first, then the nozzle adds new
    // ones already backdated to frame end. Emitting first would integrate the
    // new grains a second time and double-count their fall.
    this.integrateBallistic(dt);
    this.nozzle.step(dt, this.simTime, this.particles, values);
    this.frameIndex++;
  }

  integrateBallistic(dt) {
    const P = this.particles;
    const { px, py, pz, vx, vy, vz, radius, vol, phase, live } = P;
    const g = CONFIG.gravity;
    const dragK = values.dragK;
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

      // Drag is solved implicitly so it cannot go unstable for small grains,
      // where dragK/radius gets large. The 1/r is what makes size matter: fine
      // grains are strongly deflected by the turbulence, clumps punch through.
      const kr = dragK / radius[i];
      const denom = 1 / (1 + dt * kr);
      const nvx = (vx[i] + dt * kr * fx) * denom;
      const nvy = (vy[i] + dt * (kr * fy - g)) * denom;
      const nvz = (vz[i] + dt * kr * fz) * denom;

      vx[i] = nvx; vy[i] = nvy; vz[i] = nvz;
      px[i] += nvx * dt;
      py[i] += nvy * dt;
      pz[i] += nvz * dt;

      const r = radius[i];
      if (py[i] - r <= 0) {
        // M1 has no contact solver, so grains stop dead on the floor and will
        // visibly interpenetrate. That is the motivation for M3, not a bug.
        py[i] = r;
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
    const n = this.fillInstances();
    this.renderer.draw(this.camera, n, {
      lightDir: LIGHT_DIR,
      medianRadius: values.medianDiameter * 0.5,
    });
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
    const emitted = this.nozzle.emittedVolume;
    // The audit that matters. In M1 only two paths move mass, so this should be
    // ~0; absorption, emission and fragmentation will each get a chance to
    // break it later.
    const residual = emitted - (grainVol + this.lostVolume);
    const rel = emitted > 0 ? Math.abs(residual) / emitted : 0;

    this.hud.textContent = [
      `${fps.toFixed(0)} fps   ${avg.toFixed(1)} ms   substeps ${this.lastSubsteps}`,
      `grains ${P.count} / ${P.capacity}   flight ${phases.ballistic}   resting ${phases.resting}`,
      `volume  emitted ${emitted.toExponential(3)}  live ${grainVol.toExponential(3)}  lost ${this.lostVolume.toExponential(3)}`,
      `audit residual ${residual.toExponential(2)}  (${(rel * 100).toFixed(4)}%)`,
      `crossOriginIsolated ${!!globalThis.crossOriginIsolated}   SharedArrayBuffer ${SHARED_MEMORY_AVAILABLE}`,
      this.paused ? 'PAUSED  (space run, s step, r reset)' : '(space pause, s step, r reset)',
    ].join('\n');
  }

  frame(now) {
    const raw = now - this.lastTime;
    this.lastTime = now;
    this.frameTimes.push(raw);
    if (this.frameTimes.length > 30) this.frameTimes.shift();

    if (!this.paused || this.stepOnce) {
      // Cap the step so a backgrounded tab does not resume with a huge jump.
      this.simulate(Math.min(raw / 1000, 0.1));
      this.stepOnce = false;
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
      fail('Failed to start', String(err && err.message || err));
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
  globalThis.syncPanel = sync;

  console.log(
    `crossOriginIsolated=${!!globalThis.crossOriginIsolated}, ` +
    `SharedArrayBuffer=${SHARED_MEMORY_AVAILABLE}, ` +
    `grain arrays backed by ${app.particles.buffer.constructor.name}`,
  );

  requestAnimationFrame(app.frame);
}

main();
