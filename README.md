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

Early. Sand is emitted from a nozzle, falls under gravity and drag through a divergence-free turbulence field, and lands on the pile surface. That surface is a real hex heightfield now, sampled for collision and drawn as a smooth displaced lattice — but nothing fills it yet, so it starts flat and stays flat during a normal run. There is no contact solver either, so grains stop dead where they land and visibly interpenetrate. Both are the next milestones, not bugs.

The surface can slump toward a repose angle, but that is off by default and deliberately so. The point of the project is to find out what shape sand makes; a surface that collapses to a dialed angle mostly hands that angle back. The toggle is there so the two can be compared rather than argued about.

Not yet implemented: the contact solver, the grain/heightfield mass exchange, and breakable clumps.

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
because the panel is the instrument for the question above. Hover any control
for a description; the ones whose milestone is not built yet are dimmed.

## Tests

```
node test/run.mjs            all suites
node test/run.mjs pour       one suite
```

Needs Node 22.7 or newer: the sources are ES modules in `.js` files with no
`package.json` to declare it, so Node has to recognise the module syntax on its
own. The runner checks and says so rather than failing obscurely.

Every suite runs on Node 22 and 24 on push and on every pull request, as a
matrix rather than one job — `clumps` takes minutes while the rest take seconds,
so fanning out puts the wall clock at the slowest suite instead of their sum. A
single `all-tests` job aggregates the matrix into one check. Branch protection
is not enabled, and the gate exists so that turning it on later is a matter of
requiring that one name rather than every matrix job — which would otherwise
need re-editing each time the matrix changed. Adding a suite means adding it to
`SUITES` in `test/run.mjs` and to the matrix list; nothing else.

No framework and no dependencies. The suites are less about catching crashes
than about pinning down behaviour that is invisible from the code — that the
stream's spacing does not change with frame rate, that the size cap does not
quietly change how often clumps appear, that the surface a grain stands on has
no seams in it, that the pile the slump rule builds is round rather than
hexagonal, that volume is conserved through every path that moves it. Several
exist because a reasonable-looking implementation had already failed them.

`clumps` takes about two and a half minutes. Clumps are rare, so its tolerances
only hold when pooled across many seeded runs.

## Layout

```
index.html      entry point
src/            simulation modules (pure, over flat typed arrays)
src/gl/         WebGL2 renderer
test/           behavioural suites, run with test/run.mjs
tools/serve.js  static dev server that sets COOP/COEP
PLAN.md         design record: decisions, and why the alternatives were wrong
CLAUDE.md       conventions for working in this repo
```
