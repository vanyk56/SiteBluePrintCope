// Visual regression: screenshots of the original (taken during the crawl) vs the running clone.
// Three numbers per page and viewport:
//   similarity — section-aligned pixel similarity (primary): every section band of the original is compared with the
//                clone at its own vertical offset (elastic search in strips, so one wrapped headline does not turn
//                everything below red); a height difference still counts. Canvas/video/iframe areas are masked out.
//   strict     — the old metric: the two full-page screenshots pixel by pixel, no alignment, no masks.
//   layout     — IoU of the text blocks (same text in the original and in the clone), area-weighted.
// pixelmatch (anti-aliasing aware, YIQ colour distance); diff images (aligned) and composites (original | clone | diff).
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

const DIFF = [255, 0, 80];
const isDiffPx = (o, i) => o[i] === 255 && o[i + 1] === 0 && (o[i + 2] === 80 || o[i + 2] === 0);

// rows [y, y+h) of an RGBA buffer of width w and height H; rows outside [0, H) are white
function rowsOf(buf, w, H, y, h) {
  if (y >= 0 && y + h <= H) return buf.subarray(y * w * 4, (y + h) * w * 4);
  const out = Buffer.alloc(w * h * 4, 255);
  const s0 = Math.max(0, y), s1 = Math.min(H, y + h);
  if (s1 > s0) buf.copy(out, (s0 - y) * w * 4, s0 * w * 4, s1 * w * 4);
  return out;
}

