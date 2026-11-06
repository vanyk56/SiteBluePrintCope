// Computed-style diffs -> Tailwind utility classes, grouped so desktop/mobile can be merged responsively.
import { fmt, round } from '../util.mjs';
import { isDirty, mapCssUrls } from './cssvars.mjs';

const DISPLAY = { flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', block: 'block', 'inline-block': 'inline-block', inline: 'inline', none: 'hidden', contents: 'contents', 'list-item': 'list-item', table: 'table', 'table-row': 'table-row', 'table-cell': 'table-cell', 'flow-root': 'flow-root', 'table-row-group': 'table-row-group', 'table-header-group': 'table-header-group' };
const JUSTIFY = { 'flex-start': 'justify-start', start: 'justify-start', left: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', end: 'justify-end', right: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', stretch: 'justify-stretch', normal: 'justify-normal' };
const ITEMS = { 'flex-start': 'items-start', start: 'items-start', 'self-start': 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', 'self-end': 'items-end', baseline: 'items-baseline', 'first baseline': 'items-baseline', stretch: 'items-stretch', normal: 'items-stretch' };
const VALIGN = { baseline: 'align-baseline', top: 'align-top', middle: 'align-middle', bottom: 'align-bottom', 'text-top': 'align-text-top', 'text-bottom': 'align-text-bottom', sub: 'align-sub', super: 'align-super' };
export const PREFLIGHT_MEDIA = /^(img|svg|video|canvas|audio|iframe|embed|object)$/;
const SELF = { 'flex-start': 'self-start', start: 'self-start', center: 'self-center', 'flex-end': 'self-end', end: 'self-end', baseline: 'self-baseline', stretch: 'self-stretch' };
const TEXT = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const WEIGHT = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const LEADING = [[1, 'none'], [1.25, 'tight'], [1.375, 'snug'], [1.5, 'normal'], [1.625, 'relaxed'], [2, 'loose']];
const TRACKING = [[-0.05, 'tighter'], [-0.025, 'tight'], [0, 'normal'], [0.025, 'wide'], [0.05, 'wider'], [0.1, 'widest']];
const RADIUS = { 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl' };
const MAXW = { 320: 'xs', 384: 'sm', 448: 'md', 512: 'lg', 576: 'xl', 672: '2xl', 768: '3xl', 896: '4xl', 1024: '5xl', 1152: '6xl', 1280: '7xl' };
const RESET = { display: null, position: 'static', inset: 'inset-auto', z: 'z-auto', flexDir: 'flex-row', flexWrap: 'flex-nowrap', justify: 'justify-normal', items: 'items-stretch', gap: 'gap-0', gridCols: 'grid-cols-none', gridFlow: 'grid-flow-row', colSpan: 'col-auto', rowSpan: 'row-auto', flex: 'flex-initial', self: 'self-auto', order: 'order-none', w: 'w-auto', h: 'h-auto', maxW: 'max-w-none', minW: 'min-w-0', maxH: 'max-h-none', minH: 'min-h-0', m: 'm-0', p: 'p-0', border: 'border-0', rounded: 'rounded-none', bg: 'bg-transparent', bgImg: 'bg-none', shadow: 'shadow-none', opacity: 'opacity-100', overflow: 'overflow-visible', clamp: 'line-clamp-none', transform: 'transform-none', filter: 'filter-none', backdrop: 'backdrop-filter-none', aspect: 'aspect-auto', objectFit: 'object-fill', list: 'list-none', decoration: 'no-underline', transition: 'transition-none', sr: 'not-sr-only' };
export const INH_GROUP_KEYS = { textColor: ['color', '-webkit-text-fill-color'], fontFamily: ['font-family'], fontSize: ['font-size', 'line-height'], fontWeight: ['font-weight'], tracking: ['letter-spacing'], italic: ['font-style'], textAlign: ['text-align'], textTransform: ['text-transform'], whitespace: ['white-space'], textShadow: ['text-shadow'], cursor: ['cursor'] };
const ROOT_SKIP = { cursor: 'auto', 'text-align': 'start', 'text-transform': 'none', 'white-space': 'normal', 'text-shadow': 'none', 'font-style': 'normal', 'letter-spacing': 0 };

export const arb = (v) => String(v).trim().replace(/_/g, '\\_').replace(/\s+/g, '_');
const firstFamily = (stack) => String(stack || '').split(',')[0].replace(/["']/g, '').trim();
// full fallback chain for arbitrary families: a Latin-only webfont + Cyrillic text renders the missing glyphs with the NEXT family in the stack —
// dropping it makes the browser fall back to its default (serif) font. Keeps ≤5 families, always keeps the generic one.
const GENERIC_FAMILY = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong)$/i;
export function familyStack(stack) {
  const parts = String(stack || '').split(',').map((x) => x.trim().replace(/"/g, "'")).filter(Boolean);
  if (!parts.length) return '';
  const head = parts.slice(0, 5), gen = parts.find((x) => GENERIC_FAMILY.test(x));
  if (gen && !head.includes(gen)) head.push(gen);
  return head.map((x) => (/^'.*'$/.test(x) || GENERIC_FAMILY.test(x) || /^-?[a-z][\w-]*$/i.test(x) ? x : `'${x.replace(/'/g, '')}'`)).join(',');
}
function sp(px) { const a = Math.abs(px); if (a === 0) return '0'; if (a === 1) return 'px'; const n = a / 4; if (Number.isInteger(n) || [0.5, 1.5, 2.5, 3.5].includes(n)) return String(n); return `[${fmt(a)}px]`; }
const spc = (prefix, px) => (px < 0 ? '-' : '') + prefix + '-' + sp(px);
function box(prefix, [t, r, b, l], explicit) {
  if (t === r && r === b && b === l) return t || explicit ? spc(prefix, t) : '';
  const out = []; const push = (p, v) => { if (v || explicit) out.push(spc(prefix + p, v)); };
  if (t === b && l === r) { push('y', t); push('x', l); }
  else if (l === r) { push('t', t); push('b', b); push('x', l); }
  else if (t === b) { push('y', t); push('l', l); push('r', r); }
  else { push('t', t); push('r', r); push('b', b); push('l', l); }
  return out.join(' ');
}
function splitTop(v) { const out = []; let depth = 0, cur = ''; for (const ch of v) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }
export function transformCls(v) {
  const m = /^matrix\(([^)]+)\)$/.exec(v || '');
  if (m) {
    const [a, b, c, d, e, f] = m[1].split(',').map(Number);
    const out = [];
    const sx = Math.hypot(a, b), sy = Math.hypot(c, d); const rot = round((Math.atan2(b, a) * 180) / Math.PI, 2);
    if (Math.abs(e) > 0.05) out.push(spc('translate-x', round(e, 1)));
    if (Math.abs(f) > 0.05) out.push(spc('translate-y', round(f, 1)));
    if (rot) out.push(rot < 0 ? `-rotate-[${-rot}deg]` : `rotate-[${rot}deg]`);
    if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) out.push(Math.abs(sx - sy) < 0.001 ? `scale-[${round(sx, 3)}]` : `scale-x-[${round(sx, 3)}] scale-y-[${round(sy, 3)}]`);
    return out.join(' ') || '';
  }
  return v ? `[transform:${arb(v)}]` : '';
}
const filterCls = (v, pre = '') => { const m = /^blur\(([\d.]+px)\)$/.exec(v); return m ? `${pre}blur-[${m[1]}]` : `[${pre ? 'backdrop-filter' : 'filter'}:${arb(v)}]`; };
function leadingCls(lh) { if (lh === 'normal' || lh === undefined) return 'leading-[normal]'; const hit = LEADING.find(([v]) => Math.abs(v - lh) < 0.01); return hit ? `leading-${hit[1]}` : `leading-[${fmt(lh)}]`; }
function trackingCls(ls) { if (!ls) return 'tracking-normal'; const hit = TRACKING.find(([v]) => Math.abs(v - ls) < 0.003); return hit ? `tracking-${hit[1]}` : `tracking-[${fmt(ls)}em]`; }
function gridCols(v) {
  const tr = String(v).trim().split(/\s+/);
  if (!tr.length || tr.some((x) => !/^-?[\d.]+px$/.test(x))) return `grid-cols-[${arb(v)}]`;
  const px = tr.map(parseFloat); const min = Math.min(...px), max = Math.max(...px);
  if (max - min <= 2) return `grid-cols-${px.length}`;
  // minmax(0,…): a bare 1fr has an automatic min-content minimum, so a long <pre> line or URL widens its track and squeezes
  // the neighbours (a docs sidebar came out 4px narrower and shifted the whole article)
  if (px.length === 2 && min < 420) return px[0] < px[1] ? `grid-cols-[${Math.round(px[0])}px_minmax(0,1fr)]` : `grid-cols-[minmax(0,1fr)_${Math.round(px[1])}px]`;
  // exact proportions (1.1fr 1fr stays 1.1fr 1fr: rounding to halves made a hero text column 26px narrower → extra line wrap)
  return `grid-cols-[${px.map((x) => `minmax(0,${fmt(Math.round((x / min) * 100) / 100)}fr)`).join('_')}]`;
}
const countersCls = (c) => [c.reset && `[counter-reset:${arb(c.reset)}]`, c.set && `[counter-set:${arb(c.set)}]`, c.inc && `[counter-increment:${arb(c.inc)}]`].filter(Boolean).join(' ');
// grid-row-start/-end pairs of a pseudo item: "span 2 / auto" -> row-span-2, "1 / -1" -> row-span-full, "2 / 4" -> start/end
function gridPair(kind, v) {
  const [a, b] = String(v).split('/').map((x) => x.trim());
  if (/^span \d+$/.test(a) && (!b || b === 'auto')) return `${kind}-span-${a.slice(5)}`;
  if (/^span \d+$/.test(b || '') && a === 'auto') return `${kind}-span-${b.slice(5)}`;
  return gridSpan(kind, `${a} / ${b || 'auto'}`);
}
function gridSpan(kind, v) {
  let m = /span (\d+)/.exec(v); if (m) return `${kind}-span-${m[1]}`;
  if (/^1 \/ -1$/.test(v)) return `${kind}-span-full`;
  m = /^(-?\d+) \/ (-?\d+)$/.exec(v); if (m) return `${kind}-start-${m[1]} ${kind}-end-${m[2]}`;
  m = /^(-?\d+) \/ auto$/.exec(v); if (m) return `${kind}-start-${m[1]}`;
  return `[grid-${kind === 'col' ? 'column' : 'row'}:${arb(v)}]`;
}
function flexCls(s) {
  const g = s['flex-grow'] ?? 0, sh = s['flex-shrink'] ?? 1, b = s['flex-basis'] ?? 'auto';
  if (g === 1 && sh === 1 && (b === '0%' || b === '0px')) return 'flex-1';
  if (g === 1 && sh === 1 && b === 'auto') return 'flex-auto';
  if (g === 0 && sh === 0 && b === 'auto') return 'flex-none';
  const out = [];
  if (g) out.push(g === 1 ? 'grow' : `grow-[${g}]`);
  if (sh !== 1) out.push(sh === 0 ? 'shrink-0' : `shrink-[${sh}]`);
  if (b !== 'auto') out.push({ '50%': 'basis-1/2', '100%': 'basis-full', '0%': 'basis-0', '0px': 'basis-0', '25%': 'basis-1/4' }[b] || `basis-[${arb(b)}]`);
  return out.join(' ');
}
function insetCls(ins, explicit) {
  if (!ins) return '';
  if (ins.every((v) => v === 0)) return 'inset-0';
  const one = (p, v) => {
    if (v === 'auto' || v === undefined) return explicit ? p + '-auto' : '';
    if (typeof v === 'number') return spc(p, v);
    if (/%$/.test(v)) { const pct = parseFloat(v); const fr = { 50: '1/2', 100: 'full', 25: '1/4', 75: '3/4' }[Math.abs(pct)]; return (pct < 0 ? '-' : '') + p + '-' + (fr || `[${Math.abs(pct)}%]`); }
    return `${p}-[${arb(v)}]`;
  };
  return ['top', 'right', 'bottom', 'left'].map((p, i) => one(p, ins[i])).filter(Boolean).join(' ');
}

const FR = [[50, '1/2'], [33.3333, '1/3'], [66.6667, '2/3'], [25, '1/4'], [75, '3/4'], [20, '1/5'], [40, '2/5'], [60, '3/5'], [80, '4/5'], [16.6667, '1/6'], [83.3333, '5/6']];
function autoTrack(kind, v) {
  v = String(v).trim();
  if (v === 'min-content') return `auto-${kind}-min`;
  if (v === 'max-content') return `auto-${kind}-max`;
  if (v === 'minmax(0px, 1fr)') return `auto-${kind}-fr`;
  return `auto-${kind}-[${arb(v)}]`;
}
export function authoredLen(kind, v) {
  v = String(v).trim();
  if (v === '100%') return kind + '-full';
  const m = /^([\d.]+)%$/.exec(v);
  if (m) { const pct = +m[1]; const hit = FR.find(([k]) => Math.abs(k - pct) < 0.05); return hit ? `${kind}-${hit[1]}` : `${kind}-[${fmt(pct)}%]`; }
  if (kind === 'w' && v === '100vw') return 'w-screen';
  if (kind === 'h' && v === '100vh') return 'h-screen';
  if (kind === 'h' && /^100[dsl]vh$/.test(v)) return 'h-' + v.slice(3);
  if (/^(-moz-|-webkit-)?fit-content$/.test(v)) return kind + '-fit';
  if (v === 'max-content') return kind + '-max';
  if (v === 'min-content') return kind + '-min';
  if (/^[\d.]+(vw|vh|dvh|svh|lvh|vmin|vmax)$/.test(v)) return `${kind}-[${v}]`;
  if (/^(calc|clamp|min|max)\(/.test(v) && !/var\(/.test(v) && v.length < 70) return `${kind}-[${arb(v)}]`;
  return '';
}
const UA_OVERFLOW = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'embed', 'object']);

export function createTw(tokens, { vh = 900, assetUrl = (u) => u, vars = null } = {}) {
  // long / data-URI values go to CSS variables (@theme static) instead of class names — see cssvars.mjs
  const bgImg = (v, multi = splitTop(v).length > 1) => (vars && isDirty(v) ? `bg-(image:${vars.add('bgi', v)})` : multi ? `[background-image:${arb(v)}]` : `bg-[${arb(v)}]`);
  const KF = tokens.keyframes || {};
  const animatedProps = (s) => { if (!s.animation) return ''; let txt = ''; for (const nm of s.animation.split(' | ')[0].split(',').map((x) => x.trim())) { if (!KF[nm]) return 'transform opacity'; txt += KF[nm]; } return txt; };
  const colorMap = tokens.colorMap || {}; const shadowMap = tokens.shadowMap || {}; const fontMap = tokens.fontMap || {};
  const col = (prefix, hex) => {
    if (!hex) return '';
    if (colorMap[hex]) return `${prefix}-${colorMap[hex]}`;
    if (/^#[0-9a-f]{6}00$/i.test(hex) || hex === 'transparent') return `${prefix}-transparent`;
    if (hex === 'currentcolor' || hex === 'currentColor') return `${prefix}-current`;
    return `${prefix}-[${hex}]`;
  };
  const INH = {
    textColor: (e) => (e['-webkit-text-fill-color'] === '#00000000' ? 'text-transparent' : col('text', e.color)),
    fontFamily: (e) => { const f = firstFamily(e['font-family']); if (fontMap[f]) return `font-${fontMap[f]}`; const st = familyStack(e['font-family']); return st.includes(',') ? `font-[${arb(st)}]` : GENERIC_FAMILY.test(f) ? `font-[${f}]` : `font-['${arb(f)}']`; },
    fontSize: (e) => { const fs = e['font-size']; return `${TEXT[fs] ? 'text-' + TEXT[fs] : `text-[${fmt(fs)}px]`} ${leadingCls(e['line-height'])}`; },
    fontWeight: (e) => (WEIGHT[e['font-weight']] ? `font-${WEIGHT[e['font-weight']]}` : `font-[${e['font-weight']}]`),
    tracking: (e) => trackingCls(e['letter-spacing']),
    italic: (e) => (/italic|oblique/.test(e['font-style'] || '') ? 'italic' : 'not-italic'),
    textAlign: (e) => ({ center: 'text-center', '-webkit-center': 'text-center', right: 'text-right', end: 'text-right', left: 'text-left', start: 'text-left', justify: 'text-justify' })[e['text-align']] || '',
    textTransform: (e) => ({ uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' })[e['text-transform']] || '',
    whitespace: (e) => ({ nowrap: 'whitespace-nowrap', pre: 'whitespace-pre', 'pre-wrap': 'whitespace-pre-wrap', 'pre-line': 'whitespace-pre-line', normal: 'whitespace-normal', 'break-spaces': 'whitespace-break-spaces' })[e['white-space']] || '',
    textShadow: (e) => (e['text-shadow'] && e['text-shadow'] !== 'none' ? `[text-shadow:${arb(e['text-shadow'])}]` : '[text-shadow:none]'),
    cursor: (e) => (e.cursor === 'pointer' ? 'cursor-pointer' : e.cursor && e.cursor !== 'auto' ? `cursor-${e.cursor}` : 'cursor-auto'),
  };
  const val = (E, keys) => JSON.stringify(keys.map((k) => (E ? E[k] : undefined)));

  function inheritedGroups(e, pe) {
    const g = {};
    for (const [grp, keys] of Object.entries(INH_GROUP_KEYS)) {
      if (val(e, keys) === val(pe, keys)) continue;
      if (!pe && keys.every((k) => e[k] === undefined || ROOT_SKIP[k] === e[k])) continue;
      const c = INH[grp](e); if (c) g[grp] = c;
    }
    return g;
  }
  function boxGroups(n, parent, explicit) {
    const s = n.s || {}; const g = {};
    if (s.margin) {
      let [t, r, b, l] = s.margin; let auto = false;
      if (parent && r > 0 && Math.abs(r - l) <= 1 && n.r[2] < parent.r[2] - 2 && !s.mfix) { // mfix: re-resolving as auto moved the box
        const pp = (parent.s && parent.s.padding) || [0, 0, 0, 0];
        const lg = n.r[0] - parent.r[0] - pp[3], rg = parent.r[0] + parent.r[2] - (n.r[0] + n.r[2]) - pp[1];
        if (Math.abs(lg - rg) <= 2) auto = true;
      }
      g.m = auto ? ['mx-auto', box('m', [t, 0, b, 0], false).replace(/\bmx-0\b/, '')].join(' ').trim() : box('m', [t, r, b, l], explicit);
    }
    if (s.padding) g.p = box('p', s.padding, explicit);
    if (s.gap) { const [rg, cg] = s.gap; g.gap = rg === cg ? spc('gap', rg) : [rg || explicit ? spc('gap-y', rg) : '', cg || explicit ? spc('gap-x', cg) : ''].filter(Boolean).join(' '); }
    return g;
  }
  function groups(n, e, pe, parent, { explicit = false } = {}) {
    let s = n.s || {}; const t = n.t; const g = {};
    if (s.display) g.display = DISPLAY[s.display] || `[display:${s.display}]`;
    if (s.position) g.position = s.position;
    if (s.inset) {
      // n.ai = sides set by authored CSS ('' = none); other sides are "auto" even though the computed value is px
      const ins = typeof n.ai === 'string' ? s.inset.map((v, i) => (n.ai.includes('trbl'[i]) ? v : 'auto')) : s.inset;
      if (!ins.every((v) => v === 'auto') && !(s.position === 'relative' && ins.every((v) => v === 0 || v === 'auto'))) g.inset = insetCls(ins, explicit);
    }
    if (s['z-index'] !== undefined && !Number.isNaN(s['z-index'])) { const z = s['z-index']; g.z = [0, 10, 20, 30, 40, 50].includes(z) ? `z-${z}` : z < 0 ? `-z-[${-z}]` : `z-[${z}]`; }
    if (s['flex-direction']) g.flexDir = { row: 'flex-row', 'row-reverse': 'flex-row-reverse', column: 'flex-col', 'column-reverse': 'flex-col-reverse' }[s['flex-direction']];
    if (s['flex-wrap']) g.flexWrap = s['flex-wrap'] === 'wrap' ? 'flex-wrap' : s['flex-wrap'] === 'wrap-reverse' ? 'flex-wrap-reverse' : 'flex-nowrap';
    if (s['justify-content']) g.justify = JUSTIFY[s['justify-content']] || `justify-[${arb(s['justify-content'])}]`;
    if (s['align-items']) g.items = ITEMS[s['align-items']] || `items-[${arb(s['align-items'])}]`;
    if (s['grid-template-columns']) {
      // authored template (validated in the page to resolve to the same tracks) beats px→fr ratios: exact at any width
      const c = gridCols(s['grid-template-columns']);
      g.gridCols = s.gcv && (c.includes('[') || /auto-(fill|fit)/.test(s.gcv)) ? `grid-cols-[${arb(s.gcv)}]` : c;
    }
    if (s['grid-auto-flow']) g.gridFlow = `grid-flow-${s['grid-auto-flow'].replace(' dense', '-dense').replace('column', 'col')}`;
    if (s['grid-template-areas']) g.gridAreas = `[grid-template-areas:${arb(s['grid-template-areas'].replace(/"/g, "'"))}]`;
    if (s['grid-auto-rows']) g.autoRows = autoTrack('rows', s['grid-auto-rows']);
    if (s['grid-auto-columns']) g.autoCols = autoTrack('cols', s['grid-auto-columns']);
    if (s['grid-area']) g.area = `[grid-area:${arb(s['grid-area'])}]`;
    if (s.counters) g.counters = countersCls(s.counters);
    if (s.table) {
      const sp = s.table.sp ? String(s.table.sp).trim().split(/\s+/) : null;
      const spc = !s.table.sep ? '' : !sp ? 'border-spacing-0' : sp.length < 2 || sp[0] === sp[1] ? `border-spacing-[${arb(sp[0])}]` : `border-spacing-x-[${arb(sp[0])}] border-spacing-y-[${arb(sp[1])}]`;
      g.table = [s.table.sep && 'border-separate', spc, s.table.fixed && 'table-fixed', s.table.cap === 'bottom' && 'caption-bottom'].filter(Boolean).join(' ');
    }
    {
      const tx = [];
      if (s['text-overflow']) tx.push(s['text-overflow'] === 'ellipsis' ? 'text-ellipsis' : `[text-overflow:${arb(s['text-overflow'])}]`);
      if (s['word-break']) tx.push({ 'break-all': 'break-all', 'keep-all': 'break-keep' }[s['word-break']] || `[word-break:${arb(s['word-break'])}]`);
      if (s['overflow-wrap']) tx.push(`[overflow-wrap:${arb(s['overflow-wrap'])}]`);
      if (s['text-wrap']) tx.push(s['text-wrap'] === 'balance' ? 'text-balance' : 'text-pretty');
      if (tx.length) g.textWrap = tx.join(' ');
    }
    if (s.appearance) g.appearance = s.appearance === 'native' ? '[border:revert]' : 'appearance-none';
    if (s['accent-color']) g.accent = col('accent', s['accent-color']);
    if (s.float) g.float = `float-${s.float === 'inline-start' ? 'start' : s.float === 'inline-end' ? 'end' : s.float}`;
    if (s.clear) g.clear = `clear-${s.clear === 'inline-start' ? 'start' : s.clear === 'inline-end' ? 'end' : s.clear}`;
    if (s['grid-column']) g.colSpan = gridSpan('col', s['grid-column']);
    if (s['grid-row']) g.rowSpan = gridSpan('row', s['grid-row']);
    if (s['flex-grow'] !== undefined || s['flex-shrink'] !== undefined || s['flex-basis'] !== undefined) g.flex = flexCls(s);
    if (s['align-self']) g.self = SELF[s['align-self']] || `self-[${arb(s['align-self'])}]`;
    if (s.order !== undefined) g.order = s.order < 0 ? `-order-[${-s.order}]` : `order-[${s.order}]`;
    // sizes (w/h are only present when the size is intrinsic/explicit: replaced, leaf, positioned, or set by an authored CSS rule)
    // inset-0 stretches a non-replaced box, but img/video/canvas/iframe keep their intrinsic size -> they still need w/h
    const insetFull = s.inset && s.inset.every((v) => v === 0) && (typeof n.ai !== 'string' || n.ai.length === 4) && !PREFLIGHT_MEDIA.test(t);
    // positioned boxes with text shrink-to-fit: when authored CSS is known and gives no size, don't freeze the measured px
    const shrink = typeof n.ai === 'string' && /^(absolute|fixed)$/.test(s.position || '') && !/^(img|svg|video|canvas|iframe|input|textarea|select|picture)$/.test(t);
    const auS = n.au || '';
    if (shrink && !auS.includes('w') && s.w !== undefined && !s.wv) { s = { ...s }; delete s.w; }
    if (shrink && !auS.includes('h') && s.h !== undefined && !s.hv) { s = { ...s }; delete s.h; }
    if (!insetFull && (s.w !== undefined || s.h !== undefined)) {
      const pp = parent && parent.s && parent.s.padding ? parent.s.padding : [0, 0, 0, 0];
      const pw = parent ? parent.r[2] - pp[1] - pp[3] : 0;
      const full = s.w !== undefined && parent && s.w > 40 && Math.abs(s.w - pw) <= 1.5 && !s.wpx; // wpx: authored px width in effect
      const isIcon = t === 'svg' || (s.w !== undefined && s.h !== undefined && s.w <= 160 && s.h <= 160);
      const au = n.au || '';
      const wCls = () => { const a = s.wv ? authoredLen('w', s.wv) : ''; if (a) return a; if (full) return 'w-full'; if (isIcon && s.h !== undefined && Math.abs(s.w - s.h) < 0.6) return Number.isInteger(s.w / 4) ? `size-${s.w / 4}` : `size-[${fmt(s.w)}px]`; return Number.isInteger(s.w / 4) && s.w <= 384 ? `w-${s.w / 4}` : `w-[${fmt(s.w)}px]`; };
      const hCls = () => { const a = s.hv ? authoredLen('h', s.hv) : ''; if (a) return a; return Math.abs(s.h - vh) <= 1 ? 'h-screen' : Number.isInteger(s.h / 4) && s.h <= 384 ? `h-${s.h / 4}` : `h-[${fmt(s.h)}px]`; };
      const natOk = t === 'img' && s.w !== undefined && s.h > 0 && n._ar && Math.abs(n._ar - s.w / s.h) < 0.02 && (!s['object-fit'] || s['object-fit'] === 'fill');
      if (natOk && au.includes('h') && !au.includes('w')) g.h = hCls();
      else if (natOk && !au.includes('h')) { if (au.includes('w') || !(n._nw >= s.w - 1) || !full) g.w = wCls(); g.h = 'h-auto'; } // downscaled below the container width (width attr / CSS) → explicit width
      else {
        if (s.w !== undefined) g.w = wCls();
        if (s.h !== undefined && !(g.w || '').startsWith('size-')) g.h = hCls();
      }
    }
    const len = (v) => (typeof v === 'number' ? `[${fmt(v)}px]` : `[${arb(v)}]`);
    if (s['max-width'] !== undefined) g.maxW = typeof s['max-width'] === 'number' ? (MAXW[s['max-width']] ? `max-w-${MAXW[s['max-width']]}` : `max-w-[${fmt(s['max-width'])}px]`) : s['max-width'] === '100%' ? 'max-w-full' : `max-w-${len(s['max-width'])}`;
    if (s['min-width'] !== undefined) g.minW = s['min-width'] === '100%' ? 'min-w-full' : `min-w-${len(s['min-width'])}`;
    if (s['max-height'] !== undefined) g.maxH = s['max-height'] === '100%' ? 'max-h-full' : `max-h-${len(s['max-height'])}`;
    if (s['min-height'] !== undefined) g.minH = typeof s['min-height'] === 'number' && Math.abs(s['min-height'] - vh) <= 1 ? 'min-h-screen' : s['min-height'] === '100%' ? 'min-h-full' : `min-h-${len(s['min-height'])}`;
    Object.assign(g, boxGroups(n, parent, explicit));
    // typography
    Object.assign(g, inheritedGroups(e || {}, pe));
    // visuals
    if (s['border-width']) {
      const [bt, br, bb, bl] = s['border-width'];
      const w = (v) => (v === 1 ? '' : [2, 4, 8].includes(v) ? '-' + v : `-[${fmt(v)}px]`);
      const out = [];
      if (bt === br && br === bb && bb === bl) out.push('border' + w(bt));
      else { const sc = (side, v) => (v ? `border-${side}${w(v)}` : explicit ? `border-${side}-0` : ''); if (bt === bb && bl === br) out.push(sc('y', bt), sc('x', bl)); else out.push(sc('t', bt), sc('r', br), sc('b', bb), sc('l', bl)); }
      const bc = s['border-color'];
      if (typeof bc === 'string') out.push(col('border', bc));
      else if (Array.isArray(bc)) ['t', 'r', 'b', 'l'].forEach((side, i) => { if (s['border-width'][i]) out.push(col('border-' + side, bc[i])); });
      if (s['border-style']) out.push('border-' + s['border-style']);
      g.border = out.filter(Boolean).join(' ');
    }
    if (s.radius) {
      const one = (v) => { if (typeof v === 'string') return parseFloat(v) >= 50 ? 'full' : `[${v}]`; if (v >= 9999 || (n.r[3] > 0 && v >= n.r[3] / 2 && v >= n.r[2] / 2 - 1)) return 'full'; return RADIUS[v] || `[${fmt(v)}px]`; };
      const [tl, tr, br, bl] = s.radius;
      if (tl === tr && tr === br && br === bl) g.rounded = 'rounded-' + one(tl);
      else g.rounded = [['tl', tl], ['tr', tr], ['br', br], ['bl', bl]].filter(([, v]) => v || explicit).map(([c, v]) => (v ? `rounded-${c}-${one(v)}` : `rounded-${c}-none`)).join(' ');
    }
    if (s['background-color']) g.bg = col('bg', s['background-color']);
    if (s['background-image']) {
      const v = mapCssUrls(s['background-image'], (u, q) => { const w = assetUrl(u); return w && w !== u ? `url(${w})` : `url(${q}${u}${q})`; });
      const out = [bgImg(v)];
      const size = s['background-size']; if (size) out.push(size === 'cover' ? 'bg-cover' : size === 'contain' ? 'bg-contain' : `bg-[length:${arb(size)}]`);
      const pos = s['background-position']; if (pos) out.push({ '50% 50%': 'bg-center', 'center center': 'bg-center', '50% 0%': 'bg-top', '50% 100%': 'bg-bottom' }[pos] || `bg-[position:${arb(pos)}]`);
      const rep = s['background-repeat']; if (rep) out.push({ 'no-repeat': 'bg-no-repeat', 'repeat-x': 'bg-repeat-x', 'repeat-y': 'bg-repeat-y' }[rep] || `[background-repeat:${arb(rep)}]`);
      if (s['background-attachment'] === 'fixed') out.push('bg-fixed');
      g.bgImg = out.join(' ');
    }
    if (s['background-clip'] === 'text') g.bgClip = 'bg-clip-text';
    else if (s['background-clip']) g.bgClip = `[background-clip:${arb(s['background-clip'])}]`;
    if (s['background-origin']) g.bgOrigin = `[background-origin:${arb(s['background-origin'])}]`;
    if (s.isolation) g.isolation = 'isolate';
    if (s['mask-image']) g.mask = [vars && isDirty(s['mask-image']) ? `[mask-image:var(${vars.add('mask', s['mask-image'])})]` : `[mask-image:${arb(s['mask-image'])}]`, s['mask-size'] ? `[mask-size:${arb(s['mask-size'])}]` : '', s['mask-position'] ? `[mask-position:${arb(s['mask-position'])}]` : '', s['mask-repeat'] ? `[mask-repeat:${arb(s['mask-repeat'])}]` : ''].filter(Boolean).join(' ');
    if (s['box-shadow']) g.shadow = shadowMap[s['box-shadow']] ? `shadow-${shadowMap[s['box-shadow']]}` : `shadow-[${arb(s['box-shadow'])}]`;
    const anim = animatedProps(s);
    if (s.opacity !== undefined && !/opacity/.test(anim)) { const o = Math.round(s.opacity * 100); g.opacity = o % 5 === 0 ? `opacity-${o}` : `opacity-[${s.opacity}]`; }
    if (s.overflow && !(UA_OVERFLOW.has(t) && /^(clip|hidden)$/.test(s.overflow))) { const [ox, oy] = s.overflow.split(' '); g.overflow = !oy ? `overflow-${ox}` : `overflow-x-${ox} overflow-y-${oy}`; }
    if (s['line-clamp']) { g.clamp = `line-clamp-${s['line-clamp']}`; if (/^(-webkit-(inline-)?box|flow-root|block)$/.test(s.display || '')) delete g.display; if (g.overflow === 'overflow-hidden') delete g.overflow; }
    if (s.transform && !/transform|translate|rotate|scale/.test(anim)) g.transform = transformCls(s.transform);
    if (s.filter) g.filter = filterCls(s.filter);
    if (s['backdrop-filter']) g.backdrop = filterCls(s['backdrop-filter'], 'backdrop-');
    if (s['mix-blend-mode']) g.blend = `mix-blend-${s['mix-blend-mode']}`;
    if (s['clip-path']) g.clip = vars && isDirty(s['clip-path']) ? `[clip-path:var(${vars.add('clip', s['clip-path'])})]` : `[clip-path:${arb(s['clip-path'])}]`;
    if (s['aspect-ratio']) { const a = s['aspect-ratio'].replace(/\s+/g, ''); g.aspect = a === '16/9' ? 'aspect-video' : a === '1/1' || a === '1' ? 'aspect-square' : `aspect-[${a}]`; }
    if (s['object-fit']) g.objectFit = `object-${s['object-fit']}`;
    if (s['vertical-align'] !== undefined) { const va = s['vertical-align']; if (!(PREFLIGHT_MEDIA.test(t) && va === 'middle')) g.valign = VALIGN[va] || (typeof va === 'number' ? `align-[${fmt(va)}px]` : `align-[${arb(String(va))}]`); }
    if (s['object-position']) g.objectPos = s['object-position'] === '50% 0%' ? 'object-top' : `object-[${arb(s['object-position'])}]`;
    if (s['list-style-type']) g.list = s['list-style-type'] === 'disc' ? 'list-disc' : s['list-style-type'] === 'decimal' ? 'list-decimal' : `list-[${arb(s['list-style-type'])}]`;
    if (s['list-style-position'] === 'inside') g.list = (g.list || '') + ' list-inside';
    if (s['text-decoration']) { const d = s['text-decoration']; g.decoration = [d.includes('underline') ? 'underline' : '', d.includes('line-through') ? 'line-through' : '', d.includes('overline') ? 'overline' : '', s['text-decoration-color'] ? col('decoration', s['text-decoration-color']) : '', s['underline-offset'] ? `underline-offset-[${s['underline-offset']}]` : ''].filter(Boolean).join(' '); }
    if (s.transition) {
      const [prop, dur, ease, delay] = s.transition.split(' | ');
      const out = []; const p = (prop || 'all').trim();
      if (p === 'all') out.push('transition-all');
      else if (/^(color|background-color|border-color|text-decoration-color|fill|stroke)(,\s*(color|background-color|border-color|text-decoration-color|fill|stroke|outline-color))*$/.test(p)) out.push('transition-colors');
      else if (p === 'transform') out.push('transition-transform'); else if (p === 'opacity') out.push('transition-opacity'); else if (p === 'box-shadow') out.push('transition-shadow');
      else out.push(`transition-[${p.split(',').map((x) => x.trim()).join(',')}]`);
      const first = (dur || '0s').split(',')[0].trim(); const ms = Math.round(parseFloat(first) * (first.endsWith('ms') ? 1 : 1000));
      if (ms) out.push([75, 100, 150, 200, 300, 500, 700, 1000].includes(ms) ? `duration-${ms}` : `duration-[${ms}ms]`);
      const ez = (/^(cubic-bezier\([^)]*\)|steps\([^)]*\)|[a-z-]+)/.exec((ease || '').trim()) || [])[1] || 'ease';
      out.push(ez === 'linear' ? 'ease-linear' : `ease-[${ez.replace(/\s+/g, '')}]`);
      const dl = (delay || '').split(',')[0].trim(); const dms = Math.round(parseFloat(dl) * (dl.endsWith('ms') ? 1 : 1000)); if (dms) out.push(`delay-[${dms}ms]`);
      g.transition = out.join(' ');
    }
    if (s.animation) { const [name, dur, tf, cnt] = s.animation.split(' | '); g.animation = `animate-[${arb([name, dur, (tf || '').replace(/\s+/g, ''), cnt].filter(Boolean).join(' '))}]`; }
    if (n.sr) g.sr = 'sr-only';
    if (n.pb) g.before = pseudoCls('before', n.pb);
    if (n.pa) g.after = pseudoCls('after', n.pa);
    if (n.fl) g.firstLetter = textPseudoCls('first-letter', n.fl);
    if (n.mk) g.marker = textPseudoCls('marker', n.mk);
    if (n.ph) g.placeholder = `placeholder:${col('text', n.ph)}`;
    if (s.columns) {
      const c = s.columns; const out = [];
      out.push(c.count && c.width ? `[columns:${fmt(c.width)}px_${c.count}]` : c.count ? `columns-${c.count}` : `columns-[${fmt(c.width)}px]`);
      if (c.gap !== undefined) out.push(spc('gap-x', c.gap));
      if (c.rule) out.push(`[column-rule:${arb(c.rule)}]`);
      g.columns = out.join(' ');
    }
    if (s['break-inside']) g.breakInside = /^(avoid|avoid-page|avoid-column)$/.test(s['break-inside']) ? `break-inside-${s['break-inside']}` : `[break-inside:${arb(s['break-inside'])}]`;
    return g;
  }
  // text-only pseudo elements (::first-letter drop cap, ::marker): typography + float/box of the first letter
  function textPseudoCls(prefix, o) {
    const out = [];
    if (o.float) out.push(`float-${o.float}`);
    if (o.color) out.push(col('text', o.color));
    if (o.fontSize) out.push(`text-[${fmt(o.fontSize)}px]`);
    if (o.lh !== undefined) out.push(o.lh === 'normal' ? 'leading-[normal]' : `leading-[${fmt(o.lh)}px]`);
    if (o.fontWeight) out.push(WEIGHT[o.fontWeight] ? `font-${WEIGHT[o.fontWeight]}` : `font-[${o.fontWeight}]`);
    if (o.fontStyle) out.push(o.fontStyle === 'italic' ? 'italic' : 'not-italic');
    if (o.fontFamily) { const st = familyStack(o.fontFamily); out.push(st.includes(',') ? `font-[${arb(st)}]` : GENERIC_FAMILY.test(st) ? `font-[${st}]` : `font-['${arb(st.replace(/'/g, ''))}']`); }
    if (o.tt) out.push({ uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' }[o.tt] || '');
    if (o.padding) out.push(box('p', o.padding, false));
    if (o.margin) out.push(box('m', o.margin, false));
    if (o.bg) out.push(col('bg', o.bg));
    return out.join(' ').split(/\s+/).filter(Boolean).map((c) => `${prefix}:${c}`).join(' ');
  }
  function pseudoCls(prefix, p) {
    const out = [];
    // counter()/counters()/attr() and mixed values ("Шаг " counter(step)) stay CSS: the clone counts by itself
    const fnContent = /\b(counters?|attr)\(/.test(p.content);
    const content = p.content === '""' || p.content === "''" ? "''" : fnContent ? p.content.replace(/\s*,\s*/g, ',') : "'" + p.content.replace(/^["']|["']$/g, '').replace(/'/g, "\\'") + "'";
    out.push(vars && isDirty(content) ? `content-(${vars.add('content', content)})` : `content-[${arb(content)}]`);
    if (p.position && p.position !== 'static') out.push(p.position);
    if (p.inset) out.push(insetCls(p.inset));
    if (p.display && !['inline', 'block'].includes(p.display) || (p.display === 'block' && p.position === 'static')) out.push(DISPLAY[p.display] || '');
    if (p.w !== undefined) out.push(typeof p.w === 'number' ? `w-[${fmt(p.w)}px]` : `w-[${arb(p.w)}]`);
    if (p.h !== undefined) out.push(typeof p.h === 'number' ? `h-[${fmt(p.h)}px]` : `h-[${arb(p.h)}]`);
    if (p.bg) out.push(col('bg', p.bg));
    if (p.bgi) out.push(bgImg(p.bgi));
    if (p.bgs) out.push(p.bgs === 'cover' ? 'bg-cover' : p.bgs === 'contain' ? 'bg-contain' : `bg-[length:${arb(p.bgs)}]`);
    if (p.bgp) out.push({ '50% 50%': 'bg-center', 'center center': 'bg-center', '50% 0%': 'bg-top', '50% 100%': 'bg-bottom' }[p.bgp] || `bg-[position:${arb(p.bgp)}]`);
    if (p.bgr) out.push({ 'no-repeat': 'bg-no-repeat', 'repeat-x': 'bg-repeat-x', 'repeat-y': 'bg-repeat-y' }[p.bgr] || `[background-repeat:${arb(p.bgr)}]`);
    if (p.flex) out.push(flexCls({ 'flex-grow': p.flex[0], 'flex-shrink': p.flex[1], 'flex-basis': p.flex[2] }));
    if (p.gcol) out.push(gridPair('col', p.gcol));
    if (p.grow) out.push(gridPair('row', p.grow));
    if (p.counters) out.push(countersCls(p.counters));
    if (p.self) out.push({ 'flex-start': 'self-start', start: 'self-start', 'flex-end': 'self-end', end: 'self-end', center: 'self-center', stretch: 'self-stretch', baseline: 'self-baseline' }[p.self] || `self-[${arb(p.self)}]`);
    if (p.order !== undefined) out.push(p.order < 0 ? `-order-${-p.order}` : `order-${p.order}`);
    if (p.z !== undefined && !Number.isNaN(p.z)) out.push(`z-[${p.z}]`);
    if (p.blend) out.push(`mix-blend-${p.blend}`);
    if (p.mask) out.push(`[mask-image:${arb(p.mask)}]`);
    if (p.radius !== undefined) out.push(typeof p.radius === 'number' ? (p.radius >= 999 ? 'rounded-full' : `rounded-[${fmt(p.radius)}px]`) : `rounded-[${arb(p.radius)}]`);
    if (p.shadow) out.push(`shadow-[${arb(p.shadow)}]`);
    if (p.opacity !== undefined) out.push(`opacity-[${p.opacity}]`);
    if (p.transform) out.push(transformCls(p.transform));
    if (p.filter) out.push(filterCls(p.filter));
    if (p.border) out.push(`[border:${arb(p.border)}]`);
    if (p.clear) out.push(`clear-${p.clear}`);
    if (p.float) out.push(`float-${p.float}`);
    if (p.color) out.push(col('text', p.color));
    if (p.fontSize) out.push(`text-[${p.fontSize}px]`);
    if (p.fontFamily) { const st = familyStack(p.fontFamily); out.push(st.includes(',') ? `font-[${arb(st)}]` : GENERIC_FAMILY.test(st) ? `font-[${st}]` : `font-['${arb(st.replace(/'/g, ''))}']`); }
    if (p.fontWeight) out.push(WEIGHT[p.fontWeight] ? `font-${WEIGHT[p.fontWeight]}` : `font-[${p.fontWeight}]`);
    if (p.lh !== undefined) out.push(p.lh === 'normal' ? 'leading-[normal]' : `leading-[${fmt(p.lh)}px]`);
    if (p.fontStyle) out.push(p.fontStyle === 'italic' ? 'italic' : 'not-italic');
    if (p.tt) out.push({ uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' }[p.tt] || '');
    if (p.ls !== undefined) out.push(`tracking-[${fmt(p.ls)}px]`);
    if (p.margin) out.push(box('m', p.margin, false));
    return out.join(' ').split(/\s+/).filter(Boolean).map((c) => `${prefix}:${c}`).join(' ');
  }
  function defaultDisplay(n) { const t = n.t; if (['img', 'svg', 'video', 'canvas', 'iframe'].includes(t)) return 'block'; if (['span', 'a', 'b', 'strong', 'i', 'em', 'small', 'label', 'code'].includes(t)) return 'inline'; if (['button', 'input', 'select', 'textarea'].includes(t)) return 'inline-block'; if (t === 'li') return 'list-item'; return 'block'; }
  function hoverCls(diff) {
    const out = [];
    for (const [k, [, to]] of Object.entries(diff)) {
      if (k === 'color') out.push(col('text', to)); else if (k === 'bg') out.push(col('bg', to)); else if (k === 'border') out.push(col('border', to));
      else if (k === 'shadow') out.push(!to || to === 'none' ? 'shadow-none' : shadowMap[to] ? `shadow-${shadowMap[to]}` : `shadow-[${arb(to)}]`); else if (k === 'opacity') out.push(`opacity-[${to}]`);
      else if (k === 'transform') out.push(to ? transformCls(to) : 'transform-none'); else if (k === 'decoration') out.push(to.includes('underline') ? 'underline' : 'no-underline');
      else if (k === 'filter') out.push(to ? filterCls(to) : 'filter-none'); else if (k === 'bgi') out.push(to ? bgImg(to) : 'bg-none');
      else if (k === 'scale' && to) out.push(`scale-[${to.split(' ')[0]}]`); else if (k === 'translate' && to) out.push(`translate-[${arb(to)}]`);
    }
    return out.join(' ').split(/\s+/).filter(Boolean).map((c) => `hover:${c}`).join(' ');
  }
  return { groups, inheritedGroups, INH, val, RESET, defaultDisplay, hoverCls, col };
}
