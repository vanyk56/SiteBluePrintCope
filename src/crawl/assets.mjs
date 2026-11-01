// Asset store for project/public — PyWebCopy-style strict directories + HTTrack-style resilience:
//   public/images  — raster pictures          public/svg   — SVG files (logos, illustrations)
//   public/fonts   — woff2/woff/ttf/otf/eot   public/icons — favicons, touch icons, .ico
//   public/media   — video/audio
// Bodies captured from the page's own network traffic are reused; everything else is downloaded with retries,
// Retry-After, Range resume and per-host throttling. Identical files are stored once (sha256 of the bytes),
// file names are clean (style.css?v=1.2 → style.css) and every original URL maps to its local web path.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { ensureDir, sha } from '../util.mjs';
import { assetBaseName, pickExt, NameRegistry, unwrapProxy, safeName } from '../net/filenames.mjs';
import { download, HostThrottle } from '../net/fetch.mjs';

export const CATEGORIES = ['images', 'svg', 'fonts', 'icons', 'media'];
const FONT_EXT = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);
const MEDIA_EXT = new Set(['mp4', 'webm', 'mov', 'ogv', 'mp3', 'ogg', 'wav', 'm4a']);

// category (= public/ sub-directory) of an asset
export function categoryFor(kind, ext, url = '') {
  if (FONT_EXT.has(ext)) return 'fonts';
  if (MEDIA_EXT.has(ext)) return 'media';
  if (kind === 'icons' || ext === 'ico' || /favicon|apple-touch-icon|mstile|android-chrome/i.test(String(url).slice(0, 300))) return 'icons';
  if (ext === 'svg') return 'svg';
  if (kind === 'fonts' || kind === 'media') return kind;
  return 'images';
}
const short = (u) => (u.startsWith('data:') ? u.slice(0, 60) + '…' : u);
const keyOf = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

