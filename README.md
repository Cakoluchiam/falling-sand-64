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

Early. Nothing is implemented yet beyond the project scaffolding.

## Running it

There is no build step and there are no dependencies — just ES modules and
WebGL2. Serve the repository root over HTTP and open `index.html`:

```
python3 -m http.server
```

Then visit http://localhost:8000. A browser with WebGL2 support is required.

## Layout

```
index.html      entry point
src/            simulation and rendering modules
src/gl/         WebGL2 renderer
```
