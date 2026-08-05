# 3D Falling Sand Simulator — v1 Implementation Plan

> ## Plan version 4 — 2026-08-05
>
> **This tracked file is canonical.** Edit it here. Plan files under `~/.claude/plans/` are created *per planning session*, not per project — entering plan mode a second time mints a new empty file rather than reloading the last one, which is why edits made after an approval never reach the Plan tab. A planning session may copy this file into whatever file it owns, for display only; that copy is downstream.
>
> Bump the version on any substantive edit, so two copies can be compared at a glance.
>
> **Changed since version 1** (the text approved at the end of the original planning session):
> 1. **M1 is built and committed** (`1187090` … `b5cb594`). Its section is kept as written; where the build diverged, the commits are the record.
> 2. **The heightfield no longer slumps.** Relaxation became an off-by-default comparison arm; repose angle became a measured output and **friction + restitution** became the inputs. Adds M6 Experiment 0, and changes what the `activeLayerDepth` sweep measures.
> 3. **Burial is a neighbourhood property, not a column height** — with two rejected formulations recorded before the one that works (direction-coverage testing).
> 4. **Absorption may never engulf a live grain** — a new invariant checked against `grainBottom`.
> 5. **Dynamic pour direction** (polar picker, swirl) tagged for M6.
> 6. *(version 3)* Plan and test suites moved into the repository; `CLAUDE.md` added.
> 7. *(version 4)* **M2 is built.** The relaxation arm's flux rule changed: the threshold is on the **surface gradient**, not on each neighbour's height difference. Two earlier rules are recorded below with the measurements that rejected them.
> 8. *(version 4)* **Clumps no longer draw on the grain budget** — a carried-over M1 bug where every clump punched a hole in the stream. The two are metered separately and nothing may come to rest inside a lump. See the Source decisions.
>
> **⛔ M1 and M2 complete. M3 and later remain documented for continuity, not approved.**

## Where things stand

**Done:** M1 and M2. This plan, the five test suites, and `CLAUDE.md` are tracked in the repo rather than living in session-scoped temp directories.

**M2 as built.** `src/hexfield.js` and `src/gl/terrain.js`, wired into `main.js`. The field is a ledger by default: odd-r storage, one `sampleTriangle` shared by surface sampling and deposition, volume-exact deposit and debit with per-cell size memory, dirty-rect tracking, and six-neighbour normals that the vertex shader reproduces exactly. Grains now land on the sampled surface rather than a hardcoded `y = 0` plane, which is the only thing standing on the field until M3. `src/shared.js` was split out of `particles.js` so both stores allocate over the same feature-detected buffer.

Measured: sampling continuous in height and normal across every cell and triangle boundary; the rendered mesh proven identical to the collision mesh, triangle by triangle, by centroid lookup; volume exact through deposit, debit and relaxation; 73k terrain triangles cost nothing next to 200k grain impostors (1.9 ms for both); the apex of a seeded cone renders to the same pixel the CPU projects it to, which is the end-to-end proof that the `SharedArrayBuffer`-backed height array uploads correctly as `R32F`.

**Next: M3**, the contact solver.

**Outstanding from M1**, neither blocking: the visual checks (grains round at any zoom, stream continuous by eye, sustained 60 fps) need the Browser pane displayed, because `requestAnimationFrame` does not fire while it is hidden — everything verified so far came from driving the loop manually. The dev server is started with `node tools/serve.js` and does not persist across sessions.

## The test suites are the enforcement mechanism

`node test/run.mjs`. They matter more than the prose in this file, because a future session that reintroduces a reversed decision gets a failing test rather than a paragraph it may not have read. Several exist *because* a plausible-looking implementation had already failed them.

What they pin down, none of it obvious from the code: the volume audit closing across every mass path; stream spacing being frame-rate independent, which is the only proof the sub-frame backdating works; clump frequency staying flat as the size cap moves; no grain ever being flagged a clump at any sorting; uniform sand being reachable at sorting 0; size limits holding for tight windows where rejection sampling would have spiked against a boundary; pour angle aiming the stream while pour spread widens it; and the clump ledger self-correcting rather than arriving Poisson.

`clumps` runs ~2.5 minutes on purpose. Clump arrivals are rare, so its tolerances only hold pooled across many seeded runs; a single run carries roughly 14% noise and would fail spuriously. Suites are ordered cheapest-first, and `node test/run.mjs pour` runs one.

## Context

**The goal.** A browser-based 3D granular simulator whose purpose is to establish **what parameters determine the shape of a pile** when a mass of sand is dropped through a mildly turbulent flow — drop height, flow rate, grain size distribution, turbulence, angle of repose. Multi-material interaction is a later direction, not part of v1. It is deliberately **not** a voxel toy: the pile is a continuous surface on a hex lattice and the grains are round spheres.

**Why this plan exists.** The design was settled over a long discussion in a previous remote session, dumped into an uncommitted `HANDOFF.md`, and then reviewed in this session — a review that recovered user feedback the remote client had dropped, and found two design reversals plus two outright bugs. `HANDOFF.md` is **not being committed** and its worktree is being deleted; it was scaffolding to restart the conversation. This plan file is therefore the surviving design record as well as the execution plan, and records each settled decision with a compressed reason so a future session doesn't re-litigate them or reintroduce the bugs.

**Repo state.** `cakoluchiam/falling-sand-64`. `master` (`e275e0b`) contains only `README.md` and `.gitignore`. Two worktrees currently sit on `da71523`, an **orphan root commit** with no shared history with `master`, holding `HANDOFF.md` and `src/rng.js`. Both are being removed. Nothing is implemented.

**Deployment target.** Dev on Windows 11 Pro; the shipped artifact is a **static site that runs on any modern browser with nothing installed** — no build step, no dependencies, no server-side logic.

---

## Settled design decisions

Recorded with reasons, because several are counter-intuitive and were argued to.

### Model

