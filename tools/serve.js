// Minimal static file server for local development.
//
// This exists for exactly one reason: SharedArrayBuffer requires cross-origin
// isolation, which requires COOP/COEP response headers. `python -m http.server`
// does not send them, so the sim would silently fall back to a plain
// ArrayBuffer under it. Everything else here is the least server that serves
// the repository root.
//
//   node tools/serve.js [port]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  // These two are the whole point of this file.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // No caching, so an edit is one refresh away.
  res.setHeader('Cache-Control', 'no-store');

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve first, then confirm the result is still inside ROOT. Checking the
  // raw path for ".." is not enough once encoding and symlinks are involved.
  const filePath = resolve(join(ROOT, pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    return send(res, 403, 'Forbidden');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return send(res, 404, `Not found: ${pathname}`);
  }
  if (info.isDirectory()) return send(res, 404, `Not found: ${pathname}`);

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
  });
  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
  console.log('  COOP/COEP set, so crossOriginIsolated should be true');
});
