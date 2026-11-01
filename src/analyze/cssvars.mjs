// Tailwind v4 / Lightning CSS sanitizer. Arbitrary-value classes are great for short values, but long or
// "dirty" values break the build or the CSS optimizer:
//   bg-[url(data:image/svg+xml;utf8,<svg_xmlns=...>)]   → Lightning CSS: "Unexpected token BadUrl"
//   [background-image:linear-gradient(...),radial-gradient(...),url(...)]  (300+ chars, unreadable)
//   content-['…'] with url()/attr()/counters, clip-path polygons with dozens of points, mask images…
// Such values are moved into CSS custom properties declared in `@theme static { … }` of app/globals.css, and the
// class references the variable: bg-(image:--sb-bgi-1), [clip-path:var(--sb-clip-1)], content-(--sb-content-1).
import path from 'node:path';
import fsp from 'node:fs/promises';

const LONG = 140;
// Tailwind arbitrary value → CSS text: "_" is a space, "\_" is a literal underscore
export const decodeArb = (v) => String(v).replace(/\\_/g, '\u0000').replace(/_/g, ' ').replace(/\u0000/g, '_');

// url(...) tokenizer that respects quotes: url("data:…rgb(1,2,3)…") must not end at the first ")"
export function mapCssUrls(css, fn) {
  const src = String(css); let out = ''; let i = 0;
  for (;;) {
    const j = src.toLowerCase().indexOf('url(', i);
    if (j < 0) { out += src.slice(i); break; }
    out += src.slice(i, j);
    let k = j + 4; while (/\s/.test(src[k] || '')) k++;
    let inner = ''; let quote = '';
    if (src[k] === '"' || src[k] === "'") {
      quote = src[k]; k++;
      while (k < src.length && src[k] !== quote) { if (src[k] === '\\' && k + 1 < src.length) { inner += src[k] + src[k + 1]; k += 2; continue; } inner += src[k++]; }
      k++; while (/\s/.test(src[k] || '')) k++;
      if (src[k] === ')') k++;
    } else {
      while (k < src.length && src[k] !== ')') inner += src[k++];
      k++; inner = inner.trim();
    }
    out += fn(inner, quote);
    i = k;
  }
  return out;
}

