import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (s, n = 10) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
export async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); return d; }
export async function writeJSON(file, data, pretty = true) { await ensureDir(path.dirname(file)); await fsp.writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0)); }
export async function writeText(file, text) { await ensureDir(path.dirname(file)); await fsp.writeFile(file, text); }
export async function readJSON(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }
export async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

const TRACKING = /^(utm_|fbclid$|gclid$|yclid$|msclkid$|mc_cid$|mc_eid$|_ga$|_gl$|igshid$|ref_src$|_hsenc$|_hsmi$|spm$|from$)/i;
const NON_HTML = /\.(pdf|zip|rar|7z|gz|tgz|tar|dmg|exe|msi|apk|ipa|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|txt|csv|xlsx?|docx?|pptx?|psd|ai|sketch|fig)$/i;

export function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch { return null; }
}
export const isHtmlLike = (u) => !NON_HTML.test(new URL(u).pathname);
const bareHost = (h) => h.replace(/^www\./, '').toLowerCase();
export function sameSite(u, root, includeSub) {
  const a = bareHost(new URL(u).hostname), b = bareHost(new URL(root).hostname);
  return a === b || (!!includeSub && a.endsWith('.' + b));
}
export function pageSlug(u) {
  const x = new URL(u);
  let p = x.pathname;
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/^\/+|\/+$/g, '');
  let s = p ? translit(p).replace(/\//g, '__').replace(/[^A-Za-z0-9._-]+/g, '-') : 'index';
  if (x.search) s += '_q' + sha(x.search, 6);
  return s.slice(0, 90) || 'page';
}
export function templateKey(u) {
  const x = new URL(u);
  const segs = x.pathname.split('/').filter(Boolean);
  if (segs.length <= 1) return '/' + segs.join('/') + (x.search ? '?' : '');
  return '/' + segs[0] + '/*'.repeat(segs.length - 1);
}
export function limiter(concurrency) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= concurrency || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    Promise.resolve().then(fn).then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
export const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
export const fmt = (n) => String(round(n, 3));
export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
export function humanBytes(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
export function translit(s) {
  return String(s || '').replace(/[а-яёіїєґ]/gi, (ch) => { const l = ch.toLowerCase(); const r = TR[l] ?? ''; return ch === l ? r : r.charAt(0).toUpperCase() + r.slice(1); });
}
export function pascal(str, maxWords = 3) {
  const words = translit(str).normalize('NFKD').replace(/[^\x00-\x7F]/g, ' ').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, maxWords);
  if (!words.length) return '';
  let s = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
  if (/^\d/.test(s)) s = 'N' + s;
  return s;
}
export function kebab(str, max = 40) {
  return translit(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'item';
}
export function inc(map, key, by = 1) { if (key === undefined || key === null || key === '') return; map.set(key, (map.get(key) || 0) + by); }
export const sortedEntries = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

// ---- colors ----
export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
export function hsl(hex) {
  const c = parseHex(hex); if (!c) return { h: 0, s: 0, l: 0 };
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return { h, s, l };
}
export function luminance(hex) {
  const c = parseHex(hex); if (!c) return 0;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export function isSaturated(hex) { const c = parseHex(hex); if (!c || c.a < 0.5) return false; const { s, l } = hsl(hex); return s > 0.32 && l > 0.12 && l < 0.92; }
export function hueName(hex) {
  const { h, s, l } = hsl(hex);
  if (s < 0.15 || l < 0.06 || l > 0.97) return 'neutral';
  if (s < 0.45 && h >= 190 && h < 250) return 'slate';
  if (s < 0.3) return 'gray';
  if (h < 15 || h >= 345) return 'red'; if (h < 40) return 'orange'; if (h < 65) return 'yellow'; if (h < 160) return 'green';
  if (h < 190) return 'teal'; if (h < 250) return 'blue'; if (h < 290) return 'violet'; return 'pink';
}
export function hueDist(a, b) { const d = Math.abs(hsl(a).h - hsl(b).h) % 360; return d > 180 ? 360 - d : d; }

// CSS color string (rgb()/rgba()/#hex) -> #rrggbb[aa]; colorsToHex() rewrites every rgb()/rgba() inside a value
export function cssHex(v) {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  const h = (n) => Math.max(0, Math.min(255, Math.round(+n))).toString(16).padStart(2, '0');
  let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
  return '#' + h(m[1]) + h(m[2]) + h(m[3]) + (a < 1 ? h(a * 255) : '');
}
export const colorsToHex = (v) => String(v || '').replace(/rgba?\([^)]*\)/gi, (m) => cssHex(m) || m);

// "prop1, prop2 | 0.2s, 0.2s | ease, ease | 0s, 0s" -> "prop1, prop2 0.2s ease" (grouped by identical timing)
export function fmtTransition(raw, { withProps = true } = {}) {
  const [p = 'all', d = '0s', t = 'ease', dl = ''] = String(raw || '').split(' | ');
  const sp = (x) => String(x).split(/,\s*(?![^()]*\))/).map((v) => v.trim()).filter(Boolean);
  const P = sp(p), D = sp(d), T = sp(t), DL = dl ? sp(dl) : [];
  if (!P.length || !D.length) return '';
  const groups = new Map();
  P.forEach((prop, i) => {
    const dur = D[i % D.length], tf = T.length ? T[i % T.length] : 'ease', del = DL.length ? DL[i % DL.length] : '0s';
    if (/^0s$/.test(dur) && (!del || del === '0s')) return;
    const key = dur + ' ' + tf + (del && del !== '0s' ? ' ' + del : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(prop);
  });
  return [...groups].map(([k, props]) => (withProps ? props.join(', ') + ' ' + k : k)).join('; ');
}
