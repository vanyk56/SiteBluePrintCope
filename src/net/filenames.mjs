// HTTrack-style file naming for downloaded assets.
// - query strings and fragments are dropped: style.css?v=1.2 -> style.css (they only bust caches);
// - image-CDN proxies are unwrapped: /_next/image?url=/img/a.png&w=640 -> a.png, /cdn-cgi/image/w=80/x.jpg -> x.jpg;
// - names are transliterated, slugified and made Windows-safe (no CON/PRN/…, no trailing dots, ≤ 60 chars);
// - collisions are resolved deterministically: same name + same content -> same file, other content -> name-<hash>.ext.
import { translit } from '../util.mjs';

export const CT_EXT = {
  'image/png': 'png', 'image/apng': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf', 'application/font-woff2': 'woff2', 'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf', 'application/x-font-woff': 'woff', 'application/x-font-otf': 'otf', 'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
  'text/css': 'css', 'application/json': 'json', 'application/pdf': 'pdf', 'application/lottie+json': 'json',
};
const EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', htm: 'html', tif: 'tiff', svgz: 'svg' };
const KNOWN_EXT = new Set([...Object.values(CT_EXT), 'html', 'js', 'mjs', 'txt', 'xml', 'gltf', 'glb', 'riv', 'lottie']);
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MEANINGLESS = /^(image|images|img|file|files|download|index|default|asset|media|picture|photo|untitled|blob|get|view|thumb|original|\d{1,4})$/i;

export function extFromContentType(ct) { return CT_EXT[String(ct || '').split(';')[0].trim().toLowerCase()] || ''; }

// magic numbers: the Content-Type of CDNs is often wrong (octet-stream, text/plain)
export function sniffExt(buf) {
  if (!buf || buf.length < 4) return '';
  const h = buf.subarray(0, 16);
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e) return 'png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpg';
  if (h.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (h.toString('ascii', 4, 12).startsWith('ftypavif') || h.toString('ascii', 4, 12).startsWith('ftypavis')) return 'avif';
  if (h.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return 'webm';
  if (h.toString('ascii', 0, 4) === 'wOF2') return 'woff2';
  if (h.toString('ascii', 0, 4) === 'wOFF') return 'woff';
  if (h.toString('ascii', 0, 4) === 'OTTO') return 'otf';
  if (h[0] === 0 && h[1] === 1 && h[2] === 0 && h[3] === 0) return 'ttf';
  if (h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0) return 'ico';
  if (h.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (h.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (h.toString('ascii', 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return 'mp3';
  const head = buf.subarray(0, 300).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg/i.test(buf.subarray(0, 2000).toString('utf8')))) return 'svg';
  return '';
}

// the "real" asset URL behind image proxies / resizers
export function unwrapProxy(url) {
  try {
    const u = new URL(url);
    if (/\/_next\/image|\/_vercel\/image|\/_ipx\//.test(u.pathname) && u.searchParams.get('url')) return unwrapProxy(new URL(u.searchParams.get('url'), u.origin).href);
    const cf = /^\/cdn-cgi\/image\/[^/]+\/(.+)$/.exec(u.pathname);
    if (cf) return unwrapProxy(/^https?:/.test(cf[1]) ? cf[1].replace(/^(https?):\/(?!\/)/, '$1://') : new URL('/' + cf[1], u.origin).href);
    return u.href;
  } catch { return url; }
}

// { base, ext } of the URL path: decoded, without query/fragment/directories
export function urlParts(url) {
  try {
    const u = new URL(unwrapProxy(url));
    let last = u.pathname.split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch {}
    const m = /^(.*?)(?:\.([A-Za-z0-9]{1,5}))?$/.exec(last) || [];
    let ext = (m[2] || '').toLowerCase(); ext = EXT_ALIAS[ext] || ext;
    if (ext && /^(php\d?|aspx?|ashx|axd|jsp|cgi|pl|do|action)$/.test(ext)) return { base: m[1] || '', ext: '' }; // image.php?id=4
    if (ext && !KNOWN_EXT.has(ext)) return { base: last, ext: '' }; // v1.2, file.bak …
    return { base: m[1] || '', ext };
  } catch { return { base: '', ext: '' }; }
}

// ASCII slug that is a valid file name on Windows, macOS and Linux
export function safeName(s, max = 60) {
  let b = translit(String(s || '')).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (b.length > max) b = b.slice(0, max).replace(/-+[^-]*$/, '') || b.slice(0, max);
  b = b.replace(/[-.]+$/, '');
  if (WIN_RESERVED.test(b)) b = 'file-' + b;
  return b;
}

const looksHashed = (b) => /^[a-f0-9]{12,}$/i.test(String(b).replace(/-/g, '')) || (b.length >= 20 && !/[-_ .]/.test(b) && /\d/.test(b) && /[a-z]/i.test(b));

// strip build hashes: app.3f9a1c2b.css -> app.css, logo-8f3e9a1b2c.png -> logo.png
export function stripHash(base) {
  return String(base || '').replace(/[.-_](?=[a-f0-9]*\d)[a-f0-9]{8,}$/i, '').replace(/[.-](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}$/, '');
}

// pick a human name: URL file name when meaningful (HTTrack), else the hint (alt text, family…), else the kind
export function assetBaseName(url, { hint = '', fallback = 'asset' } = {}) {
  const { base } = url && !url.startsWith('data:') ? urlParts(url) : { base: '' };
  const fromUrl = safeName(stripHash(base));
  if (fromUrl && fromUrl.length >= 3 && !MEANINGLESS.test(fromUrl) && !looksHashed(base)) return fromUrl;
  return safeName(hint) || fromUrl || safeName(fallback) || 'asset';
}

export function pickExt({ url = '', contentType = '', buf = null, fallback = 'bin' } = {}) {
  const sniffed = buf ? sniffExt(buf) : '';
  const fromCt = extFromContentType(contentType);
  const fromUrl = url && !url.startsWith('data:') ? urlParts(url).ext : '';
  // bytes beat headers, headers beat the URL (image.php → png); CSS/JSON text has no magic number
  return sniffed || fromCt || fromUrl || fallback;
}

// Registry of names per directory: case-insensitive (Windows/macOS file systems)
export class NameRegistry {
  constructor() { this.taken = new Map(); }
  reserve(dir, name, owner = '*') { this.taken.set(`${dir}/${name}`.toLowerCase(), owner); }
  claim(dir, base, ext, owner) {
    const key = (n) => `${dir}/${n}`.toLowerCase();
    let name = `${base}.${ext}`;
    for (let len = 6; ; len += 4) {
      const cur = this.taken.get(key(name));
      if (cur === undefined) { this.taken.set(key(name), owner); return name; }
      if (cur === owner) return name;
      if (len > 40) { name = `${base}-${this.taken.size}.${ext}`; continue; }
      name = `${base}-${String(owner).slice(0, len)}.${ext}`;
    }
  }
}
