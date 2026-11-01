// Unit tests: HTTrack-style naming (src/net/filenames.mjs) and resilient downloads (src/net/fetch.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { assetBaseName, pickExt, urlParts, safeName, unwrapProxy, NameRegistry, sniffExt } from '../../src/net/filenames.mjs';
import { download, retryAfterMs, backoffMs, HostThrottle } from '../../src/net/fetch.mjs';

test('имена: query-параметры и хэши сборки отбрасываются', () => {
  assert.equal(assetBaseName('https://x.com/static/style.css?v=1.2'), 'style');
  assert.equal(pickExt({ url: 'https://x.com/static/style.css?v=1.2' }), 'css');
  assert.equal(assetBaseName('https://x.com/assets/app.3f9a1c2b.css'), 'app');
  assert.equal(assetBaseName('https://x.com/fonts/Inter-Bold.woff2?abc'), 'inter-bold');
});

test('имена: прокси картинок, транслит, зарезервированные имена Windows', () => {
  assert.equal(unwrapProxy('https://x.com/_next/image?url=%2Fimg%2Fhero.png&w=640'), 'https://x.com/img/hero.png');
  assert.equal(assetBaseName('https://x.com/cdn-cgi/image/width=80/uploads/Avatar%20One.JPEG'), 'avatar-one');
  assert.equal(urlParts('https://x.com/a/b/photo.JPEG').ext, 'jpg');
  assert.equal(assetBaseName('https://x.com/a/3f9a1c2b8d7e6f5a4b3c.png', { hint: 'Красный нож' }), 'krasnyy-nozh');
  assert.equal(assetBaseName('https://x.com/image.php?id=4', { hint: 'logo' }), 'logo');
  assert.equal(safeName('CON'), 'file-con');
  assert.equal(safeName('  ...  '), '');
  assert.ok(safeName('a'.repeat(200)).length <= 60);
});

test('расширение: байты важнее заголовков, заголовки важнее URL', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(sniffExt(png), 'png');
  assert.equal(pickExt({ url: 'https://x.com/a.jpg', contentType: 'image/webp', buf: png }), 'png');
  assert.equal(pickExt({ url: 'https://x.com/a.jpg', contentType: 'image/webp' }), 'webp');
  assert.equal(pickExt({ url: 'https://x.com/a.jpg', contentType: 'application/octet-stream' }), 'jpg');
});

test('NameRegistry: одинаковое содержимое → один файл, разное → суффикс хэша', () => {
  const r = new NameRegistry();
  assert.equal(r.claim('images', 'logo', 'png', 'aaaaaa111'), 'logo.png');
  assert.equal(r.claim('images', 'logo', 'png', 'aaaaaa111'), 'logo.png');
  assert.equal(r.claim('images', 'logo', 'png', 'bbbbbb222'), 'logo-bbbbbb.png');
  assert.equal(r.claim('svg', 'logo', 'png', 'bbbbbb222'), 'logo.png', 'другая папка — своё пространство имён');
});

test('retryAfter и backoff', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString()) > 3000, true);
  assert.equal(retryAfterMs('junk'), null);
  assert.equal(backoffMs(0, { random: () => 0 }), 250);
  assert.equal(backoffMs(10, { random: () => 1, cap: 4000 }), 4000);
});

function server(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` })); });
}
const BODY = Buffer.from('0123456789'.repeat(5000));

test('download: повтор после 503 с Retry-After', async () => {
  let n = 0;
  const { s, url } = await server((req, res) => { n++; if (n < 3) { res.writeHead(503, { 'retry-after': '0' }); return res.end(); } res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  try {
    const r = await download(url + '/x', { retries: 3 });
    assert.equal(r.buf.toString(), 'ok'); assert.equal(r.attempts, 3);
  } finally { s.close(); }
});

test('download: 404 не повторяется', async () => {
  let n = 0;
  const { s, url } = await server((req, res) => { n++; res.writeHead(404); res.end(); });
  try { await assert.rejects(download(url, { retries: 3, backoff: { base: 1 } }), /HTTP 404/); assert.equal(n, 1); } finally { s.close(); }
});

test('download: обрыв посередине → докачка через Range', async () => {
  const seen = [];
  const { s, url } = await server((req, res) => {
    seen.push(req.headers.range || '');
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { const from = Number(m[1]); res.writeHead(206, { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`, 'content-length': BODY.length - from, 'accept-ranges': 'bytes', etag: '"v1"' }); return res.end(BODY.subarray(from)); }
    res.writeHead(200, { 'content-length': BODY.length, 'accept-ranges': 'bytes', etag: '"v1"' });
    res.write(BODY.subarray(0, 20000));
    setTimeout(() => res.socket.destroy(), 30);
  });
  try {
    const r = await download(url + '/big.bin', { retries: 2, backoff: { base: 5 } });
    assert.equal(r.buf.length, BODY.length); assert.ok(r.buf.equals(BODY)); assert.equal(r.resumed, true);
    assert.equal(seen[1], 'bytes=20000-');
  } finally { s.close(); }
});

test('download: докачка между запусками через *.part', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-part-'));
  const part = path.join(dir, 'video.mp4.part');
  const { s, url } = await server((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m && req.headers['if-range'] === '"v1"') { const from = Number(m[1]); res.writeHead(206, { 'content-range': `bytes ${from}-${BODY.length - 1}/${BODY.length}`, 'accept-ranges': 'bytes', etag: '"v1"' }); return res.end(BODY.subarray(from)); }
    res.writeHead(200, { 'accept-ranges': 'bytes', etag: '"v1"' }); res.end(BODY);
  });
  try {
    await fsp.writeFile(part, BODY.subarray(0, 12345));
    await fsp.writeFile(part + '.json', JSON.stringify({ url: url + '/v.mp4', etag: '"v1"' }));
    const r = await download(url + '/v.mp4', { partFile: part });
    assert.ok(r.buf.equals(BODY)); assert.equal(r.resumed, true);
    await assert.rejects(fsp.access(part));
  } finally { s.close(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('download: лимит размера', async () => {
  const { s, url } = await server((req, res) => { res.writeHead(200, { 'content-length': BODY.length }); res.end(BODY); });
  try { await assert.rejects(download(url, { maxBytes: 1000 }), /too large/); } finally { s.close(); }
});

test('HostThrottle: замедляется после 429 и разгоняется после успеха', async () => {
  const t = new HostThrottle({ concurrency: 1, minIntervalMs: 0 });
  await t.acquire('http://a.test/1'); t.release('http://a.test/1', { status: 429 });
  assert.equal(t.interval('http://a.test/x'), 250);
  await t.acquire('http://a.test/2'); t.release('http://a.test/2', { status: 429 });
  assert.equal(t.interval('http://a.test/x'), 750);
  await t.acquire('http://a.test/3'); t.release('http://a.test/3', { status: 200 });
  assert.equal(t.interval('http://a.test/x'), 600);
  assert.equal(t.interval('http://b.test/x'), 0, 'другой хост не тормозит');
});