export class AssetStore {
  /**
   * @param {string} outDir   output folder (files go to outDir/project/public/<category>/)
   * @param {object} opts     CLI options (assets, maxAssets, maxAssetMb, assetRetries)
   * @param {object} request  optional Playwright APIRequestContext — fallback transport (shares the browser's cookies)
   * @param {object} extra    { hooks, headers, cookiesFor(url) → Promise<string>, fetchImpl }
   */
  constructor(outDir, opts = {}, request = null, { hooks = null, headers = {}, cookiesFor = null, fetchImpl } = {}) {
    this.root = path.join(outDir, 'project', 'public'); this.partDir = path.join(outDir, 'data', 'partial');
    this.opts = opts; this.request = request; this.hooks = hooks; this.headers = { ...headers }; this.cookiesFor = cookiesFor; this.fetchImpl = fetchImpl;
    this.maxBytes = (opts.maxAssetMb || 15) * 1048576; this.maxCount = opts.maxAssets || 400;
    this.bodies = new Map(); this.saved = new Map(); this.failed = new Map(); this.pending = new Map();
    this.byHash = new Map(); this.names = new NameRegistry();
    this.bytes = 0; this.files = 0; this.dedup = 0; this.retries = 0; this.resumed = 0; this.fallbacks = 0;
    this.throttle = new HostThrottle({ concurrency: opts.assetConcurrency || 6 });
  }
  setHeaders(h) { Object.assign(this.headers, h); }
  // names already used by generated files (inline SVG icons…) so downloads never overwrite them
  reserve(web) { const m = /^\/([^/]+)\/(.+)$/.exec(web || ''); if (m) this.names.reserve(m[1], m[2]); }
  offer(url, buf, ct) {
    if (!url || !buf || !buf.length || buf.length > this.maxBytes || this.bodies.has(url)) return;
    if (this.bodies.size > 2000) return;
    this.bodies.set(url, { buf, ct });
  }
  webPath(url) { if (!url) return null; const s = this.saved.get(url) || this.saved.get(keyOf(url)); return s ? s.web : null; }
  async save(url, kind = 'images', hint = '') {
    if (!url || this.opts.assets === false) return null;
    if (this.saved.has(url)) return this.saved.get(url).web;
    if (this.failed.has(url)) return null;
    if (this.pending.has(url)) return this.pending.get(url);
    const p = this._save(url, kind, hint).finally(() => this.pending.delete(url));
    this.pending.set(url, p);
    return p;
  }
  async _fetch(url, kind) {
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(url); if (!m) throw new Error('bad data url');
      return { buf: m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4])), ct: m[1] || '' };
    }
    for (const u of [url, keyOf(url)]) if (this.bodies.has(u)) { const b = this.bodies.get(u); return { buf: b.buf, ct: b.ct || '' }; }
    if (url.startsWith('blob:')) throw new Error('blob: URL');
    const headers = { ...this.headers };
    if (this.cookiesFor) { try { const c = await this.cookiesFor(url); if (c) headers.Cookie = c; } catch {} }
    try {
      const partFile = kind === 'media' ? path.join(this.partDir, sha(url, 16) + '.part') : null;
      const r = await download(url, {
        headers, retries: this.opts.assetRetries ?? 3, maxBytes: this.maxBytes, partFile, throttle: this.throttle, fetchImpl: this.fetchImpl,
        onRetry: () => { this.retries++; },
      });
      if (r.resumed) this.resumed++;
      return { buf: r.buf, ct: r.contentType };
    } catch (e) {
      if (e.tooLarge || e.status === 404 || e.status === 410 || !this.request) throw e;
      // second transport: Playwright's request context (ignores TLS errors, uses the browser profile's cookies)
      const r = await this.request.get(url, { timeout: 25000, maxRedirects: 5 });
      if (!r.ok()) throw new Error('HTTP ' + r.status());
      this.fallbacks++;
      return { buf: await r.body(), ct: r.headers()['content-type'] || '' };
    }
  }
  async _save(url, kind, hint) {
    if (this.files >= this.maxCount) { this.failed.set(url, 'limit'); return null; }
    let got;
    try { got = await this._fetch(url, kind); }
    catch (e) {
      const reason = String((e && e.message) || e).slice(0, 120);
      this.failed.set(url, reason);
      if (this.hooks) await this.hooks.emit('onAssetError', { url, error: reason });
      return null;
    }
    const { buf, ct } = got;
    if (!buf || !buf.length) { this.failed.set(url, 'empty'); return null; }
    if (buf.length > this.maxBytes) { this.failed.set(url, 'too large'); return null; }
    if (/^text\/html/i.test(ct) && kind !== 'media') { this.failed.set(url, 'HTML вместо файла (защита/404-страница)'); return null; }
    const ext = pickExt({ url, contentType: ct, buf, fallback: kind === 'fonts' ? 'woff2' : 'bin' });
    const category = categoryFor(kind, ext, url);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    // content dedup: the same picture behind ?w=320 and ?w=640, or on two CDNs, is stored once
    // (byHash holds a promise so that two parallel downloads of identical bytes never race)
    if (this.byHash.has(hash)) {
      const dup = await this.byHash.get(hash);
      if (dup) { this.saved.set(url, { ...dup, url: short(url), alias: true }); this.dedup++; return dup.web; }
    }
    let done; this.byHash.set(hash, new Promise((r) => { done = r; }));
    try {
      let base = assetBaseName(url, { hint, fallback: category.replace(/s$/, '') });
      if (this.hooks && this.hooks.has('generateFilename')) {
        const custom = await this.hooks.waterfall('generateFilename', null, { url, kind, category, ext, hint, base });
        if (custom) base = safeName(String(custom).replace(/\.[a-z0-9]{2,5}$/i, '')) || base;
      }
      const name = this.names.claim(category, base, ext, hash);
      const file = path.join(this.root, category, name);
      const rec = { url: short(url), web: `/${category}/${name}`, file: path.posix.join('project/public', category, name), bytes: buf.length, kind: category, ext, hash: hash.slice(0, 16) };
      if (url !== unwrapProxy(url)) rec.original = unwrapProxy(url);
      await ensureDir(path.dirname(file));
      await fsp.writeFile(file, buf);
      this.saved.set(url, rec);
      this.bytes += buf.length; this.files++;
      done(rec);
      if (this.hooks) await this.hooks.emit('onAssetSaved', { ...rec, url });
      return rec.web;
    } catch (e) {
      done(null); this.byHash.delete(hash);
      this.failed.set(url, String((e && e.message) || e).slice(0, 120));
      return null;
    }
  }
  // original URL → local web path (for rewriting HTML/CSS/TSX)
  urlMap() { const m = new Map(); for (const [u, r] of this.saved) m.set(u, r.web); return m; }
  manifest() {
    const byCategory = {};
    for (const r of this.saved.values()) if (!r.alias) byCategory[r.kind] = (byCategory[r.kind] || 0) + 1;
    return {
      saved: [...this.saved.values()], failed: [...this.failed.entries()].slice(0, 300).map(([url, reason]) => ({ url: url.slice(0, 300), reason })),
      bytes: this.bytes, files: this.files, dedup: this.dedup, retries: this.retries, resumed: this.resumed, fallbacks: this.fallbacks, byCategory,
    };
  }
}
