// Downloads/stores images, fonts, media. Prefers bodies already captured from the page's network traffic.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, sha, kebab, translit } from '../util.mjs';

const CT_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'application/x-font-ttf': 'ttf', 'application/x-font-woff': 'woff', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3' };
function sniff(buf) {
  if (!buf || buf.length < 4) return '';
  const h = buf.subarray(0, 16);
  if (h[0] === 0x89 && h[1] === 0x50) return 'png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  if (h.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (h.toString('ascii', 4, 12).startsWith('ftypavif')) return 'avif';
  if (h.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (h.toString('ascii', 0, 4) === 'wOF2') return 'woff2';
  if (h.toString('ascii', 0, 4) === 'wOFF') return 'woff';
  if (h.toString('ascii', 0, 4) === 'OTTO') return 'otf';
  if (h[0] === 0 && h[1] === 1 && h[2] === 0 && h[3] === 0) return 'ttf';
  const head = buf.subarray(0, 300).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg/i.test(buf.subarray(0, 2000).toString('utf8')))) return 'svg';
  return '';
}
function nameHint(url) {
  try {
    const u = new URL(url);
    if (/\/_next\/image|\/_vercel\/image|\/cdn-cgi\/image/.test(u.pathname) && u.searchParams.get('url')) return nameHint(new URL(u.searchParams.get('url'), u.origin).href);
    let b = decodeURIComponent(path.basename(u.pathname)).replace(/\.[a-z0-9]{2,5}$/i, '');
    if (/^[a-f0-9-]{16,}$/i.test(b) || b.length < 2) b = '';
    return b;
  } catch { return ''; }
}

export class AssetStore {
  constructor(outDir, opts, request) {
    this.root = path.join(outDir, 'project', 'public'); this.opts = opts; this.request = request;
    this.maxBytes = (opts.maxAssetMb || 15) * 1048576; this.maxCount = opts.maxAssets || 400;
    this.bodies = new Map(); this.saved = new Map(); this.failed = new Map(); this.names = new Set(); this.bytes = 0;
    this.pending = new Map();
  }
  offer(url, buf, ct) {
    if (!url || !buf || !buf.length || buf.length > this.maxBytes || this.bodies.has(url)) return;
    if (this.bodies.size > 2000) return;
    this.bodies.set(url, { buf, ct });
  }
  webPath(url) { const s = this.saved.get(url); return s ? s.web : null; }
  async save(url, kind = 'images', hint = '') {
    if (!url || !this.opts.assets) return null;
    if (this.saved.has(url)) return this.saved.get(url).web;
    if (this.failed.has(url)) return null;
    if (this.pending.has(url)) return this.pending.get(url);
    const p = this._save(url, kind, hint).finally(() => this.pending.delete(url));
    this.pending.set(url, p);
    return p;
  }
  async _save(url, kind, hint) {
    if (this.saved.size >= this.maxCount) { this.failed.set(url, 'limit'); return null; }
    let buf, ct = '';
    try {
      if (url.startsWith('data:')) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url); if (!m) throw new Error('bad data url');
        ct = m[1] || ''; buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
      } else if (this.bodies.has(url)) ({ buf, ct } = this.bodies.get(url));
      else {
        const r = await this.request.get(url, { timeout: 25000, maxRedirects: 5 });
        if (!r.ok()) throw new Error('HTTP ' + r.status());
        buf = await r.body(); ct = r.headers()['content-type'] || '';
      }
    } catch (e) { this.failed.set(url, String(e.message || e).slice(0, 120)); return null; }
    if (!buf || !buf.length) { this.failed.set(url, 'empty'); return null; }
    if (buf.length > this.maxBytes) { this.failed.set(url, 'too large'); return null; }
    let ext = CT_EXT[String(ct).split(';')[0].trim().toLowerCase()] || sniff(buf);
    if (!ext) { try { ext = (/\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname) || [])[1] || 'bin'; } catch { ext = 'bin'; } }
    const base = kebab(translit(hint || nameHint(url) || kind.replace(/s$/, '')), 40) || 'asset';
    const name = `${base}-${sha(url, 6)}.${ext.toLowerCase()}`;
    const file = path.join(this.root, kind, name);
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, buf);
    const rec = { url: url.startsWith('data:') ? url.slice(0, 60) + '…' : url, web: `/${kind}/${name}`, file: path.posix.join('project/public', kind, name), bytes: buf.length, kind, ext };
    this.saved.set(url, rec); this.bytes += buf.length;
    return rec.web;
  }
  manifest() { return { saved: [...this.saved.values()], failed: [...this.failed.entries()].slice(0, 300).map(([url, reason]) => ({ url: url.slice(0, 300), reason })), bytes: this.bytes }; }
}
