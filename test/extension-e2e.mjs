// Real browser-extension E2E: loads extension/ unpacked into Chromium (new headless), opens the fixture shop,
// drives popup.html like a user (buttons + options), delivers the capture to an in-process `listen` server and
// checks the generated output. Opt-in (needs a Chromium build that still supports --load-extension, e.g.
// Chrome for Testing / Chromium): node test/extension-e2e.mjs [--zip] [--site] [--keep]
// The test copy of the extension gets host_permissions <all_urls> because activeTab is only granted by a real
// toolbar click, which automation cannot perform.
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
import { startListenServer } from '../src/server/listen.mjs';
import { runPipeline } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const MODE = args.has('--site') ? 'site' : 'page';
const DELIVERY = args.has('--zip') ? 'zip' : 'cli';
const exe = process.env.BROWSER_PATH || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else fail(m); };

async function checkOutput(dir) {
  const crawl = JSON.parse(await fsp.readFile(path.join(dir, 'data/crawl.json'), 'utf8'));
  ok(crawl.source === 'extension' && crawl.pages.length >= (MODE === 'site' ? 2 : 1), `crawl.json from the extension: ${crawl.pages.length} page(s): ${crawl.pages.map((p) => p.slug).join(', ')}`);
  ok(crawl.assets.saved.length >= 3, `assets saved: ${crawl.assets.saved.length} (from capture ${crawl.capture.offered})`);
  ok(crawl.api && crawl.api.count >= 2, `API mocks: ${crawl.api && crawl.api.count}`);
  const shop = crawl.pages.find((p) => p.slug === 'shop') || crawl.pages[0];
  const pg = JSON.parse(await fsp.readFile(path.join(dir, 'data/pages', shop.slug + '.json'), 'utf8'));
  ok(pg.shots.desktop && fs.existsSync(path.join(dir, pg.shots.desktop)), 'stitched screenshot present');
  ok(pg.shots.sections.length >= 2, `section crops: ${pg.shots.sections.length}`);
  ok(pg.probes.tabGroups.length >= 1, `interactive state: tab groups ${pg.probes.tabGroups.length}, dialogs ${pg.probes.dialogs.length}`);
  ok(crawl.snapshots && crawl.snapshots.count >= 1, `offline snapshots: ${crawl.snapshots && crawl.snapshots.count}`);
  ok(fs.existsSync(path.join(dir, 'project/package.json')), 'Next.js project generated');
  ok(fs.existsSync(path.join(dir, 'SITE_CLONE_BLUEPRINT.md')), 'blueprint written');
  const idx = JSON.parse(await fsp.readFile(path.join(dir, 'data/api-mocks/index.json'), 'utf8'));
  const me = idx.entries.find((e) => e.path === '/api/me');
  if (me) { const m = await fsp.readFile(path.join(dir, me.file), 'utf8'); ok(!m.includes('ivan.petrov@nimbus.dev') && !m.includes('tok_live_9f8e7d6c5b4a3210'), '/api/me mock is redacted'); }
  ok(!crawl.pages.some((p) => /private/.test(p.slug)), 'robots.txt: /private not crawled');
  console.log('  out:', dir);
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-ext-'));
const extDir = path.join(tmp, 'extension');
await fsp.cp(path.join(ROOT, 'extension'), extDir, { recursive: true });
const man = JSON.parse(await fsp.readFile(path.join(extDir, 'manifest.json'), 'utf8'));
man.host_permissions = [...new Set([...(man.host_permissions || []), '<all_urls>'])];
await fsp.writeFile(path.join(extDir, 'manifest.json'), JSON.stringify(man, null, 2));
const out = path.join(tmp, 'out');
const site = await serve(0);
const base = `http://127.0.0.1:${site.address().port}`;
const done = [];
const srv = await startListenServer({ port: 0, out, maxUploadMb: 300 }, {
  pkg: { version: 'test' }, quiet: true,
  onCapture: async (dir) => { done.push(dir); return runPipeline(dir, { llm: false, verify: false, zip: false, out }, { source: 'extension' }); },
});
const userData = path.join(tmp, 'profile');
const ctx = await chromium.launchPersistentContext(userData, {
  executablePath: exe, headless: true, viewport: { width: 1280, height: 800 }, acceptDownloads: true, downloadsPath: path.join(tmp, 'dl'),
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check'],
});
let code = 0;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId, '·', exe);
  const page = await ctx.newPage();
  await page.goto(base + '/shop', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(u)).id, base + '/shop');
  await popup.evaluate(async (s) => chrome.storage.local.set({ settings: s }), { api: true, state: true, delivery: DELIVERY, maxPages: 3, depth: 1, robots: true, port: srv.port, token: '', cdn: false });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForSelector('#btn-page:not([disabled])');
  ok((await popup.textContent('#host')).includes('127.0.0.1'), 'popup shows the target tab');
  ok((await popup.textContent('#cli')).includes('CLI test'), 'popup sees the CLI (/health): ' + (await popup.textContent('#cli')));
  const t0 = Date.now();
  await popup.click(MODE === 'site' ? '#btn-site' : '#btn-page');
  let job = null; let lastStage = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    job = (await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'sb:status' }))).job;
    if (job && job.status !== 'running') break;
    if (Date.now() - t0 > 240000) { fail('timeout, stage: ' + (job && job.stage)); break; }
    if (job && job.stage !== lastStage) { lastStage = job.stage; console.log('  … ' + job.stage); }
  }
  console.log('  job:', job && job.status, job && job.error ? job.error : '', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const l of (job && job.log) || []) console.log('   ', l);
  for (const w of (job && job.warnings) || []) console.log('    ⚠', w);
  ok(job && job.status === 'done', 'extension job finished');
  if (DELIVERY === 'cli') {
    ok(job && job.result && job.result.kind === 'cli' && job.result.status === 'done', 'CLI pipeline finished: ' + (job && job.result && job.result.outDir));
    if (done[0]) await checkOutput(done[0]);
  } else {
    ok(job && job.result && job.result.kind === 'zip', 'ZIP delivered: ' + (job && job.result && job.result.filename));
    // Playwright deletes downloads with the context — keep a copy, then run `import` on it
    if (job && job.result && job.result.filename && fs.existsSync(job.result.filename)) {
      const copy = path.join(tmp, 'capture.zip'); await fsp.copyFile(job.result.filename, copy);
      const { importCapture } = await import('../src/capture/import.mjs');
      const dir = await importCapture(copy, { out });
      await runPipeline(dir, { llm: false, verify: false, zip: false, out }, { source: 'extension' });
      await checkOutput(dir);
    } else fail('downloaded ZIP not found');
  }
} catch (e) { console.error(e); code = 1; }
finally {
  await ctx.close().catch(() => {});
  await srv.close(); site.close();
  if (!args.has('--keep')) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  else console.log('kept', tmp);
}
process.exit(code || process.exitCode || 0);
