// Unit tests: tracker catalogue, HTML sanitizer, plugin hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { trackerOf, scanText, BLOCK_RE, mergeTrackers } from '../../src/sanitize/trackers.mjs';
import { sanitizeHtml, detectRouters } from '../../src/sanitize/html.mjs';
import { Hooks, loadPlugins, createHooks } from '../../src/core/hooks.mjs';

const GTM = `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-K7X2ABC');</script>`;
const YM = `<script type="text/javascript">(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym"); ym(98765432, "init", { clickmap:true, webvisor:true });</script><noscript><div><img src="https://mc.yandex.ru/watch/98765432" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;
const FB = `<script>!function(f,b,e,v,n,t,s){}(window, document,'script','https://connect.facebook.net/en_US/fbevents.js'); fbq('init', '1234567890123'); fbq('track', 'PageView');</script>`;
const VK = `<script>!function(){var t=document.createElement("script");t.src="https://vk.com/js/api/openapi.js?169",t.onload=function(){VK.Retargeting.Init("VK-RTRG-1234567-abcDE"),VK.Retargeting.Hit()},document.head.appendChild(t)}();</script>`;
const ROI = `<script>(function(w, d, s, h, id) { w.roistatProjectId = id; w.roistatHost = h; })(window, document, 'script', 'cloud.roistat.com', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');</script>`;
const NEXT = `<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script><link rel="preload" as="script" href="/_next/static/chunks/main.js"><next-route-announcer><p aria-live="assertive"></p></next-route-announcer>`;

test('trackerOf: хосты и пути', () => {
  assert.equal(trackerOf('https://mc.yandex.ru/watch/1').id, 'ym');
  assert.equal(trackerOf('https://www.googletagmanager.com/gtm.js?id=GTM-1').id, 'gtm');
  assert.equal(trackerOf('https://www.facebook.com/tr?id=1&ev=PageView').id, 'fb');
  assert.equal(trackerOf('https://vk.com/rtrg?p=VK-RTRG-1').id, 'vk');
  assert.equal(trackerOf('https://cloud.roistat.com/api/site/1.0/x').id, 'roistat');
  assert.equal(trackerOf('https://example.com/api/products'), null);
  assert.ok(BLOCK_RE.test('https://mc.yandex.ru/metrika/tag.js'));
  assert.ok(!BLOCK_RE.test('https://example.com/app.js'));
});

test('scanText: счётчики и их id', () => {
  const ids = Object.fromEntries(scanText(GTM + YM + FB + VK + ROI).map((t) => [t.id, t.ids]));
  assert.deepEqual(ids.gtm, ['GTM-K7X2ABC']);
  assert.ok(ids.ym.includes('98765432'));
  assert.deepEqual(ids.fb, ['1234567890123']);
  assert.ok(ids.vk.includes('VK-RTRG-1234567-abcDE'));
  assert.ok('roistat' in ids);
});

test('sanitizeHtml: вычищает трекеры, роутеры, обработчики', () => {
  const html = `<html><head><base href="https://x.com/"><meta http-equiv="refresh" content="5;url=/x">${GTM}${NEXT}<script type="application/ld+json">{"@type":"Organization"}</script></head>`
    + `<body><div x-cloak data-reactroot="" onclick="track()"><a href="javascript:void(0)" onmouseover="x()">Меню</a></div>${YM}${FB}${VK}${ROI}`
    + `<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-K7X2ABC" height="0" width="0"></iframe><img src="https://www.facebook.com/tr?id=1&ev=PageView" height="1" width="1"><img src="/logo.png" alt="logo"></body></html>`;
  const { html: out, report } = sanitizeHtml(html);
  for (const bad of ['<script>', 'googletagmanager', 'mc.yandex', 'fbq(', 'VK.Retargeting', 'roistat', '__NEXT_DATA__', 'onclick', 'onmouseover', 'x-cloak', 'data-reactroot', '<base', 'http-equiv', 'next-route-announcer', 'facebook.com/tr', 'rel="preload"'])
    assert.ok(!out.includes(bad), 'осталось: ' + bad);
  assert.ok(out.includes('application/ld+json'), 'JSON-LD — это контент, остаётся');
  assert.ok(out.includes('<img src="/logo.png" alt="logo">'));
  assert.ok(out.includes('href="#"'));
  const names = report.trackers.map((t) => t.id).sort();
  for (const id of ['fb', 'gtm', 'roistat', 'vk', 'ym']) assert.ok(names.includes(id), 'не найден ' + id);
  assert.ok(report.routers.some((r) => r.id === 'next'));
  assert.equal(report.handlers, 2); assert.equal(report.cloaks, 1);
});

test('detectRouters / mergeTrackers', () => {
  assert.deepEqual(detectRouters('<div id="__nuxt"></div><script>window.__NUXT__={}</script>').map((r) => r.id), ['nuxt']);
  const m = mergeTrackers([{ page: 'index', items: [{ id: 'ym', name: 'Яндекс.Метрика', ids: ['1'] }] }, { page: 'about', items: [{ id: 'ym', name: 'Яндекс.Метрика', ids: ['1', '2'] }] }]);
  assert.deepEqual(m[0].ids, ['1', '2']); assert.deepEqual(m[0].pages, ['index', 'about']);
});

test('Hooks: порядок, waterfall, first, изоляция ошибок', async () => {
  const calls = [];
  const h = new Hooks([
    { name: 'a', hooks: { beforeStart: () => calls.push('a'), generateFilename: (n) => n + '-a', beforeRequest: () => undefined } },
    { name: 'b', apply(register) { register('beforeStart', () => { throw new Error('boom'); }); register('generateFilename', (n, ctx) => `${n}-${ctx.ext}`); register('beforeRequest', ({ url }) => (url.includes('ads') ? { abort: true } : undefined)); } },
  ]);
  await h.emit('beforeStart', {});
  assert.deepEqual(calls, ['a'], 'ошибка плагина b не ломает конвейер');
  assert.equal(await h.waterfall('generateFilename', 'logo', { ext: 'png' }), 'logo-a-png');
  assert.deepEqual(await h.first('beforeRequest', { url: 'https://x/ads.js' }), { abort: true });
  assert.equal(await h.first('beforeRequest', { url: 'https://x/app.js' }), undefined);
  assert.throws(() => h.on('nope', () => {}), /неизвестный хук/);
  assert.ok(h.has('generateFilename') && !h.has('afterFinish'));
});

test('loadPlugins: путь к файлу (Windows/POSIX) через pathToFileURL', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-plugin-'));
  const file = path.join(dir, 'my plugin.mjs');
  await fsp.writeFile(file, "export default { name: 'demo', hooks: { generateFilename: (n) => 'x-' + n } };\n");
  try {
    const [{ plugin }] = await loadPlugins([file]);
    assert.equal(plugin.name, 'demo');
    const hooks = await createHooks({ plugin: file });
    assert.equal(await hooks.waterfall('generateFilename', 'logo', {}), 'x-logo');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
