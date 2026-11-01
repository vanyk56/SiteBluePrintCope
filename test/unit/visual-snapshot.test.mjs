// Unit tests: visual regression engine (src/verify/visual.mjs), PNG helpers for extension captures
// (src/capture/png.mjs) and SingleFile-style snapshot finalisation (src/capture/snapshot.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { comparePng, padTo, downscale, loadLibs } from '../../src/verify/visual.mjs';
import { decodePng, cropRows, makeSheets, loadPng } from '../../src/capture/png.mjs';
import { resolvePlaceholders, SnapshotStore } from '../../src/capture/snapshot.mjs';

const { PNG } = await loadLibs();
const noPng = !PNG && 'нет pngjs (npm install)';
function img(w, h, paint = () => [255, 255, 255, 255]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.data.set(paint(x, y), (y * w + x) * 4);
  return PNG.sync.write(p);
}

test('comparePng: одинаковые → 100 %, половина другого цвета → ~50 %, полосы секций, diff и composite', { skip: noPng }, async () => {
  const white = img(120, 100);
  const same = await comparePng(white, img(120, 100));
  assert.equal(same.similarity, 1); assert.equal(same.diffPixels, 0);
  const half = img(120, 100, (x, y) => (y < 50 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
  const r = await comparePng(white, half, { bands: [{ name: 'hero', y: 0, h: 50 }, { name: 'footer', y: 50, h: 50 }, { name: 'tiny', y: 10, h: 2 }] });
  assert.ok(Math.abs(r.similarity - 0.5) < 0.02, String(r.similarity));
  assert.deepEqual(r.bands.map((b) => [b.name, Math.round(b.similarity * 100)]), [['hero', 100], ['footer', 0]], 'полосы < 4 px пропускаются');
  const diff = PNG.sync.read(r.diffPng); assert.equal(diff.width, 120); assert.equal(diff.height, 100);
  const comp = PNG.sync.read(r.compositePng); assert.equal(comp.width, 120 * 3 + 16); assert.equal(comp.height, 100);
  assert.ok(['pixelmatch', 'yiq-fallback'].includes(r.engine));
});

test('comparePng: разная высота дополняется белым, maxHeight ограничивает, мелкий шум в пределах threshold', { skip: noPng }, async () => {
  const a = img(100, 100); const b = img(100, 140, (x, y) => (y < 100 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const r = await comparePng(a, b, { composite: false });
  assert.equal(r.height, 140); assert.equal(r.heightA, 100); assert.equal(r.heightB, 140);
  assert.ok(Math.abs(r.similarity - 100 / 140) < 0.02);
  assert.equal(r.compositePng, null);
  assert.equal((await comparePng(a, b, { maxHeight: 100 })).similarity, 1);
  const noisy = img(100, 100, () => [252, 253, 251, 255]);
  assert.equal((await comparePng(a, noisy)).similarity, 1);
});

test('padTo / downscale', { skip: noPng }, () => {
  const small = { width: 2, height: 1, data: Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]) };
  const p = padTo(small, 3, 2);
  assert.equal(p.length, 3 * 2 * 4);
  assert.deepEqual([...p.subarray(0, 8)], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual([...p.subarray(8, 12)], [255, 255, 255, 255]);
  const d = downscale(Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]), 2, 2, 2);
  assert.equal(d.width, 1); assert.deepEqual([...d.data], [127, 127, 127, 255]);
});

test('png.mjs: cropRows и makeSheets для захватов расширения (без браузера на стороне CLI)', { skip: noPng }, async () => {
  assert.ok(await loadPng());
  const tall = await decodePng(img(1280, 7000, (x, y) => [y % 256, 0, 0, 255]));
  assert.equal(tall.height, 7000);
  assert.equal(await decodePng(Buffer.from('nope')), null);
  const crop = PNG.sync.read(await cropRows(tall, 100, 300));
  assert.equal(crop.width, 1280); assert.equal(crop.height, 300); assert.equal(crop.data[0], 100);
  assert.equal(await cropRows(tall, 6999, 50), null, 'меньше 2 строк → null');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-png-'));
  const sheets = await makeSheets(tall, path.join(dir, 'llm', 'index-desktop'), { width: 1000, maxH: 1800, max: 4 });
  assert.ok(sheets.length >= 1 && sheets.length <= 4, String(sheets.length));
  for (const s of sheets) { const p = PNG.sync.read(await fsp.readFile(s.file)); assert.ok(p.width <= 1000 && p.height <= 1800, `${p.width}×${p.height}`); }
  assert.equal(sheets[0].y0, 0); assert.equal(sheets.at(-1).y1, 7000, 'последний лист доходит до низа страницы');
  assert.deepEqual(await makeSheets(tall, path.join(dir, 'x'), { max: 0 }), []);
});

test('resolvePlaceholders: атрибуты экранируются, локальные пути важнее исходных URL', () => {
  const html = '<img src="__SBRES_A0__"><a href="__SBRES_A2__">x</a><style>.h{background:url(__SBRES_C1__)}</style><img src="__SBRES_A9__">';
  const res = [{ url: 'https://x.example/a.png?w=1&h=2' }, { url: 'https://x.example/b".png' }, { url: 'https://x.example/about' }];
  const out = resolvePlaceholders(html, res, (i) => (i === 0 ? '../project/public/images/a.png' : i === 2 ? './about.html' : null));
  assert.equal(out, '<img src="../project/public/images/a.png"><a href="./about.html">x</a><style>.h{background:url(https://x.example/b%22.png)}</style><img src="">');
  assert.equal(resolvePlaceholders('<img src="__SBRES_A0__">', res, () => null), '<img src="https://x.example/a.png?w=1&amp;h=2">');
});

test('SnapshotStore.finalize: ассеты → project/public, ссылки между страницами → ./<slug>.html, скрипты и трекеры удалены', async () => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-snap-'));
  const saved = [];
  const assets = {
    webPath: (u) => (u.endsWith('/logo.png') ? '/images/logo.png' : null),
    save: async (u, kind) => { saved.push([u, kind]); return '/fonts/inter.woff2'; },
  };
  const store = new SnapshotStore(outDir, { assets, maxNewAssets: 5 });
  const html = '<!doctype html><html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-X1"></script><style>@font-face{src:url(__SBRES_C1__)}</style></head>'
    + '<body><img src="__SBRES_A0__" onclick="steal()"><a href="__SBRES_A2__">О нас</a><a href="__SBRES_A3__">ext</a><a href="javascript:alert(1)">bad</a><script>window.__NEXT_DATA__={}</script></body></html>';
  const resources = [{ url: 'https://shop.example/logo.png', kind: 'images' }, { url: 'https://shop.example/inter.woff2', kind: 'fonts' }, { url: 'https://shop.example/about#team', kind: 'page' }, { url: 'https://other.example/', kind: 'page' }];
  assert.equal(await store.add('index', { html: '' }), null);
  await store.add('index', { url: 'https://shop.example/', title: 'Shop', html, resources, stats: { nodes: 10 } });
  const out = await store.finalize([{ slug: 'index', url: 'https://shop.example/' }, { slug: 'about', url: 'https://shop.example/about' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'snapshots/index.html'); assert.equal(out[0].local, 2); assert.equal(out[0].resources, 2);
  assert.deepEqual(saved, [['https://shop.example/inter.woff2', 'fonts']]);
  const page = await fsp.readFile(path.join(outDir, 'snapshots/index.html'), 'utf8');
  assert.match(page, /src="\.\.\/project\/public\/images\/logo\.png"/);
  assert.match(page, /url\(\.\.\/project\/public\/fonts\/inter\.woff2\)/);
  assert.match(page, /href="\.\/about\.html#team"/);
  assert.match(page, /href="https:\/\/other\.example\/"/);
  assert.ok(!/<script/i.test(page), 'скриптов нет');
  assert.ok(!/onclick|javascript:/i.test(page), 'обработчиков и javascript: нет');
  assert.ok(out[0].removed.scripts >= 2 && out[0].removed.handlers >= 1);
  await assert.rejects(fsp.stat(path.join(outDir, 'data/snapshots')), 'сырые снимки удалены');
});
