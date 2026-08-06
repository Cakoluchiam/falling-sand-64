// Screen-space sphere impostors.
//
// One instanced camera-facing quad per grain, with the sphere solved
// analytically in the fragment shader. Grains stay perfectly round at any zoom
// for the cost of a quad, and per-instance radius is free -- it is just another
// instance attribute -- so polydispersity and clumps cost the renderer nothing.
//
// Writing gl_FragDepth is what lets grains interpenetrate the terrain correctly
// once there is terrain (M2). It costs early-Z rejection, which is the accepted
// trade for correct intersections.

import { createProgram, uniforms } from './context.js';

// Floats per instance: x, y, z, radius, seed.
export const INSTANCE_FLOATS = 5;

const VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 iCenter;
layout(location = 2) in float iRadius;
layout(location = 3) in float iSeed;

uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uEye;

out vec3 vCenter;
out float vRadius;
out float vSeed;
out vec3 vWorld;

void main() {
  vCenter = iCenter;
  vRadius = iRadius;
  vSeed = iSeed;

  // A sphere's silhouette is the cone of rays from the eye tangent to it. Slice
  // that cone perpendicular to its own axis at the centre and you get a circle
  // of radius r * d / sqrt(d^2 - r^2) whose projection *is* the silhouette, so
  // a square of that half-size bounds it exactly.
  vec3 toEye = uEye - iCenter;
  float d = length(toEye);
  float scale = (d > iRadius * 1.001)
    ? iRadius * d * inversesqrt(d * d - iRadius * iRadius)
    : iRadius * 32.0;  // eye inside the sphere: just cover everything

  // The quad has to be square to the *cone's* axis, not to the camera. Built on
  // uCamRight/uCamUp it lies parallel to the image plane instead, which is a
  // slanted cut through the cone -- short in the radial direction by 1/cos(t)
  // for a grain t off the optical axis. Off-axis spheres project to ellipses
  // stretched radially by that same 1/cos(t), which is correct perspective and
  // was never the bug; the bug was that the quad grew by none of it, so the
  // ellipse had its sides clipped off exactly where it needed them. Around 20%
  // at the corner of a 50 degree field.
  vec3 axis = toEye / max(d, 1e-9);
  vec3 right = cross(uCamUp, axis);
  float rl = length(right);
  // Looking straight along the camera's up axis at a grain. uCamRight is
  // perpendicular to uCamUp, so it is perpendicular to the cone axis too.
  right = (rl > 1e-6) ? right / rl : uCamRight;
  vec3 up = cross(axis, right);

  vec3 world = iCenter + (aCorner.x * right + aCorner.y * up) * scale;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const FS = `#version 300 es
precision highp float;

in vec3 vCenter;
in float vRadius;
in float vSeed;
in vec3 vWorld;

uniform mat4 uViewProj;
uniform vec3 uEye;
uniform vec3 uLightDir;
uniform float uMedianRadius;

out vec4 fragColor;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

void main() {
  vec3 rd = normalize(vWorld - uEye);
  vec3 oc = uEye - vCenter;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - vRadius * vRadius;
  float h = b * b - c;
  if (h < 0.0) discard;                 // ray misses: outside the silhouette
  h = sqrt(h);
  float t = -b - h;
  if (t < 0.0) t = -b + h;              // eye inside the sphere
  if (t < 0.0) discard;

  vec3 hit = uEye + rd * t;
  vec3 n = (hit - vCenter) / vRadius;

  vec4 clip = uViewProj * vec4(hit, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;

  // Per-instance variation gives the stream visual texture; tying part of the
  // value shift to radius makes the size distribution legible at a glance.
  float v = 0.80 + 0.34 * hash11(vSeed);
  float warm = 0.93 + 0.14 * hash11(vSeed + 7.0);
  float sizeShift = clamp((vRadius / uMedianRadius - 1.0) * 0.10, -0.20, 0.26);
  vec3 base = vec3(0.86, 0.73, 0.50) * v * vec3(warm, 1.0, 2.0 - warm);
  base *= (1.0 + sizeShift);

  float diff = max(dot(n, uLightDir), 0.0);
  float hemi = n.y * 0.5 + 0.5;
  vec3 amb = mix(vec3(0.20, 0.18, 0.17), vec3(0.42, 0.46, 0.52), hemi);

  fragColor = vec4(base * (amb + diff * 0.85), 1.0);
}`;

export class GrainRenderer {
  constructor(gl, capacity) {
    this.gl = gl;
    this.capacity = capacity;
    this.prog = createProgram(gl, VS, FS, 'grains');
    this.u = uniforms(gl, this.prog, [
      'uViewProj', 'uCamRight', 'uCamUp', 'uEye', 'uLightDir', 'uMedianRadius',
    ]);

    // Filled by the caller each frame, then uploaded in one go.
    this.staging = new Float32Array(capacity * INSTANCE_FLOATS);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.staging.byteLength, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);
  }

  // `count` instances are read from the head of `staging`.
  draw(camera, count, { lightDir, medianRadius }) {
    if (count <= 0) return;
    const gl = this.gl;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.staging, 0, count * INSTANCE_FLOATS);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.uViewProj, false, camera.viewProj);
    gl.uniform3fv(this.u.uCamRight, camera.right);
    gl.uniform3fv(this.u.uCamUp, camera.up);
    gl.uniform3fv(this.u.uEye, camera.eye);
    gl.uniform3fv(this.u.uLightDir, lightDir);
    gl.uniform1f(this.u.uMedianRadius, medianRadius);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }
}
