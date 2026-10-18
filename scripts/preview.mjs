import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMonitor} from '../lib/monitor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const monitor = createMonitor();
const port = Number(process.env.SKILL_DESK_PREVIEW_PORT || 47832);
const files = new Map([
  ['/', ['ui/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['ui/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['ui/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['ui/style.css', 'text/css; charset=utf-8']],
  ['/icon.png', ['assets/icon.png', 'image/png']],
  ['/assets/icon.svg', ['assets/icon.svg', 'image/svg+xml']],
]);
const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') {
    res.writeHead(403).end(); return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/api/state') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(monitor.getState())); return;
  }
  const entry = files.get(url.pathname);
  if (!entry) {res.writeHead(404).end(); return;}
  res.setHeader('Content-Type', entry[1]);
  fs.createReadStream(path.join(root, entry[0])).on('error', () => res.destroy()).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Skill Desk preview: http://127.0.0.1:${port}`));
const close = () => server.close(() => {monitor.close(); process.exit();});
process.on('SIGINT', close);
process.on('SIGTERM', close);
