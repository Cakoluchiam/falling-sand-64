# Conventions

How code in this repo is written. **Design decisions live in `PLAN.md`** — read that before changing behaviour, especially the entries marked ⚠, which are reversals of earlier designs and record why the earlier version was wrong.

## Constraints that are not negotiable

- **Zero dependencies, no build step.** ES modules served as-is. There is no bundler, no transpiler, no `package.json`. The shipped artifact is a static site that runs on any modern browser with nothing installed.
- **Relative paths everywhere.** No absolute `/src/...`, so the site works served from a subdirectory.
- **`src/hexfield.js`, `src/particles.js`, `src/exchange.js` stay pure** over flat typed arrays, with no DOM or WebGL references. That is what keeps a later move into a Web Worker a contained change; the renderer reads those arrays and nothing else touches them.

## Running it

```bash
node tools/serve.js          # dev server on :8000
node test/run.mjs            # all suites (~2.5 min, clumps dominates)
node test/run.mjs pour       # one suite
```

The server exists because the sim allocates over a `SharedArrayBuffer`, which browsers only permit on a cross-origin-isolated page — that needs COOP/COEP headers, which `python -m http.server` does not send. Note `python3` is not a command on the dev machine; it is `python` / `py`.

Verification uses the in-app browser (`preview_start` → `navigate` → `read_console_messages`) rather than Playwright, which is not installed and would break the zero-dependency constraint. `globalThis.sim` and `globalThis.params` are exposed for driving the simulation from the console; `globalThis.syncPanel()` repaints the panel after changing a parameter directly.

Note `requestAnimationFrame` does not fire while the Browser pane is hidden, so the loop must be driven manually (`sim.simulate(1/60)`) for headless checks.

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

Conserve volume by construction rather than by tolerance: carry fractional remainders as debt (`Nozzle.debt`) instead of rounding counts, and take the last share of a split as a subtraction rather than trusting shares to sum.

## Comments

Explain *why*, especially where the obvious implementation is wrong — those comments are load-bearing, since the obvious implementation is what a future reader will otherwise restore. Do not narrate what the code plainly does.
