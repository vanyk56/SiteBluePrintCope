// Renders a detected section as a ready-to-use Next.js/React component (TSX) with Tailwind classes:
// exact texts, local asset paths, mobile-first responsive classes, hover states, repeated items -> data + .map().
import { kids, textOf, walkTree } from './tree.mjs';
import { INH_GROUP_KEYS, arb } from './tailwind.mjs';
import { cssHex, colorsToHex, sha } from '../util.mjs';
import { PRICE_RE } from './sections.mjs';
import { ADD_TO_CART_RE, clientImports, dialogProps, isCartDialog } from '../output/interactive.mjs';

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'label', 'font']);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'audio', 'iframe', 'embed', 'object']);
// invalid nesting that React/HTML reject (hydration errors): <p> with block children, <a> in <a>, <button> in <button>
const BLOCKISH = /^(div|section|article|aside|header|footer|nav|main|ul|ol|dl|table|form|fieldset|figure|blockquote|pre|h[1-6]|p|hr|address|details|dialog|menu|hgroup)$/;
function hasBlockKid(N) { let f = false; walkTree(N, (x) => { if (f) return false; if (x !== N && BLOCKISH.test(x.t)) { f = true; return false; } return undefined; }); return f; }
export function expectedDisplay(t) {
  if (REPLACED.has(t)) return 'block';
  if (t === 'button' || t === 'input' || t === 'select' || t === 'textarea' || t === 'meter' || t === 'progress') return 'inline-block';
  if (t === 'li' || t === 'summary') return 'list-item';
  const tbl = { table: 'table', tr: 'table-row', td: 'table-cell', th: 'table-cell', thead: 'table-header-group', tbody: 'table-row-group', tfoot: 'table-footer-group', caption: 'table-caption' };
  if (tbl[t]) return tbl[t];
  return INLINE.has(t) ? 'inline' : 'block';
}
const DISPLAY_CLS = { flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', block: 'block', 'inline-block': 'inline-block', inline: 'inline', contents: 'contents', 'list-item': 'list-item', table: 'table', 'table-row': 'table-row', 'table-cell': 'table-cell', 'flow-root': 'flow-root', 'table-row-group': 'table-row-group', 'table-header-group': 'table-header-group', 'table-footer-group': 'table-footer-group', 'table-caption': 'table-caption' };
const KNOWN = new Set('a abbr address article aside b blockquote button caption cite code dd del details dfn div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i input ins kbd label legend li main mark nav ol optgroup option p pre q s samp section select small span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul var picture dialog menu search hgroup address'.split(' '));
const VOID = new Set(['input', 'hr', 'img']);
const ORDER = ['display', 'position', 'inset', 'z', 'flexDir', 'flexWrap', 'justify', 'items', 'gridCols', 'gridFlow', 'colSpan', 'rowSpan', 'flex', 'self', 'order', 'w', 'h', 'maxW', 'minW', 'maxH', 'minH', 'm', 'p', 'gap',
  'fontFamily', 'fontSize', 'fontWeight', 'tracking', 'italic', 'textAlign', 'textTransform', 'whitespace', 'textColor', 'textShadow', 'cursor',
  'border', 'rounded', 'bg', 'bgImg', 'bgClip', 'shadow', 'opacity', 'overflow', 'clamp', 'transform', 'filter', 'backdrop', 'blend', 'clip', 'aspect', 'objectFit', 'objectPos', 'list', 'decoration', 'transition', 'animation', 'sr', 'before', 'after', 'hover'];
const ORD = Object.fromEntries(ORDER.map((k, i) => [k, i]));
const EXTRA_RESET = { bgClip: 'bg-clip-border', blend: 'mix-blend-normal', clip: '[clip-path:none]', objectPos: 'object-center', animation: 'animate-none', gridFlow: 'grid-flow-row', before: 'before:hidden', after: 'after:hidden' };
const displayOf = (n) => (n.s && n.s.display) || expectedDisplay(n.t);
const inlineLevel = (d) => /^inline/.test(d) || d === 'contents';

const NEEDS_EXPR = /[{}<>"'`]|&[#\w]+;/;
// non-breaking / thin spaces stay visible in the code: &nbsp; in JSX text, \u00a0 in strings
const SPECIAL_SP = /[\u00a0\u2007\u2009\u202f]/g;
export const jsEsc = (v) => JSON.stringify(v).replace(SPECIAL_SP, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const textEnt = (p) => p.replace(/\u00a0/g, '&nbsp;').replace(/[\u2007\u2009\u202f]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`);
export function jsxText(s) { return String(s).split('\n').map((p) => (p && NEEDS_EXPR.test(p) ? `{${jsEsc(p)}}` : textEnt(p))).join('<br />'); }
export function jsxAttr(name, v) { if (v === true) return name; const s = String(v); return /["\\\n&\u00a0\u2007\u2009\u202f]/.test(s) ? `${name}={${jsEsc(s)}}` : `${name}="${s}"`; }
const comment = (s) => `{/* ${String(s).replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */}`;
const M_TEXT = '\u0001', M_ATTR = '\u0002', M_TAG = '\u0003', M_CLS = '\u0004', M_LIST = '\u0005', M_CA = '\u0006', M_DYN = '\u0007';
const COLOR_TOK = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/g;
const cssVarName = (f) => '--item-' + f.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const posList = (ps) => { const out = []; for (let i = 0; i < ps.length; i++) { let j = i; while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++; out.push(j > i + 1 ? `${ps[i]}–${ps[j]}` : j === i + 1 ? `${ps[i]}, ${ps[j]}` : `${ps[i]}`); i = j; } return out.join(', '); };
// className markers of a template -> plain attribute, template literal with per-item classes, CSS variables for per-item colours
function finishClass(code, ref) {
  return code.replace(new RegExp(`className=${M_CA}([^${M_CA}]*)${M_CA}`, 'g'), (m, body) => {
    const vars = new Set();
    body = body.replace(new RegExp(`${M_DYN}V([\\w$]+)${M_DYN}`, 'g'), (mm, f) => { vars.add(f); return ''; });
    const b = body.replace(/\s+/g, ' ').trim();
    const style = vars.size ? ` style={{ ${[...vars].map((f) => `'${cssVarName(f)}': ${ref(f)}`).join(', ')} } as React.CSSProperties}` : '';
    if (!b.includes(M_DYN)) return b ? jsxAttr('className', b) + style : style.trim();
    const parts = b.split(M_DYN);
    if (parts.length === 3 && !parts[0].trim() && !parts[2].trim()) return `className={${ref(parts[1])}}` + style;
    return 'className={`' + parts.map((x, i) => (i % 2 ? '${' + ref(x) + '}' : x.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${'))).join('').replace(/ +`$/, '`') + '`}' + style;
  });
}

const normT = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
// drop explicit zero resets (px-0, mt-0…) from the desktop variant when mobile never set that side
const SIDE_OF = { '': 'trbl', x: 'rl', y: 'tb', t: 't', r: 'r', b: 'b', l: 'l', s: 'l', e: 'r' };
function pruneZeros(dv, a, base) {
  const rx = new RegExp(`^-?${base}([xytrblse]?)-`);
  const aSides = new Set(); for (const c of String(a || '').split(/\s+/)) { const m = rx.exec(c); if (m) for (const ch of SIDE_OF[m[1]]) aSides.add(ch); }
  return String(dv).split(/\s+/).filter((c) => { const m = new RegExp(`^${base}([xytrblse]?)-0$`).exec(c); return !m || [...SIDE_OF[m[1]]].some((ch) => aSides.has(ch)); }).join(' ');
}
const VAR_BY_TYPE = { header: 'navLinks', footer: 'footerLinks', features: 'features', pricing: 'plans', testimonials: 'testimonials', logos: 'logos', stats: 'stats', faq: 'faqs', blog: 'posts', team: 'team', gallery: 'images', tabs: 'tabs', hero: 'heroItems', cta: 'ctaItems' };

export function createSkeleton(ctx) {
  const { tw } = ctx;
  const BP = ctx.bp.prefix;
  const mob = ctx.mob || null;
  const pre = (cls, P = BP) => String(cls || '').split(/\s+/).filter(Boolean).map((c) => `${P}:${c}`).join(' ');
  // per-property breakpoint: taken from the media queries that actually style this element (n.bq), else from ancestors, else the site-wide one
  const LO = mob ? mob.raw.viewport.w : 390, HI = ctx.vw || 1440;
  const STD_BP = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];
  const bpName = (px) => { const hit = STD_BP.find(([, v]) => Math.abs(v - px) <= 2); return hit ? hit[0] : `min-[${px}px]`; };
  const LAYOUT_G = ['display', 'gridCols', 'flexDir', 'flexWrap', 'w', 'maxW', 'p', 'gap', 'colSpan'];
  const bqOf = (n, ks) => { const out = []; for (const [t, gs] of (n && n.bq) || []) if (t > LO && t <= HI) { const set = gs.split(','); if (ks.some((k) => set.includes(k))) out.push(t); } return out; };
  function prefixFor(D, M, k) {
    let ts = [...bqOf(D, [k]), ...bqOf(M, [k])];
    const up = D ? (n) => ctx.P.get(n.i) : (n) => mob.P.get(n.i);
    const start = D || M;
    if (!ts.length && INH_GROUP_KEYS[k]) for (let p = up(start), d = 0; p && d < 8 && !ts.length; p = up(p), d++) ts = bqOf(p, [k]);
    if (!ts.length && !INH_GROUP_KEYS[k]) for (let p = up(start), d = 0; p && d < 3 && !ts.length; p = up(p), d++) ts = bqOf(p, LAYOUT_G);
    return ts.length ? bpName(Math.max(...ts)) : BP;
  }
  // hover dropdowns (from the crawler probe) are re-created as hidden panels: group-hover:block
  const ddMap = new Map(((ctx.hidden && ctx.hidden.dropdowns) || []).filter((d) => d && d.label).map((d) => [normT(d.label), d]));
  const usedDD = new Set();
  const dropdownFor = (e) => { if (!ddMap.size || !e || !e.D) return null; const k = normT(textOf(e.D, 200)); if (usedDD.has(k) || !ddMap.has(k)) return null; if (kids(e.D).some((c) => normT(textOf(c, 200)) === k)) return null; return ddMap.get(k); };
  function dropdownPanel(d, ind, st) {
    usedDD.add(normT(d.label)); st.sh.interactive.add('dropdown');
    const S = d.style || {}; const cls = ['absolute left-0 top-full z-50 hidden group-hover:block group-focus-within:block'];
    const bg = cssHex(S.bg); if (bg && !/^#[0-9a-f]{6}00$/.test(bg)) cls.push(tw.col('bg', bg));
    if (S.radius && S.radius !== '0px') cls.push(`rounded-[${arb(S.radius)}]`);
    if (S.shadow && S.shadow !== 'none') cls.push(`shadow-[${arb(colorsToHex(S.shadow))}]`);
    if (S.padding && S.padding !== '0px') cls.push(`p-[${arb(S.padding)}]`);
    if (S.minWidth && !/^(auto|0px)$/.test(S.minWidth)) cls.push(`min-w-[${arb(S.minWidth)}]`);
    const links = (d.links || []).slice(0, 40).map((l) => { const L = ctx.linkFor(l.href); if (L.internal) st.sh.link = true; const tag = L.internal ? 'Link' : 'a'; return `${ind}  <${tag} ${jsxAttr('href', L.href)} className="block rounded-md px-3 py-2 whitespace-nowrap hover:bg-black/5">${jsxText(l.text || l.href)}</${tag}>`; });
    const body = links.length ? links.join('\n') : `${ind}  <div className="whitespace-pre-line">${jsxText(d.text || '')}</div>`;
    return `${ind}${comment(`выпадающее меню «${d.label}»: открывается при наведении${d.screenshot ? ' — скриншот ' + d.screenshot : ''}`)}\n${ind}<div className="${cls.join(' ')}">\n${body}\n${ind}</div>`;
  }
  const burger = ctx.hidden && ctx.hidden.burger;
  const menu = ctx.hidden && ctx.hidden.menu; // { links, bg, fg } of the opened burger menu
  const dialogs = (ctx.hidden && ctx.hidden.dialogs) || new Map(); // desktop node id -> probed dialog
  const usedDlg = new Set();
  const hasCart = !!(ctx.hidden && ctx.hidden.cart);
  const burgerNote = (ind) => `\n${ind}${comment(`мобильное меню по клику на бургер (useState): ${String(burger.text || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 14).join(' · ')}${burger.screenshot ? ' — скриншот ' + burger.screenshot : ''}`)}`;
  const effD = (n) => ctx.E.get(n.i) || {};
  const effM = (n) => mob.E.get(n.i) || {};
  const parentEffD = (n, isRoot) => { if (isRoot) return ctx.bodyEff; const p = ctx.P.get(n.i); return p ? effD(p) : ctx.bodyEff; };
  const parentEffM = (n, isRoot) => { if (isRoot) return mob.bodyEff; const p = mob.P.get(n.i); return p ? effM(p) : mob.bodyEff; };
  const resetFor = (k, D) => (k === 'display' ? DISPLAY_CLS[expectedDisplay(D.t)] || 'block' : tw.RESET[k] ?? EXTRA_RESET[k] ?? '');

  // ---- classes: returns [[group, classString], ...] sorted ----
  function classPairs(en, mode, isRoot) {
    const out = [];
    const push = (k, c) => { if (c) out.push([k, c]); };
    if (mode === 'd' || mode === 'dOnly') {
      const D = en.D; const g = tw.groups(D, effD(D), parentEffD(D, isRoot), ctx.P.get(D.i));
      if (mode === 'dOnly') { const disp = g.display || DISPLAY_CLS[expectedDisplay(D.t)] || 'block'; delete g.display; push('display', 'hidden ' + pre(disp, prefixFor(D, null, 'display'))); }
      for (const [k, c] of Object.entries(g)) push(k, c);
    } else if (mode === 'm' || mode === 'mOnly') {
      const M = en.M; const g = tw.groups(M, effM(M), parentEffM(M, isRoot), mob.P.get(M.i));
      if (mode === 'mOnly') { g.display = [g.display, pre('hidden', prefixFor(null, M, 'display'))].filter(Boolean).join(' '); }
      for (const [k, c] of Object.entries(g)) push(k, c);
    } else {
      const { D, M } = en;
      const eD = effD(D), eM = effM(M), peD = parentEffD(D, isRoot), peM = parentEffM(M, isRoot);
      const gD = tw.groups(D, eD, peD, ctx.P.get(D.i)), gM = tw.groups(M, eM, peM, mob.P.get(M.i));
      let gDx = null;
      for (const k of new Set([...Object.keys(gM), ...Object.keys(gD)])) {
        if (INH_GROUP_KEYS[k]) continue;
        let a = gM[k]; const b = gD[k];
        if (k === 'm' && b && /\bmx-auto\b/.test(b) && !/\b-?m[xlr]-/.test(a || '')) { const a2 = ['mx-auto', a || ''].join(' ').trim(); if (a2 === b || !a) a = a2; }
        if (a === b) { push(k, a); continue; }
        let dv;
        if (b) { if (!gDx) gDx = tw.groups(D, eD, peD, ctx.P.get(D.i), { explicit: true }); dv = gDx[k] || b; if (k === 'p' || k === 'm') dv = pruneZeros(dv, a, k); } else dv = resetFor(k, D);
        push(k, [a, pre(dv, prefixFor(D, M, k))].filter(Boolean).join(' '));
      }
      for (const [k, keys] of Object.entries(INH_GROUP_KEYS)) {
        const vM = tw.val(eM, keys), vD = tw.val(eD, keys), needM = vM !== tw.val(peM, keys), needD = vD !== tw.val(peD, keys);
        if (vM === vD) { if (needM || needD) push(k, tw.INH[k](eM)); }
        else push(k, [needM ? tw.INH[k](eM) : '', needM || needD ? pre(tw.INH[k](eD), prefixFor(D, M, k)) : ''].filter(Boolean).join(' '));
      }
    }
    if (en.D && (mode !== 'm' && mode !== 'mOnly')) { const h = ctx.hoverFor ? ctx.hoverFor(en.D) : ''; if (h) out.push(['hover', h]); }
    const N0 = en.D || en.M;
    if (N0 && N0.t === 'button' && !textOf(N0, 60).trim()) return out.filter(([k, c]) => c && c.trim() && (!INH_GROUP_KEYS[k] || k === 'cursor')).sort((a, b) => (ORD[a[0]] ?? 99) - (ORD[b[0]] ?? 99));
    return out.filter(([, c]) => c && c.trim()).sort((a, b) => (ORD[a[0]] ?? 99) - (ORD[b[0]] ?? 99));
  }
  const clsString = (pairs) => pairs.map(([, c]) => c).join(' ').replace(/\s+/g, ' ').trim();

  function childMode(en, parentMode) {
    if (parentMode === 'both') { if (en.D && en.M) return 'both'; if (en.D) return mob.truncated ? 'd' : 'dOnly'; return 'mOnly'; }
    if (parentMode === 'd' || parentMode === 'dOnly') return 'd';
    return 'm';
  }
  function childEntries(en, mode) {
    if (mode === 'both') {
      const { D, M } = en;
      const mKids = kids(M); const mBy = new Map(mKids.map((k) => [k._p, k]));
      const dPaths = new Set(kids(D).map((k) => k._p));
      const mobOnly = mKids.filter((k) => !dPaths.has(k._p) && k.r[3] > 0).sort((a, b) => a.n - b.n);
      const out = []; let mi = 0;
      for (const k of D.k || []) {
        if (typeof k === 'string') { out.push({ text: k }); continue; }
        while (mi < mobOnly.length && mobOnly[mi].n < k.n) out.push({ D: null, M: mobOnly[mi++] });
        const m = mBy.get(k._p);
        out.push({ D: k, M: m && m.t === k.t ? m : null });
      }
      while (mi < mobOnly.length) out.push({ D: null, M: mobOnly[mi++] });
      return out;
    }
    const N = mode === 'd' || mode === 'dOnly' ? en.D : en.M;
    const isD = mode === 'd' || mode === 'dOnly';
    return (N.k || []).map((k) => (typeof k === 'string' ? { text: k } : isD ? { D: k, M: null } : { D: null, M: k }));
  }

  // ---- slots (template mode for repeated items) ----
  function slotText(st, value, hint) {
    if (!st.slots || !value.trim()) return jsxText(value);
    st.slots.push({ kind: 'text', value, tags: st.tags.slice(), hint });
    return M_TEXT + (st.slots.length - 1) + M_TEXT;
  }
  function slotAttr(st, name, value, kind) {
    if (!st.slots) return jsxAttr(name, value);
    st.slots.push({ kind, value: String(value), name, tags: st.tags.slice() });
    return `${name}=${M_ATTR}${st.slots.length - 1}${M_ATTR}`;
  }

  // ---- renderers ----
  function headTag(tag, attrs) { return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`; }
  function classAttr(pairs, st, sizeSlots) {
    if (!pairs.length) return null;
    if (st.slots) {
      // template mode: every class group is a slot — items that differ only in classes still share one template
      const parts = pairs.map(([k, c]) => { st.slots.push({ kind: 'cls', group: k, value: c, tags: st.tags.slice() }); return M_CLS + (st.slots.length - 1) + M_CLS; });
      return `className=${M_CA}${parts.join(' ')}${M_CA}`;
    }
    return jsxAttr('className', clsString(pairs));
  }
  function renderSvg(N, isMob, pairs, st, fl) {
    const ic = ctx.iconFor(N, isMob);
    const a = [];
    if (fl.itemRoot) a.push('key={i}');
    if (!ic || ic.big) { const c = classAttr(pairs, st, false); if (c) a.push(c); a.push('aria-hidden="true"'); return `${headTag('div', a)}>${comment(`SVG-иллюстрация ${N.r[2]}×${N.r[3]} — возьми из скриншота/ассетов`)}</div>`; }
    st.sh.icons.add(ic.name);
    let tag = ic.name;
    if (st.slots) { st.slots.push({ kind: 'icon', value: ic.name, tags: st.tags.slice() }); tag = M_TAG + (st.slots.length - 1) + M_TAG; }
    if (N.a && N.a.label) a.push(jsxAttr('aria-label', N.a.label));
    const c = classAttr(pairs, st, true); if (c) a.push(c);
    return `${headTag(tag, a)} />`;
  }
  function renderImg(N, isMob, pairs, st, fl) {
    const im = ctx.imgFor(N, isMob) || {};
    const a = [];
    if (fl.itemRoot) a.push('key={i}');
    a.push(slotAttr(st, 'src', im.src || '', 'src'));
    a.push(slotAttr(st, 'alt', im.alt || '', 'alt'));
    if (im.lazy) a.push('loading="lazy"');
    const c = classAttr(pairs, st, true); if (c) a.push(c);
    return `${headTag('img', a)} />`;
  }
  function renderMedia(N, isMob, pairs, st, fl) {
    const md = ctx.mediaFor(N, isMob) || { type: N.t };
    const a = [];
    if (fl.itemRoot) a.push('key={i}');
    const c = classAttr(pairs, st, true);
    if (md.type === 'video') {
      if (md.src) a.push(slotAttr(st, 'src', md.src, 'src'));
      if (md.poster) a.push(jsxAttr('poster', md.poster));
      if (md.autoplay) a.push('autoPlay'); if (md.loop) a.push('loop'); if (md.muted || md.autoplay) a.push('muted'); a.push('playsInline');
      if (c) a.push(c);
      return `${headTag('video', a)} />`;
    }
    if (md.type === 'iframe') { if (md.src) a.push(slotAttr(st, 'src', md.src, 'src')); if (md.title) a.push(jsxAttr('title', md.title)); a.push('allowFullScreen'); if (c) a.push(c); return `${headTag('iframe', a)} />`; }
    if (md.type === 'audio') { if (md.src) a.push(jsxAttr('src', md.src)); a.push('controls'); if (c) a.push(c); return `${headTag('audio', a)} />`; }
    if (md.type === 'canvas' && md.snapshot) {
      a.push(jsxAttr('src', md.snapshot), 'alt=""', 'aria-hidden="true"'); if (c) a.push(c);
      return `${headTag('img', a)} />${comment(`снимок canvas/WebGL ${N.r[2]}×${N.r[3]}: в исходнике рисуется скриптом (анимация) — здесь статичная замена`)}`;
    }
    if (c) a.push(c); a.push('aria-hidden="true"');
    return `${headTag('div', a)}>${comment(md.type === 'canvas' ? `canvas/WebGL ${N.r[2]}×${N.r[3]} — рисуется скриптом, см. скриншот` : `встроенный объект ${md.type}: ${md.src || ''}`)}</div>`;
  }
  function attrsFor(N, isMob, st, fl) {
    const a = []; const A = N.a || {}; let tag = KNOWN.has(N.t) ? N.t : inlineLevel(displayOf(N)) ? 'span' : 'div';
    const anc = st.anc || [];
    const nestedLink = N.t === 'a' && anc.some((t) => t === 'a' || t === 'Link');
    if (nestedLink || (N.t === 'button' && anc.includes('button'))) tag = 'span';
    else if (N.t === 'p' && hasBlockKid(N)) tag = 'div';
    if (fl.itemRoot) a.push('key={i}');
    if (N.id) a.push(st.slots ? slotAttr(st, 'id', N.id, 'id') : jsxAttr('id', N.id));
    if (N.t === 'a' && A.href !== undefined && !nestedLink) {
      const L = ctx.linkFor(A.href);
      if (L.internal) { tag = 'Link'; st.sh.link = true; }
      a.push(slotAttr(st, 'href', L.href, 'href'));
      if (A.target === '_blank') a.push('target="_blank"', 'rel="noopener noreferrer"');
    }
    if (A.role && !(N.t === 'a' && A.role === 'link')) a.push(jsxAttr('role', A.role));
    if (A.label) a.push(st.slots ? slotAttr(st, 'aria-label', A.label, 'label') : jsxAttr('aria-label', A.label));
    if (A.title) a.push(st.slots ? slotAttr(st, 'title', A.title, 'title') : jsxAttr('title', A.title));
    if (A.type && (N.t === 'button' || N.t === 'input')) a.push(jsxAttr('type', A.type));
    if (A.name) a.push(st.slots ? slotAttr(st, 'name', A.name, 'name') : jsxAttr('name', A.name));
    if (A.placeholder) a.push(st.slots ? slotAttr(st, 'placeholder', A.placeholder, 'placeholder') : jsxAttr('placeholder', A.placeholder));
    if (A.required) a.push('required');
    if (A.value !== undefined && N.t === 'input') a.push(jsxAttr(/submit|button|reset/.test(A.type || '') ? 'value' : 'defaultValue', A.value));
    if (A.checked) a.push('defaultChecked');
    if (A.for) a.push(jsxAttr('htmlFor', A.for));
    if (A.datetime) a.push(st.slots ? slotAttr(st, 'dateTime', A.datetime, 'datetime') : jsxAttr('dateTime', A.datetime));
    if (A.open && N.t === 'details') a.push('open');
    if ((N.t === 'td' || N.t === 'th') && A.colspan) a.push(`colSpan={${A.colspan}}`);
    if ((N.t === 'td' || N.t === 'th') && A.rowspan) a.push(`rowSpan={${A.rowspan}}`);
    if (N.t === 'th' && A.scope) a.push(jsxAttr('scope', A.scope));
    const formish = /^(button|input|select|textarea|fieldset)$/.test(N.t);
    if (st.slots && formish) a.push(slotAttr(st, 'disabled', A.disabled ? 'true' : 'false', 'bool'));
    else if (A.disabled) a.push(formish ? 'disabled' : 'aria-disabled="true"');
    for (const [k, nm] of [['selected', 'aria-selected'], ['pressed', 'aria-pressed'], ['current', 'aria-current']]) if (A[k] !== undefined) a.push(st.slots ? slotAttr(st, nm, A[k], k !== 'current' && /^(true|false)$/.test(String(A[k])) ? 'abool' : 'aria') : jsxAttr(nm, A[k]));
    if (A.expanded !== undefined && N.t !== 'details') a.push(jsxAttr('aria-expanded', A.expanded));
    return { tag, a };
  }

  const anc0 = (st) => st.anc || [];
  // wraps rendered markup into a client component (keeps the original element; key={i} moves to the wrapper)
  function wrapWith(out, ind, open, close, fl) {
    let o = open;
    if (fl.itemRoot && /^\s*<[\w.]+ key=\{[ij]\}/.test(out)) { const k = /key=\{[ij]\}/.exec(out)[0]; out = out.replace(' ' + k, ''); o = o.replace(/^<([\w.]+)/, `<$1 ${k}`); }
    if (!ind) return `${o}${out}${close}`;
    return `${ind}${o}\n${out.split('\n').map((l) => '  ' + l).join('\n')}\n${ind}${close}`;
  }
  // compact data literal: one row per line ({ href: "…", text: "…" } / "…")
  const rowsLit = (rows) => '[\n' + rows.map((o) => '  ' + (o && typeof o === 'object' ? '{ ' + Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? jsEsc(v) : JSON.stringify(v)}`).join(', ') + ' }' : jsEsc(o)) + ',').join('\n') + '\n]';
  const dataName = (st, base) => { let n = base, i = 2; while (st.sh.dataNames.has(n)) n = base + i++; st.sh.dataNames.add(n); return n; };
  const isExpandTrigger = (N) => !!(N && N.a && N.a.expanded === 'false' && ctx.hidden && ctx.hidden.expand && ctx.hidden.expand.has(N.i) && ctx.hidden.expand.get(N.i).text);
  function renderEntry(en, mode, ind, st, fl = {}) {
    const out = renderEntry0(en, mode, ind, st, fl);
    const isMob = mode === 'm' || mode === 'mOnly';
    // burger (mobile-only element) -> <MobileMenu> with the links of the opened menu
    if (burger && en.M && !en.D && String(en.M.i) === String(burger.id) && !st.slots) {
      st.sh.interactive.add('mobile-menu');
      if (!menu || !menu.links || !menu.links.length) return out + burgerNote(ind);
      st.sh.client.add('MobileMenu'); st.sh.handled.add('mobile-menu');
      const nm = dataName(st, 'mobileMenuLinks');
      st.sh.data.push({ name: nm, literal: rowsLit(menu.links), count: menu.links.length, fields: ['href', 'text', 'external'], rows: menu.links, kind: 'menu' });
      const attrs = [`links={${nm}}`, menu.bg ? jsxAttr('bg', menu.bg) : '', menu.fg ? jsxAttr('fg', menu.fg) : ''].filter(Boolean).join(' ');
      return wrapWith(out, ind, `<MobileMenu ${attrs}>`, '</MobileMenu>', fl);
    }
    const N = isMob ? en.M : en.D;
    if (!N || isMob) return out;
    // probed dialog trigger -> <ModalTrigger> (content and look of the original overlay) or <CartButton>
    const dlg = !st.slots && dialogs.size ? dialogs.get(String(N.i)) : null;
    if (dlg && !usedDlg.has(dlg)) {
      usedDlg.add(dlg);
      if (isCartDialog(dlg)) { st.sh.interactive.add('cart'); st.sh.handled.add('cart'); st.sh.client.add('CartButton'); st.sh.cart = true; return wrapWith(out, ind, '<CartButton>', '</CartButton>', fl); }
      const pr = dialogProps(dlg, ctx.vp || { w: ctx.vw || 1440, h: 900 });
      if (pr.title || pr.lines.length) {
        st.sh.interactive.add('modal'); st.sh.handled.add('modal'); st.sh.client.add('ModalTrigger');
        const nm = dataName(st, 'dialogLines');
        st.sh.data.push({ name: nm, literal: rowsLit(pr.lines), count: pr.lines.length, fields: [], rows: [], kind: 'dialog' });
        const look = Object.entries(pr.look).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : jsEsc(v)}`).join(', ');
        const attrs = [pr.title ? jsxAttr('title', pr.title) : '', `lines={${nm}}`, look ? `look={{ ${look} }}` : ''].filter(Boolean).join(' ');
        return wrapWith(out, ind, `<ModalTrigger ${attrs}>`, '</ModalTrigger>', fl);
      }
    }
    // "add to cart" buttons outside of data templates (templates: enhanceSection adds item props)
    if (hasCart && !st.slots && N.t === 'button' && ADD_TO_CART_RE.test(textOf(N, 80).replace(/\s+/g, ' ').trim()) && !(N.a && N.a.disabled)) {
      st.sh.interactive.add('cart'); st.sh.handled.add('cart'); st.sh.client.add('AddToCart');
      return wrapWith(out, ind, '<AddToCart>', '</AddToCart>', fl);
    }
    // aria-expanded trigger with probed panel -> <Disclosure panel={...}>
    if (isExpandTrigger(N)) {
      const x = ctx.hidden.expand.get(N.i);
      st.sh.interactive.add('accordion'); st.sh.handled.add('accordion'); st.sh.client.add('Disclosure');
      const panel = `<div className="whitespace-pre-line pt-2">${slotText(st, x.text, 'answer')}</div>`;
      return wrapWith(out, ind, `<Disclosure panel={${panel}}>`, '</Disclosure>', fl);
    }
    return out;
  }
  function renderEntry0(en, mode, ind, st, fl = {}) {
    const N = mode === 'm' || mode === 'mOnly' ? en.M : en.D;
    const isMob = mode === 'm' || mode === 'mOnly';
    const pairs = classPairs(en, mode, fl.isRoot);
    if (N.t === 'svg') return ind + renderSvg(N, isMob, pairs, st, fl);
    if (N.t === 'img') return ind + renderImg(N, isMob, pairs, st, fl);
    if (N.m !== undefined) return ind + renderMedia(N, isMob, pairs, st, fl);
    const { tag, a } = attrsFor(N, isMob, st, fl);
    // children
    let entries = N.t === 'select' || N.t === 'textarea' ? [] : childEntries(en, mode);
    const flexy = /flex|grid/.test(displayOf(N));
    const blk = (x) => !!x && x.text === undefined && !inlineLevel(displayOf(x.D || x.M));
    entries = entries.filter((e, i) => {
      if (e.text === undefined || e.text.trim()) return true;
      if (flexy) return false;
      return !(i === 0 || i === entries.length - 1 || blk(entries[i - 1]) || blk(entries[i + 1]));
    });
    // flatten classless wrappers
    if (!fl.isRoot && !fl.itemRoot && !pairs.length && a.length === 0 && /^(div|span|picture)$/.test(N.t) && entries.length === 1 && entries[0].text === undefined) {
      const c = entries[0]; const C = c.D || c.M;
      const same = Math.abs(C.r[2] - N.r[2]) <= 1 && Math.abs(C.r[3] - N.r[3]) <= 1;
      const parentFlexy = fl.parentDisplay && /flex|grid/.test(fl.parentDisplay);
      if (same || (!parentFlexy && !inlineLevel(displayOf(C)))) return renderEntry(c, childMode(c, mode), ind, st, { parentDisplay: fl.parentDisplay });
    }
    const repSkip = !isMob && !st.slots ? st.sh.repeats.get(N.i) : null;
    const ddChild = !isMob && !st.slots && ddMap.size ? entries.find((x) => !(repSkip && x.D && repSkip.itemIds.includes(x.D.i)) && dropdownFor(x)) || null : null;
    if (ddChild) pairs.push(['position', pairs.some(([k]) => k === 'position') ? 'group' : 'relative group']);
    const c = classAttr(pairs, st, false); if (c) a.push(c);
    const open = headTag(tag, a);
    if (VOID.has(N.t) || N.t === 'textarea') return `${ind}${open} />`;
    if (N.t === 'select') {
      const opts = (N.a && N.a.options) || [];
      if (!opts.length) return `${ind}${open} />`;
      return `${ind}${open}>\n${opts.map((o) => `${ind}  <option>${jsxText(o)}</option>`).join('\n')}\n${ind}</select>`;
    }
    const sub = { ...st, tags: st.slots ? [...st.tags, N.t] : st.tags, anc: [...anc0(st), tag] };
    const extra = isMob ? [] : hiddenExtras(N, sub, ind + '  ');
    const inline = entries.some((e) => e.text !== undefined);
    const disp = displayOf(N);
    if (inline) {
      const parts = entries.map((e) => (e.text !== undefined ? slotText(sub, e.text, N.t === 'summary' ? 'question' : '') : renderEntry(e, childMode(e, mode), '', sub, { parentDisplay: disp })));
      const body = parts.join('');
      st.sh.used += body.length;
      if (!extra.length) return `${ind}${open}>${body}</${tag}>`;
      return `${ind}${open}>\n${ind}  ${body}\n${extra.join('\n')}\n${ind}</${tag}>`;
    }
    const lines = [];
    const rep = !isMob && !st.slots ? st.sh.repeats.get(N.i) : null;
    const repIds = rep ? new Set(rep.itemIds) : null;
    let repDone = false;
    // nested list inside a repeated item (footer column links, plan features) -> item.links.map(...)
    const inRep = !isMob && st.slots && !st.inList && st.sh.innerRepeats ? st.sh.innerRepeats.get(N.i) : null;
    const inIds = inRep ? new Set(inRep.itemIds) : null;
    let inDone = false, inFailed = false;
    for (const e of entries) {
      if (st.sh.used > st.sh.cap) { if (!st.sh.capHit) { lines.push(ind + '  ' + comment('… секция усечена по лимиту размера — остальное смотри на скриншоте и в dom/*.html')); st.sh.capHit = true; } break; }
      if (repIds && e.D && repIds.has(e.D.i)) {
        if (repDone) continue;
        repDone = true;
        const items = entries.filter((x) => x.D && repIds.has(x.D.i)).map((x) => ({ en: x, mode: childMode(x, mode) }));
        lines.push(renderRepeat(items, ind + '  ', st, disp));
        continue;
      }
      if (inIds && !inFailed && e.D && inIds.has(e.D.i)) {
        if (inDone) continue;
        const its = entries.filter((x) => x.D && inIds.has(x.D.i)).map((x) => ({ en: x, mode: childMode(x, mode) }));
        const marker = renderInnerList(its, ind + '  ', sub, disp);
        if (marker) { inDone = true; lines.push(marker); continue; }
        inFailed = true;
      }
      const s = renderEntry(e, childMode(e, mode), ind + '  ', sub, { parentDisplay: disp });
      st.sh.used += s.length;
      lines.push(s);
      if (ddChild && e === ddChild) { const d = dropdownFor(e); if (d) { lines.push(dropdownPanel(d, ind + '  ', st)); st.sh.handled.add('dropdown'); } }
    }
    lines.push(...extra);
    if (!lines.length) return `${ind}${open} />`;
    return `${ind}${open}>\n${lines.join('\n')}\n${ind}</${tag}>`;
  }

  // hidden content revealed by interaction (details answers, aria-expanded panels)
  function hiddenExtras(N, st, ind) {
    const H = ctx.hidden || {}; const out = [];
    if (N.t === 'details' && !(N.a && N.a.open) && H.details) {
      const sm = kids(N).find((k) => k.t === 'summary');
      const q = sm ? textOf(sm, 400) : '';
      const ans = H.details.get(q);
      if (ans) { st.sh.interactive.add('details'); st.sh.handled.add('details'); out.push(`${ind}<div>${slotText(st, ans, 'answer')}</div>`); }
    }
    if (N.a && N.a.role === 'tab') st.sh.interactive.add('tabs');
    return out;
  }

  // ---- nested list inside a repeated item: one slot holding rows + the inner template ----
  function renderInnerList(items, ind, st, parentDisplay) {
    const saved = st.sh.used;
    const rendered = items.map(({ en, mode }) => { const slots = []; const s = renderEntry(en, mode, ind + '  ', { sh: st.sh, slots, tags: [], inList: true }, { itemRoot: true, parentDisplay }); return { s, slots }; });
    st.sh.used = saved;
    if (rendered.length < 2 || new Set(rendered.map((r) => r.s)).size !== 1) return null;
    const tpl = rendered[0];
    if (tpl.slots.some((sl, j) => sl.kind === 'cls' && rendered.some((r) => r.slots[j].value !== sl.value))) return null;
    const used = new Set(); const fields = [];
    const repl = tpl.slots.map((sl, j) => {
      if (sl.kind === 'cls') return { lit: sl.value };
      if ((sl.kind === 'bool' || sl.kind === 'aria' || sl.kind === 'abool') && rendered.every((r) => r.slots[j].value === sl.value)) return { lit: sl.value, kind: sl.kind };
      const name = fieldName(sl, used, null); fields.push({ name, kind: sl.kind, j }); return { field: name };
    });
    if (!fields.length) return null;
    const hasHref = fields.some((f) => f.kind === 'href');
    const v = hasHref ? 'link' : items[0].en.D.t === 'li' ? 'point' : 'sub';
    let code = tpl.s
      .replace(new RegExp(`${M_TEXT}(\\d+)${M_TEXT}`, 'g'), (m, j) => (repl[j].field ? `{${v}.${repl[j].field}}` : jsxText(repl[j].lit)))
      .replace(new RegExp(`( ?)(\\S+)=${M_ATTR}(\\d+)${M_ATTR}`, 'g'), (m, sp, attr, j) => (repl[j].field ? `${sp}${attr}={${v}.${repl[j].field}}` : repl[j].kind === 'bool' ? (repl[j].lit === 'true' ? sp + attr : '') : sp + jsxAttr(attr, repl[j].lit)))
      .replace(new RegExp(`${M_TAG}(\\d+)${M_TAG}`, 'g'), (m, j) => (repl[j].field ? `${v}.${repl[j].field}` : repl[j].lit))
      .replace(new RegExp(`${M_CLS}(\\d+)${M_CLS}`, 'g'), (m, j) => repl[j].lit)
      .replace('key={i}', 'key={j}');
    code = finishClass(code, (f) => `${v}.${f}`);
    const rows = rendered.map((r) => Object.fromEntries(fields.map((f) => [f.name, f.kind === 'bool' || f.kind === 'abool' ? r.slots[f.j].value === 'true' : r.slots[f.j].value])));
    const listName = hasHref ? 'links' : v === 'point' ? (st.sh.type === 'pricing' ? 'features' : 'points') : 'items';
    st.slots.push({ kind: 'list', value: JSON.stringify(rows), rows, fields, code, v, listName, tags: st.tags.slice() });
    return `${ind}${M_LIST}${st.slots.length - 1}:${sha(code, 8)}${M_LIST}`;
  }
  const listLiteral = (slot) => '[' + slot.rows.map((r) => '{ ' + slot.fields.map((f) => `${f.name}: ${f.kind === 'icon' || f.kind === 'bool' || f.kind === 'abool' ? r[f.name] : jsEsc(r[f.name])}`).join(', ') + ' }').join(', ') + ']';

  // ---- repeated items -> data array + map() ----
  // short structured description of an item that is not rendered as markup (text, first image, first link)
  function summaryOf(en, mode) {
    const isMob = mode === 'm' || mode === 'mOnly';
    const N = (isMob ? en.M : en.D) || en.D || en.M;
    const o = { text: textOf(N, 600).replace(/[ \t]+/g, ' ').trim() };
    let img = N.t === 'img' ? N : null, a = N.t === 'a' && N.a && N.a.href !== undefined ? N : null;
    (function rec(x) { for (const k of kids(x)) { if (img && a) return; if (!img && k.t === 'img') img = k; if (!a && k.t === 'a' && k.a && k.a.href !== undefined) a = k; rec(k); } })(N);
    if (img) { const im = ctx.imgFor(img, isMob) || {}; if (im.src) { o.image = im.src; if (im.alt) o.imageAlt = im.alt; } }
    if (a) o.href = ctx.linkFor(a.a.href).href;
    return o;
  }
  const jsLit = (v) => JSON.stringify(v, null, 2).replace(SPECIAL_SP, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  // class groups whose per-item differences are runtime states (slider offsets, fade-in, stagger) -> most common value
  const STATE_GROUPS = new Set(['transform', 'opacity', 'z', 'transition', 'animation']);
  const SIZE_GROUPS = new Set(['minW', 'minH', 'maxW', 'maxH']);
  const GEOM_TOK = /(^|:)-?(inset|inset-x|inset-y|top|right|bottom|left|start|end|w|h|min-w|min-h|max-w|max-h|size|basis|translate-x|translate-y)-/;
  function renderRepeat(items, ind, st, parentDisplay) {
    const saved = st.sh.used;
    const rendered = items.map(({ en, mode }) => { const slots = []; const s = renderEntry(en, mode, ind + '  ', { sh: st.sh, slots, tags: [] }, { itemRoot: true, parentDisplay }); return { s, slots, en, mode }; });
    st.sh.used = saved;
    const groups = new Map();
    rendered.forEach((r, idx) => { if (!groups.has(r.s)) groups.set(r.s, []); groups.get(r.s).push(idx); });
    const full = (idxs) => idxs.map((i) => { const s = renderEntry(items[i].en, items[i].mode, ind, { sh: st.sh, slots: null, tags: [] }, { parentDisplay }); st.sh.used += s.length; return s; }).join('\n');
    const varName = (() => { let base = VAR_BY_TYPE[st.sh.type] || 'items'; let n = base, i = 2; while (st.sh.dataNames.has(n)) n = base + i++; st.sh.dataNames.add(n); return n; });
    const mostCommon = (vals) => { const cnt = new Map(); vals.forEach((v) => cnt.set(v, (cnt.get(v) || 0) + 1)); return [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
    const template = (idxs) => {
      const tpl = rendered[idxs[0]];
      const used = new Set(); const fields = [];
      const claim = (base) => { let n = base, k = 2; while (used.has(n)) n = base + k++; used.add(n); return n; };
      const colorField = new Map(); // per-item colour vector -> field (one CSS variable even if used by several classes)
      const clsRepl = (sl, vals, j) => {
        if (vals.every((v) => v === vals[0])) return { lit: vals[0] };
        const g = sl.group;
        if (g === 'w' || g === 'h') return { lit: vals.every((v) => /^size-/.test(v)) ? mostCommon(vals) : g === 'w' ? 'w-auto' : 'h-auto' };
        if (SIZE_GROUPS.has(g) || STATE_GROUPS.has(g)) return { lit: mostCommon(vals) };
        const toks = vals.map((v) => v.split(/\s+/).filter(Boolean));
        if (toks.every((t) => t.length === toks[0].length)) {
          // token by token: same -> literal; only colours differ -> CSS variable from the data (per-card glow, accent border…);
          // only numbers of a geometry utility differ -> most common value; anything else -> per-item class field
          const lit = [], names = new Set(), extra = toks.map(() => []); let anyExtra = false;
          for (let k = 0; k < toks[0].length; k++) {
            const col = toks.map((t) => t[k]);
            if (col.every((x) => x === col[0])) { lit.push(col[0]); continue; }
            const shp = col.map((x) => x.replace(COLOR_TOK, '#'));
            if (shp.every((x) => x === shp[0])) {
              const cs = col.map((x) => x.match(COLOR_TOK) || []); let ci = -1;
              lit.push(col[0].replace(COLOR_TOK, (c) => {
                ci++; const vec = cs.map((t) => t[ci]);
                if (vec.every((x) => x === vec[0])) return c;
                const key = vec.join(','); let nm = colorField.get(key);
                if (!nm) { nm = claim('color'); colorField.set(key, nm); fields.push({ name: nm, kind: 'color', j, k, ci }); }
                names.add(nm); return `var(${cssVarName(nm)})`;
              }).replace(/-\[var\((--item-[\w-]+)\)\]/g, '-[color:var($1)]'));
              continue;
            }
            const nshp = col.map((x) => x.replace(/-?\d+(\.\d+)?/g, '0'));
            if (nshp.every((x) => x === nshp[0]) && GEOM_TOK.test(col[0])) { lit.push(mostCommon(col)); continue; }
            anyExtra = true; col.forEach((x, t) => extra[t].push(x));
          }
          let out = lit.join(' ');
          if (anyExtra) { const nm = claim(g + 'Class'); fields.push({ name: nm, kind: 'clsxTok', j, byIdx: new Map(idxs.map((ii, t) => [ii, extra[t].join(' ')])) }); out += ` ${M_DYN}${nm}${M_DYN}`; }
          return { lit: (out + [...names].map((nm) => ` ${M_DYN}V${nm}${M_DYN}`).join('')).trim() };
        }
        // different number of classes -> common part + item.<group>Class
        const common = toks[0].filter((c) => toks.every((x) => x.includes(c)));
        const nm = claim(g + 'Class');
        fields.push({ name: nm, kind: 'clsx', j, common });
        return { lit: (common.join(' ') + ` ${M_DYN}${nm}${M_DYN}`).trim() };
      };
      const repl = tpl.slots.map((sl, j) => {
        if (sl.kind === 'list') { const nm = claim(sl.listName); fields.push({ name: nm, kind: 'list', j }); return { field: nm, sl }; }
        const vals = idxs.map((i) => rendered[i].slots[j].value);
        if (sl.kind === 'cls') return clsRepl(sl, vals, j);
        if (vals.every((v) => v === vals[0])) return { lit: vals[0], sl, kind: sl.kind };
        const name = fieldName(sl, used, tpl.en);
        fields.push({ name, kind: sl.kind, j });
        return { field: name, sl };
      });
      const name = varName();
      let code = tpl.s
        .replace(new RegExp(`([ \\t]*)${M_LIST}(\\d+):[0-9a-f]*${M_LIST}`, 'g'), (m, sp, j) => { const sl = tpl.slots[j]; return `${sp}{item.${repl[j].field}.map((${sl.v}, j) => (\n${sl.code}\n${sp}))}`; })
        .replace(new RegExp(`${M_TEXT}(\\d+)${M_TEXT}`, 'g'), (m, j) => (repl[j].field ? `{item.${repl[j].field}}` : jsxText(repl[j].lit)))
        .replace(new RegExp(`( ?)(\\S+)=${M_ATTR}(\\d+)${M_ATTR}`, 'g'), (m, sp, attr, j) => {
          const r = repl[j];
          if (r.field) return `${sp}${attr}={item.${r.field}}`;
          if (r.kind === 'bool') return r.lit === 'true' ? sp + attr : '';
          return sp + jsxAttr(attr, r.lit);
        })
        .replace(new RegExp(`${M_TAG}(\\d+)${M_TAG}`, 'g'), (m, j) => (repl[j].field ? `item.${repl[j].field}` : repl[j].lit))
        .replace(new RegExp(`${M_CLS}(\\d+)${M_CLS}`, 'g'), (m, j) => repl[j].lit);
      code = finishClass(code, (f) => `item.${f}`);
      const fieldValue = (f, i) => {
        const sl = rendered[i].slots[f.j]; const v = sl.value;
        if (f.kind === 'color') return jsEsc(((v.split(/\s+/).filter(Boolean)[f.k] || '').match(COLOR_TOK) || [])[f.ci] || 'transparent');
        if (f.kind === 'clsxTok') return jsEsc(f.byIdx.get(i) || '');
        if (f.kind === 'clsx') return jsEsc(v.split(/\s+/).filter((c) => c && !f.common.includes(c)).join(' '));
        if (f.kind === 'bool' || f.kind === 'abool') return v === 'true' ? 'true' : 'false';
        if (f.kind === 'icon') return v;
        if (f.kind === 'list') return listLiteral(sl);
        return jsEsc(v);
      };
      const rawValue = (f, i) => {
        const sl = rendered[i].slots[f.j]; const v = sl.value;
        if (f.kind === 'color') return ((v.split(/\s+/).filter(Boolean)[f.k] || '').match(COLOR_TOK) || [])[f.ci] || 'transparent';
        if (f.kind === 'clsxTok') return f.byIdx.get(i) || '';
        if (f.kind === 'clsx') return v.split(/\s+/).filter((c) => c && !f.common.includes(c)).join(' ');
        if (f.kind === 'bool' || f.kind === 'abool') return v === 'true';
        if (f.kind === 'list') return sl.rows;
        return v;
      };
      const rows = idxs.map((i) => '  { ' + fields.map((f) => `${f.name}: ${fieldValue(f, i)}`).join(', ') + ' },');
      if (fields.length) st.sh.data.push({ name, literal: '[\n' + rows.join('\n') + '\n]', count: idxs.length, fields: fields.map((f) => f.name), rows: idxs.map((i) => Object.fromEntries(fields.map((f) => [f.name, rawValue(f, i)]))), positions: idxs.map((i) => i + 1) });
      else st.sh.dataNames.delete(name);
      st.sh.lastTpl = { name: fields.length ? name : null, fields: fields.map((f) => f.name) };
      st.sh.used += code.length + rows.join('').length;
      if (!fields.length) return `${ind}${comment(`×${idxs.length} одинаковых элемента`)}\n${ind}{Array.from({ length: ${idxs.length} }).map((_, i) => (\n${code}\n${ind}))}`;
      return `${ind}{${name}.map((item, i) => (\n${code}\n${ind}))}`;
    };
    const all = items.map((_, i) => i);
    // card-like repeats are reported as sub-component candidates (PricingCard, FeatureCard…)
    const elCount = (N, lim = 3) => { let c = 0; (function rec(x) { for (const k of kids(x)) { if (c >= lim) return; c++; rec(k); } })(N); return c; };
    const complex = items.every(({ en }) => elCount(en.D || en.M) >= 2);
    const card = (mode, extra = {}) => { if (complex) st.sh.cards.push({ count: items.length, tag: (items[0].en.D || items[0].en.M).t, mode, variants: groups.size, ...extra }); };
    if (groups.size === 1) { const r = template(all); card('template', { ...st.sh.lastTpl }); return r; }
    if (items.length <= 6) { card('full'); return full(all); }
    // several variants: each variant with 2+ items -> its own data array + map(); unique items -> markup (first 4) or data
    const sorted = [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
    const multi = sorted.filter((g) => g.length >= 2);
    const singles = sorted.filter((g) => g.length === 1).map((g) => g[0]).sort((a, b) => a - b);
    const parts = []; let firstTpl = null;
    multi.forEach((g, gi) => {
      const code = template(g);
      if (!firstTpl) firstTpl = { ...st.sh.lastTpl };
      parts.push(`${ind}${comment(`вариант ${gi + 1} из ${multi.length + singles.length}: ${g.length} шт., позиции в исходнике ${posList(g.map((i) => i + 1))}`)}\n${code}`);
    });
    const shown = singles.slice(0, 4), rest = singles.slice(4);
    for (const i of shown) parts.push(`${ind}${comment(`элемент №${i + 1} оформлен иначе остальных (позиция ${i + 1} в исходнике)`)}\n${full([i])}`);
    if (rest.length) {
      const nm = varName();
      const sums = rest.map((i) => ({ position: i + 1, ...summaryOf(items[i].en, items[i].mode) }));
      st.sh.data.push({ name: nm, literal: jsLit(sums), count: sums.length, fields: [...new Set(sums.flatMap((x) => Object.keys(x)))], rows: sums, kind: 'summary' });
      st.sh.used += 200;
      parts.push(`${ind}${comment(`ещё ${rest.length} элементов со своим оформлением (позиции ${posList(rest.map((i) => i + 1))}): тексты, картинки и ссылки — в массиве ${nm}, вид — как у похожих элементов выше и на скриншоте`)}`);
    }
    card(multi.length ? 'mixed' : 'partial', { ...(firstTpl || {}) });
    return parts.join('\n');
  }
  function fieldName(sl, used, en) {
    let base;
    const tags = sl.tags || []; const v = sl.value || '';
    if (sl.kind === 'icon') base = 'icon';
    else if (sl.kind === 'src') base = 'image';
    else if (sl.kind === 'alt') base = 'imageAlt';
    else if (sl.kind === 'href') base = 'href';
    else if (sl.kind === 'id') base = 'id';
    else if (sl.kind === 'label') base = 'ariaLabel';
    else if (sl.kind === 'datetime') base = 'dateTime';
    else if (sl.kind === 'title') base = 'tooltip';
    else if (sl.kind === 'name') base = 'name';
    else if (sl.kind === 'placeholder') base = 'placeholder';
    else if (sl.kind === 'bool') base = sl.name || 'flag';
    else if (sl.kind === 'aria' || sl.kind === 'abool') base = { 'aria-selected': 'ariaSelected', 'aria-pressed': 'ariaPressed', 'aria-current': 'ariaCurrent' }[sl.name] || 'aria';
    else if (sl.hint) base = sl.hint;
    else if (PRICE_RE.test(v) && v.length < 40) base = 'price';
    else {
      // name by the innermost meaningful tag around the text
      const inner = [...tags].reverse();
      const t0 = inner.find((t) => /^(h[1-6]|time|blockquote|q|cite|figcaption|p|li|button|a|label|small|dt|dd)$/.test(t));
      if (!t0) base = /^[\d\s.,+%$€₽×xkKmMbB/]+$/.test(v) ? 'value' : 'text';
      else if (/^h[1-6]$/.test(t0)) base = 'title';
      else if (t0 === 'time') base = 'date';
      else if (t0 === 'blockquote' || t0 === 'q') base = 'quote';
      else if (t0 === 'cite' || t0 === 'figcaption') base = 'author';
      else if (t0 === 'p') base = 'description';
      else if (t0 === 'li') base = 'point';
      else if (t0 === 'a' || t0 === 'button') base = tags[0] === t0 && tags.lastIndexOf(t0) === 0 ? 'label' : 'cta';
      else if (t0 === 'label') base = 'label';
      else if (t0 === 'small') base = 'note';
      else if (t0 === 'dt') base = 'term';
      else if (t0 === 'dd') base = 'definition';
      else base = 'text';
      if (base === 'text' && /^[\d\s.,+%$€₽×xkKmMbB/]+$/.test(v)) base = 'value';
    }
    let name = base, i = 2; while (used.has(name)) name = base + i++;
    used.add(name); return name;
  }

  // ---- public ----
  function renderSection(sec) {
    const root = sec.node;
    let total = 0, matched = 0;
    if (mob) (function rec(n) { total++; const m = mob.map.get(n._p); if (m && m.t === n.t) matched++; for (const k of kids(n)) rec(k); })(root);
    const ratio = mob ? matched / Math.max(1, total) : 0;
    const rootM = mob ? mob.map.get(root._p) : null;
    let mode = 'd';
    // union merge: nodes missing on mobile -> "hidden lg:flex", mobile-only nodes (burger…) -> "lg:hidden"
    if (mob && rootM && rootM.t === root.t && (ratio >= 0.5 || !mob.truncated)) mode = 'both';
    else if (mob && !mob.truncated && !rootM) mode = 'dOnly';
    const sh = { repeats: new Map((sec.repeats || []).map((g) => [g.containerId, g])), innerRepeats: new Map((sec.repeats || []).flatMap((g) => (g.inner || []).map((x) => [x.containerId, x]))), cards: [], icons: new Set(), link: false, used: 0, cap: ctx.maxChars || 40000, capHit: false, data: [], dataNames: new Set(), type: sec.type, interactive: new Set(), handled: new Set(), client: new Set(), cart: false };
    const jsx = renderEntry({ D: root, M: mode === 'both' ? rootM : null }, mode, '    ', { sh, slots: null, tags: [] }, { isRoot: true });
    const notes = [];
    if (mob && mode === 'd') notes.push('DOM мобильной версии заметно отличается — адаптив делай по мобильному скриншоту.');
    if (mode === 'dOnly') notes.push('Секция видна только на десктопе (на мобильном скрыта).');
    if (sh.capHit) notes.push('Разметка усечена по лимиту размера.');
    return { name: sec.name, jsx, icons: [...sh.icons].sort(), usesLink: sh.link, data: sh.data, cards: sh.cards, responsive: mode === 'both', matchRatio: Math.round(ratio * 100), interactive: [...sh.interactive], handled: [...sh.handled], client: [...sh.client].sort(), cart: sh.cart, notes, chars: jsx.length };
  }
  function sectionFile(r, { clientNote = true } = {}) {
    const lines = [];
    const todo = (r.interactive || []).filter((f) => !(r.handled || []).includes(f));
    if (clientNote && todo.length) lines.push(`// Интерактив (${todo.join(', ')}): добавь 'use client' и useState для открытия/переключения — см. раздел «Интерактив».`);
    if (r.usesLink) lines.push("import Link from 'next/link';");
    if (r.icons.length) lines.push(`import { ${r.icons.join(', ')} } from '@/components/icons';`);
    lines.push(...clientImports(r.client || []));
    if (lines.length) lines.push('');
    for (const d of r.data) lines.push(`const ${d.name} = ${d.literal};`, '');
    lines.push(`export function ${r.name}() {`, '  return (', r.jsx, '  );', '}', '');
    return lines.join('\n');
  }
  return { renderSection, sectionFile };
}
