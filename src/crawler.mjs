// Stage 1: Playwright crawler. BFS over same-site pages (depth N), desktop + mobile passes, screenshots,
// computed-style DOM extraction, hover/tab/accordion probes, asset download, cleaned HTML. Writes everything to outDir.
import path from 'node:path';
import { launchBrowser, newContext } from './browser.mjs';
import { extractPage } from './inpage/extract.mjs';
import { analyzeSections } from './analyze/page.mjs';
import { fontUrlsFromFaces } from './analyze/css.mjs';
import { AssetStore } from './crawl/assets.mjs';
import { loadRobots, sitemapUrls } from './crawl/robots.mjs';
import * as ops from './crawl/pageops.mjs';
import { parseSize } from './config.mjs';
import { log, color } from './log.mjs';
import { normalizeUrl, isHtmlLike, sameSite, pageSlug, templateKey, sleep, writeJSON, writeText, kebab, humanBytes } from './util.mjs';
import { walkTree } from './analyze/tree.mjs';

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

  log.step('Запуск браузера');
  const browser = await launchBrowser(opts);
  // one desktop + one mobile context per worker: pages of different contexts render in separate windows,
  // so background tabs are never throttled during hover/screenshot work
  const sheetCtx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const sheets = ops.createSheetMaker(sheetCtx);
  const workerCtx = [];
  const ctxFor = async (i) => {
    if (!workerCtx[i]) workerCtx[i] = { d: await newContext(browser, { ...desk, locale: opts.locale }), m: opts.mobile ? await newContext(browser, { ...mobV, mobile: true, locale: opts.locale }) : null };
    return workerCtx[i];
  };
  const ctxD = (await ctxFor(0)).d;
  const assets = new AssetStore(outDir, opts, ctxD.request);
  const css = new Map();
  const fonts = new Map();
  const shotDir = path.join(outDir, 'screenshots');

  // ---------- robots / sitemap ----------
  let robots = null;
  if (opts.robots) {
    robots = await loadRobots(ctxD.request, origin);
    log.info(`robots.txt: ${robots.status === 200 ? `${robots.rules} правил${robots.delay ? `, crawl-delay ${robots.delay}s` : ''}` : 'нет (' + robots.status + ')'}`);
    if (!robots.allowed(start)) { await browser.close(); throw new Error('robots.txt запрещает обход этой страницы. Если это твой сайт или у тебя есть права — запусти с --ignore-robots'); }
  } else log.warn('robots.txt игнорируется (--ignore-robots)');
  const delay = Math.max(opts.delay || 0, robots && robots.delay ? Math.min(10, robots.delay) * 1000 : 0);

  const queue = []; const seen = new Set(); let order = 0;
  const skipped = [];
  const hoverSeen = new Set(); // hover signatures probed so far (shared across pages)
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

  function attachCapture(page) {
    const pending = [];
    page.on('response', (res) => {
      try {
        const rt = res.request().resourceType(); const url = res.url();
        if (res.status() >= 300 || url.startsWith('data:')) return;
        if (rt === 'stylesheet') pending.push(res.text().then((t) => { if (!css.has(url) && t.length < 5e6) css.set(url, t); }).catch(() => {}));
        else if (rt === 'image' || rt === 'font') {
          const len = +(res.headers()['content-length'] || 0); if (len > assets.maxBytes) return;
          pending.push(res.body().then((b) => assets.offer(url, b, res.headers()['content-type'])).catch(() => {}));
        }
      } catch {}
    });
    return { flush: () => withTimeout(Promise.allSettled(pending), 15000, 'network').catch(() => {}) };
  }

  // cross-origin stylesheets are unreadable from the page (CORS) — hand their captured text to the extractor
  async function provideCss(page) {
    try {
      const hrefs = await page.evaluate(() => [...document.styleSheets].filter((s) => { try { void s.cssRules; return false; } catch (e) { return !!s.href; } }).map((s) => s.href));
      const payload = hrefs.map((h) => ({ href: h, text: css.get(h) })).filter((x) => x.text && x.text.length < 4e6);
      if (payload.length) await page.evaluate((list) => { window.__sbCss = list; }, payload);
    } catch {}
  }

  async function saveAssets(raw) {
    const jobs = [];
    raw.images.forEach((im) => { if (im.src) jobs.push(assets.save(im.src, 'images', im.alt || (im.logo ? 'logo' : '')).then((w) => { if (w) im.local = w; })); });
    raw.bgImages.forEach((b) => { if (b.src) jobs.push(assets.save(b.src, 'images', 'bg').then((w) => { if (w) b.local = w; })); });
    (raw.media || []).forEach((m) => {
      if (m.poster) jobs.push(assets.save(m.poster, 'images', 'poster').then((w) => { if (w) m.posterLocal = w; }));
      if (m.type === 'video' && m.src && !m.src.startsWith('blob:')) jobs.push(assets.save(m.src, 'media', 'video').then((w) => { if (w) m.local = w; }));
    });
    (raw.meta.favicons || []).forEach((f) => { if (f.href) jobs.push(assets.save(f.href, 'icons', 'favicon').then((w) => { if (w) f.local = w; })); });
    if (raw.meta.ogImage) jobs.push(assets.save(raw.meta.ogImage, 'images', 'og-image').then((w) => { if (w) raw.meta.ogImageLocal = w; }));
    const used = new Set((raw.loadedFonts || []).map((f) => f.family.toLowerCase()));
    const byFace = new Map();
    for (const f of fontUrlsFromFaces(raw.fontFaces || [])) {
      if (used.size && !used.has(f.family.toLowerCase())) continue;
      const k = `${f.family}|${f.weight}|${f.style}`; if (byFace.has(k)) continue; byFace.set(k, f);
    }
    for (const f of byFace.values()) {
      const key = `${f.family}|${f.weight}|${f.style}`; if (fonts.has(key)) continue;
      fonts.set(key, { ...f, web: null });
      jobs.push(assets.save(f.url, 'fonts', `${f.family}-${String(f.weight).replace(/\s+/g, '_')}-${f.style}`).then((w) => { fonts.get(key).web = w; }));
    }
    await withTimeout(Promise.allSettled(jobs), 180000, 'assets').catch((e) => log.warn(errMsg(e)));
    // rewrite url(...) in computed backgrounds to local paths
    const bgBy = new Map(); for (const b of raw.bgImages) if (b.local) bgBy.set(b.src.slice(0, 300), b.local);
    const swap = (v) => v.replace(/url\(["']?(.*?)["']?\)/g, (m, u) => { const w = assets.webPath(u) || bgBy.get(u.slice(0, 300)); if (w) return `url(${w})`; return u.startsWith('data:') ? 'url(/images/inline-image-missing.png)' : m; });
    walkTree(raw.tree, (n) => {
      if (n.s && n.s['background-image'] && n.s['background-image'].includes('url(')) n.s['background-image'] = swap(n.s['background-image']);
      for (const ps of [n.pb, n.pa]) if (ps && ps.bgi && ps.bgi.includes('url(')) ps.bgi = swap(ps.bgi);
    });
  }

  async function processMobile(ctxM, url, slug, first) {
    const page = await ctxM.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      await ops.settle(page, 6000);
      if (opts.cookies && (await ops.dismissCookies(page))) await sleep(400);
      await ops.autoScroll(page);
      await ops.waitAssets(page, 3000);
      await provideCss(page);
      const raw = await withTimeout(page.evaluate(extractPage, { maxNodes: opts.maxNodes, html: false }), 90000, 'mobile extract');
      if (!raw || !raw.tree) return null;
      for (const k of ['html', 'cssVars', 'fontFaces', 'keyframes', 'mediaQueries', 'loadedFonts', 'sheets', 'links', 'forms']) delete raw[k];
      const full = await ops.fullScreenshot(page, path.join(shotDir, 'mobile', slug + '.png'), raw.docHeight);
      const llm = full ? await sheets.make(full.file, path.join(shotDir, 'llm', slug + '-mobile'), { width: 520, maxH: 2000, max: 2, dpr: 2 }) : [];
      let burger = null;
      if (first && opts.interactions) { burger = await ops.probeBurger(page, path.join(shotDir, 'mobile', slug + '-menu.png')); if (burger) burger.screenshot = rel(burger.screenshot); }
      return { raw, finalUrl: page.url(), screenshot: full ? rel(full.file) : null, llm: llm.map((s) => ({ ...s, file: rel(s.file) })), burger };
    } catch (e) { log.warn(`Мобильная версия ${url}: ${errMsg(e)}`); return null; }
    finally { await page.close().catch(() => {}); }
  }

  async function processPage(it, c) {
    const page = await c.d.newPage();
    const cap = attachCapture(page);
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
      if (opts.cookies) { const c = await ops.dismissCookies(page); if (c) { log.debug('cookie banner:', c); await sleep(500); } }
      await ops.autoScroll(page); mark('scroll');
      await ops.waitAssets(page); mark('assets-wait');
      await provideCss(page);
      const raw = await withTimeout(page.evaluate(extractPage, { maxNodes: opts.maxNodes, html: opts.html }), 90000, 'extract');
      mark('extract');
      if (!raw || raw.error || !raw.tree) { skipped.push({ url: it.url, reason: 'не удалось извлечь DOM: ' + ((raw && raw.error) || '?') }); return null; }
      if (raw.stats.truncated) log.warn(`Страница большая: взято первые ${raw.stats.nodes} узлов (--max-nodes)`);
      const html = raw.html; delete raw.html;
      if (html) await writeText(path.join(outDir, 'dom', slug + '.html'), html);
      const { sections } = analyzeSections(raw);
      const full = await ops.fullScreenshot(page, path.join(shotDir, 'desktop', slug + '.png'), raw.docHeight); mark('screenshot');
      const secShots = await ops.sectionShots(page, sections, path.join(shotDir, 'sections', slug), slug); mark('section-shots');
      const llmDesktop = full ? await sheets.make(full.file, path.join(shotDir, 'llm', slug + '-desktop'), { width: 1000, maxH: 1800, max: 4 }) : []; mark('llm-sheets');
      const probes = { hover: [], dropdowns: [], tabs: [], expand: [], details: [] };
      await page.bringToFront().catch(() => {});
      if (opts.hover) {
        probes.hover = await ops.probeHover(page, raw.interactive || [], { skip: hoverSeen });
        probes.dropdowns = (await ops.probeDropdowns(page, path.join(shotDir, 'interactions'), slug)).map((d) => ({ ...d, screenshot: rel(d.screenshot) }));
      }
      mark('hover');
      if (opts.interactions) Object.assign(probes, await ops.probeInteractions(page, raw.interactive || [])); mark('interactions');
      await cap.flush();
      await saveAssets(raw); mark('save-assets');
      const mobile = c.m ? await processMobile(c.m, finalUrl, slug, pages.length === 0 || it.depth === 0) : null; mark('mobile');
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
  const summary = {
    start, origin, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
    options: { depth: opts.depth, maxPages: opts.maxPages, perTemplate: opts.perTemplate, viewport: `${desk.width}x${desk.height}`, mobileViewport: opts.mobile ? `${mobV.width}x${mobV.height}` : null, robots: !!opts.robots },
    robots: robots ? { status: robots.status, rules: robots.rules, delay: robots.delay, sitemaps: robots.sitemaps } : null, sitemapCount,
    pages: pages.map(({ links, ...p }) => p), skipped: skipped.slice(0, 500), css: cssIndex,
    fonts: [...fonts.values()], assets: manifest,
  };
  await writeJSON(path.join(outDir, 'data', 'crawl.json'), summary);
  log.ok(`Обход завершён: ${pages.length} стр., ассетов ${manifest.saved.length} (${humanBytes(manifest.bytes)}), CSS ${cssIndex.length}, пропущено ${skipped.length} — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return summary;
}
