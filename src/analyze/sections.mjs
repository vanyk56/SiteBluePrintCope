import { kids, textOf, walkTree, ownText } from './tree.mjs';
import { pascal } from '../util.mjs';

const hasBox = (n) => n.s && (n.s['background-color'] || n.s['background-image'] || n.s['border-width'] || n.s['box-shadow']);
// a tiny leaf between sections that still shapes the page: <hr> (1px line + 20px margins), a spacer, a coloured bar.
// Dropping it when its wrapper is split into sections shifted everything below by its height + margins.
const tinyKeep = (k) => {
  if (k.sr || k.r[3] >= 8 || kids(k).length || ownText(k)) return false;
  const s = k.s || {};
  if (s.position === 'absolute' || s.position === 'fixed' || s.display === 'none') return false;
  const m = s.margin || [0, 0, 0, 0];
  return k.t === 'hr' || k.r[3] >= 1 || !!(m[0] || m[2]) || hasBox(k);
};

// info (optional out-param): base = single-child containers descended from <body> (they wrap header/footer too),
// wrapOf = section node -> wrappers that were expanded into sections (outermost first). Their own box/layout styles
// (max-width, padding, grid columns of a sidebar layout…) must be re-created around the sections — see pageFile().
// info.inline = tiny leaves (tinyKeep) between sections: { node, before: index of the next section, wrap: [wrappers] }.
// subtree size (capped) — a wrapper with hundreds of nodes is split into its children instead of becoming one huge
// component that hits the per-section code limit (an app dashboard: the whole main column was one section)
const HEAVY = 150;
function weightOf(n, memo) {
  if (memo.has(n)) return memo.get(n);
  let c = 0; const st = [n];
  while (st.length && c <= 4000) { const x = st.pop(); c++; for (const k of kids(x)) st.push(k); }
  memo.set(n, c); return c;
}
// >= 3 siblings of one shape making >= 60% of the children: a card grid / list, never split into sections
function repeatKids(ks) {
  if (ks.length < 3) return false;
  const cnt = new Map(); for (const k of ks) { const sg = shapeSig(k); cnt.set(sg, (cnt.get(sg) || 0) + 1); }
  const bc = Math.max(...cnt.values());
  return bc >= 3 && bc >= ks.length * 0.6;
}
export function detectSections(root, vh, info = null) {
  const memo = new Map();
  let container = root; const base = [];
  for (let d = 0; d < 10; d++) {
    const ks = kids(container).filter((k) => k.r[3] >= 8 && !k.sr);
    if (ks.length === 1 && !['header', 'footer', 'nav', 'section'].includes(ks[0].t) && ks[0].r[3] > vh * 0.5) { container = ks[0]; base.push(container); }
    else break;
  }
  const wrapOf = new Map();
  const tiny = new Set();
  let list = kids(container).filter((k) => { if (tinyKeep(k)) { tiny.add(k); return true; } return !k.sr && (k.r[3] >= 8 || ['header', 'nav'].includes(k.t)); });
  for (let pass = 0; pass < 6; pass++) {
    let changed = false; const out = [];
    for (const n of list) {
      if (tiny.has(n)) { out.push(n); continue; }
      const ks = kids(n).filter((k) => !k.sr && k.r[3] >= 8);
      const big = ks.filter((k) => k.r[3] >= 120);
      const semantic = ['header', 'footer', 'nav'].includes(n.t);
      const singleUnwrap = !semantic && ks.length === 1 && ['main', 'article', 'div'].includes(n.t) && ['main', 'article', 'div', 'section'].includes(ks[0].t) && ks[0].r[3] >= 8;
      const expand = !semantic && (
        singleUnwrap ||
        (ks.length >= 2 && (
          n.t === 'main' ||
          (n.t === 'section' && ks.filter((k) => k.t === 'section').length >= 2) ||
          (['div', 'article'].includes(n.t) && ks.some((k) => k.t === 'section')) ||
          (['div', 'article'].includes(n.t) && n.r[3] > vh * 1.5 && big.length >= 2 && (!hasBox(n) || big.length >= 3)) ||
          (['div', 'article'].includes(n.t) && ks.some((k) => ['header', 'footer', 'section', 'main'].includes(k.t)) && big.length >= 2) ||
          (['div', 'article', 'section', 'main', 'aside'].includes(n.t) && ks.length <= 12 && weightOf(n, memo) > HEAVY && !repeatKids(ks))
        ))
      );
      if (expand) {
        const w = [...(wrapOf.get(n) || []), n];
        for (const k of kids(n)) {
          if (ks.includes(k)) { wrapOf.set(k, w); out.push(k); } else if (tinyKeep(k)) { wrapOf.set(k, w); tiny.add(k); out.push(k); }
        }
        changed = true;
      } else out.push(n);
    }
    list = out;
    if (!changed) break;
  }
  // tiny leaves at the edges of the page / runs of them are fine; a page made of tiny leaves only is not a page
  const sections = list.filter((n) => !tiny.has(n));
  if (info) {
    info.base = base; info.wrapOf = wrapOf;
    info.inline = []; let idx = 0;
    for (const n of list) { if (tiny.has(n)) info.inline.push({ node: n, before: idx, wrap: wrapOf.get(n) || [] }); else idx++; }
  }
  return sections;
}

