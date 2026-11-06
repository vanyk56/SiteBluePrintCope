// `site-blueprint verify <blueprint-dir> --url http://localhost:3000`
// Opens the running clone at every crawled route (desktop + mobile) and compares it with the original crawl:
// section positions / heights (matched by text anchors), screenshot difference per section, texts missing in the clone,
// broken images, failed requests, console errors, horizontal scroll, fonts. Writes verify/report.md + comparison images.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { launchBrowser, newContext } from '../browser.mjs';
import { loadCrawl, buildSite } from '../analyze/site.mjs';
import { kids, textOf } from '../analyze/tree.mjs';
import { autoScroll, waitAssets } from '../crawl/pageops.mjs';
import { log, color } from '../log.mjs';
import { ensureDir, writeText, exists, truncate, sleep } from '../util.mjs';

const norm = (s) => String(s || '').replace(/[\s\u00a0\u2007\u2009\u202f\u200b]+/g, ' ').trim();
const HEAD = /^h[1-6]$/;
const ownText = (n) => norm((n.k || []).filter((k) => typeof k === 'string').join(' '));

// first heading (full text) in a section, else its first text of 3+ chars
function anchorOf(node) {
  let head = null, first = null;
  (function rec(n) {
    if (head || !n) return;
    if (HEAD.test(n.t)) { const t = norm(textOf(n, 300)); if (t.length >= 2) { head = { text: t.slice(0, 80), y: n.r[1] }; return; } }
    const own = ownText(n);
    if (!first && own.length >= 3 && /[\p{L}\d]/u.test(own)) first = { text: own.slice(0, 80), y: n.r[1] };
    for (const k of kids(n)) rec(k);
  })(node);
  return head || first;
}
function treeTexts(root, max = 2500) {
  const out = new Set();
  (function rec(n) { if (out.size >= max) return; for (const k of n.k || []) { if (typeof k === 'string') { const t = norm(k); if (t.length >= 3 && /[\p{L}]/u.test(t)) out.add(t.slice(0, 200)); } else rec(k); } })(root);
  return [...out];
}

// in the clone page: measurements + anchor lookup (runs in the browser)
function measureInPage({ anchors, texts }) {
  const norm = (s) => String(s || '').replace(/[\s\u00a0\u2007\u2009\u202f\u200b]+/g, ' ').trim();
  const sy = scrollY, W = innerWidth;
  const cands = []; let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (++n > 20000) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH)$/i.test(el.tagName)) continue;
    let own = '';
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue + ' ';
    own = norm(own);
    const full = el.childElementCount && el.textContent.length < 400 ? norm(el.textContent) : own;
    if (!own && !full) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue;
    cands.push({ own, full, y: Math.round(r.top + sy), heading: /^H[1-6]$/.test(el.tagName) });
  }
  cands.sort((a, b) => a.y - b.y);
  let cursor = -1e9;
  const found = anchors.map((a) => {
    if (!a) return null;
    const A = a.text;
    const ok = (c) => c.y >= cursor - 30;
    const prefs = [(c) => c.own === A, (c) => c.heading && c.full === A, (c) => c.full === A, (c) => c.own.startsWith(A) || c.full.startsWith(A), (c) => A.length >= 12 && c.full.length >= A.length * 0.7 && A.startsWith(c.full)];
    let hit = null;
    for (const f of prefs) { hit = cands.find((c) => ok(c) && f(c)); if (hit) break; }
    if (!hit) hit = cands.find((c) => c.own === A || c.full === A) || null; // out of order: still report it
    if (hit && hit.y >= cursor) cursor = hit.y;
    return hit ? hit.y : null;
  });
  const all = norm(document.body.textContent);
  const missing = texts.filter((t) => !all.includes(t));
  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.getAttribute('src'))).map((i) => i.currentSrc || i.getAttribute('src')).slice(0, 30);
  const docW = document.documentElement.scrollWidth; const over = Math.max(0, docW - W);
  const wide = [];
  if (over > 1) {
    const desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 3).map((c) => '.' + c).join('');
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect(); if (r.right <= W + 1 || r.width < 1) continue;
      const p = el.parentElement; if (p && p !== document.body && p.getBoundingClientRect().right > W + 1) continue;
      wide.push(`${desc(el)} (${Math.round(r.width)}px, правый край ${Math.round(r.right)}px)`); if (wide.length >= 6) break;
    }
  }
  const fonts = document.fonts ? [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, '')) : [];
  return { found, missing, broken, over, wide, fonts: [...new Set(fonts)], docH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), vw: W };
}