// per-row signature: mean brightness of K column buckets (for the offset search) + "textured" flag
function signatures(buf, w, h, K) {
  const sig = new Float32Array(h * K); const tex = new Uint8Array(h);
  const bw = w / K;
  for (let y = 0; y < h; y++) {
    let mn = 1e9, mx = -1e9;
    for (let k = 0; k < K; k++) {
      const x0 = Math.floor(k * bw), x1 = Math.max(x0 + 1, Math.floor((k + 1) * bw));
      let acc = 0, n = 0;
      for (let x = x0; x < x1; x += 2) { const i = (y * w + x) * 4; acc += buf[i] * 0.299 + buf[i + 1] * 0.587 + buf[i + 2] * 0.114; n++; }
      const v = acc / n; sig[y * K + k] = v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    tex[y] = mx - mn > 4 ? 1 : 0;
  }
  return { sig, tex, K };
}

// best vertical offset d (clone row = original row + d) for original rows [y0, y1) in [prev-R, prev+R]
function bestOffset(SA, SB, hB, y0, y1, prev, R) {
  const K = SA.K; const rows = [];
  const step = y1 - y0 > 1200 ? 3 : y1 - y0 > 400 ? 2 : 1;
  for (let y = y0; y < y1; y += step) if (SA.tex[y]) rows.push(y);
  if (rows.length < Math.max(3, (y1 - y0) / step * 0.08)) return { d: prev, cost: null, evidence: false };
  const cost = (d) => {
    let c = 0;
    for (const y of rows) {
      const yb = y + d;
      if (yb < 0 || yb >= hB) { c += 255 * K; continue; }
      const a = y * K, b = yb * K;
      for (let k = 0; k < K; k++) c += Math.abs(SA.sig[a + k] - SB.sig[b + k]);
    }
    return c / (rows.length * K);
  };
  const c0 = cost(prev);
  let best = prev, bc = c0 + 0;
  const coarse = Math.max(1, Math.round(R / 48));
  for (let d = prev - R; d <= prev + R; d += coarse) { const c = cost(d) + 0.01 * Math.abs(d - prev); if (c < bc) { bc = c; best = d; } }
  for (let d = best - coarse + 1; d < best + coarse; d++) { if (d === best || Math.abs(d - prev) > R) continue; const c = cost(d) + 0.01 * Math.abs(d - prev); if (c < bc) { bc = c; best = d; } }
  // move only on clear evidence (else stay with the drift of the previous strip)
  if (best !== prev && !(bc < c0 * 0.85 - 0.3)) best = prev;
  return { d: best, cost: best === prev ? c0 : bc, evidence: true };
}

/**
 * Compare two PNG buffers (A = original, B = clone).
 * @param {object} o { threshold, maxHeight (device px), bands: [{ name, y, h }] and masks: [{ x, y, w, h }] in CSS px of A,
 *                     cssWidth (A's CSS viewport width; DPR = A.width / cssWidth), align (default true), composite }
 * @returns {{ width, height, heightA, heightB, scale, diffPixels, similarity, strict, aligned, maskedShare, bands, offsets, diffPng, compositePng, engine }}
 */
export async function comparePng(bufA, bufB, { threshold = 0.1, maxHeight = 40000, bands = [], masks = [], cssWidth = 0, align = true, composite = true, compositeWidth = 1400 } = {}) {
  const { PNG, pixelmatch } = await loadLibs();
  if (!PNG) throw new Error('нет пакета pngjs (npm install)');
  const a = PNG.sync.read(bufA); const b = PNG.sync.read(bufB);
  const w = Math.max(a.width, b.width);
  const hA = Math.min(maxHeight, a.height), hB = Math.min(maxHeight, b.height); const h = Math.max(hA, hB);
  const A = padTo(a, w, h); const B = padTo(b, w, h);
  const scale = cssWidth > 0 ? a.width / cssWidth : 1;
  const pmOpts = { threshold, includeAA: false, alpha: 0.15, diffColor: DIFF };
  const match = (x, y, out, hh) => (pixelmatch ? pixelmatch(x, y, out, w, hh, pmOpts) : simpleMatch(x, y, out, w, hh, pmOpts));
  // masks (device px, clipped)
  const M = masks.map((m) => ({ x0: Math.max(0, Math.round(m.x * scale)), y0: Math.max(0, Math.round(m.y * scale)), x1: Math.min(w, Math.round((m.x + m.w) * scale)), y1: Math.min(hA, Math.round((m.y + m.h) * scale)) })).filter((m) => m.x1 - m.x0 >= 8 && m.y1 - m.y0 >= 8);
  const maskedIn = (y0, y1) => { let n = 0; for (const m of M) { const t = Math.max(y0, m.y0), u = Math.min(y1, m.y1); if (u > t) n += (u - t) * (m.x1 - m.x0); } return n; };
  // partition of A's height: named bands (sorted, clipped so they do not overlap) + filler bands between them
  const named = bands.map((bd, i) => ({ ...bd, i, y0: Math.max(0, Math.round(bd.y * scale)), y1: Math.min(hA, Math.round((bd.y + bd.h) * scale)) }))
    .filter((bd) => bd.y1 - bd.y0 >= 4).sort((x, y) => x.y0 - y.y0);
  const parts = []; let cur = 0;
  for (const bd of named) {
    const y0 = Math.max(bd.y0, cur); if (bd.y1 - y0 < 4) continue;
    if (y0 > cur) parts.push({ y0: cur, y1: y0, filler: true });
    parts.push({ y0, y1: bd.y1, band: bd }); cur = bd.y1;
  }
  if (cur < hA) parts.push({ y0: cur, y1: hA, filler: true });
  // offsets: strips of <= 600 CSS px; the first strip of a part searches widely around the previous drift
  const K = Math.max(16, Math.min(64, Math.round(w / 24)));
  const SA = align ? signatures(A, w, hA, K) : null; const SB = align ? signatures(B, w, hB, K) : null;
  const S = Math.round(600 * scale); const R0 = Math.min(Math.round(1000 * scale), Math.max(Math.round(64 * scale), Math.abs(hB - hA) + Math.round(48 * scale)));
  const out = Buffer.alloc(w * h * 4);
  let prev = 0, alignedDiff = 0, strictDiff = 0; const offsets = [];
  for (const pt of parts) {
    pt.diff = 0; pt.strict = 0; pt.masked = maskedIn(pt.y0, pt.y1);
    for (let y = pt.y0, first = true; y < pt.y1; first = false) {
      const hh = Math.min(S, pt.y1 - y);
      const tail = pt.y1 - (y + hh) < S * 0.35 ? pt.y1 - y : hh; // no tiny last strip
      const sh = Math.min(tail, pt.y1 - y);
      const R = first ? R0 : Math.max(Math.round(16 * scale), Math.round(sh * 0.08));
      const d = align ? bestOffset(SA, SB, hB, y, y + sh, prev, R).d : 0;
      prev = d;
      const ra = A.subarray(y * w * 4, (y + sh) * w * 4);
      const o = out.subarray(y * w * 4, (y + sh) * w * 4);
      const raw0 = match(ra, rowsOf(B, w, hB, y + d, sh), o, sh); let nd = raw0;
      for (const m of M) { // masked pixels: not counted, tinted blue
        const t = Math.max(y, m.y0), u = Math.min(y + sh, m.y1); if (u <= t) continue;
        for (let yy = t; yy < u; yy++) for (let x = m.x0; x < m.x1; x++) { const i = ((yy - y) * w + x) * 4; if (isDiffPx(o, i)) nd--; o[i] = 200; o[i + 1] = 225; o[i + 2] = 255; o[i + 3] = 255; }
      }
      pt.diff += nd;
      pt.strict += d === 0 ? raw0 : match(ra, rowsOf(B, w, hB, y, sh), null, sh);
      offsets.push({ y0: y, y1: y + sh, d });
      y += sh;
    }
    alignedDiff += pt.diff; strictDiff += pt.strict;
  }
  // strict: rows of the clone below the end of the original count as different (against white padding)
  if (hB > hA) { const extra = match(rowsOf(A, w, h, hA, hB - hA), rowsOf(B, w, hB, hA, hB - hA), out.subarray(hA * w * 4, hB * w * 4), hB - hA); strictDiff += extra; }
  const masked = maskedIn(0, hA);
  const area = w * h - masked;
  // every row of the original is compared exactly once (missing content shows up there); rows the clone has in excess
  // are never compared, so they count as different
  const aligned = Math.max(0, 1 - (alignedDiff + w * Math.max(0, hB - hA)) / Math.max(1, area));
  const strict = 1 - strictDiff / (w * h);
  const bandRes = parts.filter((pt) => pt.band).map((pt) => ({ name: pt.band.name, y: pt.band.y, h: pt.band.h, similarity: 1 - pt.diff / Math.max(1, (pt.y1 - pt.y0) * w - pt.masked), strict: 1 - pt.strict / ((pt.y1 - pt.y0) * w), offset: Math.round((offsets.find((o) => o.y0 === pt.y0) || { d: 0 }).d / scale) }));
  const diffPng = PNG.sync.write({ width: w, height: h, data: out });
  let compositePng = null;
  if (composite) {
    const f = Math.max(1, Math.ceil((w * 3) / compositeWidth));
    const cparts = [downscale(A, w, h, f), downscale(B, w, h, f), downscale(out, w, h, f)];
    const gap = 8; const W = cparts.reduce((sum, p) => sum + p.width, 0) + gap * 2; const H = cparts[0].height;
    const c = Buffer.alloc(W * H * 4, 0xcc);
    let ox = 0;
    for (const p of cparts) { for (let y = 0; y < p.height; y++) p.data.copy(c, (y * W + ox) * 4, y * p.width * 4, (y + 1) * p.width * 4); ox += p.width + gap; }
    compositePng = PNG.sync.write({ width: W, height: H, data: c });
  }
  const similarity = align ? aligned : strict;
  return { width: w, height: h, heightA: a.height, heightB: b.height, scale, diffPixels: align ? alignedDiff : strictDiff, similarity, strict, aligned, maskedShare: masked / (w * h), bands: bandRes, offsets, diffPng, compositePng, engine: pixelmatch ? 'pixelmatch' : 'yiq-fallback' };
}

// ---------- layout: text blocks of the original (crawl tree) vs the clone (live DOM) ----------
const normText = (s) => String(s || '').replace(/[\s\u00a0\u2007\u2009\u202f\u200b]+/g, ' ').trim();
export function treeBlocks(root, max = 2500) {
  const out = [];
  (function rec(n) {
    if (!n || out.length >= max) return;
    const own = normText((n.k || []).filter((k) => typeof k === 'string').join(' '));
    if (own.length >= 2 && /[\p{L}\p{N}]/u.test(own) && n.r && n.r[2] >= 2 && n.r[3] >= 2) out.push({ text: own.slice(0, 120), r: n.r });
    for (const k of n.k || []) if (k && typeof k === 'object') rec(k);
  })(root);
  return out;
}
// runs in the clone page
export function pageBlocksInPage(max = 4000) {
  const norm = (s) => String(s || '').replace(/[\s\u00a0\u2007\u2009\u202f\u200b]+/g, ' ').trim();
  const out = []; const sx = scrollX, sy = scrollY; let n = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (++n > 30000 || out.length >= max) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/i.test(el.tagName)) continue;
    let own = ''; for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue + ' ';
    own = norm(own); if (own.length < 2 || !/[\p{L}\p{N}]/u.test(own)) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
    out.push({ text: own.slice(0, 120), r: [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)] });
  }
  return out;
}
/**
 * Area-weighted IoU of text blocks matched by text (k-th occurrence ↔ k-th occurrence, in page order).
 * offsetAt(yCss) → vertical offset of the clone at that height of the original (from the aligned comparison).
 */
