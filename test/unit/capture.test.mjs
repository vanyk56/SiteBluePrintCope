// Unit tests: capture package of the browser extension (extension/lib/zip.js + package.js) ↔ CLI reader
// (src/capture/zipread.mjs + openCapture): round trip, zip-slip, zip bombs, limits, corruption, format checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { ZipWriter, crc32 } from '../../extension/lib/zip.js';
import { CapturePackager, buildCaptureZip, FORMAT, VERSION, slugSafe } from '../../extension/lib/package.js';
import { readZip, safeEntryName, ZipError } from '../../src/capture/zipread.mjs';
import { openCapture, CAPTURE_FORMAT, CAPTURE_VERSION } from '../../src/capture/import.mjs';

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sb-cap-'));
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a1e6b5a20000000049454e44ae426082', 'hex');
const rawPage = (title = 'Shop') => ({ url: 'https://shop.example/', title, tree: { tag: 'body', children: [] }, tokens: {}, nodes: 12 });
const big = (n, ch = 'a') => ch.repeat(n);

async function zipOf(entries) {
  const z = new ZipWriter();
  for (const [name, data, o] of entries) await z.add(name, data, o);
  return Buffer.from(z.finishBytes());
}
// replaces same-length byte sequences everywhere (local + central headers) — to forge names the writer refuses
const patch = (buf, from, to) => { assert.equal(from.length, to.length); const out = Buffer.from(buf); let i = 0; while ((i = out.indexOf(from, i)) >= 0) { out.write(to, i, 'latin1'); i += to.length; } return out; };

test('формат: расширение и CLI говорят на одной версии', () => {
  assert.equal(FORMAT, CAPTURE_FORMAT);
  assert.equal(VERSION, CAPTURE_VERSION);
  assert.equal(slugSafe('Каталог / Товары?x=1'), 'x-1');
  assert.equal(slugSafe(''), 'page');
});

test('crc32 совпадает с zlib', { skip: typeof zlib.crc32 !== 'function' && 'zlib.crc32 нет в этой версии Node' }, () => {
  for (const s of ['', 'a', 'hello world', big(70000, 'x')]) assert.equal(crc32(new TextEncoder().encode(s)), zlib.crc32(Buffer.from(s)) >>> 0);
});

test('ZIP: store + deflate, UTF-8 имена, бинарные файлы — туда и обратно', async () => {
  const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, title: 'Товар ' + i })) });
  const buf = await zipOf([['pages/главная.json', json], ['screenshots/a.png', PNG_1PX], ['small.txt', 'hi'], ['empty.bin', new Uint8Array(0)]]);
  const files = readZip(buf);
  assert.deepEqual([...files.keys()], ['pages/главная.json', 'screenshots/a.png', 'small.txt', 'empty.bin']);
  assert.equal(files.get('pages/главная.json').toString('utf8'), json);
  assert.ok(files.get('screenshots/a.png').equals(PNG_1PX));
  assert.equal(files.get('small.txt').toString(), 'hi');
  assert.equal(files.get('empty.bin').length, 0);
  assert.ok(buf.length < json.length, 'JSON сжат deflate');
  // system unzip (if present) reads the same archive
  const f = path.join(await tmp(), 'a.zip'); await fsp.writeFile(f, buf);
  assert.equal(readZip(await fsp.readFile(f), { filter: (n) => n.endsWith('.txt') }).size, 1, 'filter');
});

test('ZIP: писатель отвергает плохие и повторяющиеся имена', async () => {
  const z = new ZipWriter();
  await assert.rejects(z.add('../evil.txt', 'x'), /bad entry name/);
  await assert.rejects(z.add('a//b.txt', 'x'), /bad entry name/);
  await z.add('\\win\\path.txt', 'x');
  assert.ok(z.has('win/path.txt'));
  await assert.rejects(z.add('win/path.txt', 'y'), /duplicate/);
});

test('safeEntryName: zip-slip, абсолютные пути, диски Windows, NUL', () => {
  assert.equal(safeEntryName('a/b.json'), 'a/b.json');
  assert.equal(safeEntryName('./a//b.json'), 'a/b.json');
  assert.equal(safeEntryName('a\\b.json'), 'a/b.json');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'c:\\x', 'a\0b', '', '..']) assert.equal(safeEntryName(bad), null, bad);
});

