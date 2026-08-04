# falling-sand-64

A 3D falling sand simulator that runs in the browser.

The goal is to find out **what parameters determine the shape of a pile** when a
mass of sand is dropped through a mildly turbulent flow — drop height, flow rate,
grain size distribution, turbulence, and the angle of repose. Multi-material
interaction in the spirit of the classic falling-sand games is a later direction,
not part of the first version.

It is deliberately not a voxel toy. The pile is a continuous surface on a
hexagonal lattice, and the grains are round.

## Status

Early. The first milestone is in: sand is emitted from a nozzle, falls under
gravity and drag through a divergence-free turbulence field, and lands on a flat
floor. There is no contact solver yet, so grains stop where they land and
visibly interpenetrate — that is the next milestone, not a bug.

Not yet implemented: the hex heightfield and its terrain rendering, the contact
solver, the grain/heightfield mass exchange, and breakable clumps.

## Running it

There is no build step and there are no dependencies — just ES modules and
WebGL2. Serve the repository root and open <http://localhost:8000>:

```
node tools/serve.js
```

A browser with WebGL2 support is required.

The bundled server exists because the simulation allocates its grain arrays over
a `SharedArrayBuffer`, which browsers only permit on a cross-origin-isolated
page. That needs `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
response headers, which `python -m http.server` does not send. Any static server
that sets those two headers works just as well. Without them the page still
runs — it falls back to a plain `ArrayBuffer`, at no cost on the main thread.

## Controls

Drag to orbit, wheel to zoom, right-drag or shift-drag to pan. Space pauses,
`s` single-steps, `r` reseeds and restarts. Every parameter is on the panel,
because the panel is the instrument for the question above.

## Layout

```
index.html      entry point
src/            simulation modules (pure, over flat typed arrays)
src/gl/         WebGL2 renderer
tools/serve.js  static dev server that sets COOP/COEP
```