export function layoutScore(orig, clone, { offsetAt = () => 0, capArea = 1440 * 900 } = {}) {
  const by = new Map();
  for (const c of [...clone].sort((x, y) => x.r[1] - y.r[1] || x.r[0] - y.r[0])) { if (!by.has(c.text)) by.set(c.text, []); by.get(c.text).push(c); }
  const used = new Map(); let wsum = 0, acc = 0, matched = 0;
  for (const o of [...orig].sort((x, y) => x.r[1] - y.r[1] || x.r[0] - y.r[0])) {
    const wgt = Math.min(capArea, Math.max(1, o.r[2] * o.r[3])); wsum += wgt;
    const list = by.get(o.text); if (!list) continue;
    const k = used.get(o.text) || 0; if (k >= list.length) continue; used.set(o.text, k + 1);
    const c = list[k]; const d = offsetAt(o.r[1]);
    const [x1, y1, w1, h1] = o.r; const x2 = c.r[0], y2 = c.r[1] - d, w2 = c.r[2], h2 = c.r[3];
    const ix = Math.max(0, Math.min(x1 + w1, x2 + w2) - Math.max(x1, x2)); const iy = Math.max(0, Math.min(y1 + h1, y2 + h2) - Math.max(y1, y2));
    const inter = ix * iy; const uni = w1 * h1 + w2 * h2 - inter;
    acc += wgt * (uni > 0 ? inter / uni : 0); matched++;
  }
  return { score: wsum ? acc / wsum : null, matched, total: orig.length };
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
  const label = (s, i) => `${i + 1}. ${s.type}${s.heading ? ' «' + String(s.heading).slice(0, 40) + '»' : ''}`;
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
          // same preparation as the crawl screenshot of the original
          await ops.settle(page, 4000).catch(() => {});
          await ops.forceLazy(page);
          await ops.autoScroll(page);
          await ops.waitAssets(page, 6000);
          await ops.finishAnimations(page);
          await ops.freezeMotion(page);
          const docH = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 4000);
          const cloneFile = path.join(dir, `${p.slug}-${view}-clone.png`);
          const shot = await ops.fullScreenshot(page, cloneFile, docH);
          if (!shot) throw new Error('скриншот клона не удался');
          const blocks = await page.evaluate(pageBlocksInPage, 4000).catch(() => []);
          // section bands and dynamic areas (canvas / video / iframe) of the original, CSS px of that viewport
          const raw = view === 'desktop' ? p.raw : p.mob && p.mob.raw;
          const bands = (p.sections || []).map((s, i) => {
            const n = view === 'desktop' ? s.node : p.mob && p.mob.map ? p.mob.map.get(s.node._p) : null;
            return n && n.r ? { name: label(s, i), y: n.r[1], h: n.r[3] } : null;
          }).filter(Boolean);
          const masks = ((raw && raw.media) || []).filter((m) => /^(canvas|video|iframe)$/.test(m.type) && m.w > 0 && m.h > 0).map((m) => ({ x: m.x || 0, y: m.y || 0, w: m.w, h: m.h }));
          const cssW = (raw && raw.viewport && raw.viewport.w) || (view === 'desktop' ? vp.w : mvp.w);
          const cmp = await comparePng(await fsp.readFile(path.join(outDir, origRel)), await fsp.readFile(cloneFile), { threshold: opts.threshold ?? 0.1, bands, masks, cssWidth: cssW, align: opts.align !== false });
          const diffFile = path.join(dir, `${p.slug}-${view}-diff.png`); await fsp.writeFile(diffFile, cmp.diffPng);
          let compFile = null; if (cmp.compositePng) { compFile = path.join(dir, `${p.slug}-${view}-compare.png`); await fsp.writeFile(compFile, cmp.compositePng); }
          // layout: text blocks, clone positions corrected by the offset of the strip they belong to
          const offs = cmp.offsets.map((o) => ({ y0: o.y0 / cmp.scale, y1: o.y1 / cmp.scale, d: o.d / cmp.scale }));
          const offsetAt = (y) => { for (const o of offs) if (y < o.y1) return o.d; return offs.length ? offs[offs.length - 1].d : 0; };
          const lay = raw && raw.tree ? layoutScore(treeBlocks(raw.tree), blocks, { offsetAt, capArea: cssW * ((raw.viewport && raw.viewport.h) || 900) }) : { score: null, matched: 0, total: 0 };
          Object.assign(row, {
            clone: rel(cloneFile), diff: rel(diffFile), composite: compFile ? rel(compFile) : null,
            similarity: cmp.similarity, strict: cmp.strict, layout: lay.score, layoutMatched: lay.total ? lay.matched / lay.total : null, masked: cmp.maskedShare,
            heightOriginal: Math.round(cmp.heightA / cmp.scale), heightClone: Math.round(cmp.heightB / cmp.scale),
            bands: cmp.bands.map(({ name, y, h, similarity, strict, offset }) => ({ name, y, h, similarity, strict, offset })), engine: cmp.engine,
          });
        } catch (e) { row.error = String((e && e.message) || e).split('\n')[0].slice(0, 300); }
        finally { await page.close().catch(() => {}); }
        results.push(row);
      }
    }
  } finally { await browser.close().catch(() => {}); }
  const ok = results.filter((r) => r.similarity !== undefined);
  const avg = (k) => { const v = ok.map((r) => r[k]).filter((x) => typeof x === 'number'); return v.length ? v.reduce((s2, x) => s2 + x, 0) / v.length : null; };
  const mn = (k) => { const v = ok.map((r) => r[k]).filter((x) => typeof x === 'number'); return v.length ? Math.min(...v) : null; };
  return { pages: results, average: avg('similarity'), min: mn('similarity'), strict: { average: avg('strict'), min: mn('strict') }, layout: { average: avg('layout'), min: mn('layout') } };
}
