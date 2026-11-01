// Stage 1: Playwright crawler. BFS over same-site pages (depth N), desktop + mobile passes, screenshots,
// computed-style DOM extraction, hover/tab/accordion probes, asset download, cleaned HTML. Writes everything to outDir.
import path from 'node:path';
import { launchBrowser, newContext } from './browser.mjs';
import { extractPage } from './inpage/extract.mjs';
import { analyzeSections } from './analyze/page.mjs';
import { AssetStore } from './crawl/assets.mjs';
import { saveRawAssets } from './crawl/saveassets.mjs';
import { createHooks } from './core/hooks.mjs';
import { ApiSniffer } from './capture/network.mjs';
import { SnapshotStore } from './capture/snapshot.mjs';
import { trackerOf, scanText, mergeTrackers } from './sanitize/trackers.mjs';
import { loadRobots, sitemapUrls } from './crawl/robots.mjs';
import * as ops from './crawl/pageops.mjs';
import { parseSize } from './config.mjs';
import { log, color } from './log.mjs';
import { normalizeUrl, isHtmlLike, sameSite, pageSlug, templateKey, sleep, writeJSON, writeText, kebab, humanBytes } from './util.mjs';

const SKIP_RE = /\/(logout|log-out|signout|sign-out|wp-admin|wp-login\.php|cart|checkout|basket|my-account|cdn-cgi|wp-json|xmlrpc\.php)(\/|$)|[?&](replytocom|share|add-to-cart|action|print)=/i;
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: таймаут ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t)); };
const errMsg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