export const PRICE_RE = /(?:[$€£₽¥]\s?\d|\d[\d\s.,]*\s?(?:₽|руб|р\.|\$|€|USD|EUR)|\/\s?(?:mo|month|yr|year|мес|год)\b|per (?:month|year|user))/i;

export function shapeSig(n) {
  const tags = new Set();
  (function rec(x, d) { for (const k of kids(x)) { if (/^(h[1-6]|p|img|svg|a|button|ul|ol|blockquote|video|input)$/.test(k.t)) tags.add(k.t); if (d < 4) rec(k, d + 1); } })(n, 0);
  return n.t + '|' + [...tags].sort().join(',') + '|' + (textOf(n, 3) ? 'T' : '');
}
export function findRepeats(secNode) {
  const groups = [];
  walkTree(secNode, (x) => {
    const ks = kids(x).filter((k) => !k.sr);
    if (ks.length < 3) return;
    const sigs = ks.map(shapeSig);
    const cnt = new Map(); sigs.forEach((s) => cnt.set(s, (cnt.get(s) || 0) + 1));
    let best = null, bc = 0; for (const [s, c] of cnt) if (c > bc) { best = s; bc = c; }
    if (bc >= 3 && bc >= ks.length * 0.6) {
      const items = ks.filter((k, i) => sigs[i] === best);
      const y0 = items[0].r[1];
      const perRow = items.filter((it) => Math.abs(it.r[1] - y0) <= 6).length;
      // one nested level (footer columns -> links, plans -> feature list): homogeneous runs of >= 2 siblings inside each item
      const inner = [];
      for (const it of items) walkTree(it, (y) => {
        const ys = kids(y).filter((k) => !k.sr);
        if (ys.length < 2) return;
        const sg = ys.map(shapeSig); const cn = new Map(); sg.forEach((g) => cn.set(g, (cn.get(g) || 0) + 1));
        let top = null, tc = 0; for (const [g, c] of cn) if (c > tc) { top = g; tc = c; }
        const same = ys.filter((k, i) => sg[i] === top);
        const tag = same[0].t;
        if (tc < 2 || !(/^(a|li|button)$/.test(tag) || tc >= 3) || same.some((k) => k.t !== tag)) return;
        // the run must be contiguous so that a single .map() can replace it
        const idx = sg.map((g, i) => (g === top ? i : -1)).filter((i) => i >= 0);
        if (idx[idx.length - 1] - idx[0] === idx.length - 1) { inner.push({ containerId: y.i, itemIds: same.map((k) => k.i), tag }); return false; }
      });
      groups.push({ containerId: x.i, itemIds: items.map((it) => it.i), count: items.length, perRow, tag: items[0].t, simple: items.every((it) => kids(it).length === 0), inner });
      return false;
    }
  });
  return groups;
}

const BASE = { article: 'Article', header: 'Header', banner: 'AnnouncementBar', footer: 'Footer', hero: 'Hero', faq: 'Faq', pricing: 'Pricing', testimonials: 'Testimonials', form: 'ContactForm', newsletter: 'Newsletter', stats: 'Stats', logos: 'LogoCloud', gallery: 'Gallery', tabs: 'Tabs', blog: 'BlogGrid', team: 'Team', features: 'Features', cta: 'Cta', content: 'Content' };

