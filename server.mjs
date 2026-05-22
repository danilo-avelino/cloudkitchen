import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.jsx':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = normalize(join(root, decoded));
  if (!target.startsWith(root)) return null;
  return target;
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = req.url || '/';
    if (urlPath === '/' || urlPath === '') urlPath = '/StockKitchen.html';

    const filePath = safeJoin(ROOT, urlPath);
    if (!filePath) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    let target = filePath;
    try {
      const s = await stat(target);
      if (s.isDirectory()) target = join(target, 'StockKitchen.html');
    } catch {
      res.writeHead(404); res.end('Not found: ' + urlPath); return;
    }

    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error: ' + (err && err.message ? err.message : String(err)));
  }
});

server.listen(PORT, () => {
  console.log(`StockKitchen serving on http://localhost:${PORT}/`);
  console.log(`Root: ${ROOT}`);
});