// url(...) with a data: URI must be quoted and its SVG markup escaped, otherwise CSS tokenizers produce BadUrl
export function normalizeUrls(css) {
  return mapCssUrls(css, (inner) => {
    let u = inner.trim();
    if (/^data:/i.test(u) && !/;base64,/i.test(u)) {
      const comma = u.indexOf(',');
      const head = u.slice(0, comma + 1); let body = u.slice(comma + 1);
      try { if (/%[0-9a-f]{2}/i.test(body)) body = decodeURIComponent(body); } catch {}
      body = body.replace(/"/g, "'").replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/[\r\n\t]+/g, ' ').replace(/\{/g, '%7B').replace(/\}/g, '%7D');
      u = head + body;
    } else u = u.replace(/"/g, '%22');
    return `url("${u}")`;
  });
}

// is this CSS value risky inside a class name?
export function isDirty(value) {
  const v = String(value);
  if (v.length > LONG) return true;
  if (/url\(\s*["']?data:/i.test(v)) return true;
  if (/url\([^)]*[\s"'<>{}]/.test(v)) return true;
  if (/[<>{};]/.test(v.replace(/url\([^)]*\)/g, ''))) return true;
  return false;
}

export class CssVarRegistry {
  constructor(prefix = 'sb') { this.prefix = prefix; this.byValue = new Map(); this.list = []; this.counters = {}; }
  add(kind, cssValue) {
    const value = normalizeUrls(String(cssValue).trim());
    const key = kind + '|' + value;
    if (this.byValue.has(key)) return this.byValue.get(key);
    this.counters[kind] = (this.counters[kind] || 0) + 1;
    const name = `--${this.prefix}-${kind}-${this.counters[kind]}`;
    this.byValue.set(key, name); this.list.push({ name, value, kind });
    return name;
  }
  get size() { return this.list.length; }
  // block for app/globals.css (static = always emitted, even if no utility references it)
  css() {
    if (!this.list.length) return '';
    return ['/* long / data-URI values moved out of class names (site-blueprint css-vars) */', '@theme static {', ...this.list.map((x) => `  ${x.name}: ${x.value};`), '}', ''].join('\n');
  }
}

// one class (with variants) → safe class; null if unchanged
const PREFIXED = [
  // [regex on utility, kind, (varName) → utility]
  [/^bg-\[(.+)\]$/s, 'bgi', (n) => `bg-(image:${n})`, (v) => /gradient\(|url\(|image-set\(/.test(v)],
  [/^content-\[(.+)\]$/s, 'content', (n) => `content-(${n})`, () => true],
  [/^shadow-\[(.+)\]$/s, 'shadow', (n) => `shadow-(${n})`, () => true],
  [/^\[([a-z-]+):(.+)\]$/s, null, null, () => true],
];
export function sanitizeClass(cls, reg) {
  const m = /^((?:[\w-]+(?:\[[^\]]*\])?:)*)(!?)(.+)$/s.exec(cls);
  if (!m) return null;
  const [, variants, bang, util] = m;
  for (const [re, kind, make, applies] of PREFIXED) {
    const x = re.exec(util); if (!x) continue;
    if (kind === null) {
      const prop = x[1]; const raw = decodeArb(x[2]);
      if (!isDirty(raw)) return null;
      const k = /background/.test(prop) ? 'bgi' : /mask/.test(prop) ? 'mask' : /clip-path/.test(prop) ? 'clip' : /grid-template/.test(prop) ? 'grid' : /shadow/.test(prop) ? 'shadow' : 'val';
      return `${variants}${bang}[${prop}:var(${reg.add(k, raw)})]`;
    }
    const raw = decodeArb(x[1]);
    if (!applies(raw) || !isDirty(raw)) return null;
    return `${variants}${bang}${make(reg.add(kind, raw))}`;
  }
  return null;
}
export function sanitizeClassList(str, reg) {
  let changed = false;
  const out = String(str).split(/\s+/).filter(Boolean).map((c) => { const r = sanitizeClass(c, reg); if (r) { changed = true; return r; } return c; });
  return changed ? out.join(' ') : str;
}

// ---------- build-loop fixer: rewrite existing TSX files ----------
// className="…" / className={'…'} / class strings inside data arrays (cls: "…")
const CLASS_STR = /(className=|cls:\s*|class:\s*|className:\s*)(["'`])((?:(?!\2)[^\\]|\\.)*)\2/g;
export async function sanitizeProjectClasses(root, ctx = null) {
  const reg = new CssVarRegistry('sb');
  const globalsFile = path.join(root, 'app', 'globals.css');
  let globals = await fsp.readFile(globalsFile, 'utf8').catch(() => '');
  // continue numbering after variables that already exist
  for (const m of globals.matchAll(/--sb-([a-z]+)-(\d+):/g)) reg.counters[m[1]] = Math.max(reg.counters[m[1]] || 0, +m[2]);
  const changed = [];
  const files = [];
  const walk = async (d, rel = '') => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (['node_modules', '.next', 'public'].includes(e.name) || e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r); else if (/\.(tsx|ts|jsx)$/.test(e.name)) files.push(r);
    }
  };
  await walk(root);
  for (const f of files) {
    const abs = path.join(root, f);
    const src = await fsp.readFile(abs, 'utf8');
    const next = src.replace(CLASS_STR, (m, pre, q, body) => {
      const plain = q === '`' ? body : body.replace(/\\(.)/g, '$1');
      const fixed = sanitizeClassList(plain, reg);
      if (fixed === plain) return m;
      const enc = q === '`' ? fixed.replace(/`/g, '\\`') : fixed.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q);
      return pre + q + enc + q;
    });
    if (next !== src) { if (ctx) await ctx.write(f, next); else await fsp.writeFile(abs, next); changed.push(f); }
  }
  if (reg.size && globals) {
    const block = reg.css();
    globals = /@import\s+["']tailwindcss["'];?\s*\n/.test(globals) ? globals.replace(/(@import\s+["']tailwindcss["'];?\s*\n)/, `$1\n${block}\n`) : block + '\n' + globals;
    if (ctx) await ctx.write('app/globals.css', globals); else await fsp.writeFile(globalsFile, globals);
    changed.push('app/globals.css');
  }
  return changed;
}
