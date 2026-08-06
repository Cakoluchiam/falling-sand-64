// Everything the behavioural suites never touch.
//
// They exercise the simulation modules, which leaves `main.js`, `ui.js` and
// most of `gl/` unparsed by anything -- a typo in the entry point or a renamed
// module breaks the page while every other suite stays green. This is the
// cheap sweep that catches that, plus the two repo constraints that have a
// deployment consequence and no other enforcement.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (n, c, x = '') => { console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${x}`); if (!c) failures++; };

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const sources = walk(join(root, 'src')).concat(join(root, 'tools', 'serve.js'));
const rel = (p) => relative(root, p).replace(/\\/g, '/');

console.log(`every module parses  (${sources.length} files)`);
{
  // Node has to detect the module syntax to do this, since the sources are ESM
  // in .js files with no package.json to say so -- see the version floor in
  // run.mjs. A parse failure here reads as a plain syntax error, which is the
  // point: the alternative is finding it in the browser console.
  let bad = 0;
  for (const f of sources) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { console.log(`  FAIL ${rel(f)}\n${r.stderr.trim()}`); bad++; }
  }
  check('no syntax errors', bad === 0, `${bad} of ${sources.length}`);
}

console.log('\nevery module loads');
{
  // Actually running the imports is what catches a renamed file or a missing
  // export, which parsing alone cannot see. `main.js` is the exception -- it
  // boots the app on import and wants a DOM -- so it gets a static check below.
  let bad = 0;
  for (const f of sources) {
    if (rel(f) === 'src/main.js' || rel(f) === 'tools/serve.js') continue;
    try {
      await import(pathToFileURL(f).href);
    } catch (e) {
      console.log(`  FAIL ${rel(f)}  ->  ${String(e.message).split('\n')[0]}`);
      bad++;
    }
  }
  check('no module fails to load', bad === 0, `${bad} failed`);
}

// Relative specifiers only, and every one of them has to resolve. `main.js`
// imports nearly everything and is the one file no suite can load, so this is
// its only cover.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
console.log('\nimports resolve');
{
  let bad = 0, n = 0;
  for (const f of sources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;              // node: builtins
      n++;
      if (!existsSync(resolve(dirname(f), spec))) {
        console.log(`  FAIL ${rel(f)} imports ${spec}, which does not exist`);
        bad++;
      }
    }
  }
  check(`all ${n} relative imports point at a file`, bad === 0, `${bad} broken`);
}

console.log('\nthe site stays self-contained and subdirectory-safe');
{
  // Two standing constraints with no other enforcement: zero dependencies, and
  // every path relative so the site works served from a subpath such as
  // /falling-sand-64/ rather than only from a domain root.
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const files = [['index.html', html], ...sources.map((f) => [rel(f), readFileSync(f, 'utf8')])];

  let absolute = [], remote = [];
  for (const [name, src] of files) {
    for (const m of src.matchAll(/(?:from\s*|src=|href=)['"](\/[^/][^'"]*)['"]/g)) absolute.push(`${name}: ${m[1]}`);
    for (const m of src.matchAll(/(?:from\s*|src=|href=)['"](https?:\/\/[^'"]*)['"]/g)) remote.push(`${name}: ${m[1]}`);
  }
  check('no absolute paths', absolute.length === 0, absolute.join(', '));
  check('nothing is fetched from another host', remote.length === 0, remote.join(', '));
  check('no package.json crept in', !existsSync(join(root, 'package.json')));

  const entry = html.match(/<script[^>]*src=['"]([^'"]+)['"]/);
  check('index.html loads the entry point as a module',
    entry && existsSync(resolve(root, entry[1])) && /type=['"]module['"]/.test(html),
    entry ? entry[1] : 'no script tag');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
