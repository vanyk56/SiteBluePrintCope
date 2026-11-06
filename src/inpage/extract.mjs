/* Runs INSIDE the page via page.evaluate(extractPage, opts). Must stay self-contained (no outer references). */
export function extractPage(opts) {
  const t0 = Date.now();
  const MAX_NODES = opts.maxNodes || 4000;
  const LITE = !!opts.lite;
  const VW = window.innerWidth, VH = window.innerHeight;
  const sx = window.scrollX, sy = window.scrollY;
  if (!document.body) return { error: 'no <body>' };
  const DOC_H = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base', 'source', 'track', 'param', 'map', 'area', 'wbr']);
  const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'label', 'font']);
  const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'audio', 'iframe', 'embed', 'object']);
  const INH = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'text-shadow', '-webkit-text-fill-color', 'cursor'];
  const IX_SEL = 'a[href],button,[role="button"],[role="tab"],input[type="submit"],input[type="button"],summary,[aria-expanded]';

  // ---------- colors ----------
  const colorCache = new Map(); let cctx = null;
  const hx = (r, g, b, a) => { const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'); return '#' + h(r) + h(g) + h(b) + (a < 0.995 ? h(a * 255) : ''); };
  function toHex(c) {
    if (!c) return null;
    let v = colorCache.get(c); if (v !== undefined) return v;
    v = null;
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(c);
    if (m) v = hx(+m[1], +m[2], +m[3], m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1));
    else if (c === 'transparent') v = '#00000000';
    else if (/^#[0-9a-f]{3,8}$/i.test(c)) { let h = c.slice(1); if (h.length <= 4) h = h.split('').map((x) => x + x).join(''); v = '#' + h.toLowerCase(); if (v.length === 9 && v.endsWith('ff')) v = v.slice(0, 7); }
    else {
      try {
        if (!cctx) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; cctx = cv.getContext('2d', { willReadFrequently: true }); }
        cctx.clearRect(0, 0, 1, 1); cctx.fillStyle = 'rgba(1, 2, 3, 0.5)'; const sentinel = cctx.fillStyle; cctx.fillStyle = c;
        if (cctx.fillStyle !== sentinel) { cctx.fillRect(0, 0, 1, 1); const d = cctx.getImageData(0, 0, 1, 1).data; v = hx(d[0], d[1], d[2], d[3] / 255); }
      } catch (e) { v = null; }
    }
    colorCache.set(c, v); return v;
  }
  const COLOR_FN = /(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)/gi;
  const colorsIn = (s) => (s ? s.replace(COLOR_FN, (m) => toHex(m) || m) : s);
  const isClear = (h) => !h || /^#[0-9a-f]{6}00$/i.test(h);
  const REPLACED_FORM = /^(input|select|textarea|button|progress|meter)$/;
  const pxn = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const r1 = (n) => Math.round(n * 10) / 10;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
  const lenOrRaw = (v) => (/^-?[\d.]+px$/.test(v) ? pxn(v) : v);
  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
  const urlsIn = (v) => [...String(v || '').matchAll(URL_RE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')).filter(Boolean);
  const colorsInBg = (v) => { v = String(v || ''); let out = '', last = 0; for (const m of v.matchAll(URL_RE)) { out += colorsIn(v.slice(last, m.index)) + m[0]; last = m.index + m[0].length; } return out + colorsIn(v.slice(last)); };
  const pickSet = (ss) => { let best = '', bw = -1; for (const part of String(ss || '').split(/,\s+/)) { const [u, d] = part.trim().split(/\s+/); if (!u) continue; const w = d ? parseFloat(d) * (/x$/.test(d) ? 1000 : 1) : 1; if (w > bw) { bw = w; best = u; } } return best; };

  function expectedDisplay(t) {
    if (REPLACED.has(t)) return 'block';
    if (t === 'button' || t === 'input' || t === 'select' || t === 'textarea' || t === 'meter' || t === 'progress') return 'inline-block';
    if (t === 'li' || t === 'summary') return 'list-item';
    const tbl = { table: 'table', tr: 'table-row', td: 'table-cell', th: 'table-cell', thead: 'table-header-group', tbody: 'table-row-group', tfoot: 'table-footer-group', caption: 'table-caption', col: 'table-column', colgroup: 'table-column-group' };
    if (tbl[t]) return tbl[t];
    return INLINE.has(t) ? 'inline' : 'block';
  }
  function cleanClasses(el) {
    const raw = el.getAttribute('class'); if (!raw || typeof raw !== 'string') return '';
    const out = [];
    for (let c of raw.split(/\s+/)) {
      if (!c || c.length > 80 || c.startsWith('__')) continue;
      if (/^(css|sc|jsx|emotion|styled|svelte|astro|e)-[a-z0-9]{5,}$/i.test(c)) continue;
      if (!c.includes('-') && /^[a-zA-Z][A-Za-z0-9]{5,}$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c)) continue;
      const mm = /^([A-Za-z][A-Za-z0-9-]*_[A-Za-z0-9-]+)__[A-Za-z0-9_-]{5}$/.exec(c); if (mm) c = mm[1];
      out.push(c);
    }
    return out.join(' ').slice(0, 400);
  }
  function siblingIndex(el) { let i = 0, p = el; while ((p = p.previousElementSibling)) i++; return i; }
  function renderChildren(el) {
    const sr = el.shadowRoot || (window.__sbShadowOf ? window.__sbShadowOf(el) : null); // closed roots via inpage/hooks.mjs
    const src = sr ? sr.childNodes : el.childNodes;
    const out = [];
    for (const n of src) {
      if (n.nodeType === 1 && n.tagName === 'SLOT') { const as = n.assignedNodes({ flatten: true }); for (const x of (as.length ? as : n.childNodes)) out.push(x); }
      else out.push(n);
    }
    return out;
  }
  function visibleEl(el) { const r = el.getBoundingClientRect(); if (r.width < 1 && r.height < 1) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; }

  // ---------- styles ----------
  const bgImages = [];
  function styleDiff(el, cs, pcs, t, r, pdisp) {
    const s = {};
    const root = !pcs;
    const fs = parseFloat(cs.fontSize) || 16;
    const fsChanged = root || cs.fontSize !== pcs.fontSize;
    for (const p of INH) {
      const v = cs.getPropertyValue(p);
      const same = !root && v === pcs.getPropertyValue(p);
      if (same && !(fsChanged && (p === 'line-height' || p === 'letter-spacing'))) continue;
      switch (p) {
        case 'color': s[p] = toHex(v); break;
        case '-webkit-text-fill-color': { const h = toHex(v); if (h !== toHex(cs.color)) s[p] = h; break; }
        case 'font-size': s[p] = pxn(v); break;
        case 'font-weight': s[p] = parseInt(v, 10) || v; break;
        case 'line-height': s[p] = v === 'normal' ? 'normal' : Math.round((parseFloat(v) / fs) * 1000) / 1000; break;
        case 'letter-spacing': s[p] = v === 'normal' ? 0 : Math.round((parseFloat(v) / fs) * 1000) / 1000; break;
        case 'text-shadow': s[p] = v === 'none' ? 'none' : colorsIn(v); break;
        default: s[p] = v;
      }
    }
    const disp = cs.display;
    if (disp !== expectedDisplay(t)) s.display = disp;
    // vertical-align matters only for inline-level boxes / table cells; replaced elements always record it (Tailwind preflight sets img/svg/video… to vertical-align: middle)
    if (/^inline/.test(disp) || disp === 'table-cell') { const va = cs.verticalAlign; if (va !== (disp === 'table-cell' ? 'middle' : 'baseline') || (REPLACED.has(t) && disp !== 'table-cell')) s['vertical-align'] = lenOrRaw(va); }
    if (cs.position !== 'static') {
      s.position = cs.position;
      const ins = [cs.top, cs.right, cs.bottom, cs.left];
      if (ins.some((v) => v !== 'auto')) s.inset = ins.map((v) => (v === 'auto' ? 'auto' : lenOrRaw(v)));
      if (cs.zIndex !== 'auto') s['z-index'] = parseInt(cs.zIndex, 10);
    } else if (cs.zIndex !== 'auto' && /flex|grid/.test(pdisp || '')) s['z-index'] = parseInt(cs.zIndex, 10);
    { const fl = cs.cssFloat || cs.float; if (fl && fl !== 'none') s.float = fl; if (cs.clear && cs.clear !== 'none') s.clear = cs.clear; }
    // tables: Tailwind's preflight collapses borders, the browser default (and many sites) is "separate" + spacing
    if (disp === 'table' || disp === 'inline-table') {
      const tb = {};
      if (cs.borderCollapse === 'separate') { tb.sep = 1; const sp = (cs.borderSpacing || '').trim(); if (sp && !/^0px(\s+0px)?$/.test(sp)) tb.sp = sp; }
      if (cs.tableLayout === 'fixed') tb.fixed = 1;
      if (cs.captionSide === 'bottom') tb.cap = 'bottom';
      if (Object.keys(tb).length) s.table = tb;
    }
    // CSS counters (numbered steps, "01" badges): kept as CSS, the clone counts itself — see pseudo content counter()
    { const c = counters(cs); if (c) s.counters = c; }
    // multi-column text (columns: 2 + column-rule) and what must not be split between columns
    if (!/flex|grid/.test(disp) && (cs.columnCount !== 'auto' || cs.columnWidth !== 'auto')) {
      const mc = { count: cs.columnCount === 'auto' ? null : +cs.columnCount, width: cs.columnWidth === 'auto' ? null : pxn(cs.columnWidth) };
      if (cs.columnGap !== 'normal') mc.gap = pxn(cs.columnGap);
      if (cs.columnRuleStyle !== 'none' && pxn(cs.columnRuleWidth) > 0) mc.rule = `${pxn(cs.columnRuleWidth)}px ${cs.columnRuleStyle} ${toHex(cs.columnRuleColor)}`;
      s.columns = mc;
    }
    if (cs.breakInside && cs.breakInside !== 'auto') s['break-inside'] = cs.breakInside;
    // a truncated table cell ("api-gateway-production-eu-w…"), a long URL broken anywhere, custom toggles
    if (cs.textOverflow && cs.textOverflow !== 'clip') s['text-overflow'] = cs.textOverflow;
    // inherited ones only where they start (differ from the parent), not on every descendant
    const own = (k) => !pcs || pcs[k] !== cs[k];
    if (cs.wordBreak && cs.wordBreak !== 'normal' && own('wordBreak')) s['word-break'] = cs.wordBreak;
    if (cs.overflowWrap && cs.overflowWrap !== 'normal' && own('overflowWrap')) s['overflow-wrap'] = cs.overflowWrap;
    { const tws = cs.textWrapStyle || (/^(balance|pretty)$/.test(cs.textWrap || '') ? cs.textWrap : ''); if ((tws === 'balance' || tws === 'pretty') && own(cs.textWrapStyle !== undefined ? 'textWrapStyle' : 'textWrap')) s['text-wrap'] = tws; }
    if (REPLACED_FORM.test(t)) {
      const ap = cs.appearance || cs.webkitAppearance; if (ap === 'none') s.appearance = 'none';
      // native <progress>/<meter> (no author border/background): Tailwind's preflight "border: 0 solid" would switch Chrome
      // to the fallback look (green bar on grey) — the clone reverts the border to keep the native, accent-colored one
      else if ((t === 'progress' || t === 'meter') && ['Top', 'Right', 'Bottom', 'Left'].every((sd) => cs['border' + sd + 'Style'] === 'none') && isClear(toHex(cs.backgroundColor)) && cs.backgroundImage === 'none') s.appearance = 'native';
      if (cs.accentColor && cs.accentColor !== 'auto') s['accent-color'] = toHex(cs.accentColor); // set on the control itself: no inheritance noise
    }
    const m = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(pxn);
    if (m.some(Boolean)) s.margin = m;
    const pd = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(pxn);
    if (pd.some(Boolean)) s.padding = pd;
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const bw = sides.map((sd) => (/none|hidden/.test(cs['border' + sd + 'Style']) ? 0 : pxn(cs['border' + sd + 'Width'])));
    if (bw.some(Boolean)) {
      s['border-width'] = bw;
      const bc = sides.map((sd) => toHex(cs['border' + sd + 'Color']));
      const used = bc.filter((c, i) => bw[i]);
      s['border-color'] = used.every((c) => c === used[0]) ? used[0] : bc;
      const st = sides.map((sd) => cs['border' + sd + 'Style']).find((x) => !/none|hidden/.test(x)) || 'solid';
      if (st !== 'solid') s['border-style'] = st;
    }
    const rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => (v.includes('%') ? v.split(' ')[0] : pxn(v)));
    if (rad.some((v) => v && v !== '0%')) s.radius = rad;
    const bg = toHex(cs.backgroundColor); if (!isClear(bg)) s['background-color'] = bg;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      s['background-image'] = colorsInBg(cs.backgroundImage).slice(0, cs.backgroundImage.includes('url(') ? 62000 : 1500);
      if (!/^auto( auto)?$/.test(cs.backgroundSize)) s['background-size'] = cs.backgroundSize;
      if (cs.backgroundPosition !== '0% 0%') s['background-position'] = cs.backgroundPosition;
      if (cs.backgroundRepeat !== 'repeat') s['background-repeat'] = cs.backgroundRepeat;
      if (cs.backgroundAttachment === 'fixed') s['background-attachment'] = 'fixed';
      for (const u of urlsIn(cs.backgroundImage)) bgImages.push({ src: u.startsWith('data:') ? u.slice(0, 60000) : abs(u), w: Math.round(r.width), h: Math.round(r.height), size: cs.backgroundSize });
    }
    if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') s['background-clip'] = 'text';
    else if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      // per-layer boxes: gradient borders = "linear-gradient(bg) padding-box, linear-gradient(border) border-box"
      if (cs.backgroundClip && !/^border-box(,\s*border-box)*$/.test(cs.backgroundClip)) s['background-clip'] = cs.backgroundClip.slice(0, 120);
      if (cs.backgroundOrigin && !/^padding-box(,\s*padding-box)*$/.test(cs.backgroundOrigin)) s['background-origin'] = cs.backgroundOrigin.slice(0, 120);
    }
    if (cs.isolation === 'isolate') s.isolation = 'isolate';
    { const mi = cs.maskImage || cs.webkitMaskImage; if (mi && mi !== 'none') {
      s['mask-image'] = colorsInBg(mi).slice(0, 1500);
      const ms = cs.maskSize || cs.webkitMaskSize, mp = cs.maskPosition || cs.webkitMaskPosition, mr = cs.maskRepeat || cs.webkitMaskRepeat;
      if (ms && !/^auto( auto)?$/.test(ms)) s['mask-size'] = ms; if (mp && !/^0% 0%$/.test(mp)) s['mask-position'] = mp; if (mr && !/^repeat( repeat)?$/.test(mr)) s['mask-repeat'] = mr;
    } }
    if (cs.boxShadow !== 'none') s['box-shadow'] = colorsIn(cs.boxShadow);
    if (cs.opacity !== '1') s.opacity = +cs.opacity;
    { const lc = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'); if (lc && lc !== 'none' && parseInt(lc, 10) > 0) s['line-clamp'] = parseInt(lc, 10); }
    if (cs.transform !== 'none') s.transform = cs.transform;
    if (cs.filter !== 'none') s.filter = colorsIn(cs.filter);
    const bdf = cs.backdropFilter || cs.webkitBackdropFilter; if (bdf && bdf !== 'none') s['backdrop-filter'] = bdf;
    if (cs.mixBlendMode !== 'normal') s['mix-blend-mode'] = cs.mixBlendMode;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') s.overflow = cs.overflowX === cs.overflowY ? cs.overflowX : cs.overflowX + ' ' + cs.overflowY;
    if (cs.clipPath && cs.clipPath !== 'none') s['clip-path'] = cs.clipPath.slice(0, 300);
    if (disp.includes('flex')) {
      if (cs.flexDirection !== 'row') s['flex-direction'] = cs.flexDirection;
      if (cs.flexWrap !== 'nowrap') s['flex-wrap'] = cs.flexWrap;
    }
    if (disp.includes('flex') || disp.includes('grid')) {
      if (!['normal', 'flex-start', 'start', 'left'].includes(cs.justifyContent)) s['justify-content'] = cs.justifyContent;
      if (!['normal', 'stretch'].includes(cs.alignItems)) s['align-items'] = cs.alignItems;
      const rg = cs.rowGap === 'normal' ? 0 : pxn(cs.rowGap), cg = cs.columnGap === 'normal' ? 0 : pxn(cs.columnGap);
      if (rg || cg) s.gap = [rg, cg];
    }
    if (disp.includes('grid')) {
      if (cs.gridTemplateColumns !== 'none') s['grid-template-columns'] = cs.gridTemplateColumns.replace(/\[[^\]]*\]\s*/g, '').trim().slice(0, 300);
      if (cs.gridAutoFlow !== 'row') s['grid-auto-flow'] = cs.gridAutoFlow;
      if (cs.justifyItems && !['normal', 'stretch', 'legacy'].includes(cs.justifyItems)) s['justify-items'] = cs.justifyItems;
      if (cs.gridTemplateAreas && cs.gridTemplateAreas !== 'none') s['grid-template-areas'] = cs.gridTemplateAreas.slice(0, 600);
      // computed grid-auto-rows/-columns stay as authored (minmax(190px, auto)); grid-template-rows is resolved to px and is not taken
      if (cs.gridAutoRows && cs.gridAutoRows !== 'auto') s['grid-auto-rows'] = cs.gridAutoRows.slice(0, 200);
      if (cs.gridAutoColumns && cs.gridAutoColumns !== 'auto') s['grid-auto-columns'] = cs.gridAutoColumns.slice(0, 200);
    }
    if (pdisp && (pdisp.includes('flex') || pdisp.includes('grid'))) {
      if (cs.flexGrow !== '0') s['flex-grow'] = +cs.flexGrow;
      if (cs.flexShrink !== '1') s['flex-shrink'] = +cs.flexShrink;
      if (cs.flexBasis !== 'auto') s['flex-basis'] = cs.flexBasis;
      if (cs.alignSelf !== 'auto' && cs.alignSelf !== 'normal') s['align-self'] = cs.alignSelf;
      if (cs.order !== '0') s.order = +cs.order;
      const ga = cs.gridRowStart;
      if (/^[a-z_-][\w-]*$/i.test(ga) && !/^(auto|span)$/i.test(ga) && cs.gridColumnStart === ga && cs.gridRowEnd === ga && cs.gridColumnEnd === ga) s['grid-area'] = ga; // named area (grid-template-areas)
      else {
        const gc = cs.gridColumnStart + ' / ' + cs.gridColumnEnd; if (gc !== 'auto / auto') s['grid-column'] = gc;
        const gr = cs.gridRowStart + ' / ' + cs.gridRowEnd; if (gr !== 'auto / auto') s['grid-row'] = gr;
      }
    }
    if (cs.maxWidth !== 'none') s['max-width'] = lenOrRaw(cs.maxWidth);
    if (cs.minWidth !== 'auto' && cs.minWidth !== '0px') s['min-width'] = lenOrRaw(cs.minWidth);
    if (cs.maxHeight !== 'none') s['max-height'] = lenOrRaw(cs.maxHeight);
    if (cs.minHeight !== 'auto' && cs.minHeight !== '0px') s['min-height'] = lenOrRaw(cs.minHeight);
    if (cs.aspectRatio && cs.aspectRatio !== 'auto' && !cs.aspectRatio.startsWith('auto')) s['aspect-ratio'] = cs.aspectRatio;
    if (t === 'img' || t === 'video') { if (cs.objectFit !== 'fill') s['object-fit'] = cs.objectFit; if (cs.objectPosition !== '50% 50%') s['object-position'] = cs.objectPosition; }
    if ((t === 'ul' || t === 'ol') && cs.listStyleType !== 'none') { s['list-style-type'] = cs.listStyleType; if (cs.listStylePosition !== 'outside') s['list-style-position'] = cs.listStylePosition; }
    const tdl = cs.textDecorationLine;
    if (tdl && tdl !== 'none') {
      s['text-decoration'] = tdl;
      const tdc = toHex(cs.textDecorationColor); if (tdc !== toHex(cs.color)) s['text-decoration-color'] = tdc;
      if (cs.textUnderlineOffset && cs.textUnderlineOffset !== 'auto') s['underline-offset'] = cs.textUnderlineOffset;
    }
    if (cs.transitionDuration && !/^0s(\s*,\s*0s)*$/.test(cs.transitionDuration)) s.transition = [cs.transitionProperty, cs.transitionDuration, cs.transitionTimingFunction, cs.transitionDelay].join(' | ').slice(0, 300);
    if (cs.animationName && cs.animationName !== 'none') s.animation = [cs.animationName, cs.animationDuration, cs.animationTimingFunction, cs.animationIterationCount, cs.animationDelay].join(' | ').slice(0, 200);
    if (cs.outlineStyle !== 'none' && pxn(cs.outlineWidth) > 0) s.outline = cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + toHex(cs.outlineColor);
    const leaf = !el.firstElementChild && !(el.textContent || '').trim();
    if (REPLACED.has(t) || leaf || cs.position === 'absolute' || cs.position === 'fixed' || t === 'input' || t === 'select' || t === 'textarea' || t === 'hr') { s.w = r1(r.width); s.h = r1(r.height); }
    return s;
  }
  function counters(st) {
    const one = (v) => (v && v !== 'none' ? v.replace(/\blist-item\s+-?\d+\s*/g, '').trim() : '');
    const o = {}; const r = one(st.counterReset), i = one(st.counterIncrement), z = one(st.counterSet);
    if (r) o.reset = r.slice(0, 120); if (i) o.inc = i.slice(0, 120); if (z) o.set = z.slice(0, 120);
    return Object.keys(o).length ? o : null;
  }
  function pseudo(el, which) {
    const ps = getComputedStyle(el, which);
    const content = ps.content;
    if (!content || content === 'none' || content === 'normal' || ps.display === 'none') return null;
    const bg = toHex(ps.backgroundColor);
    const hasBox = !isClear(bg) || ps.backgroundImage !== 'none' || pxn(ps.borderTopWidth) > 0 || ps.boxShadow !== 'none';
    const txt = content.replace(/^["']|["']$/g, '');
    const clr = ps.clear && ps.clear !== 'none' ? ps.clear : '';
    if (!hasBox && !txt && !clr) return null;
    const o = { content: content.slice(0, 80), display: ps.display, position: ps.position };
    if (ps.position !== 'static') o.inset = [ps.top, ps.right, ps.bottom, ps.left].map((v) => (v === 'auto' ? 'auto' : lenOrRaw(v)));
    if (ps.width !== 'auto') o.w = lenOrRaw(ps.width);
    if (ps.height !== 'auto') o.h = lenOrRaw(ps.height);
    if (!isClear(bg)) o.bg = bg;
    if (ps.backgroundImage !== 'none') {
      const us = urlsIn(ps.backgroundImage);
      for (const u of us) bgImages.push({ src: u.startsWith('data:') ? u.slice(0, 60000) : abs(u), w: 0, h: 0, size: ps.backgroundSize, pseudo: which });
      o.bgi = colorsInBg(ps.backgroundImage).slice(0, us.length ? 62000 : 1500);
      // a 12px check centred in a 20px tinted box: without size/position/repeat it tiles at its natural size
      if (!/^auto( auto)?$/.test(ps.backgroundSize)) o.bgs = ps.backgroundSize.slice(0, 120);
      if (ps.backgroundPosition && !/^0% 0%$/.test(ps.backgroundPosition)) o.bgp = ps.backgroundPosition.slice(0, 120);
      if (ps.backgroundRepeat && ps.backgroundRepeat !== 'repeat') o.bgr = ps.backgroundRepeat;
    }
    if (pxn(ps.borderTopWidth) > 0) o.border = pxn(ps.borderTopWidth) + 'px ' + ps.borderTopStyle + ' ' + toHex(ps.borderTopColor);
    if (ps.borderTopLeftRadius !== '0px') o.radius = lenOrRaw(ps.borderTopLeftRadius);
    if (ps.boxShadow !== 'none') o.shadow = colorsIn(ps.boxShadow);
    if (ps.opacity !== '1') o.opacity = +ps.opacity;
    if (ps.transform !== 'none') o.transform = ps.transform;
    if (ps.filter !== 'none') o.filter = ps.filter;
    if (clr) o.clear = clr;
    if (ps.position !== 'static' && ps.zIndex !== 'auto') o.z = parseInt(ps.zIndex, 10);
    if (ps.mixBlendMode && ps.mixBlendMode !== 'normal') o.blend = ps.mixBlendMode;
    { const mi = ps.maskImage || ps.webkitMaskImage; if (mi && mi !== 'none') o.mask = colorsInBg(mi).slice(0, 1500); }
    { const fl = ps.cssFloat || ps.float; if (fl && fl !== 'none') o.float = fl; }
    if (txt) {
      o.color = toHex(ps.color); o.fontSize = pxn(ps.fontSize);
      // icon fonts often set the family on the pseudo itself (content: "\f007")
      const ecs = getComputedStyle(el);
      if (ps.fontFamily !== ecs.fontFamily) o.fontFamily = ps.fontFamily.slice(0, 160);
      if (ps.fontWeight !== ecs.fontWeight) o.fontWeight = parseInt(ps.fontWeight, 10) || ps.fontWeight;
      // "+" of a FAQ row set in 26px/1: inheriting the row's 1.6 line-height makes every row taller
      if (ps.lineHeight !== ecs.lineHeight) o.lh = ps.lineHeight === 'normal' ? 'normal' : pxn(ps.lineHeight);
      if (ps.fontStyle !== ecs.fontStyle) o.fontStyle = ps.fontStyle;
      if (ps.textTransform !== ecs.textTransform) o.tt = ps.textTransform;
      if (ps.letterSpacing !== ecs.letterSpacing && ps.letterSpacing !== 'normal') o.ls = pxn(ps.letterSpacing);
    }
    { const m = [ps.marginTop, ps.marginRight, ps.marginBottom, ps.marginLeft].map(pxn); if (m.some(Boolean) && (ps.display !== 'inline' || m[1] || m[3])) o.margin = ps.display === 'inline' ? [0, m[1], 0, m[3]] : m; }
    // a pseudo inside a flex/grid parent is an item: flex: none keeps a 20px check box from shrinking next to long text
    { const c = counters(ps); if (c) o.counters = c; }
    if (ps.position === 'static' || ps.position === 'relative') {
      const pd = getComputedStyle(el).display;
      if (/grid/.test(pd)) {
        // a "01" counter in the first column spanning two rows of a numbered list item
        if (ps.gridColumnStart !== 'auto' || ps.gridColumnEnd !== 'auto') o.gcol = (ps.gridColumnStart + ' / ' + ps.gridColumnEnd).slice(0, 60);
        if (ps.gridRowStart !== 'auto' || ps.gridRowEnd !== 'auto') o.grow = (ps.gridRowStart + ' / ' + ps.gridRowEnd).slice(0, 60);
      }
      if (/flex|grid/.test(pd)) {
        if (/flex/.test(pd) && (ps.flexGrow !== '0' || ps.flexShrink !== '1' || ps.flexBasis !== 'auto')) o.flex = [+ps.flexGrow, +ps.flexShrink, ps.flexBasis];
        if (ps.alignSelf && !['auto', 'normal'].includes(ps.alignSelf)) o.self = ps.alignSelf;
        if (ps.order && ps.order !== '0') o.order = +ps.order;
      }
    }
    return o;
  }

  // ::first-letter (drop caps), ::marker (coloured bullets), ::placeholder (preflight would make it currentColor/50%)
  const TXT_P = [['color', 'color', (v) => toHex(v)], ['fontSize', 'fontSize', pxn], ['fontWeight', 'fontWeight', (v) => parseInt(v, 10) || v], ['fontStyle', 'fontStyle', (v) => v], ['fontFamily', 'fontFamily', (v) => v.slice(0, 160)], ['lineHeight', 'lh', (v) => (v === 'normal' ? v : pxn(v))], ['textTransform', 'tt', (v) => v]];
  function textPseudo(el, which, ecs, extra) {
    let ps; try { ps = getComputedStyle(el, which); } catch (e) { return null; }
    if (!ps || !ps.color) return null;
    const o = {};
    for (const [js, k, f] of TXT_P) if (ps[js] && ps[js] !== ecs[js]) o[k] = f(ps[js]);
    if (extra) extra(ps, o);
    return Object.keys(o).length ? o : null;
  }
  function firstLetter(el, ecs) {
    return textPseudo(el, '::first-letter', ecs, (ps, o) => {
      const fl = ps.cssFloat || ps.float; if (fl && fl !== 'none') o.float = fl;
      const pd = [ps.paddingTop, ps.paddingRight, ps.paddingBottom, ps.paddingLeft].map(pxn); if (pd.some(Boolean)) o.padding = pd;
      const mg = [ps.marginTop, ps.marginRight, ps.marginBottom, ps.marginLeft].map(pxn); if (mg.some(Boolean)) o.margin = mg;
      const bg = toHex(ps.backgroundColor); if (!isClear(bg)) o.bg = bg;
    });
  }

  // ---------- registries ----------
  const svgs = [], svgIdx = new Map(), images = [], media = [], interactive = [];
  const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'g', 'use', 'svg']);
  function svgName(svg) {
    const host = svg.closest('a,button');
    const cls = svg.getAttribute('class') || '';
    const cands = [svg.getAttribute('aria-label'), svg.querySelector('title') && svg.querySelector('title').textContent, svg.getAttribute('data-icon'),
      cls.split(/\s+/).find((c) => /^(lucide|icon|fa|bi|ri|ti|ph|heroicon|tabler|mdi|feather)-/.test(c)),
      host && host.getAttribute('aria-label'), host && (host.innerText || '').trim().length < 30 ? (host.innerText || '').trim() : '',
      svg.parentElement && (svg.parentElement.getAttribute('class') || '').split(/\s+/).find((c) => /icon|logo/i.test(c))];
    let name = cands.find((x) => x && String(x).trim()) || 'icon';
    name = String(name).toLowerCase().replace(/^(lucide|icon|fa|bi|ri|ti|ph|heroicon|tabler|mdi|feather)-/, '').replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'icon';
    const logoHint = /logo|brand/i.test(cls + ' ' + (svg.parentElement ? svg.parentElement.getAttribute('class') || '' : '') + ' ' + (svg.getAttribute('aria-label') || ''));
    const homeLink = svg.closest('a[href="/"], a[href="./"], a[href="' + location.origin + '"], a[href="' + location.origin + '/"]');
    const logo = logoHint || !!(homeLink && svg.closest('header, nav, footer, [role="banner"]'));
    return { name: logo && !/logo/.test(name) ? 'logo' : name, logo };
  }
  function registerSvg(svg, cs, r) {
    try {
      const clone = svg.cloneNode(true);
      const os = [svg, ...svg.querySelectorAll('*')], cl = [clone, ...clone.querySelectorAll('*')];
      const rootColor = cs.color;
      for (let i = 0; i < os.length && i < 3000; i++) {
        const o = os[i], c = cl[i]; if (!c) break;
        const tn = o.tagName.toLowerCase(); if (!SHAPES.has(tn)) continue;
        const ocs = getComputedStyle(o);
        const pcs2 = i === 0 ? null : getComputedStyle(o.parentElement || svg);
        for (const prop of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin']) {
          let v = ocs.getPropertyValue(prop);
          if (!v) continue;
          if (prop === 'opacity' ? v === '1' : (pcs2 && pcs2.getPropertyValue(prop) === v)) continue;
          if (i === 0 && ((prop === 'fill' && v === 'rgb(0, 0, 0)') || (prop === 'stroke' && v === 'none') || (prop === 'stroke-width' && v === '1px') || (/opacity/.test(prop) && v === '1') || (prop === 'stroke-linecap' && v === 'butt') || (prop === 'stroke-linejoin' && v === 'miter'))) continue;
          if (prop === 'fill' || prop === 'stroke') {
            if (v.startsWith('url(')) { const mm = /#([^"')]+)["']?\)/.exec(v); v = mm ? 'url(#' + mm[1] + ')' : v; }
            else if (v !== 'none') v = v === rootColor ? 'currentColor' : (toHex(v) || v);
          }
          if (prop === 'stroke-width') v = String(pxn(v));
          c.setAttribute(prop, v);
        }
      }
      clone.querySelectorAll('use').forEach((u) => {
        const ref = u.getAttribute('href') || u.getAttribute('xlink:href'); if (!ref || ref[0] !== '#') return;
        let sym = null; try { sym = document.querySelector(ref); } catch (e) {}
        if (!sym) return;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        for (const at of ['fill', 'stroke', 'transform']) { const v = u.getAttribute(at); if (v) g.setAttribute(at, v); }
        for (const n of sym.childNodes) g.appendChild(n.cloneNode(true));
        if (!clone.getAttribute('viewBox') && sym.getAttribute('viewBox')) clone.setAttribute('viewBox', sym.getAttribute('viewBox'));
        u.replaceWith(g);
      });
      for (const e of [clone, ...clone.querySelectorAll('*')]) {
        for (const at of [...e.attributes]) { const n = at.name; if (n === 'class' || n.startsWith('data-') || n.startsWith('aria-') || n === 'focusable' || n === 'role' || n === 'tabindex' || /^on/i.test(n)) e.removeAttribute(n); }
      }
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('viewBox') && r.width && r.height) clone.setAttribute('viewBox', '0 0 ' + Math.round(r.width) + ' ' + Math.round(r.height));
      clone.setAttribute('width', String(Math.round(r.width))); clone.setAttribute('height', String(Math.round(r.height)));
      let markup = clone.outerHTML.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
      const big = markup.length > 200000;
      if (big) markup = markup.slice(0, 2000);
      if (svgIdx.has(markup)) { const ix = svgIdx.get(markup); svgs[ix].count++; return ix; }
      const nm = svgName(svg);
      // context label: own/host aria-label or title first, then the first text line of the nearest ancestor with text
      const host = svg.closest('a,button,[role="button"]');
      let label = (svg.getAttribute('aria-label') || (svg.querySelector('title') && svg.querySelector('title').textContent) || (host && (host.getAttribute('aria-label') || host.getAttribute('title'))) || '').trim().slice(0, 60);
      for (let p = svg.parentElement, k = 0; p && k < 4 && !label; p = p.parentElement, k++) { const tx = (p.innerText || '').trim(); if (tx) label = (tx.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '').slice(0, 60); }
      svgs.push({ markup, big, name: nm.name, logo: nm.logo, w: Math.round(r.width), h: Math.round(r.height), color: toHex(cs.color), count: 1, y: Math.round(r.top + sy), label });
      svgIdx.set(markup, svgs.length - 1);
      return svgs.length - 1;
    } catch (e) { return -1; }
  }
  function registerImg(img, cs, r) {
    let src = img.currentSrc || img.src || '';
    const ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || pickSet(img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset'));
    if ((!src || src.startsWith('data:') || /(placeholder|blank|spacer|transparent|lazy)[^/]*\.(gif|png|svg)(\?|$)/i.test(src)) && ds) src = ds;
    if (!src) src = pickSet(img.getAttribute('srcset'));
    const homeLink = img.closest('a[href="/"], a[href="' + location.origin + '/"]');
    images.push({
      src: src.startsWith('data:') ? src.slice(0, 120000) : abs(src), alt: img.getAttribute('alt') || '', nw: img.naturalWidth, nh: img.naturalHeight,
      w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + sy), fit: cs.objectFit,
      logo: /logo|brand/i.test((img.alt || '') + ' ' + (img.getAttribute('class') || '') + ' ' + src) || !!(homeLink && img.closest('header, nav, footer')),
      lazy: img.loading === 'lazy' || img.hasAttribute('data-src') || undefined, pending: !(img.complete && img.naturalWidth) || undefined, srcset: img.getAttribute('srcset') ? img.getAttribute('srcset').slice(0, 1500) : undefined,
    });
    return images.length - 1;
  }
  function registerMedia(el, t, r) {
    const rec = { type: t, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + sx), y: Math.round(r.top + sy) };
    try { el.setAttribute('data-sb-media', String(media.length)); } catch (e) {}
    if (t === 'video') { const so = el.querySelector('source'); rec.src = abs(el.currentSrc || el.src || (so && so.src) || ''); if (el.poster) rec.poster = abs(el.poster); rec.autoplay = el.autoplay; rec.loop = el.loop; rec.muted = el.muted; }
    else if (t === 'iframe') { rec.src = abs(el.src || el.getAttribute('data-src') || ''); rec.title = el.title || ''; }
    else if (t === 'canvas') rec.note = 'canvas/WebGL — рисуется скриптом';
    else rec.src = abs(el.src || el.data || '');
    media.push(rec); return media.length - 1;
  }
  function attrsOf(el, t) {
    const a = {}; const g = (k) => el.getAttribute(k);
    if (t === 'a') { const h = g('href'); if (h != null) a.href = /^(#|mailto:|tel:|javascript:)/i.test(h) ? h : abs(h); if (g('target') === '_blank') a.target = '_blank'; }
    if (g('role')) a.role = g('role');
    if (g('aria-label')) a.label = g('aria-label').slice(0, 120);
    if (g('title') && t !== 'svg') a.title = g('title').slice(0, 120);
    if ((t === 'button' || t === 'input') && g('type')) a.type = g('type');
    if (t === 'input' || t === 'textarea' || t === 'select') {
      if (g('name')) a.name = g('name');
      if (g('placeholder')) a.placeholder = g('placeholder').slice(0, 200);
      if (el.required) a.required = true;
      if (t === 'input' && /submit|button/.test(el.type) && el.value) a.value = el.value;
      if (t === 'input' && /checkbox|radio/.test(el.type) && el.checked) a.checked = true;
      // range/number/date… show their value (the thumb of a range slider sits at it); text-like only when authored in HTML
      if (t === 'input' && /^(range|number|color|date|time|month|week|datetime-local)$/.test(el.type) && el.value) a.value = el.value.slice(0, 60);
      else if (t === 'input' && /^(text|search|email|url|tel)$/.test(el.type) && g('value')) a.value = g('value').slice(0, 200);
      if (t === 'input' && /^(range|number)$/.test(el.type)) for (const k of ['min', 'max', 'step']) if (g(k) != null) a[k] = g(k).slice(0, 20);
      if (t === 'select') a.options = [...el.options].slice(0, 30).map((o) => o.text.trim());
      try { const lab = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label'); if (lab) { const c = lab.cloneNode(true); c.querySelectorAll('select,textarea,input,option,datalist').forEach((x) => x.remove()); const tx = (c.textContent || '').replace(/\s+/g, ' ').trim(); if (tx) a.labelText = tx.slice(0, 160); } } catch (e) {}
    }
    if (t === 'progress' || t === 'meter') { if (g('value') != null) a.value = String(el.value); for (const k of ['max', 'min', 'low', 'high', 'optimum']) if (g(k) != null) a[k] = g(k).slice(0, 20); }
    if (t === 'label' && g('for')) a.for = g('for');
    if ((t === 'td' || t === 'th') && el.colSpan > 1) a.colspan = el.colSpan;
    if ((t === 'td' || t === 'th') && el.rowSpan > 1) a.rowspan = el.rowSpan;
    if (t === 'th' && g('scope')) a.scope = g('scope');
    if (el.disabled === true || g('aria-disabled') === 'true') a.disabled = true;
    for (const [k, nm] of [['selected', 'aria-selected'], ['pressed', 'aria-pressed'], ['current', 'aria-current']]) if (g(nm) != null) a[k] = g(nm).slice(0, 20);
    if (t === 'form') { a.action = g('action') || ''; a.method = (g('method') || 'get').toLowerCase(); }
    if (g('aria-expanded') != null) a.expanded = g('aria-expanded');
    if (t === 'time' && g('datetime')) a.datetime = g('datetime');
    if (t === 'details' && el.open) a.open = true;
    return Object.keys(a).length ? a : null;
  }
  function markInteractive(el, node, t) {
    node.ix = 1;
    el.setAttribute('data-sb-id', String(node.i));
    const role = el.getAttribute('role');
    const kind = role === 'tab' ? 'tab' : t === 'summary' ? 'summary' : el.hasAttribute('aria-expanded') ? 'expand' : (t === 'a' ? 'link' : 'button');
    const area = el.closest('header,[role="banner"]') ? 'header' : el.closest('nav') ? 'nav' : el.closest('footer,[role="contentinfo"]') ? 'footer' : 'main';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    // signature = "looks & hovers the same": tag, own classes, nearest classed ancestor, area and base colours
    let anc = '';
    for (let p = el.parentElement, k = 0; p && k < 4; p = p.parentElement, k++) { const c = (p.getAttribute('class') || '').trim(); if (c) { anc = p.tagName.toLowerCase() + '.' + c.split(/\s+/).slice(0, 3).join('.'); break; } }
    let colors = '';
    try { const cs = getComputedStyle(el); colors = cs.color + '/' + cs.backgroundColor; } catch {}
    interactive.push({ id: node.i, kind, area, tag: t, text, sig: [t, (el.getAttribute('class') || '').slice(0, 160), anc.slice(0, 120), area, colors, el.querySelector('svg') ? 'svg' : ''].join('|'), expanded: el.getAttribute('aria-expanded') });
  }

  // ---------- tree walk ----------
  let count = 0, truncated = false, seq = 0;
  const elNode = new Map();
  function walk(el, pcs, pdisp) {
    const t = el.tagName.toLowerCase();
    if (SKIP.has(t)) return null;
    if (count >= MAX_NODES) { truncated = true; return null; }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return null;
    let fade = false;
    if (cs.opacity === '0') {
      // fade-in content (lazy images, scroll-reveal cards) stays at opacity:0 until loaded / scrolled into view — keep it,
      // otherwise its images and texts are lost. Hover-swap images (a visible image at the same spot) stay hidden.
      const r0 = el.getBoundingClientRect();
      const unloaded = (im) => !(im.complete && im.naturalWidth) || im.hasAttribute('data-src') || im.hasAttribute('data-srcset');
      if (t === 'img') {
        const host = el.parentElement && (el.parentElement.parentElement || el.parentElement);
        const swap = !!host && [...host.querySelectorAll('img')].slice(0, 12).some((im) => { if (im === el) return false; const c2 = getComputedStyle(im); if (c2.opacity === '0' || c2.visibility === 'hidden' || c2.display === 'none') return false; const r2 = im.getBoundingClientRect(); return Math.abs(r2.left - r0.left) < 4 && Math.abs(r2.top - r0.top) < 4 && r2.width > 0; });
        if (!swap) fade = true;
        else if (!(r0.width > 0)) return null;
      } else {
        const flow = cs.position === 'static' || cs.position === 'relative' || cs.position === 'sticky';
        const REVEAL = /(^|[\s_-])(aos|reveal|fade|animate|animated|wow|appear|inview|in-view|scroll|motion|lazy|observe)/i;
        const revealSig = () => REVEAL.test(el.getAttribute('class') || '') || el.hasAttribute('data-aos') || el.hasAttribute('data-animate') || el.hasAttribute('data-scroll') || /opacity:\s*0/.test(el.getAttribute('style') || '');
        const first = (e) => String(e.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
        const sibVisible = () => { const p = el.parentElement; if (!p) return false; let n = 0; for (const sb of p.children) { if (++n > 60) break; if (sb !== el && sb.tagName === el.tagName && first(sb) === first(el) && getComputedStyle(sb).opacity !== '0') return true; } return false; };
        fade = flow && r0.width > 0 && r0.height > 0 && ([...el.querySelectorAll('img')].slice(0, 6).some(unloaded) || revealSig() || sibVisible());
        if (!fade) return null;
      }
    }
    if (cs.display === 'contents') {
      // transparent wrapper: walk children as if they were ours (rare)
    }
    const r = el.getBoundingClientRect();
    const node = { i: seq++, t, n: siblingIndex(el) };
    count++;
    elNode.set(el, node);
    node.r = [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];
    const id = el.getAttribute('id');
    if (id && id.length < 60 && !/^[:«]|^\d|^radix-|^headlessui-|^react-aria|^mantine-|^:r/.test(id)) node.id = id;
    const cls = cleanClasses(el); if (cls) node.c = cls;
    const a = attrsOf(el, t); if (a) node.a = a;
    const s = styleDiff(el, cs, pcs, t, r, pdisp);
    if (fade) { delete s.opacity; node.fade = 1; if (s.transform && /^matrix\(1, 0, 0, 1, [-\d.]+, [-\d.]+\)$/.test(s.transform)) delete s.transform; }
    if (Object.keys(s).length) node.s = s;
    if (r.width <= 1.5 && r.height <= 1.5 && cs.position === 'absolute' && cs.overflow !== 'visible') node.sr = 1;
    if (!LITE) {
      const pb = pseudo(el, '::before'); if (pb) node.pb = pb; const pa = pseudo(el, '::after'); if (pa) node.pa = pa;
      if (/^(block|list-item|table-cell|inline-block|flow-root)$/.test(cs.display) && el.firstChild && el.firstChild.nodeType === 3 && /\S/.test(el.firstChild.nodeValue)) { const fl = firstLetter(el, cs); if (fl) node.fl = fl; }
      if (cs.display === 'list-item') { const mk = textPseudo(el, '::marker', cs); if (mk) node.mk = mk; }
      if ((t === 'input' || t === 'textarea') && el.getAttribute('placeholder')) { try { const pc = toHex(getComputedStyle(el, '::placeholder').color); if (pc) node.ph = pc; } catch (e) {} }
    }
    if (el.matches && el.matches(IX_SEL)) markInteractive(el, node, t);
    if (t === 'svg') { node.svg = LITE ? -1 : registerSvg(el, cs, r); return node; }
    if (t === 'img') { node.img = LITE ? -1 : registerImg(el, cs, r); return node; }
    if (t === 'video' || t === 'iframe' || t === 'canvas' || t === 'audio' || t === 'embed' || t === 'object') { node.m = LITE ? -1 : registerMedia(el, t, r); return node; }
    if (t === 'input' || t === 'select') return node;
    if (t === 'textarea') { if (el.value) node.k = [el.value.slice(0, 500)]; return node; }
    const k = []; let pending = '';
    const pre = /pre/.test(cs.whiteSpace);
    const flush = () => {
      if (!pending) return;
      let tx = pre ? pending.replace(/\uE000/g, '\n') : pending.replace(/[ \t\n\r\f]+/g, ' ').replace(/ ?\uE000 ?/g, '\n');
      // in <pre> a whitespace-only node is content: the "\n" between two highlighted <span>s is the line break
      if (/[^ \t\n\r\f]/.test(tx) || (k.length && tx === ' ') || (pre && tx)) k.push(tx);
      pending = '';
    };
    for (const ch of renderChildren(el)) {
      if (ch.nodeType === 3) pending += ch.nodeValue;
      else if (ch.nodeType === 1) {
        if (ch.tagName === 'BR') { pending += '\uE000'; continue; }
        const kid = walk(ch, cs, cs.display);
        if (kid) { flush(); k.push(kid); }
      }
    }
    flush();
    if (!pre && k.length && typeof k[0] === 'string') { k[0] = k[0].replace(/^[ \t]+/, ''); if (!k[0]) k.shift(); }
    if (!pre && k.length && typeof k[k.length - 1] === 'string') { k[k.length - 1] = k[k.length - 1].replace(/[ \t]+$/, ''); if (!k[k.length - 1]) k.pop(); }
    if (pre && k.length && typeof k[k.length - 1] === 'string' && !/[^ \t\n\r\f]/.test(k[k.length - 1])) k.pop();
    if (k.length) node.k = k;
    const ss = node.s || {};
    const visual = ss['background-color'] || ss['background-image'] || ss['border-width'] || ss['box-shadow'] || node.pb || node.pa || node.ix;
    if (!node.k && !visual && (r.width < 2 || r.height < 2)) { count--; return null; }
    return node;
  }
  const tree = walk(document.body, null, null);

  // ---------- authored CSS: explicit sizes + which media-query breakpoint changes which property ----------
  const ruleStats = { rules: 0, matched: 0, ms: 0, capped: false };
  (function authored() {
    const T0 = Date.now(); const BUDGET = opts.ruleBudgetMs || 1800;
    const STATE = /:(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|enabled|target|placeholder-shown|autofill|invalid|valid|empty|indeterminate|default)\b|::|:-(webkit|moz|ms)-/;
    const SIZE_P = { width: 'w', 'inline-size': 'w', height: 'h', 'block-size': 'h' };
    const INS_P = { top: 't', right: 'r', bottom: 'b', left: 'l', 'inset-block-start': 't', 'inset-block-end': 'b', 'inset-inline-start': 'l', 'inset-inline-end': 'r' };
    // authored :hover rules (cards and other non-link elements are not mouse-probed)
    const HOVER_P = { color: ['color', 'color'], 'background-color': ['bg', 'backgroundColor'], 'box-shadow': ['shadow', 'boxShadow'], transform: ['transform', 'transform'], opacity: ['opacity', 'opacity'], 'border-top-color': ['border', 'borderTopColor'], 'text-decoration-line': ['decoration', 'textDecorationLine'], filter: ['filter', 'filter'] };
    let hvProbe = null;
    const hoverVal = (el, prop, v) => {
      let out = v;
      for (let g = 0; g < 5 && /var\(/.test(out); g++) out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (m0, name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || (fb || '').trim());
      if (!hvProbe) { hvProbe = document.createElement('i'); hvProbe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;display:block;width:10px;height:10px'; document.body.appendChild(hvProbe); }
      const js = HOVER_P[prop][1];
      hvProbe.style[js] = ''; hvProbe.style[js] = out;
      if (!hvProbe.style[js]) return null;
      const cv = getComputedStyle(hvProbe)[js];
      return /color/i.test(js) ? toHex(cv) : cv;
    };
    const PG = (p) => {
      if (p === 'display' || p === 'visibility') return 'display';
      if (p === 'position') return 'position';
      if (/^(top|right|bottom|left|inset)/.test(p)) return 'inset';
      if (p === 'z-index') return 'z';
      if (p === 'flex-direction') return 'flexDir'; if (p === 'flex-wrap') return 'flexWrap';
      if (p === 'justify-content') return 'justify'; if (p === 'align-items') return 'items';
      if (p === 'grid-template-columns') return 'gridCols'; if (p === 'grid-template-areas') return 'gridAreas';
      if (p === 'grid-auto-rows') return 'autoRows'; if (p === 'grid-auto-columns') return 'autoCols'; if (p === 'grid-area') return 'area';
      if (p === 'float') return 'float'; if (p === 'clear') return 'clear'; if (/^counter-/.test(p)) return 'counters'; if (/^(border-collapse|border-spacing|table-layout|caption-side)$/.test(p)) return 'table';
      if (p === 'columns' || /^column-(count|width|rule)/.test(p)) return 'columns'; if (p === 'break-inside') return 'breakInside';
      if (/^(text-overflow|word-break|overflow-wrap|word-wrap|text-wrap)/.test(p)) return 'textWrap'; if (/appearance$/.test(p)) return 'appearance'; if (p === 'accent-color') return 'accent';
      if (p === 'grid-auto-flow') return 'gridFlow';
      if (/^grid-column/.test(p)) return 'colSpan'; if (/^grid-row/.test(p)) return 'rowSpan';
      if (/^flex(-grow|-shrink|-basis)?$/.test(p)) return 'flex';
      if (p === 'align-self') return 'self'; if (p === 'order') return 'order';
      if (SIZE_P[p]) return SIZE_P[p];
      if (p === 'max-width') return 'maxW'; if (p === 'min-width') return 'minW'; if (p === 'max-height') return 'maxH'; if (p === 'min-height') return 'minH';
      if (/^margin/.test(p)) return 'm'; if (/^padding/.test(p)) return 'p';
      if (/gap$/.test(p)) return 'gap';
      if (p === 'font-size' || p === 'line-height') return 'fontSize';
      if (p === 'font-weight') return 'fontWeight'; if (p === 'font-family') return 'fontFamily';
      if (p === 'letter-spacing') return 'tracking'; if (p === 'text-align') return 'textAlign';
      if (p === 'color') return 'textColor'; if (p === 'text-transform') return 'textTransform'; if (p === 'white-space') return 'whitespace';
      if (/^border-.*radius$/.test(p)) return 'rounded';
      if (/^border/.test(p)) return 'border';
      if (p === 'background-color') return 'bg';
      if (/^background/.test(p)) return 'bgImg';
      if (p === 'box-shadow') return 'shadow'; if (p === 'opacity') return 'opacity';
      if (/^overflow/.test(p)) return 'overflow';
      if (/^(transform|translate|scale|rotate)$/.test(p)) return 'transform';
      if (p === 'aspect-ratio') return 'aspect';
      return null;
    };
    const px = (v, u) => (u === 'px' ? +v : +v * 16);
    const thOf = (cond) => {
      const c = String(cond).toLowerCase();
      const mins = [], maxs = [];
      for (const m of c.matchAll(/min-width\s*:\s*([\d.]+)(px|em|rem)/g)) mins.push(px(m[1], m[2]));
      for (const m of c.matchAll(/max-width\s*:\s*([\d.]+)(px|em|rem)/g)) maxs.push(px(m[1], m[2]));
      for (const m of c.matchAll(/(?:^|[(\s])width\s*(>=|>)\s*([\d.]+)(px|em|rem)/g)) mins.push(px(m[2], m[3]));
      for (const m of c.matchAll(/(?:^|[(\s])width\s*(<=|<)\s*([\d.]+)(px|em|rem)/g)) maxs.push(px(m[2], m[3]) - (m[1] === '<' ? 0.5 : 0));
      for (const m of c.matchAll(/([\d.]+)(px|em|rem)\s*(<=|<)\s*width/g)) mins.push(px(m[1], m[2]));
      if (mins.length && maxs.length) return null;
      if (mins.length) return Math.round(Math.max(...mins));
      if (maxs.length) return Math.round(Math.min(...maxs) + 0.5);
      return null;
    };
    const splitSel = (sel) => { const out = []; let d = 0, cur = ''; for (const ch of sel) { if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
    const nodesFor = (sel) => { const parts = splitSel(sel || '').filter((x) => x && !STATE.test(x) && !x.includes('&')); if (!parts.length) return []; try { return document.querySelectorAll(parts.join(',')); } catch (e) { return []; } };
    const visit = (rules, th, active, depth) => {
      for (const rule of rules) {
        if (Date.now() - T0 > BUDGET) { ruleStats.capped = true; return; }
        try {
          if (rule.type === 1) {
            const st = rule.style; if (!st || !st.length) continue;
            if (active && (rule.selectorText || '').includes(':hover')) {
              const decl = {};
              for (let i = 0; i < st.length; i++) { const p = st[i]; if (HOVER_P[p] && !(p in decl)) decl[p] = st.getPropertyValue(p).trim(); }
              if (Object.keys(decl).length) for (const part of splitSel(rule.selectorText)) {
                const ix = part.lastIndexOf(':hover'); if (ix < 0 || /[\s>+~]/.test(part.slice(ix + 6))) continue; // hover on an ancestor -> skip
                const base = part.replace(/:hover/g, '').trim() || '*'; if (STATE.test(base)) continue;
                let els = []; try { els = document.querySelectorAll(base); } catch (e) {}
                let k = 0;
                for (const el of els) { if (k++ > 200) break; const n = elNode.get(el); if (!n) continue; const h = n._hv || (n._hv = {}); for (const [p, v] of Object.entries(decl)) { const val = hoverVal(el, p, v); if (val != null) h[HOVER_P[p][0]] = val; } }
              }
              continue;
            }
            // ::before / ::after rules: which insets and sizes are authored (computed values of positioned pseudos are used px,
            // e.g. a derived "bottom" that differs per card and would split identical cards into variants)
            const selT = rule.selectorText || '';
            if (active && /::?(before|after)\b/.test(selT)) {
              let pins = null;
              for (let i = 0; i < st.length; i++) { const p = st[i]; if (INS_P[p]) (pins = pins || {})[INS_P[p]] = st.getPropertyValue(p).trim(); else if (SIZE_P[p]) (pins = pins || {})[SIZE_P[p]] = st.getPropertyValue(p).trim(); }
              for (const part of splitSel(selT)) {
                const m = /^(.*?)::?(before|after)$/.exec(part.trim()); if (!m) continue;
                const base = m[1].trim() || '*'; if (STATE.test(base) || base.includes('&')) continue;
                let els = []; try { els = document.querySelectorAll(base); } catch (e) {}
                let k = 0; const key = m[2] === 'before' ? '_pib' : '_pia';
                for (const el of els) { if (k++ > 500) break; const n = elNode.get(el); if (!n || !n[m[2] === 'before' ? 'pb' : 'pa']) continue; Object.assign(n[key] || (n[key] = {}), pins || {}); }
              }
              continue;
            }
            let sz = null, grp = null, ins = null, gcv = null;
            for (let i = 0; i < st.length; i++) {
              const p = st[i];
              if (active && p === 'grid-template-columns') gcv = st.getPropertyValue(p).trim() || null;
              if (active && SIZE_P[p]) { const v = st.getPropertyValue(p).trim(); if (v && !/^(auto|initial|unset|inherit|revert|revert-layer|none|normal)$/.test(v)) (sz = sz || {})[SIZE_P[p]] = v; }
              if (active && INS_P[p]) (ins = ins || {})[INS_P[p]] = st.getPropertyValue(p).trim();
              if (th !== null) { const g = PG(p); if (g) (grp = grp || new Set()).add(g); }
            }
            if (!sz && !grp && !ins && !gcv) continue;
            ruleStats.rules++;
            for (const el of nodesFor(rule.selectorText)) {
              const n = elNode.get(el); if (!n) continue;
              ruleStats.matched++;
              if (sz) { if (sz.w) n._aw = sz.w; if (sz.h) n._ah = sz.h; }
              if (ins) Object.assign(n._ai || (n._ai = {}), ins);
              if (gcv) n._agc = gcv;
              if (grp) { const b = n._bq || (n._bq = {}); const cur = b[th] || (b[th] = new Set()); grp.forEach((g) => cur.add(g)); }
            }
          } else if (rule.type === 4) {
            const cond = rule.conditionText || (rule.media && rule.media.mediaText) || '';
            if (/^\s*print\s*$/i.test(cond)) continue;
            const t = thOf(cond); let m = false; try { m = window.matchMedia(cond).matches; } catch (e) {}
            visit(rule.cssRules, t !== null ? t : th, active && m, depth + 1);
          } else if (rule.type === 12) {
            let ok = false; try { ok = CSS.supports(rule.conditionText); } catch (e) {}
            if (ok) visit(rule.cssRules, th, active, depth + 1);
          } else if (rule.type === 3) {
            if (rule.styleSheet && depth < 6) { let ok = true; try { const mt = rule.media && rule.media.mediaText; if (mt) ok = window.matchMedia(mt).matches; } catch (e) {} visit(rule.styleSheet.cssRules, th, active && ok, depth + 1); }
          } else if (rule.cssRules && rule.type !== 7 && typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) visit(rule.cssRules, th, active, depth + 1);
        } catch (e) {}
      }
    };
    const extra = new Map((window.__sbCss || []).map((x) => [x.href, x.text]));
    for (const sh of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      if (Date.now() - T0 > BUDGET) { ruleStats.capped = true; break; }
      let ok = !sh.disabled; try { const mt = sh.media && sh.media.mediaText; if (mt && ok) ok = window.matchMedia(mt).matches; } catch (e) {}
      let rules = null; try { rules = sh.cssRules; } catch (e) {}
      if (!rules && sh.href && extra.has(sh.href)) { try { const c = new CSSStyleSheet(); c.replaceSync(extra.get(sh.href)); rules = c.cssRules; ruleStats.cors = (ruleStats.cors || 0) + 1; } catch (e) {} }
      if (rules) { try { visit(rules, null, ok, 0); } catch (e) {} }
    }
    if (hvProbe) { hvProbe.remove(); hvProbe = null; }
    const NUMPX = /^-?[\d.]+px$/;
    let mfN = 0;
    for (const [el, n] of elNode) {
      // authored insets: computed top/right/bottom/left of positioned elements are used px values even when "auto"
      if (n.s && n.s.inset && !ruleStats.capped) {
        const a = n._ai || {};
        if (el.style) for (const [p, k] of Object.entries(INS_P)) { const v = el.style.getPropertyValue(p); if (v) a[k] = v; }
        n.ai = ['t', 'r', 'b', 'l'].filter((k) => a[k] && !/^(auto|initial|unset|revert|revert-layer)$/.test(a[k])).join('');
        // authored percentages (top: 50% + translate for centering) instead of the px they resolve to at this viewport
        ['t', 'r', 'b', 'l'].forEach((k, i) => { if (/^-?[\d.]+%$/.test(a[k] || '') && typeof n.s.inset[i] === 'number') n.s.inset[i] = a[k]; });
      }
      delete n._ai;
      // authored grid-template-columns (264px minmax(0, 1fr) 224px, repeat(auto-fill, minmax(240px, 1fr))) instead of the
      // resolved px tracks: kept only when it re-resolves to the same tracks on this element (cascade/specificity check)
      if (el.style && el.style.gridTemplateColumns) n._agc = el.style.gridTemplateColumns;
      if (n._agc && n.s && n.s['grid-template-columns'] && !ruleStats.capped) {
        let v = n._agc;
        for (let g = 0; g < 5 && /var\(/.test(v); g++) v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (m0, name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || (fb || '').trim());
        if (v && v.length <= 160 && !/var\(|\[|subgrid|masonry|inherit|initial|unset|revert|none/.test(v)) {
          const prev = el.style.getPropertyValue('grid-template-columns'), pri = el.style.getPropertyPriority('grid-template-columns');
          const before = getComputedStyle(el).gridTemplateColumns;
          try {
            el.style.setProperty('grid-template-columns', v, 'important');
            const after = getComputedStyle(el).gridTemplateColumns;
            const a = before.replace(/\[[^\]]*\]\s*/g, '').trim().split(/\s+/), b = after.replace(/\[[^\]]*\]\s*/g, '').trim().split(/\s+/);
            if (a.length === b.length && a.every((x, i) => Math.abs(parseFloat(x) - parseFloat(b[i])) < 0.6)) n.s.gcv = v.replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ');
          } catch (e) {}
          if (prev) el.style.setProperty('grid-template-columns', prev, pri); else el.style.removeProperty('grid-template-columns');
        }
      }
      delete n._agc;
      for (const [key, pk] of [['_pib', 'pb'], ['_pia', 'pa']]) {
        const ps = n[pk]; const a = n[key]; delete n[key];
        if (!ps || !a || ruleStats.capped) continue;
        const live = (v) => v && !/^(auto|initial|unset|revert|revert-layer)$/.test(v);
        if (ps.inset) ps.inset = ps.inset.map((v, i) => { const av = a['trbl'[i]]; return !live(av) ? 'auto' : /%$/.test(av) ? av : v; });
        if (ps.w !== undefined && !live(a.w)) delete ps.w; else if (ps.w !== undefined && /%$/.test(a.w)) ps.w = a.w;
        if (ps.h !== undefined && !live(a.h)) delete ps.h; else if (ps.h !== undefined && /%$/.test(a.h)) ps.h = a.h;
      }
      if (el.style && (el.style.width || el.style.height)) { if (el.style.width && el.style.width !== 'auto') n._aw = el.style.width; if (el.style.height && el.style.height !== 'auto') n._ah = el.style.height; }
      if (n._aw || n._ah) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'inline' && cs.display !== 'contents') {
          const s = n.s || (n.s = {}); const r = el.getBoundingClientRect();
          n.au = (n._aw ? 'w' : '') + (n._ah ? 'h' : '');
          if (n._aw) {
            if (s.w === undefined) s.w = r1(r.width);
            if (!NUMPX.test(n._aw) && !/var\(/.test(n._aw)) s.wv = n._aw.slice(0, 80);
            else if (NUMPX.test(n._aw)) { // the authored px width is the used one (not overridden): keep px, never "w-full"
              const cw = cs.boxSizing === 'border-box' ? r.width : r.width - pxn(cs.paddingLeft) - pxn(cs.paddingRight) - pxn(cs.borderLeftWidth) - pxn(cs.borderRightWidth);
              if (Math.abs(parseFloat(n._aw) - cw) < 0.6) s.wpx = 1;
            }
          }
          if (n._ah) { if (s.h === undefined) s.h = r1(r.height); if (!NUMPX.test(n._ah) && !/var\(/.test(n._ah)) s.hv = n._ah.slice(0, 80); }
        }
        delete n._aw; delete n._ah;
      }
      // equal side margins of a box centred in its parent: "margin: 0 auto" or fixed ("margin: 0 18px" on an auto-width
      // block)? Computed margins are used px either way, so they are re-resolved as auto: if the box moves or resizes,
      // the margins are fixed (s.mfix) and must not become mx-auto
      if (n.s && n.s.margin && n.r && mfN < 600 && Date.now() - T0 < BUDGET + 1500) {
        const m = n.s.margin; const pn = el.parentElement && elNode.get(el.parentElement);
        if (m[1] > 0 && Math.abs(m[1] - m[3]) <= 1 && pn && pn.r && n.r[2] < pn.r[2] - 2) {
          const pp = (pn.s && pn.s.padding) || [0, 0, 0, 0];
          const lg = n.r[0] - pn.r[0] - pp[3], rg = pn.r[0] + pn.r[2] - (n.r[0] + n.r[2]) - pp[1];
          if (Math.abs(lg - rg) <= 2 && el.style) {
            mfN++;
            const st = el.style; const keep = ['margin-left', 'margin-right'].map((pr) => [pr, st.getPropertyValue(pr), st.getPropertyPriority(pr)]);
            try {
              const a = el.getBoundingClientRect();
              st.setProperty('margin-left', 'auto', 'important'); st.setProperty('margin-right', 'auto', 'important');
              const b = el.getBoundingClientRect();
              if (Math.abs(a.left - b.left) > 1 || Math.abs(a.width - b.width) > 1) n.s.mfix = 1;
            } catch (e) {}
            for (const [pr, v, pri] of keep) { if (v) st.setProperty(pr, v, pri); else st.removeProperty(pr); }
          }
        }
      }
      if (n._bq) { n.bq = Object.entries(n._bq).map(([t, set]) => [+t, [...set].join(',')]); delete n._bq; }
      if (n._hv) { n.hv = n._hv; delete n._hv; }
    }
    ruleStats.ms = Date.now() - T0;
  })();

  // ---------- page-level data ----------
  const rootCS = getComputedStyle(document.documentElement);
  const htmlBg = toHex(rootCS.backgroundColor), bodyBg = toHex(getComputedStyle(document.body).backgroundColor);
  const pageBg = !isClear(bodyBg) ? bodyBg : !isClear(htmlBg) ? htmlBg : '#ffffff';
  const mc = (sel, attr) => { const e = document.querySelector(sel); return e ? (e.getAttribute(attr || 'content') || '').trim() : ''; };
  const meta = {
    title: document.title, lang: document.documentElement.lang || '', description: mc('meta[name="description"]'),
    ogTitle: mc('meta[property="og:title"]'), ogDescription: mc('meta[property="og:description"]'), ogImage: mc('meta[property="og:image"]') ? abs(mc('meta[property="og:image"]')) : '',
    themeColor: mc('meta[name="theme-color"]'), canonical: mc('link[rel="canonical"]', 'href'), generator: mc('meta[name="generator"]'), viewport: mc('meta[name="viewport"]'),
    favicons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')].slice(0, 8).map((l) => ({ rel: l.getAttribute('rel'), href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || '', type: l.getAttribute('type') || '' })),
  };
  const links = [...document.querySelectorAll('a[href]')].slice(0, 3000).map((a) => ({
    href: abs(a.getAttribute('href')), text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    area: a.closest('header,[role="banner"]') ? 'header' : a.closest('nav') ? 'nav' : a.closest('footer,[role="contentinfo"]') ? 'footer' : 'main',
  })).filter((l) => /^https?:/.test(l.href));

  let forms = [], cssVars = {}, fontFaces = [], keyframes = {}, mediaQueries = [], loadedFonts = [], tech = [], html = '', sheets = [], usedChars = '';
  if (!LITE) {
    const labText = (l) => { const c = l.cloneNode(true); c.querySelectorAll('select,textarea,input,option,datalist').forEach((x) => x.remove()); return (c.textContent || '').replace(/\s+/g, ' ').trim(); };
    const fieldLabel = (i) => { try { if (i.id) { const l = document.querySelector('label[for="' + CSS.escape(i.id) + '"]'); if (l) return labText(l); } } catch (e) {} const l2 = i.closest('label'); if (l2) return labText(l2); return i.getAttribute('aria-label') || ''; };
    forms = [...document.querySelectorAll('form')].filter(visibleEl).slice(0, 20).map((f) => {
      const sub = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      return {
        action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'get').toLowerCase(), y: Math.round(f.getBoundingClientRect().top + sy),
        fields: [...f.querySelectorAll('input,textarea,select')].filter((i) => i.type !== 'hidden').slice(0, 40).map((i) => ({ tag: i.tagName.toLowerCase(), type: i.getAttribute('type') || '', name: i.getAttribute('name') || '', placeholder: i.getAttribute('placeholder') || '', label: fieldLabel(i).slice(0, 160), required: i.required || undefined, options: i.tagName === 'SELECT' ? [...i.options].slice(0, 30).map((o) => o.text.trim()) : undefined })),
        submit: sub ? ((sub.innerText || sub.value || '').trim()) : '',
      };
    });
    const names = new Set();
    const ROOTSEL = /(^|,)\s*(:root|html|body|:host|\.dark|\.light|\[data-theme[^\]]*\]|\[data-mode[^\]]*\])\s*(?=,|$)/;
    const scan = (rules, base, depth) => {
      for (const rule of rules) {
        try {
          if (rule.type === 5) fontFaces.push({ family: (rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(), src: (rule.style.getPropertyValue('src') || '').slice(0, 1500), weight: rule.style.getPropertyValue('font-weight') || '400', style: rule.style.getPropertyValue('font-style') || 'normal', display: rule.style.getPropertyValue('font-display') || '', unicodeRange: (rule.style.getPropertyValue('unicode-range') || '').slice(0, 2000), base });
          else if (rule.type === 7) { if (!keyframes[rule.name]) keyframes[rule.name] = rule.cssText.slice(0, 2500); }
          else if (rule.type === 1 && rule.selectorText && ROOTSEL.test(rule.selectorText)) { for (let i = 0; i < rule.style.length; i++) { const p = rule.style[i]; if (p.startsWith('--')) names.add(p); } }
          if (rule.type === 4 && mediaQueries.length < 400) mediaQueries.push(rule.conditionText || (rule.media && rule.media.mediaText) || '');
          if (rule.cssRules && depth < 6) scan(rule.cssRules, base, depth + 1);
        } catch (e) {}
      }
    };
    for (const sh of document.styleSheets) { sheets.push(sh.href || 'inline'); try { scan(sh.cssRules, sh.href || location.href, 0); } catch (e) {} }
    for (const sh of document.adoptedStyleSheets || []) { sheets.push('adopted'); try { scan(sh.cssRules, location.href, 0); } catch (e) {} }
    // fonts created from JS (new FontFace(...)) are in no stylesheet — captured by inpage/hooks.mjs
    try {
      for (const f of (window.__sbFontFaces ? window.__sbFontFaces() : [])) {
        const d = f.descriptors || {};
        if (f.data && f.data.length > 4e6) continue;
        fontFaces.push({ family: f.family, src: f.data ? 'url("' + f.data + '")' : String(f.src || '').slice(0, 1500), weight: d.weight || '400', style: d.style || 'normal', display: d.display || '', unicodeRange: d.unicodeRange || '', base: location.href, js: true, allowData: !!f.data });
      }
    } catch (e) {}
    for (let i = 0; i < rootCS.length; i++) { const p = rootCS[i]; if (p && p.startsWith('--')) names.add(p); }
    for (const n of [...names].slice(0, 900)) {
      const v = rootCS.getPropertyValue(n).trim(); if (!v) continue;
      let hex = null;
      if (CSS.supports('color', v) && !/^(inherit|initial|unset|currentcolor|transparent)$/i.test(v)) hex = toHex(v);
      else if (/^\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(v)) hex = toHex('hsl(' + v + ')');
      cssVars[n] = hex ? { v: v.slice(0, 120), hex } : { v: v.slice(0, 200) };
    }
    try { document.fonts.forEach((f) => { if (f.status === 'loaded') loadedFonts.push({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, unicodeRange: f.unicodeRange && f.unicodeRange !== 'U+0-10FFFF' ? f.unicodeRange.slice(0, 2000) : '' }); }); } catch (e) {}
    try { const set = new Set(); for (const ch of (document.body.innerText || '').slice(0, 300000)) { set.add(ch); if (set.size >= 4000) break; } usedChars = [...set].join(''); } catch (e) {}
    const has = (sel) => { try { return !!document.querySelector(sel); } catch (e) { return false; } };
    const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
    const allSrc = scripts.join(' ') + ' ' + sheets.join(' ');
    if (window.__NEXT_DATA__ || has('#__next') || window.__next_f || /\/_next\//.test(allSrc)) tech.push('Next.js');
    if (window.__NUXT__ || has('#__nuxt') || /\/_nuxt\//.test(allSrc)) tech.push('Nuxt');
    if (has('#___gatsby')) tech.push('Gatsby');
    if (has('[ng-version]')) tech.push('Angular');
    if (has('[data-v-app]') || window.__VUE__) tech.push('Vue');
    if (has('[class*="svelte-"]')) tech.push('Svelte');
    if (has('astro-island')) tech.push('Astro');
    if (has('[data-framer-name]') || /framerusercontent|framer\.com/.test(allSrc)) tech.push('Framer');
    if (has('[data-wf-page]') || /webflow/.test(allSrc)) tech.push('Webflow');
    if (has('.t-records') || /tildacdn|tilda\.ws/.test(allSrc)) tech.push('Tilda');
    if (/wp-content|wp-includes/.test(allSrc)) tech.push('WordPress');
    if (window.Shopify || /cdn\.shopify\.com/.test(allSrc)) tech.push('Shopify');
    if (/wixstatic|parastorage/.test(allSrc)) tech.push('Wix');
    if (has('[data-aos]')) tech.push('AOS (scroll animations)');
    if (window.gsap || window.TweenMax || /gsap/.test(allSrc)) tech.push('GSAP');
    if (has('.swiper, .swiper-container')) tech.push('Swiper slider');
    if (has('.slick-slider')) tech.push('Slick slider');
    if (document.documentElement.classList.contains('lenis') || has('.lenis')) tech.push('Lenis smooth scroll');
    if (has('svg.lucide, [class*="lucide-"]')) tech.push('Lucide icons');
    if (has('.fa, .fas, .far, .fab, [class*="fa-"]')) tech.push('Font Awesome');
    if (has('.material-icons, .material-symbols-outlined, .material-symbols-rounded')) tech.push('Material Icons');
    const sample = [...document.querySelectorAll('[class]')].slice(0, 2000).map((e) => e.getAttribute('class')).join(' ');
    const tw = (sample.match(/(?:^|\s)(?:[a-z]+:)*(?:flex|grid|items-center|justify-between|p[xytrbl]?-\d+(?:\.5)?|m[xytrbl]?-\d+|gap-\d+|text-(?:xs|sm|base|lg|[2-9]?xl)|font-(?:medium|semibold|bold)|rounded(?:-(?:md|lg|xl|2xl|full))?|bg-[a-z]+-\d{2,3}|w-full|max-w-\w+|mx-auto)(?=\s|$)/g) || []).length;
    if (tw > 40 || Object.keys(cssVars).some((k) => k.startsWith('--tw-'))) tech.push('Tailwind CSS');
    {
      const bsCss = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /bootstrap/i.test(l.href || ''));
      const bsJs = !!window.bootstrap || /bootstrap(\.bundle)?(\.min)?\.js/i.test(allSrc);
      const bsGrid = has('.row > [class*="col-sm-"], .row > [class*="col-md-"], .row > [class*="col-lg-"], .row > [class*="col-xl-"]');
      const bsCls = ['.navbar-expand-lg, .navbar-expand-md, .navbar-toggler', '.d-flex.justify-content-between, .d-none.d-md-block, .d-md-flex', '.card-body', '.form-control, .form-select', '.btn-outline-primary, .btn-outline-secondary', '.mb-3, .mt-3, .py-5, .px-4'].filter((q) => has(q)).length;
      if (bsCss || bsJs || bsGrid || bsCls >= 3) tech.push('Bootstrap');
    }
    if (opts.html !== false) {
      try {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script,noscript,template,link[rel="preload"][as="script"],link[rel="modulepreload"],link[rel="prefetch"],link[rel="dns-prefetch"],link[rel="preconnect"]').forEach((n) => n.remove());
        clone.querySelectorAll('iframe').forEach((n) => { if (/googletagmanager|doubleclick|facebook|yandex|metrika|hotjar/i.test(n.getAttribute('src') || '')) n.remove(); });
        for (const n of clone.querySelectorAll('*')) {
          for (const at of [...n.attributes]) {
            const nm = at.name;
            if (/^on/i.test(nm) || nm === 'nonce' || nm === 'integrity' || nm === 'data-sb-id') n.removeAttribute(nm);
            else if ((nm === 'src' || nm === 'href' || nm === 'poster' || nm === 'action') && at.value && !/^(data:|#|mailto:|tel:|javascript:)/i.test(at.value)) { try { n.setAttribute(nm, new URL(at.value, location.href).href); } catch (e) {} }
          }
        }
        html = '<!DOCTYPE html>\n' + clone.outerHTML;
        if (html.length > 6e6) html = html.slice(0, 6e6);
      } catch (e) { html = ''; }
    }
  }

  // ---------- helpers for later probes ----------
  const q = (id) => document.querySelector('[data-sb-id="' + id + '"]');
  const pick = (e) => { const c = getComputedStyle(e); return { color: toHex(c.color), bg: toHex(c.backgroundColor), bgi: c.backgroundImage === 'none' ? '' : colorsIn(c.backgroundImage).slice(0, 300), border: toHex(c.borderTopColor), shadow: c.boxShadow === 'none' ? '' : colorsIn(c.boxShadow), opacity: c.opacity, transform: c.transform === 'none' ? '' : c.transform, decoration: c.textDecorationLine, filter: c.filter === 'none' ? '' : c.filter, scale: c.scale && c.scale !== 'none' ? c.scale : '', translate: c.translate && c.translate !== 'none' ? c.translate : '' }; };
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';

  // ---------- tab-like groups: role="tab" lists + rows of buttons where one is styled as active ----------
  (function tabGroups() {
    const byHost = new Map();
    for (const it of interactive) {
      if (it.kind !== 'button' && it.kind !== 'tab') continue;
      const el = q(it.id); if (!el || !el.parentElement) continue;
      const pe = el.parentElement;
      const host = it.kind === 'tab' ? el.closest('[role="tablist"]') || pe : pe.childElementCount === 1 && pe.parentElement ? pe.parentElement : pe;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push({ it, el });
    }
    const ACTIVE = /(^|[\s_-])(active|selected|current|is-active|is-selected|on)($|[\s_-])/i;
    const stateOn = (e) => e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-selected') === 'true' || (e.hasAttribute('aria-current') && e.getAttribute('aria-current') !== 'false') || /^(active|on|open|checked)$/.test(e.getAttribute('data-state') || '') || e.hasAttribute('data-active') || ACTIVE.test(e.getAttribute('class') || '');
    let gid = 0;
    for (const [host, list] of byHost) {
      if (list.length < 2 || list.length > 16) continue;
      if (list.every((x) => x.it.kind === 'tab')) {
        gid++;
        list.forEach((x) => { x.it.group = 'g' + gid; x.it.active = x.el.getAttribute('aria-selected') === 'true' || stateOn(x.el); });
        continue;
      }
      if (list.length < 3 || list.some((x) => x.it.kind !== 'button' || !x.it.text || x.it.text.length > 40 || x.it.tag !== list[0].it.tag) || host.closest('form')) continue;
      const key = (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.fontWeight, c.borderTopColor, c.boxShadow, c.textDecorationLine].join('|'); };
      const keys = list.map((x) => key(x.el));
      const cnt = new Map(); keys.forEach((k) => cnt.set(k, (cnt.get(k) || 0) + 1));
      let act = list.findIndex((x) => stateOn(x.el));
      if (act < 0 && cnt.size === 2) { const u = keys.findIndex((k) => cnt.get(k) === 1); if (u >= 0 && cnt.get(keys[(u + 1) % keys.length]) === list.length - 1) act = u; }
      if (act < 0) continue;
      gid++;
      list.forEach((x, i) => { x.it.kind = 'tab'; x.it.group = 'g' + gid; x.it.active = i === act; x.it.heur = 1; });
    }
  })();
  let ovSeq = 0;
  window.__sb = {
    hoverState(id) { const el = q(id); if (!el) return null; const kids = [...el.querySelectorAll('svg, img, span, i')].slice(0, 3); const host = el.closest('li') || el.parentElement; return { self: pick(el), kids: kids.map(pick), hostText: host ? (host.innerText || '').trim().slice(0, 3000) : '' }; },
    openDetails() { const out = []; document.querySelectorAll('details').forEach((d) => { const sm = d.querySelector('summary'); d.open = true; const qq = sm ? (sm.innerText || '').trim() : ''; let aa = (d.innerText || '').trim(); if (aa.startsWith(qq)) aa = aa.slice(qq.length).trim(); if (qq || aa) out.push({ q: qq.slice(0, 300), a: aa.slice(0, 3000) }); }); return out; },
    tabPanel(id) { const tab = q(id); if (!tab) return null; const ctl = tab.getAttribute('aria-controls'); let panel = ctl ? document.getElementById(ctl) : null; if (!vis(panel)) { const list = tab.closest('[role="tablist"]'); const scope = (list && list.parentElement) || document; panel = [...scope.querySelectorAll('[role="tabpanel"]')].find(vis) || null; } return { label: (tab.innerText || '').trim().slice(0, 120), text: panel ? (panel.innerText || '').trim().slice(0, 4000) : '' }; },
    expandedText(id) { const el = q(id); if (!el) return null; const ctl = el.getAttribute('aria-controls'); let region = ctl ? document.getElementById(ctl) : null; if (!region) region = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling); const label = (el.innerText || '').trim(); let text = region && vis(region) ? (region.innerText || '').trim() : ''; if (text.startsWith(label)) text = text.slice(label.length).trim(); return { label: label.slice(0, 300), text: text.slice(0, 3000), expanded: el.getAttribute('aria-expanded') }; },
    findBurger() {
      const rx = /menu|burger|hamburger|nav-?toggle|toggle-?nav|navbar-toggler|меню|навигац|open navigation|mobile-nav/i;
      let best = null;
      for (const el of document.querySelectorAll('button, [role="button"], a, label, div[class*="burger" i], div[class*="toggle" i]')) {
        const r = el.getBoundingClientRect(); if (r.width < 14 || r.height < 14 || r.width > 140 || r.top > 170 || r.bottom < 0) continue;
        const c = getComputedStyle(el); if (c.visibility === 'hidden' || c.display === 'none' || c.opacity === '0') continue;
        const txt = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('class'), el.id, el.getAttribute('data-testid'), (el.innerText || '').slice(0, 30)].join(' ');
        const noText = !(el.innerText || '').trim();
        const score = (rx.test(txt) ? 3 : 0) + (el.hasAttribute('aria-expanded') ? 2 : 0) + (noText && el.querySelectorAll('span, i, div').length >= 2 ? 1 : 0) + (noText && el.querySelector('svg') ? 1 : 0) + (r.left > window.innerWidth / 2 ? 1 : 0);
        if (score >= 3 && (!best || score > best.score)) best = { el, score };
      }
      if (!best) return null;
      let id = best.el.getAttribute('data-sb-id'); if (!id) { id = 'burger'; best.el.setAttribute('data-sb-id', id); }
      return id;
    },
    // visible text of the main area — used to diff what a tab / filter click changes
    region(ids) {
      const root = document.querySelector('main') || document.body;
      const lines = new Set(); const heads = [];
      for (const l of (root.innerText || '').split('\n')) { const t = l.trim(); if (t) lines.add(t); if (lines.size > 5000) break; }
      for (const id of ids || []) { const e = q(id); if (e) for (const l of (e.innerText || '').split('\n')) lines.delete(l.trim()); }
      for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
        if (heads.length >= 400) break; if (!vis(h)) continue;
        const t = (h.innerText || '').trim().replace(/\s+/g, ' '); if (t) heads.push(t.slice(0, 120));
      }
      return { lines: [...lines], heads };
    },
    // visible overlays (dialogs, drawers, popups) — diffed before/after a click
    overlays() {
      const out = []; const W = innerWidth, H = innerHeight;
      const cands = new Set(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'));
      let n = 0;
      for (const el of document.body.querySelectorAll('*')) { if (++n > 12000) break; const c = getComputedStyle(el); if (c.position === 'fixed' || (c.position === 'absolute' && (parseInt(c.zIndex, 10) || 0) >= 20)) cands.add(el); }
      for (const el of cands) {
        const c = getComputedStyle(el); if (c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect(); if (r.width < 120 || r.height < 60 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) continue;
        let id = el.getAttribute('data-sb-ov'); if (!id) { id = 'ov' + (++ovSeq); el.setAttribute('data-sb-ov', id); }
        let panel = null;
        for (const d of el.querySelectorAll('*')) {
          const dc = getComputedStyle(d); const bg = toHex(dc.backgroundColor); if (isClear(bg)) continue;
          const dr = d.getBoundingClientRect(); if (dr.width < 100 || dr.height < 60 || dr.width * dr.height > r.width * r.height * 0.9) continue;
          panel = { rect: [Math.round(dr.left), Math.round(dr.top), Math.round(dr.width), Math.round(dr.height)], bg, radius: dc.borderTopLeftRadius, shadow: dc.boxShadow !== 'none' }; break;
        }
        const hd = el.querySelector('h1,h2,h3,h4,[role="heading"]');
        out.push({
          id, role: el.getAttribute('role') || (el.tagName === 'DIALOG' ? 'dialog' : ''), modal: el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG',
          label: (el.getAttribute('aria-label') || (hd ? hd.innerText : '') || '').trim().slice(0, 120), text: (el.innerText || '').trim().slice(0, 3000),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], bg: toHex(c.backgroundColor), radius: c.borderTopLeftRadius, shadow: c.boxShadow !== 'none',
          pos: c.position, z: c.zIndex, blur: c.backdropFilter && c.backdropFilter !== 'none' ? c.backdropFilter : '', panel,
        });
      }
      const elOf = (o) => document.querySelector('[data-sb-ov="' + o.id + '"]');
      return out.filter((o) => !out.some((p) => p !== o && elOf(p) && elOf(o) && elOf(p).contains(elOf(o))));
    },
    // links visible in the viewport ("href|text") — diffed before/after the burger click
    visibleLinks() {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const r = a.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
        if (getComputedStyle(a).visibility === 'hidden') continue;
        out.push(a.href + '|' + (a.innerText || '').trim().replace(/\s+/g, ' '));
        if (out.length > 800) break;
      }
      return out;
    },
    // links of the opened mobile menu + its colours (for <MobileMenu links bg fg>)
    menuLinks(before) {
      const was = new Set(before || []); const out = []; const seen = new Set(); let style = null;
      const roots = [...document.querySelectorAll('[aria-modal="true"], [role="dialog"], nav, [class*="menu" i], [class*="drawer" i], [class*="offcanvas" i], [class*="mobile" i]')].filter((el) => {
        const r = el.getBoundingClientRect(); if (r.width < 100 || r.height < 100 || r.bottom < 0 || r.top > innerHeight) return false;
        const c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && c.opacity !== '0';
      });
      for (const root of roots) {
        for (const a of root.querySelectorAll('a[href]')) {
          const r = a.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
          if (getComputedStyle(a).visibility === 'hidden') continue;
          const text = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
          const key = a.href + '|' + text;
          if (!text || seen.has(key) || was.has(key)) continue;
          seen.add(key); out.push({ href: a.href, text: text.slice(0, 120) });
          if (!style) for (let x = root, d = 0; x && x !== document.documentElement && d < 6; x = x.parentElement, d++) { const bg = toHex(getComputedStyle(x).backgroundColor); if (!isClear(bg)) { style = { bg, color: toHex(getComputedStyle(a).color) }; break; } }
          if (out.length >= 40) break;
        }
        if (out.length >= 40) break;
      }
      return { links: out, style };
    },
    menuText() {
      const seen = []; const parts = [];
      for (const el of document.querySelectorAll('[aria-modal="true"], [role="dialog"], nav, [class*="menu" i], [class*="drawer" i], [class*="offcanvas" i], [class*="mobile" i]')) {
        const r = el.getBoundingClientRect(); if (r.width < 100 || r.height < 100 || r.bottom < 0 || r.top > window.innerHeight) continue;
        const c = getComputedStyle(el); if (c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0') continue;
        const tx = (el.innerText || '').trim(); if (!tx || seen.some((s) => s.includes(tx))) continue;
        seen.push(tx); parts.push(tx.slice(0, 3000)); if (parts.length >= 3) break;
      }
      return parts.join('\n---\n');
    },
  };

  return {
    url: location.href, viewport: { w: VW, h: VH }, docHeight: DOC_H, rootFontSize: parseFloat(rootCS.fontSize) || 16, pageBg, meta, tech,
    cssVars, fontFaces, keyframes, mediaQueries: [...new Set(mediaQueries)].slice(0, 200), loadedFonts, sheets, usedChars,
    tree, svgs, images, bgImages, media, interactive, links, forms, html,
    stats: { nodes: count, truncated, ms: Date.now() - t0, rules: ruleStats },
  };
}
