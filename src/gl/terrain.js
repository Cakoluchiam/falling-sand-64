// The pile surface: a static triangular lattice displaced by a height texture.
//
// There is no per-frame CPU mesh work. The topology never changes, so the index
// buffer is uploaded once; heights live in an R32F texture refreshed over the
// dirty sub-rect only, and the vertex shader reads its own cell plus the six
// neighbours to place the vertex and compute an analytic normal.
//
// The normal comes from the same six-neighbour plane fit HexField.cellNormal
// uses, so the surface a grain rests on and the surface you can see are the
// same surface. If those two ever drift apart, grains sit at angles the shading
// contradicts, and it looks like a physics bug rather than a shading one.

import { createProgram, uniforms } from './context.js';

const SQRT3_2 = Math.sqrt(3) / 2;

// The lattice triangulation, as flat vertex indices. Must agree with
// HexField.sampleTriangle: the rhombus between rows r and r+1 is cut along the
// diagonal that is a lattice edge, which in odd-r terms shifts by one column
// between row parities. test/hexfield.mjs checks every triangle here against
// what sampleTriangle returns for its centroid.
export function buildTerrainIndices(W, H) {
  const tris = [];
  for (let r = 0; r < H - 1; r++) {
    const shift = r & 1;
    const row = r * W, next = (r + 1) * W;
    for (let q = 0; q < W; q++) {
      // Point-up: two cells in row r, one in row r + 1.
      if (q + 1 < W && q + shift < W) tris.push(row + q, row + q + 1, next + q + shift);
      // Point-down: one cell in row r, two in row r + 1.
      if (q - 1 + shift >= 0 && q + shift < W) tris.push(row + q, next + q - 1 + shift, next + q + shift);
    }
  }
  return new Uint32Array(tris);
}

const VS = `#version 300 es
precision highp float;

uniform sampler2D uHeight;
uniform mat4 uViewProj;
uniform vec2 uOrigin;
uniform float uSpacing;
uniform ivec2 uGrid;

out vec3 vNormal;
out vec3 vWorld;
out float vHeight;

const float SQRT3_2 = 0.8660254037844386;

// Same six directions, same order, as the CPU tables.
const ivec2 NB_EVEN[6] = ivec2[6](
  ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(-1, -1), ivec2(0, -1), ivec2(-1, 1));
const ivec2 NB_ODD[6] = ivec2[6](
  ivec2(1, 0), ivec2(-1, 0), ivec2(1, 1), ivec2(0, -1), ivec2(1, -1), ivec2(0, 1));
const vec2 NB_D[6] = vec2[6](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.5, SQRT3_2),
  vec2(-0.5, -SQRT3_2), vec2(0.5, -SQRT3_2), vec2(-0.5, SQRT3_2));

void main() {
  int id = gl_VertexID;
  int q = id % uGrid.x;
  int r = id / uGrid.x;
  float h = texelFetch(uHeight, ivec2(q, r), 0).r;

  vec3 world = vec3(
    uOrigin.x + uSpacing * (float(q) + 0.5 * float(r & 1)),
    h,
    uOrigin.y + uSpacing * SQRT3_2 * float(r));

  // Least-squares plane fit over the six neighbours. Because they sit 60
  // degrees apart the normal equations collapse to sum(dh * d) / (3 s).
  // Neighbours off the edge read back as this cell, which flattens the normal
  // at the rim instead of inventing a cliff there.
  vec2 g = vec2(0.0);
  for (int k = 0; k < 6; k++) {
    ivec2 nb = ((r & 1) == 1) ? NB_ODD[k] : NB_EVEN[k];
    ivec2 nc = ivec2(q, r) + nb;
    float hn = h;
    if (nc.x >= 0 && nc.x < uGrid.x && nc.y >= 0 && nc.y < uGrid.y) {
      hn = texelFetch(uHeight, nc, 0).r;
    }
    g += (hn - h) * NB_D[k];
  }
  g /= 3.0 * uSpacing;

  vNormal = normalize(vec3(-g.x, 1.0, -g.y));
  vWorld = world;
  vHeight = h;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

const FS = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
in float vHeight;

uniform vec3 uEye;
uniform vec3 uLightDir;

out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  // The camera can orbit under the floor, and a heightfield has no back face
  // worth its own shading rule.
  if (dot(n, uEye - vWorld) < 0.0) n = -n;

  // Slightly deeper and less saturated than a loose grain, so the boundary
  // between the packed surface and the grains sitting on it stays readable.
  vec3 base = vec3(0.60, 0.51, 0.38);

  float diff = max(dot(n, uLightDir), 0.0);
  float hemi = n.y * 0.5 + 0.5;
  vec3 amb = mix(vec3(0.17, 0.16, 0.15), vec3(0.36, 0.39, 0.44), hemi);

  fragColor = vec4(base * (amb + diff * 0.80), 1.0);
}`;

export class TerrainRenderer {
  constructor(gl, field) {
    this.gl = gl;
    this.field = field;
    this.prog = createProgram(gl, VS, FS, 'terrain');
    this.u = uniforms(gl, this.prog, [
      'uHeight', 'uViewProj', 'uOrigin', 'uSpacing', 'uGrid', 'uEye', 'uLightDir',
    ]);

    const indices = buildTerrainIndices(field.W, field.H);
    this.indexCount = indices.length;

    // No vertex attributes at all: gl_VertexID under drawElements is the cell
    // index, and everything else is derived from it.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, field.W, field.H);
    // NEAREST because the shader uses texelFetch, and R32F is only linearly
    // filterable behind an extension.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Push whatever changed since the last call. Uploading the dirty sub-rect out
  // of the middle of a full-width array is what UNPACK_ROW_LENGTH is for --
  // without it the only options are a full-grid upload every frame or a staging
  // copy, and the field touches a handful of cells per absorption.
  sync() {
    const gl = this.gl, f = this.field;
    if (!f.hasDirty()) return;
    const d = f.dirty;
    const w = d.maxQ - d.minQ + 1;
    const h = d.maxR - d.minR + 1;

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, f.W);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, d.minQ);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, d.minR);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, d.minQ, d.minR, w, h, gl.RED, gl.FLOAT, f.height);
    // Pixel store state is global, so leave it as the other renderers expect.
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    f.clearDirty();
  }

  draw(camera, { lightDir }) {
    const gl = this.gl, f = this.field;
    this.sync();

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uHeight, 0);
    gl.uniformMatrix4fv(this.u.uViewProj, false, camera.viewProj);
    gl.uniform2f(this.u.uOrigin, f.originX, f.originZ);
    gl.uniform1f(this.u.uSpacing, f.s);
    gl.uniform2i(this.u.uGrid, f.W, f.H);
    gl.uniform3fv(this.u.uEye, camera.eye);
    gl.uniform3fv(this.u.uLightDir, lightDir);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
