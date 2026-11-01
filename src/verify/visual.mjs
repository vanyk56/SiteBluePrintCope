// Visual regression: screenshots of the original (taken during the crawl) vs the running clone.
// pixelmatch (anti-aliasing aware, YIQ colour distance) per page and per section band, diff images and
// side-by-side composites (original | clone | diff) in verify/visual/.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists } from '../util.mjs';

let LIBS = null;
export async function loadLibs() {
  if (LIBS) return LIBS;
  let PNG = null; let pixelmatch = null;
  try { const m = await import('pngjs'); PNG = m.PNG || (m.default && m.default.PNG) || null; } catch {}
  try { const m = await import('pixelmatch'); pixelmatch = m.default || m; } catch {}
  LIBS = { PNG, pixelmatch };
  return LIBS;
}

// fallback diff (no pixelmatch installed): YIQ distance like pixelmatch, without anti-aliasing detection
function simpleMatch(a, b, out, w, h, { threshold = 0.1 } = {}) {
  const maxDelta = 35215 * threshold * threshold; let diff = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    const r1 = a[i], g1 = a[i + 1], b1 = a[i + 2], r2 = b[i], g2 = b[i + 1], b2 = b[i + 2];
    const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
    const ii = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
    const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
    const d = 0.5053 * y * y + 0.299 * ii * ii + 0.1957 * q * q;
    if (d > maxDelta) { diff++; if (out) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255; } }
    else if (out) { const g = 255 + ((r1 * 0.299 + g1 * 0.587 + b1 * 0.114) - 255) * 0.1; out[i] = out[i + 1] = out[i + 2] = g; out[i + 3] = 255; }
  }
  return diff;
}

// RGBA canvas of w×h with img at the top-left, the rest filled with `fill`
export function padTo(img, w, h, fill = [255, 255, 255, 255]) {
  if (img.width === w && img.height === h) return img.data;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(fill, i * 4);
  const cw = Math.min(w, img.width); const ch = Math.min(h, img.height);
  for (let y = 0; y < ch; y++) img.data.copy(out, y * w * 4, y * img.width * 4, y * img.width * 4 + cw * 4);
  return out;
}
// integer box downscale (for composites)
export function downscale(data, w, h, f) {
  if (f <= 1) return { data, width: w, height: h };
  const W = Math.max(1, Math.floor(w / f)); const H = Math.max(1, Math.floor(h / f)); const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0, 0]; let n = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const i = ((y * f + dy) * w + (x * f + dx)) * 4; acc[0] += data[i]; acc[1] += data[i + 1]; acc[2] += data[i + 2]; acc[3] += data[i + 3]; n++; }
    const o = (y * W + x) * 4; out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = acc[3] / n;
  }
  return { data: out, width: W, height: H };
}

/**
 * Compare two PNG buffers.
 * @returns {{ width, height, diffPixels, similarity, bands: [{ name, y, h, similarity }], diffPng: Buffer, compositePng: Buffer|null }}
 */
export async function comparePng(bufA, bufB, { threshold = 0.1, maxHeight = 12000, bands = [], composite = true, compositeWidth = 1400 } = {}) {
  const { PNG, pixelmatch } = await loadLibs();
  if (!PNG) throw new Error('нет пакета pngjs (npm install)');
  const a = PNG.sync.read(bufA); const b = PNG.sync.read(bufB);
  const w = Math.max(a.width, b.width); const h = Math.min(maxHeight, Math.max(a.height, b.height));
  const A = padTo(a, w, h); const B = padTo(b, w, h);
  const out = Buffer.alloc(w * h * 4);
  const opts = { threshold, includeAA: false, alpha: 0.15, diffColor: [255, 0, 80] };
  const diffPixels = pixelmatch ? pixelmatch(A, B, out, w, h, opts) : simpleMatch(A, B, out, w, h, opts);
  // per band: share of red pixels in the diff image
  const bandRes = [];
  for (const band of bands) {
    const y0 = Math.max(0, Math.round(band.y)); const y1 = Math.min(h, Math.round(band.y + band.h));
    if (y1 - y0 < 4) continue;
    let d = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 80) d++; }
    if (!pixelmatch) { d = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 0) d++; } }
    bandRes.push({ ...band, similarity: 1 - d / ((y1 - y0) * w) });
  }
  const diffPng = PNG.sync.write({ width: w, height: h, data: out });
  let compositePng = null;
  if (composite) {
    const f = Math.max(1, Math.ceil((w * 3) / compositeWidth));
    const parts = [downscale(A, w, h, f), downscale(B, w, h, f), downscale(out, w, h, f)];
    const gap = 8; const W = parts.reduce((s, p) => s + p.width, 0) + gap * 2; const H = parts[0].height;
    const c = Buffer.alloc(W * H * 4, 0xcc);
    let ox = 0;
    for (const p of parts) { for (let y = 0; y < p.height; y++) p.data.copy(c, (y * W + ox) * 4, y * p.width * 4, (y + 1) * p.width * 4); ox += p.width + gap; }
    compositePng = PNG.sync.write({ width: W, height: H, data: c });
  }
  return { width: w, height: h, heightA: a.height, heightB: b.height, diffPixels, similarity: 1 - diffPixels / (w * h), bands: bandRes, diffPng, compositePng, engine: pixelmatch ? 'pixelmatch' : 'yiq-fallback' };
}

