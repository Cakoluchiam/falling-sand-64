// Runs every suite and exits non-zero if any fails.
//
//   node test/run.mjs            all suites
//   node test/run.mjs pour       only suites whose name contains "pour"
//
// No test framework and no dependencies, matching the project's constraint.
// Each suite is a standalone script that prints "ok"/"FAIL" lines and exits
// non-zero on failure, so it can also be run directly when iterating on one.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// The sources are ES modules in `.js` files with no `package.json` to declare
// it, so Node has to detect the module syntax itself -- which it only does
// unprompted from 22.7. Below that every suite dies claiming it cannot require
// an ES module, which points nowhere near the actual problem.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 7)) {
  console.error(
    `Node ${process.versions.node} is too old. This project has no package.json by\n` +
    'design, so it needs a Node that detects ES module syntax on its own: 22.7 or newer.',
  );
  process.exit(2);
}

// Ordered cheapest-first, so a broken build fails in seconds rather than
// minutes. `clumps` is slow on purpose: clumps are a rare event, and its
// tolerances only hold when pooled across many seeded runs.
const SUITES = [
  ['modules', 'modules.mjs', 'every module parses and loads, paths stay relative'],
  ['smoke', 'smoke.mjs', 'RNG, noise, curl field, particle store, nozzle, backdating'],
  ['sizes', 'sizes.mjs', 'grain size limits, uniform sand, truncated sampling'],
  ['pour', 'pour.mjs', 'pour angle aims, pour spread widens, launch geometry'],
  ['hexfield', 'hexfield.mjs', 'lattice geometry, sampling continuity, volume ledger, relaxation'],
  ['hash', 'hash.mjs', 'contact broad phase: hierarchy, counting sort, exactly-once pairs'],
  ['measure', 'measure.mjs', 'repose angle and footprint roundness, against surfaces with known answers'],
  // `contact` is split for the same reason as `clumps` below: it grew past a
  // minute and would otherwise set the matrix wall clock on its own.
  ['contact-surface', 'contact.mjs', 'a grain on the terrain: friction angle, sliding, bounce', 'surface'],
  ['contact-pairs', 'contact.mjs', 'grain against grain: separation, weighting, stacks, piles', 'pairs'],
  ['contact-sleep', 'contact.mjs', 'retiring settled grains, and waking them again', 'sleep'],
  ['contact-repose', 'contact.mjs', 'friction holds the pile up, and the footprint is round', 'repose'],
  // `exchange` is split from the start, for the same reason. Parts are
  // registered here only once their section exists -- the suite exits non-zero
  // on a part that runs no checks, so a name added early is red rather than a
  // job that passes while testing nothing.
  ['exchange-producers', 'exchange.mjs', 'per-frame passes: grain extrema, contact adjacency, rest timers', 'producers'],
  ['exchange-burial', 'exchange.mjs', 'how deep a grain is, measured through the pile rather than down a column', 'burial'],
  ['exchange-absorb', 'exchange.mjs', 'retiring buried grains, the volume audit, and the engulfment invariant', 'absorb'],
  ['exchange-emit', 'exchange.mjs', 'putting sand back when the active layer runs thin', 'emit'],
  // `clumps` is minutes where the rest are seconds, so it is split into three
  // parts that CI runs as separate jobs. A fourth element is the argument
  // handed to the script; everything else runs whole. The parts share one file
  // and therefore one set of pinned parameters -- see the note in clumps.mjs.
  ['clumps-stream', 'clumps.mjs', 'clumps interleave with the sand and never trap it', 'stream'],
  ['clumps-rate', 'clumps.mjs', 'clump rate, volume fraction, and slider scaling', 'rate'],
  ['clumps-spread', 'clumps.mjs', 'clump arrivals are consistent run to run, not Poisson', 'spread'],
];

const filter = process.argv[2];
const selected = filter ? SUITES.filter(([name]) => name.includes(filter)) : SUITES;

if (selected.length === 0) {
  console.error(`no suite matches "${filter}". Known: ${SUITES.map((s) => s[0]).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const [name, file, blurb, arg] of selected) {
  process.stdout.write(`\n${'='.repeat(70)}\n${name}  —  ${blurb}\n${'='.repeat(70)}\n`);
  const started = Date.now();
  const argv = arg ? [join(here, file), arg] : [join(here, file)];
  const run = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  results.push({ name, ok: run.status === 0, seconds: (Date.now() - started) / 1000 });
}

console.log(`\n${'='.repeat(70)}`);
let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(8)} ${r.seconds.toFixed(1)}s`);
  if (!r.ok) failed++;
}
console.log(failed === 0
  ? `\nall ${results.length} suites passed`
  : `\n${failed} of ${results.length} suites FAILED`);
process.exit(failed === 0 ? 0 : 1);