export async function crawl(startUrl, opts, outDir) {
  const t0 = Date.now();
  const rel = (f) => (f ? path.relative(outDir, f).split(path.sep).join('/') : null);
  const desk = parseSize(opts.viewport, { width: 1440, height: 900 });
  const mobV = parseSize(opts.mobileViewport, { width: 390, height: 844 });
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error('Некорректный URL: ' + startUrl);
  const origin = new URL(start).origin;
  // plugins (website-scraper-style actions) + built-in API sniffer
  const sniffer = opts.api !== false ? new ApiSniffer({ outDir, origin, redact: opts.redact !== false, maxMocks: opts.maxMocks || 250 }) : null;
  const hooks = opts.hooks || (await createHooks(opts));
  if (sniffer) hooks.use(sniffer.plugin());
  await hooks.emit('beforeStart', { startUrl: start, opts, outDir });
  const blocked = new Map(); // trackers blocked at network level: id → { name, count }
  const onBlocked = (u) => { const t = trackerOf(u); const k = t ? t.id : 'consent'; const cur = blocked.get(k) || { id: k, name: t ? t.name : 'Cookie-consent SDK', count: 0 }; cur.count++; blocked.set(k, cur); };
  const pageTrackers = [];

  log.step('Запуск браузера');
  const browser = await launchBrowser(opts);
  // one desktop + one mobile context per worker: pages of different contexts render in separate windows,
  // so background tabs are never throttled during hover/screenshot work
  const sheetCtx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const sheets = ops.createSheetMaker(sheetCtx);
  const workerCtx = [];
  const ctxFor = async (i) => {
    if (!workerCtx[i]) workerCtx[i] = { d: await newContext(browser, { ...desk, locale: opts.locale, hooks, onBlocked, blockTrackers: opts.blockTrackers !== false }), m: opts.mobile ? await newContext(browser, { ...mobV, mobile: true, locale: opts.locale, hooks, onBlocked, blockTrackers: opts.blockTrackers !== false }) : null };
    return workerCtx[i];
  };
  const ctxD = (await ctxFor(0)).d;
  // downloads go through Node (retries, resume, throttling) with the browser's own UA and cookies of the URL
  let ua = '';
  try { const p = await ctxD.newPage(); ua = await p.evaluate(() => navigator.userAgent).catch(() => ''); await p.close(); } catch {}
  const assets = new AssetStore(outDir, opts, ctxD.request, {
    hooks,
    headers: { ...(ua ? { 'User-Agent': ua } : {}), Referer: origin + '/', ...(opts.locale ? { 'Accept-Language': opts.locale } : {}) },
    cookiesFor: async (u) => (await ctxD.cookies(u)).map((c) => `${c.name}=${c.value}`).join('; '),
  });
  const css = new Map();
  const fonts = new Map();
  // SingleFile-style offline snapshots of every page (desktop state right after extraction)
  const snaps = opts.snapshot !== false ? new SnapshotStore(outDir, { assets: opts.assets === false ? null : assets }) : null;
  const shotDir = path.join(outDir, 'screenshots');

  // ---------- robots / sitemap ----------
  let robots = null;
  const robotsInfo = await loadRobots(ctxD.request, origin);
  if (robotsInfo.aiBlocked && robotsInfo.aiBlocked.length) log.warn(`robots.txt закрывает сайт для ИИ-ботов (${robotsInfo.aiBlocked.slice(0, 6).join(', ')}${robotsInfo.aiBlocked.length > 6 ? '…' : ''}). Владелец против использования контента нейросетями — клонируй только с его согласия.`);
  if (opts.robots) {
    robots = robotsInfo;
    log.info(`robots.txt: ${robots.status === 200 ? `${robots.rules} правил${robots.delay ? `, crawl-delay ${robots.delay}s` : ''}` : 'нет (' + robots.status + ')'}`);
    if (!robots.allowed(start)) { await browser.close(); throw new Error('robots.txt запрещает обход этой страницы. Если это твой сайт или у тебя есть права — запусти с --ignore-robots'); }
  } else log.warn('robots.txt игнорируется (--ignore-robots)');
  const delay = Math.max(opts.delay || 0, robots && robots.delay ? Math.min(10, robots.delay) * 1000 : 0);

  const queue = []; const seen = new Set(); let order = 0;
  const skipped = [];
  const hoverSeen = new Set(); // hover signatures probed so far (shared across pages)
  const dialogSeen = new Set(); // buttons already clicked by the overlay probe (header buttons repeat on every page)
  const enqueue = (u, depth, prio, from) => {
    const url = normalizeUrl(u);
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (!sameSite(url, start, opts.subdomains)) return;
    if (!isHtmlLike(url) || SKIP_RE.test(url)) return;
    if (robots && !robots.allowed(url)) { skipped.push({ url, reason: 'robots.txt' }); return; }
    queue.push({ url, depth, prio, from, order: order++ });
  };
  enqueue(start, 0, -1, null);
  let sitemapCount = 0;
  if (opts.sitemap && opts.depth > 0 && opts.maxPages > 1) {
    const urls = await sitemapUrls(ctxD.request, [...((robots && robots.sitemaps) || []), origin + '/sitemap.xml'], opts.maxPages * 10);
    sitemapCount = urls.length;
    for (const u of urls) enqueue(u, 1, 5, 'sitemap');
    if (urls.length) log.info(`sitemap.xml: ${urls.length} адресов`);
  }

  // ---------- workers ----------
  const pages = []; const finals = new Set(); const tplCount = new Map(); const slugs = new Set();
  let active = 0;
  const pickNext = () => {
    queue.sort((a, b) => a.depth - b.depth || a.prio - b.prio || a.order - b.order);
    while (queue.length) {
      const it = queue.shift();
      const key = templateKey(it.url);
      if (it.depth > 0 && (tplCount.get(key) || 0) >= opts.perTemplate) { skipped.push({ url: it.url, reason: `шаблон ${key} (лимит --per-template ${opts.perTemplate})` }); continue; }
      tplCount.set(key, (tplCount.get(key) || 0) + 1);
      return it;
    }
    return null;
  };

  function attachCapture(page, ref) {
    const pending = [];
    page.__sbRef = ref;
    const emitResponses = hooks.has('afterResponse');
    page.on('response', (res) => {
      try {
        const rt = res.request().resourceType(); const url = res.url();
        if (emitResponses) hooks.emit('afterResponse', { response: res, url, status: res.status(), resourceType: rt, page, slug: ref.slug });
        if (res.status() >= 300 || url.startsWith('data:')) return;
        if (rt === 'stylesheet') pending.push(res.text().then((t) => { if (!css.has(url) && t.length < 5e6) css.set(url, t); }).catch(() => {}));
        else if (rt === 'image' || rt === 'font') {
          const len = +(res.headers()['content-length'] || 0); if (len > assets.maxBytes) return;
          pending.push(res.body().then((b) => assets.offer(url, b, res.headers()['content-type'])).catch(() => {}));
        }
      } catch {}
    });
    return { flush: () => withTimeout(Promise.allSettled([...pending, sniffer ? sniffer.flush() : null]), 15000, 'network').catch(() => {}) };
  }

  // cross-origin stylesheets are unreadable from the page (CORS) — hand their captured text to the extractor
  async function provideCss(page) {
    try {
      const hrefs = await page.evaluate(() => [...document.styleSheets].filter((s) => { try { void s.cssRules; return false; } catch (e) { return !!s.href; } }).map((s) => s.href));
      const payload = hrefs.map((h) => ({ href: h, text: css.get(h) })).filter((x) => x.text && x.text.length < 4e6);
      if (payload.length) await page.evaluate((list) => { window.__sbCss = list; }, payload);
    } catch {}
  }

  // trackers referenced by the page (inline snippets with counter ids + script/iframe URLs) — reported, never cloned
  async function detectTrackers(page) {
    try {
      const { srcs, inline } = await page.evaluate(() => {
        const sc = [...document.scripts];
        return {
          srcs: sc.map((x) => x.src).filter(Boolean).concat([...document.querySelectorAll('iframe[src], img[src][width="1"], img[src][height="1"]')].map((f) => f.src)).slice(0, 400),
          inline: (sc.filter((x) => !x.src).map((x) => x.textContent.slice(0, 30000)).join('\n') + '\n' + [...document.querySelectorAll('noscript')].map((n) => n.textContent).join('\n')).slice(0, 600000),
        };
      });
      const items = scanText(inline);
      for (const x of scanText(srcs.join('\n'))) { const cur = items.find((y) => y.id === x.id); if (cur) cur.ids = [...new Set([...cur.ids, ...x.ids])]; else items.push(x); }
      const have = new Set(items.map((x) => x.id));
      for (const u of srcs) { const t = trackerOf(u); if (t && !have.has(t.id)) { have.add(t.id); items.push({ id: t.id, name: t.name, ids: [], widget: !!t.widget }); } }
      return items;
    } catch { return []; }
  }

  async function processMobile(ctxM, url, slug, first) {
    const page = await ctxM.newPage();
    page.__sbRef = { slug, url, view: 'mobile' };
    if (hooks.has('afterResponse')) page.on('response', (res) => { try { hooks.emit('afterResponse', { response: res, url: res.url(), status: res.status(), resourceType: res.request().resourceType(), page, slug }); } catch {} });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      await ops.settle(page, 6000);
      if (opts.cookies && (await ops.dismissCookies(page))) await sleep(400);
      await ops.forceLazy(page);
      await ops.autoScroll(page);
      await ops.waitAssets(page, 8000);
      await ops.finishAnimations(page);
      await provideCss(page);
      await hooks.emit('beforeExtract', { page, url, slug, view: 'mobile' });
      const raw = await withTimeout(page.evaluate(extractPage, { maxNodes: opts.maxNodes, html: false }), 90000, 'mobile extract');
      if (!raw || !raw.tree) return null;
      await hooks.emit('afterExtract', { page, raw, url, slug, view: 'mobile' });
      for (const k of ['html', 'cssVars', 'fontFaces', 'keyframes', 'mediaQueries', 'loadedFonts', 'sheets', 'links', 'forms']) delete raw[k];
      const full = await ops.fullScreenshot(page, path.join(shotDir, 'mobile', slug + '.png'), raw.docHeight);
      const llm = full ? await sheets.make(full.file, path.join(shotDir, 'llm', slug + '-mobile'), { width: 520, maxH: 2000, max: 2, dpr: 2 }) : [];
      let burger = null;
      if (first && opts.interactions) { burger = await ops.probeBurger(page, path.join(shotDir, 'mobile', slug + '-menu.png')); if (burger) burger.screenshot = rel(burger.screenshot); }
      return { raw, finalUrl: page.url(), screenshot: full ? rel(full.file) : null, llm: llm.map((s) => ({ ...s, file: rel(s.file) })), burger };
    } catch (e) { log.warn(`Мобильная версия ${url}: ${errMsg(e)}`); return null; }
    finally {
      if (sniffer) await withTimeout(sniffer.flush(), 10000, 'api').catch(() => {});
      await page.close().catch(() => {});
    }
  }

  async function processPage(it, c) {
    const page = await c.d.newPage();
    const ref = { slug: null, url: it.url, view: 'desktop' };
    const cap = attachCapture(page, ref);
    const t1 = Date.now(); let tm = t1;
    const mark = (what) => { const n = Date.now(); log.debug(`${what}: ${n - tm}ms`); tm = n; };
    try {
      log.info(`${color.dim('→')} ${it.url} ${color.dim(`(глубина ${it.depth})`)}`);
      let resp = null;
      try { resp = await page.goto(it.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout }); }
      catch (e) { skipped.push({ url: it.url, reason: 'ошибка загрузки: ' + errMsg(e) }); if (it.depth === 0) throw e; return null; }
      const status = resp ? resp.status() : 0;
      const ct = resp ? resp.headers()['content-type'] || '' : '';
      if (ct && !/html|xml/i.test(ct)) { skipped.push({ url: it.url, reason: 'не HTML: ' + ct }); return null; }
      if (status >= 400 && it.depth > 0) { skipped.push({ url: it.url, reason: 'HTTP ' + status }); return null; }
      if (status >= 400) log.warn(`Стартовая страница ответила HTTP ${status} — продолжаю`);
      mark('goto');
      await ops.settle(page, 8000);
      mark('networkidle');
      const finalUrl = normalizeUrl(page.url()) || it.url;
      if (finals.has(finalUrl)) { skipped.push({ url: it.url, reason: 'дубль после редиректа → ' + finalUrl }); return null; }
      if (it.depth > 0 && !sameSite(finalUrl, start, opts.subdomains)) { skipped.push({ url: it.url, reason: 'редирект на другой сайт' }); return null; }
      finals.add(finalUrl);
      let slug = pageSlug(finalUrl); { const b = slug; let i = 2; while (slugs.has(slug)) slug = `${b}-${i++}`; } slugs.add(slug);
      ref.slug = slug;
      if (opts.cookies) { const c = await ops.dismissCookies(page); if (c) { log.debug('cookie banner:', c); await sleep(500); } }
      await ops.forceLazy(page);
      await ops.autoScroll(page); mark('scroll');
      await ops.waitAssets(page); mark('assets-wait');
      await ops.finishAnimations(page);
      await provideCss(page);
      await hooks.emit('beforeExtract', { page, url: finalUrl, slug, view: 'desktop' });
      const raw = await withTimeout(page.evaluate(extractPage, { maxNodes: opts.maxNodes, html: opts.html }), 90000, 'extract');
      mark('extract');
      if (!raw || raw.error || !raw.tree) { skipped.push({ url: it.url, reason: 'не удалось извлечь DOM: ' + ((raw && raw.error) || '?') }); return null; }
      await hooks.emit('afterExtract', { page, raw, url: finalUrl, slug, view: 'desktop' });
      pageTrackers.push({ page: slug, items: await detectTrackers(page) });
      if (snaps) {
        try { const it = await withTimeout(snaps.capture(page, slug), 60000, 'snapshot'); if (it) log.debug(`snapshot ${slug}: ${humanBytes(it.stats.bytes)}, shadow ${it.stats.shadowRoots} (closed ${it.stats.closedShadowRoots}), canvas ${it.stats.canvases}`); }
        catch (e) { log.warn(`Снимок ${slug}: ${errMsg(e)}`); }
        mark('snapshot');
      }
      if (raw.stats.truncated) log.warn(`Страница большая: взято первые ${raw.stats.nodes} узлов (--max-nodes)`);
      const html = raw.html; delete raw.html;
      if (html) await writeText(path.join(outDir, 'dom', slug + '.html'), html);
      const { sections } = analyzeSections(raw);
      const full = await ops.fullScreenshot(page, path.join(shotDir, 'desktop', slug + '.png'), raw.docHeight); mark('screenshot');
      const secShots = await ops.sectionShots(page, sections, path.join(shotDir, 'sections', slug), slug); mark('section-shots');
      if (opts.assets && (raw.media || []).some((m) => m.type === 'canvas')) {
        const cv = await ops.snapshotCanvases(page, raw.media, (i) => path.join(outDir, 'project', 'public', 'images', `canvas-${slug}-${i + 1}.png`));
        for (const c of cv) raw.media[c.index].snapshot = '/images/' + path.basename(c.file);
        mark('canvas');
      }
      const llmDesktop = full ? await sheets.make(full.file, path.join(shotDir, 'llm', slug + '-desktop'), { width: 1000, maxH: 1800, max: 4 }) : []; mark('llm-sheets');
      const probes = { hover: [], dropdowns: [], tabs: [], expand: [], details: [] };
      await page.bringToFront().catch(() => {});
      if (opts.hover) {
        probes.hover = await ops.probeHover(page, raw.interactive || [], { skip: hoverSeen });
        probes.dropdowns = (await ops.probeDropdowns(page, path.join(shotDir, 'interactions'), slug)).map((d) => ({ ...d, screenshot: rel(d.screenshot) }));
      }
      mark('hover');
      if (opts.interactions) Object.assign(probes, await ops.probeInteractions(page, raw.interactive || [])); mark('interactions');
      if (opts.interactions) { probes.dialogs = (await ops.probeDialogs(page, raw.interactive || [], path.join(shotDir, 'interactions'), slug, { skip: dialogSeen })).map((d) => ({ ...d, screenshot: rel(d.screenshot) })); mark('dialogs'); }
      await cap.flush();
      await saveRawAssets(raw, assets, fonts); mark('save-assets');
      const mobile = c.m ? await processMobile(c.m, finalUrl, slug, pages.length === 0 || it.depth === 0) : null; mark('mobile');
      if (mobile && mobile.raw && opts.assets !== false) { await saveRawAssets(mobile.raw, assets, fonts, { timeoutMs: 90000 }); mark('mobile-assets'); }
      const rec = {
        url: it.url, finalUrl, slug, depth: it.depth, from: it.from, status, title: raw.meta.title, crawledAt: new Date().toISOString(), ms: Date.now() - t1,
        sectionsFound: sections.map((s) => s.type),
        shots: { desktop: full ? rel(full.file) : null, desktopTruncated: !!(full && full.truncated), sections: secShots.map((s) => ({ ...s, file: rel(s.file) })), llm: llmDesktop.map((s) => ({ ...s, file: rel(s.file) })) },
        probes, raw, mobile,
      };
      await writeJSON(path.join(outDir, 'data', 'pages', slug + '.json'), rec, false);
      log.ok(`${slug}: ${raw.stats.nodes} узлов, ${sections.length} секций, ${raw.images.length} изобр., ${raw.svgs.length} SVG, hover ${probes.hover.length}${mobile ? ', моб. ✓' : ''} ${color.dim(((Date.now() - t1) / 1000).toFixed(1) + 's')}`);
      const prio = { header: 0, nav: 0, main: 1, footer: 2 };
      return { slug, url: it.url, finalUrl, title: raw.meta.title, depth: it.depth, status, links: raw.links.map((l) => ({ href: l.href, prio: prio[l.area] ?? 1 })) };
    } finally { await page.close().catch(() => {}); }
  }

  async function worker(wi) {
    const c = await ctxFor(wi);
    for (;;) {
      if (pages.length + active >= opts.maxPages) return;
      const it = pickNext();
      if (!it) { if (active === 0) return; await sleep(150); continue; }
      active++;
      try {
        const rec = await processPage(it, c);
        if (rec) {
          pages.push(rec);
          if (it.depth < opts.depth) for (const l of rec.links) enqueue(l.href, it.depth + 1, l.prio, rec.slug);
        }
      } catch (e) {
        if (it.depth === 0) { active--; throw e; }
        skipped.push({ url: it.url, reason: errMsg(e) }); log.warn(`${it.url}: ${errMsg(e)}`);
      }
      active = Math.max(0, active - 1);
      if (delay) await sleep(delay);
    }
  }
  log.step(`Обход сайта ${origin} (глубина ${opts.depth}, максимум ${opts.maxPages} стр.)`);
  let snapList = null;
  try {
    // first page alone (it discovers the navigation), then parallel workers
    active++;
    const first = pickNext();
    let rec;
    try { rec = await processPage(first, await ctxFor(0)); } finally { active--; }
    if (!rec) throw new Error('Не удалось загрузить стартовую страницу: ' + (skipped.at(-1)?.reason || ''));
    pages.push(rec);
    if (opts.depth > 0) for (const l of rec.links) enqueue(l.href, 1, l.prio, rec.slug);
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => worker(i)));
    // snapshots are finalized while the browser is still open (missing assets are fetched with its cookies)
    if (snaps && snaps.items.length) {
      try {
        snapList = await withTimeout(snaps.finalize(pages), 240000, 'snapshots');
        log.ok(`Автономные HTML-снимки: ${snapList.length} → snapshots/ (${humanBytes(snapList.reduce((a, x) => a + x.bytes, 0))})`);
      } catch (e) { log.warn('Снимки страниц: ' + errMsg(e)); }
    }
  } finally {
    await sheets.close();
    await browser.close().catch(() => {});
  }
  // ---------- persist shared data ----------
  const cssIndex = []; let ci = 0;
  for (const [url, text] of css) {
    let base = 'style'; try { base = kebab(path.basename(new URL(url).pathname).replace(/\.css$/i, ''), 40) || 'style'; } catch {}
    const file = path.join(outDir, 'data', 'css', `${String(++ci).padStart(2, '0')}-${base}.css`);
    await writeText(file, text); cssIndex.push({ url, file: rel(file), bytes: text.length });
  }
  const manifest = assets.manifest();
  const api = sniffer ? await sniffer.write() : null;
  if (api && api.count) log.ok(`API: записано ${api.count} ответ(ов) XHR/fetch → data/api-mocks (редакция секретов: ${api.redaction.enabled ? api.redaction.replaced + ' замен' : 'выключена'})`);
  const trackers = { found: mergeTrackers(pageTrackers), blocked: [...blocked.values()].sort((a, b) => b.count - a.count) };
  if (trackers.found.length || trackers.blocked.length) log.info(`Трекеры/виджеты (не попадут в клон): ${[...new Set([...trackers.found.map((t) => t.name), ...trackers.blocked.map((t) => t.name)])].slice(0, 8).join(', ')}`);
  const summary = {
    start, origin, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
    options: { depth: opts.depth, maxPages: opts.maxPages, perTemplate: opts.perTemplate, viewport: `${desk.width}x${desk.height}`, mobileViewport: opts.mobile ? `${mobV.width}x${mobV.height}` : null, robots: !!opts.robots },
    robots: robots ? { status: robots.status, rules: robots.rules, delay: robots.delay, sitemaps: robots.sitemaps, aiBlocked: robots.aiBlocked } : { ignored: true, aiBlocked: robotsInfo.aiBlocked }, sitemapCount,
    pages: pages.map(({ links, ...p }) => p), skipped: skipped.slice(0, 500), css: cssIndex,
    fonts: [...fonts.values()], assets: manifest,
    api: api ? { count: api.count, skipped: api.skipped, redaction: api.redaction, index: api.count ? 'data/api-mocks/index.json' : null } : null,
    trackers,
    snapshots: snapList ? { count: snapList.length, dir: 'snapshots', items: snapList } : null,
  };
  await writeJSON(path.join(outDir, 'data', 'crawl.json'), summary);
  log.ok(`Обход завершён: ${pages.length} стр., ассетов ${manifest.saved.length} (${humanBytes(manifest.bytes)}), CSS ${cssIndex.length}, пропущено ${skipped.length} — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return summary;
}
