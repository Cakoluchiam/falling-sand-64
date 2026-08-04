// WebGL2 setup and the handful of helpers the two renderers share.

export class GLUnavailableError extends Error {}

export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: true,
    depth: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new GLUnavailableError(
      'WebGL2 is not available in this browser. The simulator needs it for ' +
      'instanced rendering and float textures.',
    );
  }
  return gl;
}

export function createProgram(gl, vsSrc, fsSrc, label = 'program') {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error(`${label} vertex shader:\n${gl.getShaderInfoLog(vs)}`);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error(`${label} fragment shader:\n${gl.getShaderInfoLog(fs)}`);
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`${label} link:\n${gl.getProgramInfoLog(prog)}`);
  }
  // The program holds references once linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

// Collect uniform locations by name into a plain object.
export function uniforms(gl, prog, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

// Resize the drawing buffer to match the element's CSS size and device pixel
// ratio. Returns true when the size changed.
export function resizeToDisplay(gl, canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  gl.viewport(0, 0, w, h);
  return true;
}
