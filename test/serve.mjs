// Tiny static server for the fixture site (clean URLs, robots.txt, sitemap.xml).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
export function serve(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const origin = `http://${req.headers.host}`;
      if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`); }
      if (u.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0"?><urlset>${['/', '/pricing', '/about', '/blog', '/blog/post-1', '/blog/post-2', '/blog/post-3'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`); }
      let p = decodeURIComponent(u.pathname);
      let file = path.join(root, p);
      if (p === '/') file = path.join(root, 'index.html');
      else if (!path.extname(p)) file = path.join(root, p.replace(/\/$/, '') + '.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve(Number(process.argv[2] || 4173));
  console.log('Fixture site: http://127.0.0.1:' + s.address().port);
}