test('readZip: zip-slip в архиве → ZipError', async () => {
  const buf = patch(await zipOf([['xx/evil.txt', 'pwned']]), 'xx/evil', '../evil');
  assert.throws(() => readZip(buf), (e) => e instanceof ZipError && /небезопасное имя/.test(e.message));
  const abs = patch(await zipOf([['xetc/passwd', 'x']]), 'xetc', '/etc');
  assert.throws(() => readZip(abs), ZipError);
});

test('readZip: лимиты числа файлов, размера файла и суммы', async () => {
  const buf = await zipOf([['a.txt', big(600)], ['b.txt', big(600)], ['c.txt', big(600)]]);
  assert.throws(() => readZip(buf, { maxEntries: 2 }), /слишком много файлов/);
  assert.throws(() => readZip(buf, { maxEntryBytes: 500 }), /слишком большой/);
  assert.throws(() => readZip(buf, { maxTotalBytes: 1000 }), /превышает лимит/);
  assert.equal(readZip(buf, { maxEntries: 3, maxEntryBytes: 600, maxTotalBytes: 1800 }).size, 3);
});

test('readZip: «zip-бомба», которая врёт о размере, не распаковывается', async () => {
  const buf = await zipOf([['bomb.txt', Buffer.alloc(2_000_000)]]);
  // central directory: uncompressed size at +24 → claim 1000 bytes
  const cen = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(1000, cen + 24);
  assert.throws(() => readZip(buf), (e) => e instanceof ZipError && /больше заявленного|повреждённый/.test(e.message));
});

test('readZip: повреждения и не-ZIP', { skip: typeof zlib.crc32 !== 'function' && 'нужен zlib.crc32' }, async () => {
  assert.throws(() => readZip(Buffer.from('definitely not a zip file, just text')), /не ZIP/);
  const buf = await zipOf([['a.txt', 'short text']]);
  const i = buf.indexOf('short text'); buf[i] ^= 0x20;
  assert.throws(() => readZip(buf), /CRC/);
  const trunc = (await zipOf([['a.json', big(5000, 'z')]])).subarray(0, 60);
  assert.throws(() => readZip(trunc), ZipError);
});