/**
 * Screenshot every page of the running clone and compare with the crawl screenshots.
 * @param {object} o { site, outDir, baseUrl, opts }
 */
export async function visualRegression({ site, outDir, baseUrl, opts = {} }) {
  const { launchBrowser, newContext } = await import('../browser.mjs');
  const ops = await import('../crawl/pageops.mjs');
  const dir = path.join(outDir, 'verify', 'visual');
  await ensureDir(dir);
  const rel = (f) => path.relative(outDir, f).split(path.sep).join('/');
  const pages = site.pages.slice(0, opts.visualPages || 12);
  const vp = site.home.raw.viewport || { w: 1440, h: 900 };
  const mvp = site.home.mob && site.home.mob.raw && site.home.mob.raw.viewport;
  const browser = await launchBrowser(opts);
  const results = [];
  try {
    const views = [{ view: 'desktop', ctx: await newContext(browser, { width: vp.w, height: vp.h, locale: opts.locale }) }];
    if (mvp && opts.mobile !== false) views.push({ view: 'mobile', ctx: await newContext(browser, { width: mvp.w, height: mvp.h, mobile: true, locale: opts.locale }) });
    for (const p of pages) {
      for (const { view, ctx } of views) {
        const origRel = view === 'desktop' ? p.rec.shots && p.rec.shots.desktop : p.rec.mobile && p.rec.mobile.screenshot;
        if (!origRel || !(await exists(path.join(outDir, origRel)))) continue;
        const page = await ctx.newPage();
        const row = { slug: p.slug, route: p.route, view, original: origRel };
        try {
          const res = await page.goto(baseUrl + p.route, { waitUntil: 'load', timeout: opts.timeout || 45000 });
          row.status = res ? res.status() : 0;
          await ops.settle(page, 4000).catch(() => {});
          await ops.autoScroll(page).catch(() => {});
          await ops.waitAssets(page, 6000).catch(() => {});
          await ops.finishAnimations(page).catch(() => {});
          const docH = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 4000);
          const cloneFile = path.join(dir, `${p.slug}-${view}-clone.png`);
          const shot = await ops.fullScreenshot(page, cloneFile, docH);
          if (!shot) throw new Error('скриншот клона не удался');
          const bands = view === 'desktop' ? (p.sections || []).map((s, i) => ({ name: `${i + 1}. ${s.type}${s.heading ? ' «' + String(s.heading).slice(0, 40) + '»' : ''}`, y: s.node.r[1], h: s.node.r[3] })) : [];
          const cmp = await comparePng(await fsp.readFile(path.join(outDir, origRel)), await fsp.readFile(cloneFile), { threshold: opts.threshold ?? 0.1, bands });
          const diffFile = path.join(dir, `${p.slug}-${view}-diff.png`); await fsp.writeFile(diffFile, cmp.diffPng);
          let compFile = null; if (cmp.compositePng) { compFile = path.join(dir, `${p.slug}-${view}-compare.png`); await fsp.writeFile(compFile, cmp.compositePng); }
          Object.assign(row, { clone: rel(cloneFile), diff: rel(diffFile), composite: compFile ? rel(compFile) : null, similarity: cmp.similarity, heightOriginal: cmp.heightA, heightClone: cmp.heightB, bands: cmp.bands.map(({ name, y, h, similarity }) => ({ name, y, h, similarity })), engine: cmp.engine });
        } catch (e) { row.error = String((e && e.message) || e).split('\n')[0].slice(0, 300); }
        finally { await page.close().catch(() => {}); }
        results.push(row);
      }
    }
  } finally { await browser.close().catch(() => {}); }
  const ok = results.filter((r) => r.similarity !== undefined);
  return { pages: results, average: ok.length ? ok.reduce((s, r) => s + r.similarity, 0) / ok.length : null, min: ok.length ? Math.min(...ok.map((r) => r.similarity)) : null };
}
