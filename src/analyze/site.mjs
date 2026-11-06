// Stage 2: deterministic site model — tokens, icons, routes, React components (TSX), section facts, hidden content.
import path from 'node:path';
import { CssVarRegistry } from './cssvars.mjs';
import fsp from 'node:fs/promises';
import { readJSON, exists, sha, pascal, normalizeUrl, sameSite, truncate, fmtTransition, colorsToHex } from '../util.mjs';
import { analyzeSections } from './page.mjs';
import { analyzeCss } from './css.mjs';
import { buildTokens, mainBreakpoint } from './tokens.mjs';
import { createTw } from './tailwind.mjs';
import { createSkeleton } from './skeleton.mjs';
import { computeEffective, indexTree, pathMap, textOf, walkTree, kids } from './tree.mjs';
import { svgToJsx, guessIconName } from './svg.mjs';
import { cartProps, enhanceSection, isCartDialog, menuLinks } from '../output/interactive.mjs';

export const GLOBAL_TYPES = new Set(['header', 'footer', 'banner']);
export const TYPE_RU = { article: 'статья', header: 'шапка', banner: 'анонс-бар', footer: 'подвал', hero: 'первый экран (hero)', faq: 'FAQ', pricing: 'тарифы', testimonials: 'отзывы', form: 'форма', newsletter: 'подписка', stats: 'цифры', logos: 'логотипы', gallery: 'галерея', tabs: 'табы', blog: 'статьи', team: 'команда', features: 'карточки/преимущества', cta: 'призыв к действию', content: 'контент' };
const BASE = { article: 'ArticleSection', header: 'Header', banner: 'AnnouncementBar', footer: 'Footer', hero: 'HeroSection', faq: 'FaqSection', pricing: 'PricingSection', testimonials: 'TestimonialsSection', form: 'ContactFormSection', newsletter: 'NewsletterSection', stats: 'StatsSection', logos: 'LogoCloudSection', gallery: 'GallerySection', tabs: 'TabsSection', blog: 'BlogGridSection', team: 'TeamSection', features: 'FeaturesSection', cta: 'CtaSection', content: 'ContentSection' };
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function loadCrawl(outDir) {
  const crawl = await readJSON(path.join(outDir, 'data', 'crawl.json'));
  const pages = [];
  for (const p of crawl.pages) { const f = path.join(outDir, 'data', 'pages', p.slug + '.json'); if (await exists(f)) pages.push(await readJSON(f)); }
  const css = [];
  for (const c of crawl.css || []) { try { css.push({ url: c.url, text: await fsp.readFile(path.join(outDir, c.file), 'utf8') }); } catch {} }
  if (!pages.length) throw new Error('В ' + outDir + ' нет данных страниц (data/pages/*.json)');
  return { crawl, pages, css };
}

function markImages(tree, images) {
  walkTree(tree, (n) => { if (n.t === 'img' && n.img >= 0) { const im = images[n.img]; if (im && im.nw > 0 && im.nh > 0) { n._ar = im.nw / im.nh; n._nw = im.nw; } } });
}
function preparePage(rec) {
  const raw = rec.raw;
  markImages(raw.tree, raw.images || []);
  if (rec.mobile && rec.mobile.raw && rec.mobile.raw.tree) markImages(rec.mobile.raw.tree, rec.mobile.raw.images || []);
  const { eff, sections, base, inline } = analyzeSections(raw);
  const { parent, byId } = indexTree(raw.tree);
  pathMap(raw.tree);
  let mob = null;
  if (rec.mobile && rec.mobile.raw && rec.mobile.raw.tree) {
    const mr = rec.mobile.raw; const E = computeEffective(mr.tree);
    mob = { raw: mr, E, P: indexTree(mr.tree).parent, map: pathMap(mr.tree), bodyEff: E.get(mr.tree.i) || {}, truncated: !!(mr.stats && mr.stats.truncated) };
  }
  return { rec, raw, eff, parent, byId, sections, base, inline, mob, slug: rec.slug };
}

