// Capture package, format v1 — what the extension sends to `site-blueprint listen` or saves as a ZIP for
// `site-blueprint import capture.zip` (reader: src/capture/import.mjs). Pure module: runs in the service
// worker and in Node tests.
//
//   capture.json                manifest (below)
//   pages/<slug>.json           extractPage() result (computed-style DOM tree, tokens, assets, interactive…)
//   snapshots/<slug>.json       snapshotPage() result (SingleFile-style HTML with resource placeholders)
//   screenshots/<slug>.png      full-page screenshot (CSS pixels, stitched from visible-tab captures)
//   state/<slug>.json           interactive probes (tabs/filters, accordions, dialogs, hover menus, <details>)
//   trackers/<slug>.json        script URLs + inline snippets (tracker report, never cloned)
//   hydration/<slug>.json       framework state (__NEXT_DATA__, __NUXT__, JSON-LD…) + storage key names
//   api/requests.json           XHR/fetch responses of the tab (redacted in the extension and again in the CLI)
//   assets/index.json + files/  images, fonts, media, icons fetched by the extension (the CLI downloads the rest)
//   css/index.json + files/     stylesheet texts (also cross-origin ones the page itself cannot read)
import { ZipWriter } from './zip.js';

export const FORMAT = 'site-blueprint-capture';
export const VERSION = 1;
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'text/css': 'css',
};
export const slugSafe = (s) => String(s || 'page').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'page';
const json = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export class CapturePackager {
  constructor(meta = {}) {
    this.zip = new ZipWriter();
    this.meta = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), ...meta };
    this.pages = []; this.assets = []; this.css = []; this.api = [];
    this.slugs = new Set(); this.assetUrls = new Set(); this.cssUrls = new Set();
    this.assetBytes = 0;
  }
  uniqueSlug(s) { const b = slugSafe(s); let x = b; let i = 2; while (this.slugs.has(x)) x = `${b}-${i++}`; this.slugs.add(x); return x; }
  async addPage({ slug, url, finalUrl, title = '', depth = 0, from = null, raw, snapshot = null, screenshot = null, screenshotInfo = null, state = null, trackers = null, hydration = null, ms = 0, warnings = [] }) {
    if (!raw) throw new Error('addPage: raw is required');
    slug = this.uniqueSlug(slug);
    const rec = { url, finalUrl: finalUrl || url, slug, title, depth, from, ms, raw: `pages/${slug}.json`, snapshot: null, screenshot: null, screenshotInfo, state: null, trackers: null, hydration: null, warnings };
    await this.zip.add(rec.raw, json(raw));
    if (snapshot) { rec.snapshot = `snapshots/${slug}.json`; await this.zip.add(rec.snapshot, json(snapshot)); }
    if (screenshot && screenshot.length) { rec.screenshot = `screenshots/${slug}.png`; await this.zip.add(rec.screenshot, screenshot, { compress: false }); }
    if (state) { rec.state = `state/${slug}.json`; await this.zip.add(rec.state, json(state)); }
    if (trackers) { rec.trackers = `trackers/${slug}.json`; await this.zip.add(rec.trackers, json(trackers)); }
    if (hydration) { rec.hydration = `hydration/${slug}.json`; await this.zip.add(rec.hydration, json(hydration)); }
    this.pages.push(rec);
    return rec;
  }
  hasAsset(url) { return this.assetUrls.has(url); }
  async addAsset({ url, contentType = '', bytes, page = null, kind = '' }) {
    if (!url || !bytes || !bytes.length || this.assetUrls.has(url)) return null;
    this.assetUrls.add(url);
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    const n = String(this.assets.length + 1).padStart(5, '0');
    const file = `assets/files/${n}.${EXT[ct] || 'bin'}`;
    await this.zip.add(file, bytes);
    const rec = { url, file, contentType: ct, bytes: bytes.length, page, kind };
    this.assets.push(rec); this.assetBytes += bytes.length;
    return rec;
  }
  async addCss({ url, text, page = null }) {
    if (!url || !text || this.cssUrls.has(url)) return null;
    this.cssUrls.add(url);
    const file = `css/files/${String(this.css.length + 1).padStart(3, '0')}.css`;
    await this.zip.add(file, text);
    const rec = { url, file, bytes: text.length, page };
    this.css.push(rec);
    return rec;
  }
  addApi(entries) { for (const e of entries || []) if (e && e.url) this.api.push(e); }
  manifest(extra = {}) {
    return {
      ...this.meta, ...extra,
      pages: this.pages,
      api: this.api.length ? 'api/requests.json' : null,
      assets: this.assets.length ? 'assets/index.json' : null,
      css: this.css.length ? 'css/index.json' : null,
      counts: { pages: this.pages.length, api: this.api.length, assets: this.assets.length, assetBytes: this.assetBytes, css: this.css.length },
    };
  }
  async _finishEntries(extra) {
    if (!this.pages.length) throw new Error('capture has no pages');
    if (this.api.length) await this.zip.add('api/requests.json', JSON.stringify(this.api));
    if (this.assets.length) await this.zip.add('assets/index.json', JSON.stringify(this.assets));
    if (this.css.length) await this.zip.add('css/index.json', JSON.stringify(this.css));
    const manifest = this.manifest(extra);
    await this.zip.add('capture.json', JSON.stringify(manifest, null, 2));
    return manifest;
  }
  /** → { blob, manifest, files, bytes } */
  async finish(extra = {}) { const manifest = await this._finishEntries(extra); const blob = this.zip.finish(); return { blob, manifest, files: this.zip.count, bytes: blob.size }; }
  /** → { bytes: Uint8Array, manifest } (Node) */
  async finishBytes(extra = {}) { const manifest = await this._finishEntries(extra); return { bytes: this.zip.finishBytes(), manifest, files: this.zip.count }; }
}

/** One-shot helper: capture = { meta, pages: [...addPage args], assets: [...], css: [...], api: [...] } */
export async function buildCaptureZip(capture, { bytes = false } = {}) {
  const p = new CapturePackager(capture.meta || {});
  for (const pg of capture.pages || []) await p.addPage(pg);
  for (const a of capture.assets || []) await p.addAsset(a);
  for (const c of capture.css || []) await p.addCss(c);
  p.addApi(capture.api || []);
  return bytes ? p.finishBytes() : p.finish();
}
