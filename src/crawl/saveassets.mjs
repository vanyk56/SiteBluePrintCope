// Downloads every asset referenced by an extracted page (images, backgrounds, video posters, favicons, og:image,
// web fonts actually used on the page) into project/public and rewrites url(...) in computed styles to local paths.
// Shared by the Playwright crawler and the browser-extension importer.
import { fontUrlsFromFaces, rangeHits, subsetName } from '../analyze/css.mjs';
import { walkTree } from '../analyze/tree.mjs';
import { log } from '../log.mjs';

const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: таймаут ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t)); };
const errMsg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
export const URL_RX = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;

/**
 * @param {object} raw     extractPage() result (mutated: .local paths are added, url(...) rewritten)
 * @param {AssetStore} assets
 * @param {Map} fonts      shared map of font faces across pages: key → { family, weight, style, url, subset, web }
 */
export async function saveRawAssets(raw, assets, fonts = new Map(), { timeoutMs = 180000 } = {}) {
  const jobs = [];
  const set = (p, fn) => jobs.push(p.then((w) => { if (w) fn(w); }));
  (raw.images || []).forEach((im) => { if (im.src) set(assets.save(im.src, 'images', im.alt || (im.logo ? 'logo' : '')), (w) => { im.local = w; }); });
  (raw.bgImages || []).forEach((b) => { if (b.src) set(assets.save(b.src, 'images', 'bg'), (w) => { b.local = w; }); });
  (raw.media || []).forEach((m) => {
    if (m.poster) set(assets.save(m.poster, 'images', 'poster'), (w) => { m.posterLocal = w; });
    if ((m.type === 'video' || m.type === 'audio') && m.src && !m.src.startsWith('blob:')) set(assets.save(m.src, 'media', m.type), (w) => { m.local = w; });
  });
  const meta = raw.meta || {};
  (meta.favicons || []).forEach((f) => { if (f.href) set(assets.save(f.href, 'icons', 'favicon'), (w) => { f.local = w; }); });
  if (meta.ogImage) set(assets.save(meta.ogImage, 'images', 'og-image'), (w) => { meta.ogImageLocal = w; });
  const used = new Set((raw.loadedFonts || []).map((f) => String(f.family).toLowerCase()));
  // every unicode-range subset whose characters occur on the page (latin + cyrillic files of one face, etc.)
  const chars = [...new Set([...(raw.usedChars || '')].map((c) => c.codePointAt(0)))];
  const byFace = new Map();
  for (const f of fontUrlsFromFaces(raw.fontFaces || [])) {
    if (used.size && !used.has(f.family.toLowerCase())) continue;
    if (f.unicodeRange && chars.length && !rangeHits(f.unicodeRange, chars)) continue;
    const k = `${f.family}|${f.weight}|${f.style}|${f.unicodeRange || ''}`; if (byFace.has(k)) continue; byFace.set(k, f);
  }
  for (const [key, f] of byFace) {
    if (fonts.has(key)) continue;
    const subset = subsetName(f.unicodeRange);
    fonts.set(key, { ...f, url: f.url.startsWith('data:') ? f.url.slice(0, 48) + '…' : f.url, ...(f.url.startsWith('data:') ? { inline: true } : {}), subset, web: null });
    jobs.push(assets.save(f.url, 'fonts', `${f.family}-${String(f.weight).replace(/\s+/g, '_')}-${f.style}${subset ? '-' + subset : ''}`).then((w) => { fonts.get(key).web = w; }));
  }
  await withTimeout(Promise.allSettled(jobs), timeoutMs, 'assets').catch((e) => log.warn(errMsg(e)));
  rewriteTreeUrls(raw, assets);
  return jobs.length;
}

// url(...) inside computed backgrounds / pseudo-element backgrounds → local web paths
export function rewriteTreeUrls(raw, assets) {
  const bgBy = new Map(); for (const b of raw.bgImages || []) if (b.local) bgBy.set(b.src.slice(0, 300), b.local);
  const swap = (v) => v.replace(URL_RX, (m, a, b, c) => {
    const u = (a ?? b ?? c ?? '').replace(/\\(.)/g, '$1');
    const w = assets.webPath(u) || assets.webPath(u.slice(0, 60000)) || bgBy.get(u.slice(0, 300));
    if (w) return `url(${w})`;
    return u.startsWith('data:') ? 'url(/images/inline-image-missing.png)' : m;
  });
  if (!raw.tree) return;
  walkTree(raw.tree, (n) => {
    if (n.s && n.s['background-image'] && n.s['background-image'].includes('url(')) n.s['background-image'] = swap(n.s['background-image']);
    for (const ps of [n.pb, n.pa]) if (ps && ps.bgi && ps.bgi.includes('url(')) ps.bgi = swap(ps.bgi);
  });
}