// pixel comparison of section crops (original vs clone) + composite image [original | clone | diff]
async function diffInPage({ a, b, cssA, cssB, secs, tile }) {
  const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('не загрузился ' + src)); im.src = src; });
  const [A, B] = await Promise.all([load(a), load(b)]);
  const kA = A.naturalWidth / cssA, kB = B.naturalWidth / cssB;
  const sc = tile / cssA;
  const LBL = 20, GAP = 6;
  const rows = []; let total = 0, bad = 0;
  for (const s of secs) {
    const h = Math.min(s.h, 5000);
    const th = Math.max(8, Math.round(h * sc));
    const mk = () => { const c = document.createElement('canvas'); c.width = tile; c.height = th; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, tile, th); return [c, x]; };
    const [ca, xa] = mk(), [cb, xb] = mk();
    const ay = s.top * kA, ah = Math.min(h * kA, A.naturalHeight - ay);
    if (ah > 0) xa.drawImage(A, 0, ay, A.naturalWidth, ah, 0, 0, tile, Math.round(ah / kA * sc));
    const by = Math.max(0, s.ctop) * kB, bh = Math.min(h * kB, B.naturalHeight - by);
    if (bh > 0 && s.ctop !== null) xb.drawImage(B, 0, by, B.naturalWidth, bh, 0, 0, tile, Math.round(bh / kB * sc));
    const da = xa.getImageData(0, 0, tile, th).data, db = xb.getImageData(0, 0, tile, th).data;
    const [cd, xd] = mk(); const out = xd.createImageData(tile, th); const o = out.data;
    let miss = 0; const T = 60;
    const px = (d, i) => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    for (let y = 0; y < th; y++) for (let x = 0; x < tile; x++) {
      const i = (y * tile + x) * 4;
      let best = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (best > T) {
        for (let dy = -1; dy <= 1 && best > T; dy++) for (let dx = -1; dx <= 1 && best > T; dx++) {
          const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= th || xx >= tile) continue;
          const j = (yy * tile + xx) * 4; const d = Math.abs(da[i] - db[j]) + Math.abs(da[i + 1] - db[j + 1]) + Math.abs(da[i + 2] - db[j + 2]); if (d < best) best = d;
        }
      }
      const g = 175 + px(da, i) * 0.3;
      if (best > T) { miss++; o[i] = 235; o[i + 1] = 30; o[i + 2] = 60; } else { o[i] = o[i + 1] = o[i + 2] = g; }
      o[i + 3] = 255;
    }
    xd.putImageData(out, 0, 0);
    total += tile * th; bad += miss;
    rows.push({ ca, cb, cd, th, pct: miss / (tile * th), label: s.label });
  }
  const W = tile * 3 + GAP * 2, H = rows.reduce((t, r) => t + r.th + LBL + GAP, 0) + LBL;
  const C = document.createElement('canvas'); C.width = W; C.height = Math.min(H, 30000); const X = C.getContext('2d');
  X.fillStyle = '#f4f4f5'; X.fillRect(0, 0, W, C.height); X.font = '12px sans-serif'; X.fillStyle = '#111';
  X.fillText('оригинал', 4, 14); X.fillText('клон', tile + GAP + 4, 14); X.fillText('отличия (красным)', 2 * (tile + GAP) + 4, 14);
  let y = LBL;
  for (const r of rows) {
    if (y + LBL + r.th > C.height) break;
    X.fillStyle = r.pct > 0.2 ? '#b91c1c' : '#111'; X.fillText(`${r.label} — отличие ${(r.pct * 100).toFixed(1)}%`, 4, y + 14); y += LBL;
    X.drawImage(r.ca, 0, y); X.drawImage(r.cb, tile + GAP, y); X.drawImage(r.cd, 2 * (tile + GAP), y); y += r.th + GAP;
  }
  return { pcts: rows.map((r) => r.pct), overall: total ? bad / total : 0, png: C.toDataURL('image/png') };
}