async function sampleCapture(extra = {}) {
  const p = new CapturePackager({ source: 'extension', extensionVersion: '2.0.0', startUrl: 'https://shop.example/', viewport: { width: 1280, height: 800 }, ...extra.meta });
  await p.addPage({ slug: 'index', url: 'https://shop.example/', title: 'Shop', raw: rawPage(), snapshot: { html: '<html><body>x</body></html>', resources: [] }, screenshot: PNG_1PX, state: { tabs: [], dialogs: [] }, trackers: { srcs: ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'], inline: '' }, hydration: { next: { props: {} } } });
  await p.addPage({ slug: 'index', url: 'https://shop.example/catalog', title: 'Catalog', raw: rawPage('Catalog') });
  assert.equal(await p.addAsset({ url: 'https://shop.example/logo.png', contentType: 'image/png; charset=binary', bytes: PNG_1PX }).then((r) => r.file), 'assets/files/00001.png');
  assert.equal(await p.addAsset({ url: 'https://shop.example/logo.png', contentType: 'image/png', bytes: PNG_1PX }), null, 'дубликат URL пропущен');
  await p.addAsset({ url: 'https://cdn.example/f.woff2', contentType: 'font/woff2', bytes: new Uint8Array([1, 2, 3]) });
  await p.addCss({ url: 'https://shop.example/app.css', text: 'body{color:red}' });
  p.addApi([{ url: 'https://shop.example/api/products', method: 'GET', status: 200, contentType: 'application/json', body: '{"items":[]}' }, null, { method: 'GET' }]);
  return p;
}

test('CapturePackager → readZip → openCapture: манифест, страницы, ассеты, CSS, API', async () => {
  const p = await sampleCapture();
  const { bytes, manifest } = await p.finishBytes({ finishedAt: 'now' });
  assert.equal(manifest.pages.length, 2);
  assert.deepEqual(manifest.pages.map((x) => x.slug), ['index', 'index-2'], 'уникальные слаги');
  assert.deepEqual(manifest.counts, { pages: 2, api: 1, assets: 2, assetBytes: PNG_1PX.length + 3, css: 1 });
  const dir = await tmp(); const file = path.join(dir, 'capture.zip');
  await fsp.writeFile(file, bytes);
  const { files, manifest: m2 } = await openCapture(file);
  assert.equal(m2.format, FORMAT); assert.equal(m2.finishedAt, 'now');
  for (const k of ['capture.json', 'pages/index.json', 'pages/index-2.json', 'snapshots/index.json', 'screenshots/index.png', 'state/index.json', 'trackers/index.json', 'hydration/index.json', 'api/requests.json', 'assets/index.json', 'assets/files/00001.png', 'assets/files/00002.woff2', 'css/index.json', 'css/files/001.css']) assert.ok(files.has(k), k);
  assert.ok(files.get('screenshots/index.png').equals(PNG_1PX));
  assert.equal(JSON.parse(files.get('pages/index-2.json')).title, 'Catalog');
  assert.equal(JSON.parse(files.get('assets/index.json'))[0].contentType, 'image/png');
  // the same capture unpacked into a folder (symlinks are ignored)
  const unpacked = path.join(dir, 'unpacked');
  for (const [n, b] of files) { await fsp.mkdir(path.dirname(path.join(unpacked, n)), { recursive: true }); await fsp.writeFile(path.join(unpacked, n), b); }
  try { fs.symlinkSync('/etc/passwd', path.join(unpacked, 'link.txt')); } catch {}
  const fromDir = await openCapture(unpacked);
  assert.equal(fromDir.files.size, files.size);
  assert.ok(!fromDir.files.has('link.txt'));
});

test('buildCaptureZip: одна функция для всего захвата; пустой захват — ошибка', async () => {
  const r = await buildCaptureZip({ meta: { startUrl: 'https://a.example/' }, pages: [{ slug: 'home', url: 'https://a.example/', raw: rawPage() }] }, { bytes: true });
  assert.equal(readZip(Buffer.from(r.bytes)).size, 2);
  await assert.rejects(new CapturePackager().finishBytes(), /no pages/);
  await assert.rejects(new CapturePackager().addPage({ slug: 'x', url: 'https://a.example/' }), /raw is required/);
});

test('openCapture: отвергает чужие архивы, будущие версии, плохие URL и большие файлы', async () => {
  const dir = await tmp();
  const write = async (name, entries) => { const f = path.join(dir, name); await fsp.writeFile(f, await zipOf(entries)); return f; };
  const man = (o) => JSON.stringify({ format: FORMAT, version: 1, pages: [{ url: 'https://a.example/', raw: 'pages/a.json' }], ...o });
  await assert.rejects(openCapture(path.join(dir, 'missing.zip')), /не найден/);
  await assert.rejects(openCapture(await write('nomanifest.zip', [['readme.txt', 'x']])), /нет capture\.json/);
  await assert.rejects(openCapture(await write('broken.zip', [['capture.json', '{oops']])), /повреждён/);
  await assert.rejects(openCapture(await write('alien.zip', [['capture.json', man({ format: 'other' })], ['pages/a.json', '{}']])), /неизвестный формат/);
  await assert.rejects(openCapture(await write('future.zip', [['capture.json', man({ version: 99 })], ['pages/a.json', '{}']])), /обнови CLI/);
  await assert.rejects(openCapture(await write('nopages.zip', [['capture.json', man({ pages: [] })]])), /нет страниц/);
  await assert.rejects(openCapture(await write('nodata.zip', [['capture.json', man()]])), /нет данных страницы/);
  await assert.rejects(openCapture(await write('js.zip', [['capture.json', man({ pages: [{ url: 'javascript:alert(1)', raw: 'pages/a.json' }] })], ['pages/a.json', '{}']])), /некорректный URL/);
  await assert.rejects(openCapture(await write('slip.zip', [['capture.json', man({ pages: [{ url: 'https://a.example/', raw: '../pages/a.json' }] })], ['pages/a.json', '{}']])), /нет данных страницы/);
  const ok = await write('ok.zip', [['capture.json', man()], ['pages/a.json', '{}'], ['pad.bin', Buffer.alloc(1_200_000, 1), { compress: false }]]);
  assert.equal((await openCapture(ok)).manifest.pages.length, 1);
  await assert.rejects(openCapture(ok, { maxUploadMb: 1 }), /больше лимита/);
});
