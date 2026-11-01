// Node side of the SingleFile-style snapshots (in-page part: src/inpage/snapshot.mjs).
//   capture  → data/snapshots/<slug>.raw.json  (HTML with __SBRES_* placeholders + resource list)
//   finalize → snapshots/<slug>.html           (placeholders → downloaded files in ../project/public/…, links between
//              crawled pages → ./<slug>.html, everything else → absolute URL; then the HTML sanitizer pass)
// The same finalize() is used for captures that arrive from the browser extension.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { snapshotPage } from '../inpage/snapshot.mjs';
import { sanitizeHtml } from '../sanitize/html.mjs';
import { writeJSON, writeText, readJSON, normalizeUrl } from '../util.mjs';
import { log } from '../log.mjs';

const PH = /__SBRES_([AC])(\d+)__/g;
const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const safeUrl = (u) => String(u).replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
const ASSET_KIND = { images: 'images', fonts: 'fonts', icons: 'icons', media: 'media' };

export async function capturePage(page, { maxBytes = 40e6, frameDepth = 2 } = {}) {
  return page.evaluate(snapshotPage, { maxBytes, frameDepth });
}

/** placeholders → final URLs. local(i) returns a path for resource i or null (→ absolute original URL) */
export function resolvePlaceholders(html, resources, local) {
  return String(html).replace(PH, (m, ctx, n) => {
    const i = +n; const r = resources[i]; if (!r) return '';
    const v = safeUrl(local(i, r) || r.url);
    return ctx === 'A' ? escA(v) : v;
  });
}

export class SnapshotStore {
  /** @param {AssetStore} assets  shared asset store (already holds everything the crawl downloaded) */
  constructor(outDir, { assets = null, maxNewAssets = 300, sanitize = true } = {}) {
    this.outDir = outDir; this.assets = assets; this.maxNewAssets = maxNewAssets; this.sanitize = sanitize;
    this.rawDir = path.join(outDir, 'data', 'snapshots'); this.dir = path.join(outDir, 'snapshots');
    this.items = [];
  }
  async add(slug, snap) {
    if (!snap || !snap.html) return null;
    const raw = path.join(this.rawDir, slug + '.raw.json');
    await writeJSON(raw, snap, false);
    const it = { slug, url: snap.url, title: snap.title, raw, stats: snap.stats };
    this.items.push(it);
    return it;
  }
  async capture(page, slug, opts) { return this.add(slug, await capturePage(page, opts)); }

  /** @param pages [{ slug, url, finalUrl }] crawled pages (internal links between them become relative) */
  async finalize(pages = []) {
    const bySlug = new Map();
    for (const p of pages) for (const u of [p.url, p.finalUrl]) { const n = normalizeUrl(u); if (n && !bySlug.has(n)) bySlug.set(n, p.slug); }
    let budget = this.maxNewAssets; const out = [];
    for (const it of this.items) {
      let snap; try { snap = await readJSON(it.raw); } catch (e) { log.debug('snapshot', it.slug, e.message); continue; }
      const local = new Map();
      const jobs = (snap.resources || []).map(async (r, i) => {
        if (r.kind === 'page') {
          const n = normalizeUrl(r.url); const s = n && bySlug.get(n);
          if (s) { let hash = ''; try { hash = new URL(r.url).hash; } catch {} local.set(i, `./${s}.html${hash}`); }
          return;
        }
        const kind = ASSET_KIND[r.kind]; if (!kind || !this.assets) return;
        let w = this.assets.webPath(r.url);
        if (!w && budget > 0 && /^https?:/i.test(r.url)) { budget--; w = await this.assets.save(r.url, kind, r.kind === 'fonts' ? 'font' : '').catch(() => null); }
        if (w) local.set(i, '../project/public' + w);
      });
      await Promise.allSettled(jobs);
      let html = resolvePlaceholders(snap.html, snap.resources || [], (i) => local.get(i));
      let report = null;
      if (this.sanitize) { const s = sanitizeHtml(html); html = s.html; report = s.report; }
      const file = path.join(this.dir, it.slug + '.html');
      await writeText(file, html);
      await fsp.rm(it.raw, { force: true });
      const localCount = [...local.values()].filter((v) => v && !v.startsWith('./')).length;
      out.push({
        slug: it.slug, url: it.url, file: `snapshots/${it.slug}.html`, bytes: Buffer.byteLength(html), stats: it.stats,
        resources: (snap.resources || []).filter((r) => r.kind !== 'page').length, local: localCount,
        removed: report ? { scripts: report.scripts, iframes: report.iframes, pixels: report.pixels, handlers: report.handlers } : null,
      });
    }
    await fsp.rm(this.rawDir, { recursive: true, force: true }).catch(() => {});
    return out;
  }
}
