# Conventions

How code in this repo is written. **Design decisions live in `PLAN.md`** — read that before changing behaviour, especially the entries marked ⚠, which are reversals of earlier designs and record why the earlier version was wrong.

## Constraints that are not negotiable

- **Zero dependencies, no build step.** ES modules served as-is. There is no bundler, no transpiler, no `package.json`. The shipped artifact is a static site that runs on any modern browser with nothing installed.
- **Relative paths everywhere.** No absolute `/src/...`, so the site works served from a subdirectory.
- **`src/hexfield.js`, `src/particles.js`, `src/ballistic.js`, `src/exchange.js` stay pure** over flat typed arrays, with no DOM or WebGL references. That is what keeps a later move into a Web Worker a contained change; the renderer reads those arrays and nothing else touches them. Both stores allocate through `src/shared.js`, which feature-detects `SharedArrayBuffer` once and falls back rather than failing.
- **One resolution rule for the heightfield.** `HexField.sampleTriangle` is used by surface sampling *and* by deposition, so the height a grain stands on and the cells its volume lands in can never disagree. Anything that needs to turn a world position into cells goes through it.
- **The renderer must reproduce the field's geometry, not approximate it.** `gl/terrain.js` carries the same six-neighbour tables and the same plane fit as `hexfield.js`, and `buildTerrainIndices` must produce exactly the triangulation `sampleTriangle` returns — `test/hexfield.mjs` checks every triangle against its own centroid. Drift here shows up as grains resting at angles the shading contradicts, which reads as a physics bug and is not one.

## Running it

```bash
node tools/serve.js          # dev server on :8000
node test/run.mjs            # all suites (~3 min, clumps dominates)
node test/run.mjs pour       # one suite
```

The server exists because the sim allocates over a `SharedArrayBuffer`, which browsers only permit on a cross-origin-isolated page — that needs COOP/COEP headers, which `python -m http.server` does not send. Note `python3` is not a command on the dev machine; it is `python` / `py`.

Verification uses the in-app browser (`preview_start` → `navigate` → `read_console_messages`) rather than Playwright, which is not installed and would break the zero-dependency constraint. `globalThis.sim`, `globalThis.params` and `globalThis.field` are exposed for driving the simulation from the console; `globalThis.syncPanel()` repaints the panel after changing a parameter directly. `sim.seedCone()` drops a cone into the heightfield, which until M4 is the only way to see the terrain do anything — it invents volume that was never poured, so it shows up in the audit on purpose.

Note `requestAnimationFrame` does not fire while the Browser pane is hidden, so the loop must be driven manually (`sim.simulate(1/60)`) for headless checks. Screenshots need the pane displayed too, but `sim.render()` followed by `gl.readPixels` works regardless — projecting a known world point with `camera.viewProj` and comparing it against the rendered silhouette is a cheap end-to-end check of the whole upload-and-displace chain.

## Parameters

Three separate things in `src/params.js`, and conflating them is the usual mistake:

- **`values`** — what the simulation reads. **Always SI**: metres, seconds, m³ of *solid* grain volume.
- **`SCHEMA`** — how the UI presents each key: label, range, log scale, help text, and the unit to display in. Bounds are given in display units and converted to SI once at load, so switching a displayed unit never moves the slider curve.
- **`derived`** — quantities computed from `values` that the sim wants but the panel must not show as knobs, because they are consequences rather than inputs.

Add a parameter by adding to `values` and `SCHEMA`; the panel builds itself. Every entry needs `help` text — the panel is the only instrument this project has, and a control nobody can interpret is worse than no control.

Prefer a parameter people can look up over a raw gain. `dragK` became *fall speed* (terminal velocity of a median grain), `relaxRate` became *slump half-life* in seconds, `cohesion` became *shatter speed*. Where a parameter is a multiple of something else — clump size, size limits — store the multiple so it keeps its meaning when the base moves, and display the absolute value.

## Numerical practice

This project measures emergent behaviour, so an approximation that biases a distribution is a bug even when nothing crashes. Three that were caught late and are worth pattern-matching against:

- **Rejection sampling collapses when the acceptance region is small.** Truncating a distribution redraws forever, and any bail-out after N attempts piles a spike against the boundary. Invert the CDF between the bounds instead — see `Rng.truncatedGaussian`.
- **Resampling out of a rejected tail must preserve what made the draw special**, or a size knob silently becomes a frequency knob.
- **Mean is not median.** Volume cubes a size spread, so the mean grain holds `exp(4.5σ²)` times the median's. Any "how many of these fit in that" figure divides by the mean.
- **Two pieces of code describing the same trajectory must be the same code, not merely agree on paper.** The nozzle's sub-frame backdate *is* one step of `stepBallistic`, drag and turbulence included, because ribbons tile seamlessly only when "emitted a step old" and "emitted fresh, then stepped" are the same composition. Accuracy is not the point; identity is. Two separate rounds of visible banding came from a backdate formula that resembled the integrator without being it — and the second only surfaced once the first was fixed. This is why `src/ballistic.js` is its own module: a test has to be able to reach it.
- **When you fix a defect, measure both directions.** The first banding fix was verified by searching for *holes* in the stream. It closed them, and left a 21% ripple of *dense* bands sitting exactly where the holes had been, which went unnoticed until the user saw it. A one-sided metric confirms the thing you fixed and hides its mirror image.
- **Vary the discretisation to tell an artifact from the physics.** Turbulence leaves a ~7% ripple in the stream that survives a 16-fold change in step size, so it is real bunching in a divergence-free field, not a numerical seam. Anything that scales with the step is yours.
- **A per-neighbour threshold on a lattice is a per-direction threshold.** Testing each of six neighbours against the same limit constrains six directions, not all of them, and the lattice ends up in the answer. Gate on the isotropic quantity — the fitted gradient — and transport by the real one, the actual height difference. Doing only the first lets sand be pushed at a neighbour that is not lower, and the plane fit cannot see the checkerboard it creates. `HexField.relax` carries both halves and the numbers each version scored.

Conserve volume by construction rather than by tolerance: carry fractional remainders as debt (`Nozzle.debt`) instead of rounding counts, take the last share of a split as a subtraction rather than trusting shares to sum, and never let a transfer be clamped at apply time — cap it at the source, or the receiver keeps what the sender could not pay.

Running totals (`HexField.volume`) exist so the audit does not sweep the grid every frame; each has a `sumVolume()`-style recomputation and a test that they agree. Expect ~1e-12 relative drift between them after millions of updates and set tolerances accordingly — a real leak is O(1), so there is no need to chase float noise.

Height is `Float32` because it is uploaded verbatim as an `R32F` texture; volumes and log-volume moments are `Float64` because they are the audit's accumulators.

## Comments

Explain *why*, especially where the obvious implementation is wrong — those comments are load-bearing, since the obvious implementation is what a future reader will otherwise restore. Do not narrate what the code plainly does.
