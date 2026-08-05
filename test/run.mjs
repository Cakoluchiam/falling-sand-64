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

// Ordered cheapest-first, so a broken build fails in seconds rather than
// minutes. `clumps` is slow on purpose: clumps are a rare event, and its
// tolerances only hold when pooled across many seeded runs.
const SUITES = [
  ['smoke', 'smoke.mjs', 'RNG, noise, curl field, particle store, nozzle, backdating'],
  ['sizes', 'sizes.mjs', 'grain size limits, uniform sand, truncated sampling'],
  ['pour', 'pour.mjs', 'pour angle aims, pour spread widens, launch geometry'],
  ['clumps', 'clumps.mjs', 'clump population: rate, interleaving, self-correction'],
];

const filter = process.argv[2];
const selected = filter ? SUITES.filter(([name]) => name.includes(filter)) : SUITES;

if (selected.length === 0) {
  console.error(`no suite matches "${filter}". Known: ${SUITES.map((s) => s[0]).join(', ')}`);
  process.exit(2);
}

const results = [];
for (const [name, file, blurb] of selected) {
  process.stdout.write(`\n${'='.repeat(70)}\n${name}  —  ${blurb}\n${'='.repeat(70)}\n`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
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
