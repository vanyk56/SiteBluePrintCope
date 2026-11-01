// Integration test of the extension → CLI path without the extension shell: the same in-page code the extension
// injects (extension/lib/hooks.js + inject/api-hook.js at document_start, lib/inpage.js + content.js afterwards)
// runs in a Playwright page of the fixture shop; the results are packed with extension/lib/package.js exactly like
// background.js does, then `importCapture()` + `runPipeline()` (no LLM, no build) must produce a full output.
// Needs Chromium (Playwright's or a system one); skipped when none is available or SB_SKIP_BROWSER=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';
import { CapturePackager } from '../../extension/lib/package.js';
import { Redactor } from '../../extension/lib/redact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ext = (f) => fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8');

async function browserOrSkip(t) {
  if (process.env.SB_SKIP_BROWSER === '1') { t.skip('SB_SKIP_BROWSER=1'); return null; }
  try { const { launchBrowser } = await import('../../src/browser.mjs'); return await launchBrowser({}); }
  catch (e) { t.skip('нет Chromium: ' + String(e.message).split('\n')[0]); return null; }
}

test('захват как в расширении → ZIP → import → pipeline: DOM, скриншот, стейт, API-моки (с редакцией), ассеты, снимок', { timeout: 240000 }, async (t) => {
  const browser = await browserOrSkip(t); if (!browser) return;
  const site = await serve(0);
  const base = `http://127.0.0.1:${site.address().port}`;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-import-'));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: ext('lib/hooks.js') });
    await ctx.addInitScript({ content: ext('inject/api-hook.js') });
    const page = await ctx.newPage();
    await page.goto(base + '/shop', { waitUntil: 'networkidle' });
    await page.addScriptTag({ content: ext('lib/inpage.js') });
    await page.addScriptTag({ content: ext('content.js') });
    const call = (name, arg) => page.evaluate(([n, a]) => window.__sbCapture[n](a), [name, arg]);
    const pull = async (k) => { const n = await call('size', k); return n < 0 ? null : page.evaluate(([key, len]) => window.__sbCapture.slice(key, 0, len), [k, n]); };

    const prep = await call('prepare', { scroll: true, budgetMs: 15000 });
    assert.ok(prep.steps >= 1, 'прокрутка для lazy-load');
    const cssMeta = await call('css');
    const ex = await call('extract', { maxNodes: 4000, html: true });
    assert.ok(!ex.error && ex.nodes > 100, JSON.stringify(ex).slice(0, 200));
    const sn = await call('snapshot', {});
    assert.ok(!sn.error && sn.size > 1000);
    await call('meta');
    const st = await call('probe', { budgetMs: 15000 });
    assert.ok(st.tabGroups >= 1, 'вкладки/фильтры каталога найдены');
    assert.ok(st.dialogs >= 1, 'модалки найдены');
    assert.equal(page.url(), base + '/shop', 'пробы не увели со страницы');
    const shot = await page.screenshot({ fullPage: true });
    const apiRaw = await call('drainApi');
    assert.ok(apiRaw.some((e) => e.url.includes('/api/products')) && apiRaw.some((e) => e.url.includes('/graphql')), 'fetch/XHR перехвачены');
    assert.ok(apiRaw.every((e) => !e.requestHeaders || !Object.keys(e.requestHeaders).some((k) => /authorization|cookie/i.test(k))), 'секретные заголовки не записаны уже в странице');

    // the service worker part (background.js): redaction, assets, CSS, packaging
    const redactor = new Redactor();
    const api = apiRaw.map((e) => ({ ...e, url: redactor.url(e.url), body: e.body && /json/.test(e.contentType) ? JSON.stringify(redactor.json(JSON.parse(e.body))) : e.body, requestHeaders: redactor.headers(e.requestHeaders || {}), page: 'shop' }));
    const pk = new CapturePackager({ mode: 'page', origin: base, start: base + '/shop', extension: { name: 'site-blueprint', version: 'test' }, options: { api: true, state: true } });
    let assets = 0;
    for (const a of ex.assets.slice(0, 25)) {
      const r = await call('fetchAsset', a.url);
      if (r.ok && await pk.addAsset({ url: a.url, contentType: r.contentType, bytes: Buffer.from(r.b64, 'base64'), page: 'shop', kind: a.kind })) assets++;
    }
    assert.ok(assets >= 3, `ассеты: ${assets}`);
    for (const c of JSON.parse((await pull('css')) || '[]')) await pk.addCss({ url: c.url, text: c.text, page: 'shop' });
    assert.ok(cssMeta.length >= 1);
    pk.addApi(api);
    await pk.addPage({ slug: 'shop', url: base + '/shop', finalUrl: ex.url, title: ex.title, raw: await pull('raw'), snapshot: await pull('snapshot'), screenshot: shot, screenshotInfo: { width: 1280, height: Math.round(shot.readUInt32BE(20)), dpr: 1 }, state: await pull('state'), trackers: await pull('trackers'), hydration: await pull('hydration') });
    await call('finish');
    await ctx.close();
    const { bytes, manifest } = await pk.finishBytes({ viewport: { width: 1280, height: 800 } });
    assert.equal(manifest.counts.pages, 1);
    const zipFile = path.join(tmp, 'capture.zip');
    await fsp.writeFile(zipFile, bytes);

    // CLI side
    const { DEFAULTS } = await import('../../src/config.mjs');
    const { importCapture } = await import('../../src/capture/import.mjs');
    const { runPipeline } = await import('../../src/cli.mjs');
    const out = path.join(tmp, 'out');
    const dir = await importCapture(zipFile, { ...DEFAULTS, out, offline: true });
    assert.match(path.basename(dir), /^127\.0\.0\.1-\d{8}-\d{4}-ext$/);
    const code = await runPipeline(dir, { ...DEFAULTS, out, llm: false, verify: false, zip: false }, { source: 'extension' });
    assert.equal(code, 0);

    const J = async (f) => JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
    const crawl = await J('data/crawl.json');
    assert.equal(crawl.source, 'extension'); assert.equal(crawl.pages.length, 1);
    assert.ok(crawl.assets.saved.length >= 3, `сохранено ассетов: ${crawl.assets.saved.length}`);
    const pg = await J(`data/pages/${crawl.pages[0].slug}.json`);
    assert.ok(fs.existsSync(path.join(dir, pg.shots.desktop)), 'скриншот');
    assert.ok(pg.shots.sections.length >= 2, `кропы секций: ${pg.shots.sections.length}`);
    assert.ok(pg.probes.tabGroups.length >= 1 && pg.probes.source === 'extension');
    const idx = await J('data/api-mocks/index.json');
    assert.ok(idx.count >= 2, `API-моки: ${idx.count}`);
    assert.ok(!idx.entries.some((e) => e.path === '/collect'), 'аналитика не попала в моки');
    const me = idx.entries.find((e) => e.path === '/api/me');
    if (me) { const m = await fsp.readFile(path.join(dir, me.file), 'utf8'); assert.ok(!m.includes('ivan.petrov@nimbus.dev') && !m.includes('tok_live_9f8e7d6c5b4a3210')); }
    assert.ok(fs.existsSync(path.join(dir, 'project/app/api/[...route]/route.ts')), 'catch-all mock route');
    assert.ok(fs.existsSync(path.join(dir, 'project/mocks/registry.ts')));
    assert.ok(fs.existsSync(path.join(dir, 'project/package.json')));
    const snap = await fsp.readFile(path.join(dir, `snapshots/${crawl.pages[0].slug}.html`), 'utf8');
    assert.ok(snap.length > 5000 && !/<script/i.test(snap), 'автономный снимок без скриптов');
    const bp = await fsp.readFile(path.join(dir, 'SITE_CLONE_BLUEPRINT.md'), 'utf8');
    assert.match(bp, /mocks\/data\//, 'blueprint описывает моки API');
    const trackers = await J('data/trackers.json').catch(() => null);
    if (trackers) assert.ok(JSON.stringify(trackers).includes('GTM-') || JSON.stringify(trackers).includes('G-'), 'трекеры найдены и задокументированы');
  } finally {
    await browser.close().catch(() => {});
    site.close();
    if (!process.env.SB_KEEP) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    else console.log('output kept:', tmp);
  }
});