- **Two-phase representation.** Pile bulk is a continuous **hex heightfield**; the top few grain-layers are full physics particles. — *Bounds the contact-solver population at the surface layer regardless of pour duration, and the continuum is also the physical model of consolidated bulk, not merely an optimization.*
- **Hex lattice, not square.** — *A square heightfield bakes 4-fold anisotropy into the toppling rule and yields square pyramids, corrupting the exact thing being measured. Hex is 6-fold and much weaker, and its cell centres already form a triangular lattice that triangulates into a smooth surface.*
- **Ballistic vs contact phases.** In-flight grains get gravity + drag + curl noise at frame-rate dt and are **excluded from the hash and contact solver entirely**. — *The expensive part is the hash and pair resolution, not force integration.*
- **Flight is integrated, never precomputed.** — *Turbulent footprint spread is path-integrated; solving a parabola from one noise sample at spawn turns the measured result into a tuned constant.*
- **No subsurface deformation in v1.** Buried bulk is inert. — *Dry sand compacts and fails in shear rather than holding a bulge. Deferred, not discarded.*
- **⚠ The heightfield does not slump. Repose is measured, not dialed (user's challenge, adopted — reverses the relaxation design).** The heightfield is a pure ledger of stable buried material: it gains height on absorption, loses it on emission, and never moves sand sideways. — *Building a repose rule into the mesh makes the measured repose angle largely the number that was typed in, which is circular given the project exists to find what determines pile shape. The plan already suspected this — the M6 sweep was written to detect "a tuned fiction rather than a model of the same physics the solver runs" — and the honest response to suspecting it is not to build it.*

  Two independent reasons the mesh has nothing to slump:
  - *Avalanching is a surface phenomenon.* The failing, flowing layer in dry granular material runs roughly five to ten grain diameters deep; below that nothing moves. That is the same region the active layer covers, so the contact solver already owns the entire zone where slumping happens.
  - *The quiescence rule already filters it.* Absorption only fires on grains that are buried **and** at rest, and a grain on an unstable slope is not at rest. So the heightfield only ever records geometry the solver has already declared stable. Relaxation would be the mesh second-guessing a verdict the physics already returned.

  **Emission is the release valve**, and its trigger drops the slope test: emit on **active-layer thickness alone**, never on an angle. If a surface is too steep its grains slide, the layer thins, emission refills, and those slide too — self-regulating, with no angle constant anywhere in the mass path.

  Consequences, all accepted: repose angle becomes a **readout**; **friction and restitution** become the inputs; avalanches cost real grains rather than a few flops per cell; and `activeLayerDepth` stops being a free performance knob, since setting it shallower than avalanching actually goes would freeze material mid-slide into the mesh. Its default rises from 2 grain diameters to ~8.

- **Relaxation is still built, but off by default, as a comparison arm (user's choice).** — *Having both makes "emergent repose vs dialed repose" a runtime toggle instead of an argument, which is the same reasoning that made `activeLayerDepth` a slider rather than a second build.* When on, it is the symmetric gather-then-apply flux described in M2 and it must move `solidVolume` alongside height. When off — the default — `reposeAngle`, `avalancheGap` and `slumpHalfLife` are inert inputs to that arm only, and the panel shows the measured angle instead.
- **No measurement instrumentation in v1.** — *The sliders are the instrument for the stated goal.*

### Grains

- **Polydisperse, log-normal by volume**, parameterised as sediment actually is: **median diameter** + **sorting** (log-σ). Flow rate is **volumetric**, not per-count. — *Monodisperse spheres crystallise into regular packings, which depresses the repose angle and puts lattice ordering on the flanks. Load-bearing, not cosmetic.*
- **Truncated at `maxGrainDiameter`, with a clump-preserving rejection rule.** An over-cap draw is resampled **uniformly in diameter on `[clumpThreshold, maxGrainDiameter]`**, *not* from the full distribution. — *Resampling from the full distribution returns a sub-threshold grain ~99% of the time, so the cap would silently reduce clump **frequency**, not just clump size — a size knob with a hidden rarity side-effect, which makes a parameter sweep uninterpretable.* Keep `maxGrainDiameter` a **separate slider** from `clumpThreshold` so size and rarity sweep independently; constrain the UI so `max > threshold`.
- **A clump is one large grain from the tail of the same distribution**, not a cluster of small grains. — *Intra-clump contacts become implicit and free; and a coherent lump genuinely has a lower area-to-mass ratio, so the `1/r` drag term makes it punch through turbulence correctly. This deleted two earlier mechanisms: occupancy-gated mid-flight contacts, and sub-disc burst spawning.*
- **Fragmentation is recursive and impulse-gated**, breaking when `impulse > cohesion * V^(2/3)` (cross-sectional scaling, so large clumps aren't absurdly strong). — *Gives "packed floor shatters what soft sand wouldn't" for free.*
- **The split is impulse-scaled: gentle shears, hard shatters.** With overload ratio `x = impulse / (cohesion * V^(2/3))`: low `x` → 2-way strongly asymmetric split (one small chunk shears off a large surviving aggregate); high `x` → many near-equal children. — *Recursion alone does not produce "the top chunk rolls off and breaks apart more when it hits the next grain": near-equal splits dissolve a lump into a rosette in one event and progressive breakup never appears. `cohesion` decides **whether** it breaks; excess impulse decides **how badly**.*

### Exchange — the two mass paths

This is where the subtlest bugs live. Four decisions here are corrections to earlier drafts.

- **Absorption is load-bearing, not optional.** — *Without it resting grains never retire and the grain cap fills within seconds of a steady pour.*
- **Eligibility is geometric burial on center+radius**, not center and not grain-count depth. — *Prevents a large grain whose crown still pokes through from being absorbed and visibly popping, and self-corrects for polydispersity since big grains take proportionally longer to bury.*
- **⚠ The burial reference surface is the per-cell grain-column top, NOT the heightfield height:** `grainTop(x,z) − (py + radius) > activeLayerDepth`. — *This was a bug. Overburden is **other grains**; resting grains sit above the heightfield because surface contact projects them out of it, so a terrain-relative test is negative for every correctly-collided grain — it never fires, the active layer grows unbounded, and the heightfield never rises. Deadlock.*
- **⚠ Aggregates absorb by exactly the same rule — no exception.** *Reverses an earlier "never absorb an intact aggregate" decision.* — *That rule was wrong physically: a clump under overburden genuinely does consolidate and lose identity, which is the continuum's job to model. Keeping it as a permanent rigid sphere is the artifact — a hard convex body contacts neighbours at a handful of points instead of jamming against many, so it under-supports load and under-transmits friction, and it defeats the heightfield's role in presenting a smooth surface, leaving later sand to drape into a ring around it. It was also wrong numerically: at high `cohesion` clumps survive landing, bury, and never retire, so the live-body count grows linearly with pour duration.* A clump's identity survives **statistically** in the cell's size memory. A clump resting *on* the pile isn't buried, so it still isn't absorbed and stays visible as a lump.
- **⚠ Absorption additionally requires quiescence — the barrier layer.** — *Restricts absorption to genuinely quiescent regions, which is exactly where a continuum is a valid description of a granular assembly, and keeps a resting shell between the continuum and the awake layer so absorbing a grain never pulls support out from under something currently moving.* Composes with the burial test — burial and quiescence must **both** hold. Two things to get right:
  - **"Inactive" is defined by rest duration, reusing the existing `restTimer`** rather than inventing a second notion of stillness. A grain counts as inactive once it has rested for `quiescenceSubsteps`. Note the sleep mechanism already encodes exactly this — a grain is marked resting after K substeps below the speed and correction thresholds — so `quiescenceSubsteps` is either that same K or a separate, stricter threshold layered on the same timer.
  - **Both eligibility modes are implemented and tunable; neither is a fallback for the other.** *Contact-quiescence:* every grain this one contacts is inactive. *Self-duration:* this grain has itself been inactive for `quiescenceSubsteps`. Expose a mode toggle so they can be used alone, AND-ed (strictest), or OR-ed. They fail in opposite directions — contact-quiescence can starve under continuous impact, self-duration can absorb a still load-bearing grain, and OR-ing gives a release valve — so which combination is right is an empirical question settled at M4, not a guess made now. Cost either way is one bit per grain computed in the contact pass that already enumerates pairs.
- **⚠ Burial is a neighbourhood property, not a column height (user's point, for M4).** The test as written measures the grain-column top in the same cell, which is a purely vertical measure and misreads slopes. On a 32° flank the column above a grain includes material that is laterally offset and resting on the slope, not on that grain — so a grain sitting exposed on a steep face can read as buried and vanish in plain sight, which is exactly the pop the center+radius rule was introduced to prevent. The converse happens too: a genuinely interior grain under a falling surface reads as exposed and never retires.

  The orientation-free measure is contact topology. Sum the vectors from a grain to each grain it touches: for an interior grain those roughly cancel, while a grain with a free surface has them all pointing away from it. That needs no notion of "up" and works on any slope — the same trick as estimating a surface normal from neighbour positions. The solver already enumerates the pairs, so the cost is an accumulate in a loop that is already running. Keep a cheap depth test as a prefilter, but let the topology decide.

  **Test directions for coverage; do not sum contacts (user's follow-up, twice).** Two rejected attempts, recorded because both look right until pushed:

  1. *Unweighted mean of contact directions.* Breaks under polydispersity, because a neighbour's share of your sky depends on its size relative to yours — a 17 mm clump covers nearly half a 1 mm grain's sky while that grain covers a sliver of the clump's. A large body among small grains collects contacts from every direction and reads interior too readily; a small grain wedged between three large ones has three contacts, fails to cancel, and reads exposed while completely enclosed.
  2. *Weighting each contact by the cap it subtends* (`w = 1 − cos(asin(r_j/(r_i+r_j)))`). Fixes the count bias but not the geometry: **subtended caps overlap, and a sum double-counts the overlap.** The sharp case is a grain resting on a large body — the body covers the lower hemisphere, while the small grains beside it sit on that same body and so appear near the *horizon*, with half of each cap inside the large one. Working it through, such a grain scores about 0.17 where a genuinely interior grain scores ~0, so the interior/surface threshold becomes size-dependent, which is precisely what the weighting was introduced to remove.

  **The measure that works** is coverage of a fixed set of directions. Take an icosahedral set (12, or 32 for finer resolution) and for each direction `d` ask whether any neighbour's cap contains it: `dot(d, n̂_j) > cos(θ_j)`, one dot product per direction-neighbour pair. Then the **uncovered fraction** is the burial score, and the **mean of the uncovered directions** is which way the free surface lies. Overlap-correct by construction — a direction is covered or it is not, and being covered twice does not count twice — and size-agnostic for the same reason. The terrain folds in trivially: it covers every direction with a downward component.

  Cost is roughly 12 × 20 dot products per grain, but this runs only on grains that already passed the cheap prefilters (resting, quiescent, deep enough), and absorption need run at most once per frame rather than once per substep.

  *Expected interaction with the engulfment invariant below:* a large clump cannot be absorbed while small neighbours sit beside it, because the height rise over its footprint would swallow them. The clump waits while terrain fills in around it and joins once the rise is marginal. Bottom-up and self-consistent, delayed in proportion to clump size — a lingering clump is correct behaviour, not a stuck one.

- **⚠ Absorption must never engulf a live grain (user's point, for M4).** An ordering hazard with no cheap workaround once it bites. A clump can be quiescent and buried while the grains *beneath* it are not — their own neighbours, on the side away from the clump, may still be moving. Absorbing the clump deposits its volume and raises the terrain across a footprint scaled by its radius, which puts those still-live grains **inside** the terrain, where surface contact fires them back out. A visible pop, produced by the one mechanism in the design that is supposed to be invisible.

  The invariant: **after any absorption, no live grain may lie below the terrain surface.** Enforce it directly rather than reasoning about orderings — before depositing, compare the resulting height against the per-cell `grainBottom` across the whole splat footprint, and defer the absorption if it would cross. Absorption then becomes strictly bottom-up: the terrain only ever advances upward through contiguous absorbed material and never past something still live. That subsumes the clump case without special-casing clumps, and it is one comparison per affected cell against an array the hash rebuild is already filling.

- **⚠ Elevation and volume are decoupled. Surface height is observed; volume is metadata.** *This replaces `Δh = (V_grain / φ) / A` with a global constant φ, which was the second bug.* — *A fixed φ silently assumes every absorption happens at the same packing fraction, but the solver produces whatever local packing it produces. If real local packing is 0.58 while φ says 0.64, every absorption deposits slightly too little height and the terrain drifts below the grains it is meant to support. The drift is cumulative and one-directional: the active layer thickens without bound, or grains sink into terrain, or the pile ends up shorter than the sand poured into it. **Volume conservation and surface continuity are two different invariants and one fixed φ cannot satisfy both.*** The resolution:
  - `height[c]` is the collision and render surface, driven to sit flush with the **observed** underside of resting grains in the cell (`min(py − radius)`, the natural complement to `grainTop`). Falls back to volume-derived height only where no resting grains exist to observe.
  - `solidVolume[c]` is pure accounting metadata. The volume audit becomes `Σ solidVolume + Σ grain.vol` with **no φ term at all** — strictly more exact than the previous formula, and simpler.
  - **φ becomes measured, not dialed:** `φ_local = solidVolume / (height · A)`, derived per cell. Given the project exists to find what determines pile shape, packing fraction being an emergent output rather than a tuned input is an upgrade.
  - **Relaxation must move `solidVolume` alongside height** (`ΔV = Δh · A · φ_local`) or the two desync. This is the one place the decoupling adds work.
  - **Guard, and a pre-approved retreat.** Observation-driven elevation lets a bad solver state corrupt terrain directly, where volume-driven height was robust to it. Keep computing the volume-derived height in parallel and assert the two never diverge beyond tolerance — that divergence *is* the measurement of whether φ is right. **If observation-driven elevation proves unstable at M4, reverting to volume-derived height with a fixed φ is an accepted outcome, not a failure.** The parallel computation means the retreat is a one-line switch rather than a rewrite. The φ-drift argument above still stands as the reason to try observation first; it just may lose to numerical reality.
- **Deposit footprint scales with grain radius** (`splatRadius = max(s, grainRadius)`) — now only for distributing the volume *metadata* sensibly. — *The surface-bump problem this originally addressed largely dissolves under elevation-flush absorption, since the surface rises to where the grain undersides already were and has nothing to push.*
- **Emission uses a per-cell volume debt; grains are never sliced.** — *The debt accumulator dissolves the slicing problem rather than solving it: the fractional remainder becomes next step's debt. Secondarily, absorption destroys grain identity while emission creates it, so a cell holds no grains to slice — only moments to resample from.*
- **Buried size memory stores mean AND variance** (`logVolSum`, `logVolSqSum`, `absorbCount`). — *Mean alone makes a cell that buried a chaotic mix and one that buried a well-sorted layer re-emit identically; that is a per-cell size **average**, not the per-cell size **distribution** this is supposed to be.* Clamp variance at 0 against float cancellation; fall back to global sorting when `absorbCount < 2`.
- **Emitted sizes are clamped below `clumpThreshold`** — see open concerns below.

### Source

- **Sub-frame emission is backdated, not jittered:** a grain conceptually emitted at time `t` is placed where it would have fallen to by frame end (`y -= v₀Δ + ½gΔ²`, `v += gΔ`). — *Spawning a frame's worth of grains at the nozzle plane emits a visible horizontal pancake. Backdating is exact and makes stream spacing framerate-independent; random jitter would not.*
- **Choking/surging is separate from clumping.** Drive instantaneous volumetric rate from **1D gradient noise** (`burstTimescale`, `burstIntensity`); exponentiating gives heavier tails and more dramatic chokes. — *Independent random delays give a Poisson process whose fluctuations are uncorrelated and mild; choking is correlated low-frequency modulation. Rate modulation controls surging, the size tail controls whether lumps come out — earlier drafts conflated them.*
- **⚠ Clumps and sand are metered separately. A clump takes nothing out of the grain budget (user's point, adopted — reverses the shared-budget ledger).** — *A clump is 5000 grains, which is 1.3 frames of flow at the reference pour and 8 at a slow one, so charging it to the same volume budget as the sand made every clump a hole in the stream. Spreading the repayment over following frames (`ARREARS_RATE`) did not fix it and the comment claiming it "thins the stream rather than stopping it" was simply wrong: measured, the stream went to **zero for several frames**, and the mean over the 30 frames behind a clump was 96.7% of baseline at 400 g/s and **69.9% at 60 g/s**. What is supposed to absorb a large body is the **likelihood of the next one**, not the sand.* The fix keeps the self-correcting ledger and drops only the coupling: grains draw on `flowRate · (1 − clumpFraction)`, steadily; every emitted body still credits `clumpOwed += f · vol`; a clump still subtracts its exact volume, which is what pushes the next one away. The flow-rate slider therefore still means the **total**, and the sand between lumps runs at a constant nine-tenths of it at 10% clumps rather than stuttering. Measured after: 100.00% of baseline behind a clump at both rates, leanest single frame 99.5%.
- **⚠ Nothing may come to rest inside a lump.** *The other half of the same change — it is what makes separate metering safe.* Grains are ballistic right up to the moment they land, so a clump and the sand it left the nozzle with pass freely through each other on the way down; that is correct, and it is why the two streams need not take turns. It is only wrong once they stop. So a lump reaching the pile **swallows the sand inside it**, and a grain landing inside a lump that is *still falling* is eaten. Neither adds to the lump's mass: a clump's volume already stands for the grains that stuck together to make it, so sand travelling with one is double-counted rather than new. The eaten volume is booked in the audit.

  **The restriction to falling lumps is load-bearing.** Applied to resting lumps as well — the obvious reading — this drains the pour without bound: nothing removes a clump until M4 and nothing stacks them until M3, so they heap up at floor level in exactly the spot the sand is landing and collectively shadow the stream. Measured over an 80 s pour at 8% clumps, the share of sand being eaten climbed **1% → 27% and was still rising**; restricted to falling lumps it sits at **0.03% and flat**. Sand raining onto a lump that has been sitting there for a minute is not sand the lump is made of — it should come to rest on top, which is M3's job and not a special case here.

- **Rejected: a true hopper model.** — *Physically real and would look excellent, but requires running the contact solver on grains inside the nozzle, which is exactly the cost the ballistic phase exists to avoid.*

### Open concerns to watch

**1. Clumps cannot re-expose.** Because buried aggregates are now absorbed, a cell's size memory can be centred on clump-scale volumes; emission clamps below `clumpThreshold` so a boulder never pops out of a smooth surface. **The accepted cost is that a disturbed clump-rich layer re-exposes as coarse sand rather than as clumps** — the one place this design is less faithful to "the distribution updates on absorption and is randomly selected on emission" than the alternative. The mitigating expectation is that emission should rarely fire at all, since the dominant process is *adding* sand rather than removing it. **That expectation must be measured, not assumed** — emergent behaviour may differ. Add a debug counter for emission events and emission volume and check it during M4. If emission fires often enough to matter, revisit the clamp.

**2. Which quiescence mode to use is an open empirical question.** Under a continuous pour, impacts may keep waking grains often enough that a fully-quiescent shell is rare under contact-quiescence, absorption never fires, and the cap fills anyway; self-duration alone has the opposite risk of retiring a grain that is still load-bearing. Both modes plus their AND/OR combinations are implemented and toggleable for exactly this reason. Settle it at M4 by measuring absorption rate and grain-count plateau across the modes and across `quiescenceSubsteps` — do not pick one in advance.

**3. Observation-driven elevation may lose to numerical reality.** Reverting to volume-derived height with a fixed φ is a pre-approved retreat, kept cheap by computing both in parallel. See the Exchange decisions above.

**None of the three block M1** — there is no heightfield, no absorption and no contact solver in the approved milestone. They are recorded here so the reasoning survives to M2–M4 rather than being re-derived.

---

## Prerequisites

**Order matters — the new worktree must exist before the old ones are removed, since the current session is running inside one of them.**

1. From the main worktree (`D:\My Creations\git\falling-sand-64`), create a fresh worktree and branch based on `master`, so `README.md` and `.gitignore` are present and history is linear.
2. Remove **both** existing worktrees and delete **both** local branches — `claude/falling-sand-clump-review-83f5a8` and `claude/falling-sand-initial-commit-2d9617` — orphaning `da71523` entirely so no trace of the handoff commit remains reachable. (`claude/initial-commit-2d9617` on origin is the legitimate README/gitignore branch already merged to master; leave it alone.)
3. `src/rng.js` is re-created as part of M1 rather than inherited from the orphan commit. Carry the existing implementation over verbatim — mulberry32 plus an `Rng` class with `range`, `gaussian` (Box–Muller with cached second deviate), and `disc` — **plus one addition**: `dirichlet(n, concentration)` returning `n` shares summing to 1, needed by the impulse-scaled fragmentation split. Marsaglia–Tsang gamma draws on top of the existing `gaussian`/`range`, normalised, with the rounding residue assigned to the largest share so volume conservation is exact by construction rather than to float tolerance.

## Environment and deployment constraints

- **Static-only, no build step.** All paths relative — no absolute `/src/...` — so the site works served from a subpath such as `https://cakoluchiam.github.io/falling-sand-64/`.
- **Cross-origin isolation is assumed available.** Allocate the sim's typed arrays over a `SharedArrayBuffer` from the start so a later worker migration is a pure scheduling change with no data restructuring. Note honestly that **on the main thread SAB and ArrayBuffer perform identically** — SAB's only benefit is zero-copy sharing with a worker, which is out of scope for v1. This is cheap insurance, not a v1 speedup. Feature-detect `crossOriginIsolated` and fall back to a plain `ArrayBuffer` rather than failing.
- **The dev server must set COOP/COEP headers.** `python -m http.server` does not, so SAB would be unavailable under it. Use a small Node static server (Node v24.14.1 is installed) that sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Still zero runtime dependencies. Hosting compatibility for the eventual public deploy is deferred by explicit decision.
- **Graceful WebGL2 failure** — a readable message, not a blank page, on unsupported browsers.
- **Grain budget is a parameter, not a constant.** The 100k+ target is for the dev machine (i9-12900K / RTX 3090); a public page meets unknown hardware.
- `python3` is not a command on this machine — it is `python` / `py` (3.14.3). The README's serve instruction needs correcting regardless.

---

## M1 — Visual skeleton *(the only approved milestone)*

The renderer comes first because it is the debugging instrument for everything after it; building a contact solver blind is the main way this project gets stuck.

**Files:** `index.html`, `src/params.js`, `src/rng.js`, `src/noise.js`, `src/gl/mat4.js`, `src/gl/context.js`, `src/gl/camera.js`, `src/gl/grains.js`, `src/main.js`, `src/ui.js`, plus `tools/serve.js` for the COOP/COEP dev server.

- **`params.js`** — flat `values` object, a `schema` array (value/min/max/step/group/label plus a **log-scale flag**), and `CONFIG` for non-slider constants (gridW/gridH, spacing `s`, capacity). `activeLayerDepth` spans **0** to larger than any attainable pile; a pure log slider cannot represent 0, so it needs an explicit zero stop at the bottom.
- **`noise.js`** — 3D gradient noise; curl noise as the curl of a 3-offset vector potential via finite differences, so the flow is divergence-free and does not artificially compress or rarefy the falling stream; 1D noise for rate modulation.
- **Nozzle** — volumetric rate, log-normal volumes, **backdated** sub-frame emission, horizontal position sampled across the aperture disc.
- **Ballistic integration only** — gravity plus drag `-k*(v - vFluid)/(ρ·r)`. Grains stop dead at a flat `y = 0` and mark resting. They will visibly interpenetrate; that is correct for M1 and motivates M3.
- **`gl/grains.js`** — instanced camera-facing quads, analytic ray–sphere intersection in the fragment shader, `discard` outside the silhouette, `gl_FragDepth` written so grains will interpenetrate terrain correctly later. Per-instance radius is free. Slight per-instance hue/value jitter keyed off instance id, with some value shift tied to radius so the size distribution is legible at a glance.
- **`gl/camera.js`** — orbit: drag to rotate, wheel to zoom, right-drag to pan.
- **`main.js`** — fixed 1/240 s substep with an accumulator, capped by **both** a substep count and a ~12 ms wall-clock budget so overload degrades into slow motion rather than a frozen tab. Pause, single-step, reset. Seeded throughout.
- **`ui.js`** — enough of the slider panel to drive the M1 parameters; completed at M6.

**M1 verification:** the stream is continuous rather than banded into per-frame discs, at both capped and uncapped frame rates — banding that moves with fps means the backdate is not being applied. Turbulence sliders visibly broaden the stream. Grains are round at any zoom. 100k impostors hold 60 fps. Volume audit hook present and reporting. `crossOriginIsolated` is true under the dev server and the sim arrays are SAB-backed.

**Then stop and return for plan review.**

---

## M2–M6 — documented for continuity, not approved

### M2 — Heightfield and terrain *(isolates the anisotropy risk)* — **BUILT**

`src/hexfield.js`, `src/gl/terrain.js`, `src/shared.js`, `test/hexfield.mjs`.

**Storage and sampling (the whole default path).** Odd-r offset storage in a `W*H` `Float32Array`; centre `x = s*(q + 0.5*(r&1))`, `z = s*(√3/2)*r`; standard odd-r 6-neighbour tables; adjacent centre distance `s`; cell area `A = (√3/2)·s²`. One `sampleTriangle(x,z)` helper returning 3 cell indices plus barycentric weights summing to 1, used for **both** surface sampling and absorption deposition so they stay consistent and volume-conserving. Companion arrays: `solidVolume`, `logVolSum`, `logVolSqSum`, `absorbCount`, `grainTop`, `grainBottom`. Dirty-rect tracking for the texture upload. Open boundaries. By default the field never moves sand sideways — it is a ledger, and this is all it does.

**Relaxation (the comparison arm, off by default).** Symmetric two-pass gather-then-apply into a scratch delta array, so there is no sweep-order bias and fluxes are antisymmetric by construction; it moves `solidVolume` and lets height follow, which keeps the two exactly consistent rather than nearly so. Hysteresis: sliding begins above `tan(θ_static)` and continues until `tan(θ_repose)`. `relaxRate` derives from the `slumpHalfLife` slider. Its own active-cell list, allocated lazily so the default path pays nothing.

**⚠ The flux rule is not what this plan first specified, and the two rejected versions are worth keeping** — both look obviously right, and one of them is what any reader would write.

1. *Threshold each neighbour's height difference:* `flux = rate * (|dh| - tanRepose*s) * 0.5`. **Anisotropic**, and measurably: it constrains six directions rather than all of them, so a flank pointing between two neighbours stands at `tan(repose)/cos 30°` before anything fires. Built and measured, a settled spike had a **4.1% six-fold ripple** in its footprint and a **34.1° flank when asked for 32°**. A hexagon would be 15.5%, so this is mild — but it is the lattice printing itself onto pile shape, which is the one thing choosing hex was meant to avoid.
2. *Transport down the fitted gradient instead:* gate on `|∇h| > tan(repose)` and move sand along `-∇h`, projected onto each pair. Isotropic, and it removed the ripple — but it settled into a **checkerboard with centimetre steps between adjacent cells** while every fitted gradient still read plausibly near the repose angle. The six-neighbour plane fit **cannot see the mode it is creating**: pushing sand at whichever neighbour the smoothed gradient points to, rather than at one that is actually lower, has nothing damping it.

**What works is both halves at once.** Gate on the isotropic quantity and transport by the real one:

- **Gate:** `(|∇h|_c + |∇h|_n)/2 > tan(θ_limit)`, using the same six-neighbour least-squares plane fit as the normals. Whether this patch is over-steep must not depend on which way it faces.
- **Transport:** the actual pairwise drop, against a threshold scaled by how squarely the pair faces down the slope — `excess = |dh| − tan(θ_limit) · s · |d̂·ĝ|`. A plane of gradient `g` drops `g·s·cos α` to a neighbour `α` off the fall line, so this settles at `|∇h| = tan(θ_limit)` in *every* direction rather than in six. Sand only ever moves from higher to lower, which is what damps the checkerboard.
- **A donor cap of one seventh per pair.** The gate is on the gradient, so a nearly empty cell beside a tall one carries a large gradient while having nothing to give. Without the cap the shortfall is clamped at apply time, the receiving cell keeps the full amount, and the arm quietly mints sand.
- **A flux floor of `1e-6 · spacing`.** The flux is proportional to the excess, so a pile approaches its repose angle exponentially and never exactly arrives; without a floor the active set never empties and a visually settled pile keeps a thousand cells awake forever.

Measured after that: **six-fold ripple 0.008%**, worst radial deviation 0.09%, flank **32.02° for 32°** and likewise at 20° and 42°, settling in ~9000 substeps with volume conserved to 1e-12. The profile at 0° and at 30° agree to three decimal places of a centimetre.

**Rendering.** `gl/terrain.js` uploads a static triangular-lattice VBO once, keeps heights in an `R32F` texture refreshed per frame via `texSubImage2D` over the dirty sub-rect only, and displaces vertices in the vertex shader via `texelFetch` of self plus 6 neighbours with an analytic normal — zero per-frame CPU mesh work.

*Verified, in `test/hexfield.mjs`:*
- **Volume conservation** through deposit and debit, and separately through relaxation — exact to 1e-12, including deposits that straddle the rim and debits that try to overdraw an empty cell. Sand that spills off the edge under relaxation is booked in `escapedVolume` and the audit closes with it.
- **Sampling is continuous** across cell and triangle boundaries, in **height and in normal**, checked two ways: an empirical Lipschitz sweep over a deliberately hostile random field, and sharp probes either side of every rhombus diagonal. Both are bounds rather than equalities — a seam moves a finite amount over a 1e-7 m step and reads four orders of magnitude above the bound, while a continuous surface tracks its own gradient. The normal is the **barycentric blend of the three cell normals, not the facet normal**: facet normals step at every triangle edge, which would give a grain rolling over one a sideways kick out of nowhere.
- **The rendered mesh is the collision mesh.** Every triangle in the terrain index buffer is fed back through `sampleTriangle` as its own centroid and must come back as the same three cells. If these drift apart, grains rest at angles the shading contradicts and it reads as a physics bug.
- **With the relaxation arm on**, a seeded spike settles to a **round cone, not a hexagonal pyramid**, with the flank at `θ_repose` across the slider range. See the flux-rule note above for the two versions that failed this and by how much.

Note the anisotropy risk this milestone was written to isolate largely **belongs to the relaxation rule**, which is now the optional arm — a toppling rule is what bakes lattice directions into pile shape. That risk turned out to be real, was measured, and is fixed. What remains by default is the weaker risk that lattice-aligned triangle facets bias where grains settle, and that cannot be tested until there are grain–surface contacts, so it moves to M3.

**Also settled at M2, and in effect now:** `packingFraction` is a live slider rather than a pending one — it is what converts absorbed volume into surface height until M4 replaces it with the observed underside of resting grains. `relaxation` is a new boolean in the Pile group; the three sliders under it drive that arm and nothing else. Height is `Float32` because it is uploaded verbatim as `R32F`; `solidVolume` and the size moments are `Float64` because they are the audit's accumulator and an f32 running sum drifts by ~1e-5 relative over a long pour.

### M3 — Contact solver

`src/particles.js`. SoA `px,py,pz,vx,vy,vz`, `vol`, `radius`, `cohesion`, `restTimer`; separate `Uint8` `phase` (0=ballistic, 1=awake, 2=resting, 255=free) and `Uint8` `isAgg` rather than bit-packing, for clarity; fixed capacity (~200k) with a free-list. Ballistic→contact handoff on `y - surfaceY(x,z) < max(handoffDepth * grainDiameter, speed * dt_flight)` — the speed term is what stops fast grains stepping clean through the band and tunnelling; on handoff, insert into the hash and push out of any overlap **before** the first solver iteration. PBD per substep: save `xprev`; `v += a·dt`; `x += v·dt`; two constraint iterations (grain–grain volume-weighted position correction so a big grain barely moves when a small one hits it, plus grain–surface projection along the sampled normal); then `v = (x − xprev)/dt`; damp tangential velocity for Coulomb friction and scale the normal component by restitution.

**`friction` and `restitution` are now the primary inputs of the whole project**, since repose angle became an output when the mesh stopped slumping. Friction is the Coulomb ratio damping tangential motion at each contact; restitution is the bounce, which stays low for sand but is what will produce the splash zone — grains scattering outward on impact — that pour spread alone cannot. Both replace the dialed repose angles in the panel's Pile group, which become readouts. Counting-sort spatial hash rebuilt from scratch each substep (`counts` → prefix sum → `sortedIdx`) — cache-friendly and the main perf lever; the same pass fills per-cell `grainTop`, `grainBottom`, the surface-grain count, and the all-contacts-resting bit, all free since grains are already bucketed.

**What M4 needs from M3.** Per cell, `grainBottom` — the lowest live grain underside, which is what stops absorption engulfing a live grain. Accumulate it in the hash rebuild, where the grains are already bucketed.

The burial measure needs a **neighbour list per candidate grain** (index and radius, enough to reconstruct each contact direction and cap angle) rather than an accumulator, because direction-coverage testing cannot be folded into a running sum — that was the mistake in both rejected attempts. It does not need to run in the pair loop at all: absorption candidates are few and absorption runs once per frame, so re-querying the hash for those grains is cheaper than carrying state for every grain every substep. Variable radii: size the grid to the upper end of the *ordinary* grain range (a few multiples of median) and keep **aggregates in a separate large-body list** broad-phased against the cells they overlap with search radius `ceil(radius/cellSize)+1`; `maxGrainDiameter` gives that broad phase a hard ceiling. Sleeping below speed and correction thresholds for K substeps, skipped by integration and the solver but still present in the hash as colliders — the largest single perf win.

*Verify:* no grain ever appears inside the pile or below the surface, tested at the extreme of the drop-height and flow-rate sliders where `speed * dt_flight` is largest. A pile forms with a recognisable repose angle.

### M4 — Exchange

`src/exchange.js`, implementing the decisions above. *Verify:* grain count **plateaus** under a steady pour rather than climbing to the cap — a monotonic climb with a static heightfield means the burial test is reading terrain height instead of `grainTop`. No grain's silhouette is clipped by the rising surface before it disappears. `Σ solidVolume + Σ grain.vol` tracks emitted minus lost-off-edges to float tolerance across a run exercising absorption, emission and avalanching. **Observed elevation and volume-derived elevation stay within tolerance** — divergence is the φ-drift this design exists to prevent. Emission-event counter checked against open concern 1; absorption-starvation checked against open concern 2.

### M5 — Aggregates

`src/aggregates.js`. Truncated log-normal with clump-preserving resample; recursive impulse-gated fragmentation with the impulse-scaled split. Aggregate display radius from volume at the clump packing fraction (`r = (3V / 4πφ)^⅓`) so it reads as a porous lump and, critically, its children fit inside it. Children placed on a jittered pattern within the parent radius, inheriting parent velocity plus a small radial separation impulse scaled by excess energy.

*Verify:* per-break assertion that child volumes sum to the parent's exactly. Zero `cohesion` bursts clumps on first contact; high `cohesion` lets them survive landing and sit as lumps. **Shear vs burst:** a clump landing gently on deep soft sand sheds one small chunk and keeps a large aggregate remainder, while the same clump on packed floor bursts into many near-equal pieces — a rosette from a gentle impact means the split concentration is not tracking the overload ratio. Aggregate count plateaus at high `cohesion` over a long pour. **Size cap is clump-preserving:** sweeping `maxGrainDiameter` down with `sorting` high must leave aggregate **frequency** flat while only size shrinks.

### M6 — Full parameter panel and the measurement sweeps

The panel was largely built during M1 (every control present, described on hover, with unbuilt ones dimmed), so M6 is what remains: the readouts that need data M2–M5 produce, and the sweeps.

**Packing fraction becomes a readout, not a control** — display measured per-cell and global φ live; retain a single `packingFraction` value used only as the bootstrap fallback for cells with no observed grains and for the volume-derived sanity bound.

**Dynamic pour direction (user's suggestion, deferred here).** The pour direction is currently one fixed bearing baked into the stream axis once per step, which is sound because any rotation about vertical is isometric — a static tilt needs no bearing at all. A *moving* pour is the case that needs one: a swirl, or the wobble of a hand. The natural control is a **top-down polar picker** — θ for bearing, radius for tilt angle — replacing the `pourAngle` slider, with the bearing driven over time by the same 1D gradient noise the flow surge already uses so the swirl is correlated rather than jittery. Two knobs beyond the picker: swirl rate and swirl radius. Deferred rather than dropped: it is a source control, and it belongs with the rest of them once the pile it lands on actually exists.

**Experiment 0 — emergent repose vs dialed repose.** The comparison the relaxation toggle exists for. Pour the same seeded mass with the arm off and on, and compare the flank angle the friction produces against the angle the relaxation rule was told to produce. If they agree, the rule is a faithful shortcut and could be used for speed; if they disagree, the rule was a fiction and the toggle stays off — which is the answer the default already assumes. Either result is worth having, and it is why the arm was built rather than deleted.

**Experiment 1 — the `activeLayerDepth` sweep.** Its meaning changes now that the mesh does not slump. It used to check the flank angle was flat at every depth. Instead, sweep upward and find where the angle **stops changing**: below that the active layer is thinner than the avalanching zone and material is being frozen into the mesh mid-slide; above it, the solver contains the whole moving layer. The plateau point is therefore **a measurement of how deep avalanching actually goes**, not merely a check, and it is what `activeLayerDepth` should be set just above. At **maximum** the hybrid still degenerates into pure DEM self-consistently: absorption never fires so all grains stay live; no height is deposited so the field stays flat with an empty dirty list and relaxation never runs, leaving exactly the static flat floor pure DEM needs; emission is gated on the active layer being thinner than target, which is never true, so it disables itself; and the lattice is inert and cannot leak anisotropy. **This replaces a planned second pure-DEM build** — a separate build would save only the eligibility test, a few flops behind an early-out. Pour a **fixed small mass** at several depths across the range with turbulence at zero and measure the flank angle: **it must be flat across the whole sweep.** Drift means the relaxation is a tuned fiction rather than a model of the same physics the solver runs, and the repose sliders are measuring the rule instead of the material. Maximum depth is a diagnostic mode, not a usable configuration — the cap fills within seconds of a steady pour, so keep the mass small. Passing this sweep is the precondition for the deferred idea of auto-tuning `activeLayerDepth` against a frame budget.

**Experiment 2 — `sizeMemory` on vs off.** Same seeded pour twice with a poorly-sorted distribution and a scenario that erodes and re-deposits a flank (a second drop that avalanches the first pile). Memory on, re-emitted flank grains stay coarse; off, the flank re-emits median grains and segregation washes out. Check the **variance** half separately: a cell that buried a well-sorted layer and one that buried a chaotic mix must re-emit with visibly different spread, or only the mean is being read and `logVolSqSum` is dead weight. If the two runs are indistinguishable the memory is not earning its place and should be cut.

**Also at M6 — polydispersity sanity.** At low `sorting` the flanks show no crystalline patches; at high `sorting`, coarse grains concentrate toward the base of the flanks and the measured repose angle **shifts** with sorting. If it does not shift, grain size is not actually feeding the solver.

---

## Verification approach

No build step. Serve the repo root with the COOP/COEP dev server and open `index.html`:

```bash
node tools/serve.js
```

Drive it with the in-app browser (`preview_start` → `navigate` → `read_console_messages`) rather than Playwright. Playwright is not installed here (no `package.json`, no browser cache) and adding it would put a dev dependency and a ~100 MB download into a project whose constraint is zero dependencies. The in-app browser runs against the real GPU, so it covers the boot check, WebGL2 init, console assertions, and the visual and perf checks in one environment instead of two.

Per-milestone gates are listed under each milestone; each must pass before the next begins. The standing assertion across all of them is the **volume audit**, since three code paths move mass — absorption, emission, fragmentation — and fragmentation is the easiest to get subtly wrong. Before any public deploy, verify the site works served from a **subdirectory**, not just from root, to catch absolute-path assumptions.

## Performance exposure

The GPU side is not a concern; a 3090 will not notice 100k impostors. The exposure is the **contact solver on the main thread** — 100k grains in contact is roughly 2M pair-checks per solver iteration. The counting-sort hash, two solver iterations and sleeping should hold 60 fps on a 12900K, but this is the one part that may miss.

Two design choices already cut it substantially: the ballistic phase keeps everything in flight out of the hash, and absorption retires buried grains. Together these bound the solver population at roughly the surface layer, independent of drop height and pour duration. **That independence is only true because aggregates absorb on the same rule as everything else** — under the reversed rule it was false, and the large-body list grew without bound at high `cohesion`. This belongs under Performance and not only under Exchange, because it was a correctness bug wearing a physics justification.

Mitigations in order: grain sleeping (in v1); reduce to one solver iteration for resting-adjacent contacts; shrink `activeLayerDepth` so absorption retires grains sooner. Worker offload over `SharedArrayBuffer` is the escape hatch, which is why the arrays are SAB-backed from M1. WebGPU compute is a stack change and out of scope.

## Out of scope for v1

Multiple materials; subsurface compaction and impact fluidization; shadows; measurement plots and CSV export; worker offload; public hosting compatibility for cross-origin isolation. The multi-material seam, when it comes, is the heightfield becoming a per-cell layer stack — v1 does not pay for that in advance.
