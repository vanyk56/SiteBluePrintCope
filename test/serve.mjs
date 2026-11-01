// Tiny static server for the fixture site (clean URLs, robots.txt, sitemap.xml).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
export function serve(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const origin = `http://${req.headers.host}`;
      if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`); }
      if (u.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0"?><urlset>${['/', '/pricing', '/shop', '/about', '/blog', '/blog/post-1', '/blog/post-2', '/blog/post-3'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`); }
      // tiny JSON/GraphQL backend used by shop.html (the API sniffer must record it and redact secrets)
      if (u.pathname === '/api/products') return json(res, { total: 48, page: Number(u.searchParams.get('page') || 1), items: [{ id: 1, title: 'VIP на 30 дней', price: 299 }, { id: 2, title: 'Набор строителя', price: 149 }, { id: 3, title: 'Ресурсы ×1000', price: 99 }] });
      if (u.pathname === '/api/me') return json(res, { id: 7, full_name: 'Иван Петров', email: 'ivan.petrov@nimbus.dev', phone: '+7 (999) 123-45-67', token: 'tok_live_9f8e7d6c5b4a3210', plan: 'pro', seen_auth: !!req.headers.authorization });
      if (u.pathname === '/graphql' && req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let op = ''; try { op = JSON.parse(b).operationName; } catch {} json(res, op === 'GetReviews' ? { data: { reviews: [{ id: 'r1', author: 'Сергей', text: 'Лучший сервер, вайпы вовремя!' }, { id: 'r2', author: 'Мария', text: 'Поддержка отвечает за 5 минут.' }, { id: 'r3', author: 'Олег', text: 'Честные цены, без доната на оружие.' }] } } : { errors: [{ message: 'unknown operation' }] }); }); return; }
      if (u.pathname === '/collect') { res.writeHead(204); return res.end(); }
      let p = decodeURIComponent(u.pathname);
      let file = path.join(root, p);
      if (p === '/') file = path.join(root, 'index.html');
      else if (!path.extname(p)) file = path.join(root, p.replace(/\/$/, '') + '.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
      const send = () => { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res); };
      // shop product images are slow (like a real CDN under load): lazy-loading must wait for them
      if (p.startsWith('/shop/')) setTimeout(send, 800); else send();
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await serve(Number(process.argv[2] || 4173));
  console.log('Fixture site: http://127.0.0.1:' + s.address().port);
}