export async function verify(dir, opts = {}) {
  if (!dir) { log.error('Укажи папку блюпринта: site-blueprint verify <папка> --url http://localhost:3000'); return 2; }
  dir = path.resolve(String(dir));
  if (!(await exists(path.join(dir, 'data', 'crawl.json')))) { log.error(`В ${dir} нет data/crawl.json — укажи папку, которую создал site-blueprint.`); return 2; }
  const base = String(opts.url && opts.url !== true ? opts.url : 'http://localhost:3000').replace(/\/+$/, '');
  log.step(`Сверка клона ${base} с оригиналом`);
  const data = await loadCrawl(dir);
  const site = buildSite(data, opts);
  const only = opts.routes && opts.routes !== true ? new Set(String(opts.routes).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const pages = site.pages.filter((p) => !only || only.has(p.route)).slice(0, Number(opts.maxPages) || 15);
  const vDir = await ensureDir(path.join(dir, 'verify'));
  const browser = await launchBrowser(opts);
  const files = new Map(); let fileSeq = 0;
  const dctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const dpage = await dctx.newPage();
  await dpage.route('http://sb-verify.local/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>diff</title>' });
    const f = files.get(u.pathname); return f ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
  });
  await dpage.goto('http://sb-verify.local/');
  const serve = (f) => { const k = `/f${++fileSeq}.png`; files.set(k, f); return 'http://sb-verify.local' + k; };
  const results = []; let reachable = 0;
  const expectedFonts = [...new Set((data.crawl.fonts || []).filter((f) => f.web).map((f) => f.family))];
  try {
    for (const p of pages) {
      const views = [{ name: 'desktop', vp: p.raw.viewport, tree: p.raw.tree, docH: p.raw.docHeight, shot: p.rec.shots && p.rec.shots.desktop, mobile: false }];
      if (opts.mobile !== false && p.rec.mobile && p.rec.mobile.raw && p.mob) views.push({ name: 'mobile', vp: p.rec.mobile.raw.viewport, tree: p.rec.mobile.raw.tree, docH: p.rec.mobile.raw.docHeight, shot: p.rec.mobile.screenshot, mobile: true });
      for (const V of views) {
        const url = new URL(p.route, base + '/').href;
        const R = { route: p.route, slug: p.slug, view: V.name, width: V.vp.w, url, errors: [], failed: [], sections: [] };
        results.push(R);
        // original sections in this viewport (+ text anchor of each)
        const secs = [];
        for (const s of p.sections) {
          const node = V.mobile ? p.mob.map.get(s.node._p) : s.node;
          if (!node || !node.r || node.r[3] < 4) continue;
          const comp = (p.blocks.find((b) => b.section === s) || {}).comp || site.globals.find((g) => g.type === s.type && (g.usedOn.has(p.slug))) || null;
          secs.push({ label: comp ? comp.name : s.type, type: s.type, top: node.r[1], h: node.r[3], anchor: anchorOf(node) });
        }
        const ctx = await newContext(browser, { width: V.vp.w, height: V.vp.h, mobile: V.mobile, locale: opts.locale });
        const page = await ctx.newPage();
        page.on('console', (m) => { if (m.type() === 'error' && R.errors.length < 20) R.errors.push(truncate(m.text().replace(/\s+/g, ' '), 300)); });
        page.on('pageerror', (e) => { if (R.errors.length < 20) R.errors.push(truncate('JS: ' + String(e.message || e).replace(/\s+/g, ' '), 300)); });
        page.on('response', (r) => { try { if (r.status() >= 400 && new URL(r.url()).origin === new URL(base).origin && R.failed.length < 30) R.failed.push(`${r.status()} ${new URL(r.url()).pathname}`); } catch {} });
        try {
          try { await page.goto(url, { waitUntil: 'load', timeout: 90000 }); }
          catch (e) { R.fatal = `не открылась: ${String(e.message).split('\n')[0]}`; log.warn(`${p.route} (${V.name}): ${R.fatal}`); continue; }
          reachable++;
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await autoScroll(page, { budgetMs: 15000 });
          await waitAssets(page, 8000);
          await page.evaluate(() => window.scrollTo(0, 0)); await sleep(400);
          const texts = treeTexts(V.tree);
          const m = await page.evaluate(measureInPage, { anchors: secs.map((s) => s.anchor), texts });
          Object.assign(R, { docH: m.docH, origDocH: V.docH, missing: m.missing, missingTotal: texts.length, broken: m.broken, over: m.over, wide: m.wide });
          R.fontsMissing = expectedFonts.filter((f) => !m.fonts.some((x) => x.toLowerCase().includes(f.toLowerCase().replace(/["']/g, ''))));
          // section geometry in the clone (by anchor drift)
          let lastDrift = 0;
          secs.forEach((s, i) => {
            const y = m.found[i];
            s.drift = y !== null && y !== undefined && s.anchor ? y - s.anchor.y : null;
            s.ctop = s.drift !== null ? s.top + s.drift : s.top + lastDrift;
            if (s.drift !== null) lastDrift = s.drift;
          });
          secs.forEach((s, i) => {
            const nx = secs.slice(i + 1).find((x) => x.drift !== null);
            if (s.drift === null) s.dh = null;
            else if (nx) s.dh = (nx.drift - s.drift);
            else s.dh = (m.docH - V.docH) - s.drift;
          });
          // screenshots + visual diff
          const shotFile = path.join(vDir, `${p.slug}-${V.name}.png`);
          const clip = m.docH > 16000 ? { x: 0, y: 0, width: m.vw, height: 16000 } : undefined;
          await page.screenshot({ path: shotFile, fullPage: true, animations: 'disabled', scale: 'css', timeout: 90000, ...(clip ? { clip } : {}) }).catch((e) => { R.errors.push('скриншот: ' + String(e.message).split('\n')[0]); });
          R.shot = path.relative(dir, shotFile);
          const orig = V.shot ? path.join(dir, V.shot) : null;
          if (orig && (await exists(orig)) && (await exists(shotFile)) && secs.length) {
            try {
              const d = await dpage.evaluate(diffInPage, { a: serve(orig), b: serve(shotFile), cssA: V.vp.w, cssB: m.vw, secs: secs.map((s) => ({ label: s.label, top: s.top, h: s.h, ctop: s.ctop })), tile: V.mobile ? 260 : 340 });
              d.pcts.forEach((x, i) => { secs[i].pct = x; });
              R.visual = d.overall;
              const diffFile = path.join(vDir, `${p.slug}-${V.name}-compare.png`);
              await fsp.writeFile(diffFile, Buffer.from(d.png.split(',')[1], 'base64'));
              R.compare = path.relative(dir, diffFile);
            } catch (e) { R.errors.push('сравнение скриншотов: ' + String(e.message).split('\n')[0]); }
          }
          R.sections = secs.map((s) => ({ label: s.label, anchor: s.anchor ? s.anchor.text : '', top: s.top, h: s.h, drift: s.drift, dh: s.dh, pct: s.pct }));
          log.ok(`${p.route} · ${V.name}: высота ${V.docH}→${m.docH}px, отличие ${R.visual !== undefined ? (R.visual * 100).toFixed(1) + '%' : '—'}, нет текстов ${m.missing.length}, битых картинок ${m.broken.length}, ошибок ${R.errors.length}${m.over > 1 ? color.yellow(`, гориз. скролл +${m.over}px`) : ''}`);
        } finally { await ctx.close().catch(() => {}); }
      }
    }
  } finally {
    await dctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  if (!reachable) { log.error(`Клон не отвечает по ${base}. Запусти его: cd project && npm install && npm run dev — и повтори verify.`); return 1; }
  const md = report(site, base, results, dir);
  await writeText(path.join(vDir, 'report.md'), md);
  await fsp.writeFile(path.join(vDir, 'report.json'), JSON.stringify(results, null, 2));
  const worst = results.filter((r) => !r.fatal).sort((a, b) => (b.visual || 0) - (a.visual || 0))[0];
  console.log('\n' + color.green(color.bold('Сверка готова')) + `: ${path.relative(process.cwd(), path.join(vDir, 'report.md')) || 'verify/report.md'}`);
  if (worst && worst.visual !== undefined) console.log(color.dim(`  сильнее всего отличается ${worst.route} (${worst.view}): ${(worst.visual * 100).toFixed(1)}% — см. ${worst.compare}`));
  console.log(color.dim('  Отдай verify/report.md и картинки *-compare.png ИИ-кодеру: «исправь расхождения из отчёта».\n'));
  const minSim = opts.failUnder !== undefined ? Number(opts.failUnder) : (opts.strict ? Number(opts.minSimilarity ?? 0.85) : null);
  if (minSim !== null && !Number.isNaN(minSim) && worst && worst.visual !== undefined && (1 - worst.visual) < minSim) {
    log.error(`Сходство ${(100 * (1 - worst.visual)).toFixed(1)}% ниже порога ${(minSim * 100).toFixed(1)}% (${worst.route} · ${worst.view})`);
    return 3;
  }
  return 0;
}

function report(site, base, results, dir) {
  const pct = (x) => (x === undefined || x === null ? '—' : (x * 100).toFixed(1) + '%');
  const px = (x) => (x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + Math.round(x) + 'px');
  const L = [`# Сверка клона с оригиналом`, '', `Оригинал: ${site.origin} · клон: ${base} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '',
    '> Как читать: «смещение» — насколько ниже/выше начинается секция в клоне; «Δ высоты» — насколько секция выше/ниже оригинала; «отличие» — доля пикселей, не совпавших со скриншотом оригинала (сравниваются кадры секций, выровненные по тексту-якорю). Картинки *-compare.png: оригинал | клон | отличия.', '',
    '## Итог', '', '| Страница | Вьюпорт | Высота ориг → клон | Отличие | Секции найдены | Нет текстов | Битые картинки / 4xx | Ошибки консоли | Гориз. скролл |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    if (r.fatal) { L.push(`| ${r.route} | ${r.view} ${r.width}px | ✗ ${r.fatal} | | | | | | |`); continue; }
    const found = r.sections.filter((s) => s.drift !== null).length;
    L.push(`| ${r.route} | ${r.view} ${r.width}px | ${r.origDocH} → ${r.docH} (${px(r.docH - r.origDocH)}) | ${pct(r.visual)} | ${found}/${r.sections.length} | ${r.missing.length}/${r.missingTotal} | ${r.broken.length} / ${r.failed.length} | ${r.errors.length} | ${r.over > 1 ? '⚠ +' + r.over + 'px' : 'нет'} |`);
  }
  L.push('');
  for (const r of results) {
    if (r.fatal) continue;
    L.push(`## ${r.route} — ${r.view} ${r.width}px`, '');
    L.push(`Скриншот клона: \`${r.shot || '—'}\`${r.compare ? ` · сравнение: \`${r.compare}\`` : ''}`, '');
    if (r.sections.length) {
      L.push('| # | Секция | Якорь | Смещение | Δ высоты | Отличие | |', '|---|---|---|---|---|---|---|');
      r.sections.forEach((s, i) => {
        const flags = [];
        if (s.drift === null) flags.push('⚠ якорь не найден — секции нет или текст изменён');
        if (s.dh !== null && Math.abs(s.dh) > Math.max(24, s.h * 0.08)) flags.push(`⚠ ${s.dh > 0 ? 'выше' : 'ниже'} оригинала на ${Math.abs(Math.round(s.dh))}px`);
        if (s.pct > 0.2) flags.push('⚠ сильное визуальное отличие');
        L.push(`| ${i + 1} | ${s.label} | ${s.anchor ? '«' + truncate(s.anchor, 50).replace(/\|/g, '/') + '»' : '—'} | ${px(s.drift)} | ${px(s.dh)} | ${pct(s.pct)} | ${flags.join('; ')} |`);
      });
      L.push('');
    }
    if (r.missing.length) L.push(`**Тексты оригинала, которых нет в клоне (${r.missing.length}):** ${r.missing.slice(0, 25).map((t) => '«' + truncate(t, 90) + '»').join(', ')}${r.missing.length > 25 ? ' …' : ''}`, '');
    if (r.broken.length) L.push(`**Битые картинки:** ${r.broken.map((x) => '`' + x + '`').join(', ')}`, '');
    if (r.failed.length) L.push(`**Ответы 4xx/5xx:** ${r.failed.map((x) => '`' + x + '`').join(', ')}`, '');
    if (r.errors.length) L.push('**Ошибки консоли:**', '', ...r.errors.map((e) => '- ' + e), '');
    if (r.over > 1) L.push(`**Горизонтальная прокрутка +${r.over}px** — элементы шире экрана: ${r.wide.join('; ') || '—'}`, '');
    if (r.fontsMissing && r.fontsMissing.length) L.push(`**Не загружены шрифты:** ${r.fontsMissing.join(', ')} (проверь @font-face в globals.css или next/font)`, '');
  }
  L.push('---', '', 'Повторить сверку после правок: `site-blueprint verify ' + path.basename(dir) + ' --url ' + base + '`', '');
  return L.join('\n');
}