const iconKey = (markup) => markup.replace(/^<svg\b[^>]*>/, (m) => m.replace(/\s(width|height)="[^"]*"/g, ''));
function buildIcons(P) {
  const byKey = new Map(); const names = new Set(); const list = [];
  const add = (svg, p, mobile = false) => {
    if (!svg || svg.big || !svg.markup) return null;
    const key = iconKey(svg.markup);
    let rec = byKey.get(key);
    if (!rec) {
      const shape = svg.logo ? null : guessIconName(svg.markup);
      let base = shape || pascal(svg.name || 'icon', 3) || 'Icon';
      if (!/(Icon|Logo)$/.test(base)) base += svg.logo ? 'Logo' : 'Icon';
      let name = base, i = 2; while (names.has(name)) name = base + i++;
      names.add(name);
      rec = { name, file: `svg/inline/${name}.svg`, markup: svg.markup, w: svg.w, h: svg.h, logo: !!svg.logo, color: svg.color, count: 0, pages: new Set(), where: new Set(), label: svg.label || '' };
      byKey.set(key, rec); list.push(rec);
    }
    if (mobile) rec.mobile = (rec.mobile || 0) + 1; else rec.count += svg.count || 1; // desktop occurrences only
    rec.pages.add(p.slug);
    return rec;
  };
  for (const p of P) { p.svgRecs = (p.raw.svgs || []).map((s) => add(s, p)); p.mobSvgRecs = p.mob ? (p.mob.raw.svgs || []).map((s) => add(s, p, true)) : []; }
  for (const r of list) r.jsx = svgToJsx(r.markup, r.name.replace(/(Icon|Logo)$/, '').toLowerCase() || 'i');
  return list;
}

function buildRoutes(P) {
  const map = new Map(); const usedDirs = new Set();
  for (const p of P) {
    const u = new URL(p.rec.finalUrl);
    let route = '/';
    try { route = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/'; } catch { route = u.pathname; }
    const segs = route.split('/').filter(Boolean).map((s) => s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '') || 'page');
    let dir = segs.length ? 'app/' + segs.join('/') : 'app';
    if (usedDirs.has(dir)) dir = 'app/' + p.slug.replace(/__/g, '/');
    usedDirs.add(dir);
    p.route = route + (u.search ? u.search : ''); p.appDir = dir;
    map.set(normalizeUrl(p.rec.finalUrl), p.route); map.set(normalizeUrl(p.rec.url), p.route);
  }
  return map;
}

export function buildSite(data, opts = {}) {
  const { crawl, pages } = data;
  const origin = crawl.origin;
  const P = pages.map(preparePage);
  const cssInfo = analyzeCss(data.css || [], pages.map((p) => p.raw));
  const tokens = buildTokens(P.map((p) => ({ raw: p.raw, eff: p.eff, sections: p.sections })), cssInfo);
  const home = P[0];
  const bp = mainBreakpoint(tokens, home.raw.viewport.w, home.mob ? home.mob.raw.viewport.w : 390);
  const cssVars = new CssVarRegistry('sb');
  const tw = createTw(tokens, { vh: home.raw.viewport.h, vars: cssVars });
  const icons = buildIcons(P);
  const routes = buildRoutes(P);
  const assetsBy = new Map(((crawl.assets && crawl.assets.saved) || []).map((a) => [a.url, a.web]));
  const linkFor = (href) => {
    if (!href) return { href: '#', internal: false };
    if (/^javascript:/i.test(href)) return { href: '#', internal: false };
    if (/^(#|mailto:|tel:|sms:)/i.test(href)) return { href, internal: false };
    let u; try { u = new URL(href); } catch { return { href, internal: false }; }
    if (!/^https?:$/.test(u.protocol)) return { href, internal: false };
    if (!sameSite(href, origin, true) || new URL(origin).hostname.replace(/^www\./, '') !== u.hostname.replace(/^www\./, '')) return { href, internal: false };
    const r = routes.get(normalizeUrl(href));
    let p = r || ((() => { try { return decodeURIComponent(u.pathname); } catch { return u.pathname; } })().replace(/\/+$/, '') || '/');
    if (!r && u.search) p += u.search;
    return { href: p + (u.hash || ''), internal: true };
  };

  // ---- global (layout) sections: header/footer/banner repeated on most pages ----
  const sigOf = (s) => s.type + '|' + s.node.t + '|' + sha(norm(textOf(s.node, 6000)), 10);
  const cnt = new Map();
  for (const p of P) for (const s of p.sections) { s._sig = sigOf(s); if (GLOBAL_TYPES.has(s.type)) cnt.set(s._sig, (cnt.get(s._sig) || 0) + 1); }
  const need = Math.max(1, Math.ceil(P.length * 0.5));
  const globalSigs = new Set([...cnt].filter(([, c]) => c >= need).map(([k]) => k));

  const used = new Set(['Page', 'RootLayout', 'Link', 'Image', ...icons.map((i) => i.name)]);
  const nameFor = (type, prefix) => { const base = BASE[type] || 'Section'; let n = base; if (used.has(n) && prefix) n = base.startsWith(prefix) ? base.replace(/Section$/, '') + 'PageSection' : prefix + base; const b = n; let i = 2; while (used.has(n)) n = b + i++; used.add(n); return n; };
  const components = []; const bySig = new Map(); const globals = []; let layoutWrap = [];
  // hover results are keyed by element signature; shared elements are probed once per crawl, so merge all pages
  const hoverAll = new Map();
  for (const p of P) for (const h of (p.rec.probes && p.rec.probes.hover) || []) if (!hoverAll.has(h.sig)) hoverAll.set(h.sig, h);
  // site-wide cart: the first probed overlay that looks like a cart drawer -> <CartProvider> config (app/layout.tsx)
  let cart = null;
  for (const p of P) for (const d of (p.rec.probes && p.rec.probes.dialogs) || []) if (!cart && isCartDialog(d)) cart = cartProps(d, { w: p.raw.viewport.w, h: p.raw.viewport.h });
  const opaqueHex = (h) => (h && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h) && !/^#[0-9a-f]{6}00$/i.test(h) ? h : null);
  for (const p of P) {
    const raw = p.raw;
    const sigById = new Map((raw.interactive || []).map((x) => [x.id, x.sig]));
    const hoverBySig = new Map([...hoverAll, ...((p.rec.probes && p.rec.probes.hover) || []).map((h) => [h.sig, h])]);
    const detailsMap = new Map(((p.rec.probes && p.rec.probes.details) || []).map((x) => [norm(x.q), x.a]));
    const expandMap = new Map(((p.rec.probes && p.rec.probes.expand) || []).map((x) => [x.id, x]));
    const dialogMap = new Map(((p.rec.probes && p.rec.probes.dialogs) || []).filter((d) => d && d.triggerId != null && (d.overlays || []).length).map((d) => [String(d.triggerId), d]));
    const burger = p.rec.mobile && p.rec.mobile.burger && p.rec.mobile.burger.id ? p.rec.mobile.burger : null;
    let menu = null;
    if (burger) {
      const links = menuLinks(burger, raw.links, linkFor);
      const bst = burger.style || {};
      if (links.length) menu = { links, bg: opaqueHex(bst.bg) || tokens.roles.background || '#ffffff', fg: opaqueHex(bst.color) || tokens.roles.foreground || '#111111' };
    }
    const ctx = {
      tw, bp, vw: raw.viewport.w, vp: { w: raw.viewport.w, h: raw.viewport.h }, E: p.eff, P: p.parent, bodyEff: p.eff.get(raw.tree.i) || {}, mob: p.mob, maxChars: opts.maxSectionChars || 80000,
      current: null,
      iconFor: (N, isMob) => { const rec = N.svg >= 0 ? (isMob ? p.mobSvgRecs : p.svgRecs)[N.svg] : null; if (!rec) return { big: true }; if (ctx.current) rec.where.add(ctx.current); return { name: rec.name }; },
      imgFor: (N, isMob) => { const im = (isMob ? p.mob.raw.images : raw.images)[N.img]; if (!im) return null; return { src: im.local || assetsBy.get(im.src) || im.src, alt: im.alt, lazy: im.lazy }; },
      mediaFor: (N, isMob) => { const m = ((isMob ? p.mob.raw.media : raw.media) || [])[N.m]; if (!m) return null; return { ...m, src: m.local || assetsBy.get(m.src) || m.src, poster: m.posterLocal || assetsBy.get(m.poster) || m.poster }; },
      linkFor,
      hoverFor: (D) => {
        const sg = sigById.get(D.i);
        const h = sg ? hoverBySig.get(sg) : null;
        let d;
        if (h && h.diff && Object.keys(h.diff).length) d = { ...h.diff };
        else if (D.hv) {
          // authored :hover rule (cards etc. are not mouse-probed): keep only values that differ from the base state
          const S = D.s || {}; const E = p.eff.get(D.i) || {}; d = {};
          const base = { color: E.color, bg: S['background-color'], shadow: S['box-shadow'], opacity: S.opacity, transform: S.transform };
          for (const [k, v] of Object.entries(D.hv)) {
            if (v == null || v === '' || base[k] === v) continue;
            if (k === 'transform' && v === 'none' && !S.transform) continue;
            if (k === 'shadow' && v === 'none' && !S['box-shadow']) continue;
            if (k === 'opacity' && String(v) === '1' && (S.opacity === undefined || String(S.opacity) === '1')) continue;
            if (k === 'decoration') { d.decoration = [null, v]; continue; }
            d[k] = [null, k === 'shadow' ? colorsToHex(v) : v];
          }
        } else return '';
        if (!(D.s && D.s['border-width'])) delete d.border;
        if (d.bgi && String(d.bgi[1] || '').length > 400) delete d.bgi;
        return Object.keys(d).length ? tw.hoverCls(d) : '';
      },
      hidden: { details: { get: (q) => detailsMap.get(norm(q)) }, expand: expandMap, dropdowns: (p.rec.probes && p.rec.probes.dropdowns) || [], burger, menu, dialogs: dialogMap, cart: !!cart },
    };
    const sk = createSkeleton(ctx);
    p.blocks = [];
    const prefix = p === home ? '' : pascal(p.slug.replace(/__/g, ' '), 3);
    // a header/footer inside an expanded wrapper (a sidebar/TOC column of a grid layout) is not a layout-level global:
    // it stays in the page so that the wrapper (grid columns, max-width) can be re-created around it
    const globalOf = (s) => GLOBAL_TYPES.has(s.type) && globalSigs.has(s._sig) && !(s.wrap && s.wrap.length);
    const firstContent = p.sections.findIndex((s) => !globalOf(s));
    for (const s of p.sections) {
      const isGlobal = globalOf(s);
      if (bySig.has(s._sig)) { const c = bySig.get(s._sig); c.usedOn.add(p.slug); if (!isGlobal) p.blocks.push({ comp: c, section: s, reused: true }); continue; }
      const name = nameFor(s.type, prefix);
      ctx.current = name;
      const r = sk.renderSection({ node: s.node, type: s.type, repeats: s.repeats, name });
      ctx.current = null;
      // tabs / catalog filters / add-to-cart in data templates -> working client state
      const enh = enhanceSection(sk.sectionFile(r), r, { tabGroups: (p.rec.probes && p.rec.probes.tabGroups) || [], lang: opts.lang || 'ru', catalogTools: opts.catalogTools === true, cart: !!cart });
      r.features = enh.features; r.isClient = enh.client; r.client = [...new Set([...(r.client || []), ...enh.uses])].sort();
      const comp = {
        name, type: s.type, global: isGlobal, position: isGlobal ? (firstContent < 0 || s.index < firstContent ? 'top' : 'bottom') : null,
        page: p.slug, route: p.route, index: s.index, heading: s.heading,
        file: `${isGlobal ? 'components/layout' : 'components/sections'}/${name}.tsx`,
        code: enh.code, render: r, usedOn: new Set([p.slug]), client: enh.client,
        facts: describeSection(s, p, tw, r),
        shot: ((p.rec.shots && p.rec.shots.sections) || []).find((x) => x.index === s.index)?.file || null,
      };
      components.push(comp); bySig.set(s._sig, comp);
      if (isGlobal) globals.push(comp); else p.blocks.push({ comp, section: s });
    }
    // wrappers expanded into sections -> re-created in page.tsx (only those that carry classes); base containers
    // (they also wrap header/footer) -> app/layout.tsx, taken from the home page
    p.wraps = new Map();
    const wrapOf = (id) => {
      if (!p.wraps.has(id)) { const n = p.byId.get(id); const cls = n ? sk.wrapperClass(n) : ''; p.wraps.set(id, cls ? { tag: n.t, cls } : null); }
      return p.wraps.get(id);
    };
    for (const b of p.blocks) b.wrap = (b.section.wrap || []).filter((id) => wrapOf(id));
    // tiny leaves between sections (<hr>, spacers) -> plain elements in page.tsx, placed before block `at`
    p.inlines = [];
    for (const x of p.inline || []) {
      const n = p.byId.get(x.id); if (!n) continue;
      const at = p.blocks.findIndex((b) => b.section.index >= x.before);
      p.inlines.push({ at: at < 0 ? p.blocks.length : at, tag: n.t, cls: sk.wrapperClass(n), wrap: (x.wrap || []).filter((id) => wrapOf(id)) });
    }
    if (p === home) layoutWrap = (p.base || []).map((id) => wrapOf(id)).filter(Boolean);
  }
  // the page column of an app shell (div.main { flex: 1; min-width: 0 } next to a sidebar) wraps every block of every page:
  // its classes go onto <main> in app/layout.tsx — a bare <main> around it would be the flex item and "flex-1" a no-op
  let layoutMain = null;
  {
    const outer = (p) => {
      const items = [...p.blocks, ...(p.inlines || [])];
      if (!items.length) return null;
      const w0 = items[0].wrap && items[0].wrap[0];
      if (w0 === undefined || !items.every((b) => b.wrap && b.wrap[0] === w0)) return null;
      const n = p.byId.get(w0); const par = n ? p.parent.get(n.i) : null;
      const baseId = (p.base || []).length ? p.base[p.base.length - 1] : p.raw.tree.i;
      if (!par || par.i !== baseId) return null;
      return { id: w0, ...p.wraps.get(w0) };
    };
    const all = P.map(outer);
    if (all.every((w) => w && w.cls === all[0].cls)) {
      layoutMain = { cls: all[0].cls };
      P.forEach((p, i) => { const id = all[i].id; for (const b of [...p.blocks, ...(p.inlines || [])]) if (b.wrap && b.wrap[0] === id) b.wrap = b.wrap.slice(1); });
    }
  }
  const keyframesUsed = new Set();
  for (const c of components) for (const m of c.code.matchAll(/animate-\[([A-Za-z0-9_-]+?)(?:_|\])/g)) keyframesUsed.add(m[1]);
  const usesCart = components.some((c) => /<(CartButton|AddToCart)\b/.test(c.code));
  return { origin, crawl, pages: P, home, tokens, bp, tw, icons, routes, components, globals, layoutWrap, layoutMain, cssInfo, keyframesUsed, linkFor, cssVars, cart: usesCart ? cart || {} : null };
}

// ---- deterministic facts about a section (for the blueprint & the LLM) ----
function bgOf(n, tw) {
  const s = n.s || {}; const out = [];
  if (s['background-color']) out.push(`цвет ${s['background-color']}${tw.col('bg', s['background-color']).startsWith('bg-[') ? '' : ` (${tw.col('bg', s['background-color'])})`}`);
  if (s['background-image']) out.push(/gradient/.test(s['background-image']) ? `градиент ${truncate(s['background-image'], 220)}` : `картинка ${truncate(s['background-image'], 160)}`);
  return out.join(' + ');
}
function describeSection(s, p, tw, r) {
  const n = s.node; const f = [];
  const m = p.mob ? p.mob.map.get(n._p) : null;
  f.push(`Блок: \`<${n.t}>\` ${n.r[2]}×${n.r[3]} px (десктоп ${p.raw.viewport.w}px), y=${n.r[1]}${m ? `; мобильный ${p.mob.raw.viewport.w}px: высота ${m.r[3]} px, y=${m.r[1]}` : p.mob ? '; на мобильном не найден по DOM' : ''}`);
  let bg = bgOf(n, tw);
  if (!bg) { let x = n, depth = 0; walkTree(n, (k, d) => { if (bg || d > 3) return false; if (k !== n && k.r[2] >= n.r[2] * 0.9 && (k.s && (k.s['background-color'] || k.s['background-image']))) { bg = bgOf(k, tw) + ' (вложенный контейнер)'; return false; } }); void x; void depth; }
  if (bg) f.push('Фон: ' + bg);
  let container = null;
  walkTree(n, (k) => { if (container) return false; if (typeof (k.s && k.s['max-width']) === 'number' && k.s['max-width'] >= 400) { container = k; return false; } });
  if (container) { const pd = (container.s.padding || [0, 0, 0, 0]); f.push(`Контейнер: max-width ${container.s['max-width']}px${pd[1] || pd[3] ? `, боковые отступы ${pd[3]}/${pd[1]}px` : ''}`); }
  const pd = n.s && n.s.padding; if (pd && (pd[0] || pd[2])) f.push(`Вертикальные отступы секции: ${pd[0]}px сверху / ${pd[2]}px снизу${m && m.s && m.s.padding ? ` (мобильный: ${m.s.padding[0]}/${m.s.padding[2]}px)` : ''}`);
  for (const g of s.repeats || []) {
    const box = p.byId.get(g.containerId);
    const gap = box && box.s && box.s.gap ? `, gap ${box.s.gap[0] === box.s.gap[1] ? box.s.gap[0] : box.s.gap.join('/')}px` : '';
    let mobRow = '';
    if (p.mob) {
      const ms = g.itemIds.map((id) => p.byId.get(id)).map((d) => d && p.mob.map.get(d._p)).filter(Boolean);
      if (ms.length) { const y0 = ms[0].r[1]; mobRow = `; на мобильном ${ms.filter((x) => Math.abs(x.r[1] - y0) <= 6).length} в ряд`; } else mobRow = '; на мобильном скрыты/другой DOM';
    }
    f.push(`Повтор: ${g.count}× \`<${g.tag}>\` — ${g.perRow} в ряд на десктопе${mobRow}${gap}`);
  }
  const hov = [];
  walkTree(n, (k) => { if (hov.length >= 8) return false; if (k.ix) { /* hover classes are already in JSX */ } });
  const anim = new Set(); const trans = new Set();
  walkTree(n, (k) => { if (k.s && k.s.animation) anim.add(k.s.animation.split(' | ').slice(0, 2).join(' ')); if (k.s && k.s.transition) { const v = fmtTransition(k.s.transition); if (v) trans.add(v); } });
  if (anim.size) f.push('CSS-анимации: ' + [...anim].slice(0, 5).join('; '));
  if (trans.size) f.push('Transitions: ' + [...trans].slice(0, 4).join('; '));
  const ft = s.features || {};
  const media = [ft.imgs ? `${ft.imgs} изобр.` : '', ft.svgs ? `${ft.svgs} SVG` : '', ft.inputs ? `${ft.inputs} полей формы` : ''].filter(Boolean);
  if (media.length) f.push('Содержит: ' + media.join(', '));
  if (r.interactive.length) f.push('Интерактив: ' + r.interactive.join(', '));
  const ready = [...(r.features || []), ...(r.client || []).map((c) => `<${c}>`)];
  if (ready.length) f.push('Уже работает в сгенерированном коде: ' + ready.join('; '));
  if (!r.responsive && p.mob) f.push(r.notes.join(' '));
  return f;
}

export function sectionOutline(node, max = 1600) {
  // compact, readable outline (tags + text) — used in LLM prompts
  const lines = [];
  (function rec(n, d) {
    if (lines.join('\n').length > max) return;
    const own = (n.k || []).filter((k) => typeof k === 'string').join('').replace(/\s+/g, ' ').trim();
    const tag = n.t === 'svg' ? 'svg-icon' : n.t;
    if (own || /^(h[1-6]|img|svg|button|a|input|select|textarea|video|form|ul|ol|li)$/.test(n.t)) lines.push('  '.repeat(Math.min(d, 8)) + `<${tag}>` + (own ? ' ' + truncate(own, 140) : ''));
    for (const k of kids(n)) rec(k, d + (own || /^(section|ul|ol|form|nav)$/.test(n.t) ? 1 : 0));
  })(node, 0);
  return truncate(lines.join('\n'), max);
}
