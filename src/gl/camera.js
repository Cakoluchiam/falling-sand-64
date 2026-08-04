// Orbit camera: drag to rotate, wheel to zoom, right-drag (or shift-drag) to pan.
//
// Exposes eye/right/up as world-space vectors because the grain impostors need
// them to build camera-facing quads, not just a view matrix.

import * as mat4 from './mat4.js';

const DEG = Math.PI / 180;

export class OrbitCamera {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.azimuth = opts.azimuth ?? 35 * DEG;
    this.elevation = opts.elevation ?? 22 * DEG;
    this.distance = opts.distance ?? 8;
    this.target = Float32Array.from(opts.target ?? [0, 1, 0]);
    this.fov = opts.fov ?? 50 * DEG;
    this.near = opts.near ?? 0.02;
    this.far = opts.far ?? 200;
    this.minDistance = opts.minDistance ?? 0.3;
    this.maxDistance = opts.maxDistance ?? 80;

    this.eye = new Float32Array(3);
    this.right = new Float32Array(3);
    this.up = new Float32Array(3);
    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();

    this._drag = null;
    this._attach();
    this.update(1);
  }

  _attach() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        pan: e.button === 2 || e.shiftKey,
      };
    });

    c.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;

      if (d.pan) {
        // Pan in the camera plane, scaled by distance so the grab point tracks
        // the cursor at roughly any zoom level.
        const k = this.distance * 0.0016;
        for (let i = 0; i < 3; i++) {
          this.target[i] += -this.right[i] * dx * k + this.up[i] * dy * k;
        }
      } else {
        this.azimuth -= dx * 0.006;
        this.elevation += dy * 0.006;
        const lim = 89 * DEG;
        this.elevation = Math.max(-lim, Math.min(lim, this.elevation));
      }
    });

    const end = (e) => {
      if (this._drag && this._drag.id === e.pointerId) this._drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance *= Math.exp(e.deltaY * 0.0012);
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance));
    }, { passive: false });
  }

  update(aspect) {
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.eye[0] = this.target[0] + this.distance * ce * sa;
    this.eye[1] = this.target[1] + this.distance * se;
    this.eye[2] = this.target[2] + this.distance * ce * ca;

    mat4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    mat4.perspective(this.proj, this.fov, aspect, this.near, this.far);
    mat4.multiply(this.viewProj, this.proj, this.view);

    // Camera basis falls out of the view matrix rows.
    this.right[0] = this.view[0]; this.right[1] = this.view[4]; this.right[2] = this.view[8];
    this.up[0] = this.view[1]; this.up[1] = this.view[5]; this.up[2] = this.view[9];
  }
}