export function classify(sec, ctx) {
  const n = sec.node;
  const f = { h1: 0, times: 0, articles: 0, paras: 0, prose: 0, headings: [], links: 0, buttons: 0, inputs: 0, forms: 0, imgs: 0, svgs: 0, li: 0, quotes: 0, details: 0, expand: 0, maxFont: 0, prices: 0, bigNums: 0, chars: 0, copyright: false, fixed: false, tabs: 0 };
  walkTree(n, (x) => {
    const t = x.t;
    if (/^h[1-6]$/.test(t)) { if (t === 'h1') f.h1++; f.headings.push({ level: +t[1], text: textOf(x, 200) }); }
    if (t === 'a') f.links++;
    if (t === 'time') f.times++;
    if (t === 'article') f.articles++;
    if (x.c && /(^|\s)(prose|entry-content|article-body|post-content|post-body|markdown-body|rich-text)(\s|$)/.test(x.c)) f.prose++;
    if (t === 'p') { const l = textOf(x, 2000).length; if (l > 40) f.paras++; }
    if (t === 'button' || (x.a && x.a.role === 'button')) f.buttons++;
    if (t === 'input' || t === 'textarea' || t === 'select') f.inputs++;
    if (t === 'form') f.forms++;
    if (t === 'img') f.imgs++;
    if (t === 'svg') f.svgs++;
    if (t === 'li') f.li++;
    if (t === 'blockquote' || t === 'q') f.quotes++;
    if (t === 'details') f.details++;
    if (x.a && x.a.expanded !== undefined) f.expand++;
    if (x.a && x.a.role === 'tab') f.tabs++;
    if (x.s && (x.s.position === 'fixed' || x.s.position === 'sticky')) f.fixed = true;
    const own = ownText(x);
    if (own) {
      const fs = (ctx.eff.get(x.i) || {})['font-size'] || 16;
      f.chars += own.length;
      if (fs > f.maxFont) f.maxFont = fs;
      if (PRICE_RE.test(own)) f.prices++;
      if (fs >= 28 && /\d/.test(own) && /^[\d\s.,+%$€₽×xkKmMbB/]+$/.test(own)) f.bigNums++;
      if (/©|\(c\)|copyright|все права/i.test(own)) f.copyright = true;
    }
  });
  const idx = sec.index, total = ctx.total, y = n.r[1], h = n.r[3];
  const cls = ((n.c || '') + ' ' + (n.id || '')).toLowerCase();
  const top = (f.headings.slice().sort((a, b) => a.level - b.level)[0] || {}).text || '';
  const hay = (top + ' ' + cls).toLowerCase();
  const reps = sec.repeats;
  let type = 'content';
  if (n.t === 'header' || (n.a && n.a.role === 'banner') || n.t === 'nav' || (/(^|[\s_-])(header|navbar|nav|topbar)([\s_-]|$)/.test(cls) && h < 220 && idx <= 2) || (idx <= 1 && h < 140 && f.links >= 2 && f.maxFont < 32)) type = 'header';
  else if (idx === 0 && h < 70 && f.chars < 200) type = 'banner';
  else if (
    (n.t === 'footer' || (n.a && n.a.role === 'contentinfo') || /(^|[\s_-])footer\b/.test(cls) ||
    (idx === total - 1 && (f.copyright || (f.links >= 8 && f.maxFont < 28 && !f.h1))) ||
    (idx >= total - 2 && f.copyright && !f.h1)) &&
    n.t !== 'main' && !f.h1
  ) type = 'footer';
  else if (f.prices >= 2 && reps.some((g) => g.count >= 2) && !(f.h1 && f.prices < 3 && h < ctx.vh * 0.9)) type = 'pricing';
  else if (f.h1 && (f.paras >= 4 || f.chars > 1500 || ((f.articles >= 1 || f.prose >= 1) && !reps.some((g) => g.count >= 3 && !g.simple)))) type = 'article';
  else if (y < ctx.vh * 1.1 && idx <= 3 && (f.h1 > 0 || f.maxFont >= 40) && !(ctx.prev || []).some((x) => !['header', 'banner'].includes(x)) && !(reps.some((g) => g.count >= 3 && !g.simple) && (f.times >= 2 || /blog|news|post|articles|новост|блог|стать|журнал|team|команда/.test(hay)))) type = 'hero';
  else if (f.details >= 2 || /faq|frequently|вопрос|q&a/.test(hay) || (f.expand >= 2 && f.headings.some((h) => /\?|how|what|why|когда|как|что/i.test(h.text)))) type = 'faq';
  else if (f.prices >= 2 || /pricing|plans|тариф|стоимост|цены/.test(hay)) type = 'pricing';
  else if (f.quotes >= 1 || /testimonial|review|отзыв|говорят|о нас говорят|what (people|our|customers)|loved by/.test(hay)) type = 'testimonials';
  else if (f.forms > 0 || f.inputs >= 2) type = f.inputs <= 2 ? 'newsletter' : 'form';
  else if (f.bigNums >= 3) type = 'stats';
  else if (/team|команда|founders|основател|our people|наши люди/.test(hay) && f.imgs >= 2) type = 'team';
  else if (f.imgs + f.svgs >= 4 && f.chars < 160) type = 'logos';
  else if (f.imgs >= 6 && f.chars < 400) type = 'gallery';
  else if (f.tabs >= 2) type = 'tabs';
  else if (reps.length && reps.some((g) => g.count >= 3 && !g.simple)) type = /blog|news|post|articles|новост|блог|стать|журнал/.test(hay) || f.times >= 2 ? 'blog' : /team|команда|founders|основател|people/.test(hay) && f.imgs >= 2 ? 'team' : 'features';
  else if (h <= 650 && f.headings.length <= 2 && f.buttons + f.links >= 1 && f.chars < 450) type = 'cta';
  return { type, features: f, heading: (f.headings.sort((a, b) => a.level - b.level)[0] || {}).text || '' };
}

export function componentName(type, heading, used) {
  let name = ['header', 'footer', 'banner'].includes(type) ? BASE[type] : BASE[type] + 'Section';
  if (used.has(name)) {
    const p = pascal(heading, 3);
    name = p ? p + 'Section' : name;
    let i = 2; const baseName = name;
    while (used.has(name)) name = baseName + i++;
  }
  used.add(name);
  return name;
}
