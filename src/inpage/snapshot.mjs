/* SingleFile-style page serializer. Runs INSIDE the page: page.evaluate(snapshotPage, opts) or in the extension.
 * Must stay self-contained (no outer references). Produces one self-sufficient HTML document of the CURRENT state:
 *   - every stylesheet inlined from the CSSOM (so CSS-in-JS insertRule / constructable adoptedStyleSheets survive),
 *     cross-origin sheets from window.__sbCss (text captured by the crawler), url(...) made absolute
 *   - shadow DOM (open + closed via window.__sbShadowOf) as declarative <template shadowrootmode>
 *   - canvas / WebGL → background snapshot (data: URL), current form state (no passwords / hidden tokens)
 *   - lazy images resolved (currentSrc / data-src), srcset collapsed to the rendered candidate
 *   - same-origin iframes → srcdoc, fonts created from JS (window.__sbFontFaces) → @font-face
 *   - no scripts, no inline handlers, no javascript: URLs, no preload hints, no <base>/CSP/refresh meta
 * Resource and link URLs are emitted as placeholders __SBRES_<ctx><n>__ (ctx A = attribute, C = raw CSS) — the Node
 * side maps them to downloaded local files (or back to absolute URLs) and relinks crawled pages to each other. */
export function snapshotPage(opts = {}) {
  const t0 = Date.now();
  const MAX = opts.maxBytes || 40e6;
  const FRAME_DEPTH = opts.frameDepth ?? 2;
  const res = []; const resIdx = new Map();
  const stats = { nodes: 0, shadowRoots: 0, closedShadowRoots: 0, canvases: 0, adoptedSheets: 0, cssomSheets: 0, inlinedSheets: 0, externalSheets: 0, frames: 0, jsFonts: 0, formFields: 0, truncated: false };
  let BASE = document.baseURI; let size = 0;
  const ref = (u, kind, ctx) => {
    let i = resIdx.get(u);
    if (i === undefined) { i = res.length; res.push({ url: u, kind }); resIdx.set(u, i); }
    else if (kind === 'fonts') res[i].kind = 'fonts';
    return `__SBRES_${ctx}${i}__`;
  };
  const abs = (u, base) => { try { return new URL(u, base || BASE).href; } catch (e) { return null; } };
  const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const escT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i;
  const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/g;
  const cssUrls = (css, base, ctx, font) => String(css || '').replace(URL_RE, (m, a, b, c) => {
    const raw = (a ?? b ?? c ?? '').replace(/\\(.)/g, '$1').trim();
    if (!raw || /^(data:|#|about:|blob:)/i.test(raw)) return m;
    const u = abs(raw, base); if (!u || !/^https?:/i.test(u)) return m;
    return `url("${ref(u, font || FONT_EXT.test(u) ? 'fonts' : 'images', ctx)}")`;
  });
  // undefined custom elements stay undefined without scripts — do not let :not(:defined) hide them
  const guardCss = (s) => String(s || '').replace(/:not\(\s*:defined\s*\)/g, ':not(*)').replace(/<\/(style)/gi, '<\\/$1');

  // ---------- stylesheets ----------
  const extra = new Map((window.__sbCss || []).map((x) => [x.href, x.text]));
  function rulesText(rules, base, depth) {
    let out = '';
    for (const r of rules) {
      try {
        if (r.type === 3) { // @import → inline the imported sheet
          const media = r.media && r.media.mediaText;
          const inner = r.styleSheet ? sheetText(r.styleSheet, depth + 1) : null;
          if (inner) out += media && media !== 'all' ? `@media ${media}{\n${inner}\n}\n` : inner + '\n';
          else if (r.href) { const u = abs(r.href, base); if (u) out += `@import url("${u}")${media ? ' ' + media : ''};\n`; }
          continue;
        }
        out += cssUrls(r.cssText, base, 'C', r.type === 5) + '\n';
      } catch (e) {}
    }
    return out;
  }
  function sheetText(sh, depth = 0) {
    if (!sh || depth > 8) return null;
    const base = sh.href || BASE;
    let rules = null; try { rules = sh.cssRules; } catch (e) {}
    if (rules) return rulesText(rules, base, depth);
    const t = sh.href ? extra.get(sh.href) : null;
    if (t) { try { const c = new CSSStyleSheet(); c.replaceSync(t); return rulesText(c.cssRules, base, depth); } catch (e) { return cssUrls(t, base, 'C'); } }
    return null;
  }

  // ---------- attributes ----------
  const NAV_TAGS = new Set(['a', 'area', 'form', 'iframe', 'frame']);
  function urlAttr(el, tag, name, v) {
    const t = String(v).trim();
    if (/^javascript:/i.test(t)) return name === 'href' ? '#' : null;
    if (!t || /^(#|data:|mailto:|tel:|sms:|blob:|about:)/i.test(t)) return v;
    const u = abs(t); if (!u) return v;
    if (!/^https?:/i.test(u)) return u;
    if (tag === 'a' || tag === 'area') return ref(u, 'page', 'A');
    if (NAV_TAGS.has(tag) || name === 'action' || name === 'formaction' || name === 'cite') return u;
    if (tag === 'link') return /icon/i.test(el.getAttribute('rel') || '') ? ref(u, 'icons', 'A') : u;
    if (name === 'poster') return ref(u, 'images', 'A');
    const media = tag === 'video' || tag === 'audio' || (tag === 'source' && el.parentElement && /^(video|audio)$/.test(el.parentElement.localName)) || tag === 'track';
    if (media) return ref(u, 'media', 'A');
    if (tag === 'img' || tag === 'input' || tag === 'image' || name === 'background') return ref(u, 'images', 'A');
    return u;
  }
  const URL_ATTR = new Set(['src', 'href', 'poster', 'action', 'formaction', 'data', 'xlink:href', 'background', 'cite']);
  const SENSITIVE = /pass|card|cc-|cvv|cvc|iban|ssn|token|secret|otp|pin\b/i;
  function attrs(el, tag, over, drop) {
    let out = '';
    for (const a of el.attributes) {
      const name = a.name; const ln = name.toLowerCase();
      if (ln.startsWith('on') || drop.has(ln) || Object.prototype.hasOwnProperty.call(over, ln)) continue;
      let v = a.value;
      if (URL_ATTR.has(ln) && v) { v = urlAttr(el, tag, ln, v); if (v === null) continue; }
      else if (ln === 'style') v = cssUrls(v, BASE, 'A');
      else if (ln === 'srcset' || ln === 'imagesrcset') continue;
      out += ` ${name}="${escA(v)}"`;
    }
    for (const k of Object.keys(over)) { const v = over[k]; if (v === undefined || v === null) continue; out += v === true ? ` ${k}` : ` ${k}="${escA(v)}"`; }
    return out;
  }
  const shadowOf = (el) => {
    try { if (el.shadowRoot) return el.shadowRoot; const w = (el.ownerDocument && el.ownerDocument.defaultView) || window; return w.__sbShadowOf ? w.__sbShadowOf(el) : null; } catch (e) { return null; }
  };

  // ---------- nodes ----------
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW_SKIP = new Set(['script', 'noscript', 'base', 'template']);
  const kids = (p, depth) => { let out = ''; for (let n = p.firstChild; n; n = n.nextSibling) out += node(n, depth); return out; };
  function node(n, depth) {
    if (size > MAX) { stats.truncated = true; return ''; }
    if (n.nodeType === 3) {
      const p = n.parentNode && n.parentNode.localName;
      const s = p === 'style' ? guardCss(n.data) : escT(n.data);
      size += s.length; return s;
    }
    if (n.nodeType !== 1) return '';
    const el = n; const tag = el.localName;
    if (RAW_SKIP.has(tag)) return '';
    stats.nodes++;
    const over = {}; const drop = new Set(['nonce', 'integrity']);
    let inner = null; let prefix = '';
    if (tag === 'meta') {
      const he = (el.getAttribute('http-equiv') || '').toLowerCase();
      if (he === 'content-security-policy' || he === 'refresh' || el.hasAttribute('charset') || he === 'content-type') return '';
    }
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/\b(preload|prefetch|modulepreload|dns-prefetch|preconnect|manifest|prerender|serviceworker|alternate)\b/.test(rel) && !/\bstylesheet\b/.test(rel)) return '';
      if (/\bstylesheet\b/.test(rel)) {
        if (el.disabled || /\balternate\b/.test(rel)) return '';
        const txt = el.sheet ? sheetText(el.sheet) : null;
        if (txt !== null && txt !== undefined) {
          const media = el.getAttribute('media');
          const s = `<style data-sb-href="${escA(el.href)}"${media ? ` media="${escA(media)}"` : ''}>${guardCss(txt)}</style>`;
          size += s.length; stats.inlinedSheets++; return s;
        }
        stats.externalSheets++;
      }
    }
    if (tag === 'style') {
      const txt = el.sheet ? sheetText(el.sheet) : cssUrls(el.textContent || '', BASE, 'C');
      if (el.sheet && !(el.textContent || '').trim()) { try { if (el.sheet.cssRules.length) stats.cssomSheets++; } catch (e) {} }
      const s = `<style${attrs(el, tag, {}, drop)}>${guardCss(txt || '')}</style>`;
      size += s.length; return s;
    }
    if (tag === 'img') {
      let src = el.currentSrc || el.getAttribute('src') || '';
      const lazy = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
      const placeholder = !el.complete || !el.naturalWidth || (/^data:image\/(gif|svg)/i.test(src) && src.length < 500);
      if (lazy && placeholder) src = lazy;
      if (src) { const u = src.startsWith('data:') ? src : abs(src); over.src = u && /^https?:/i.test(u) ? ref(u, 'images', 'A') : u || src; }
      for (const k of ['srcset', 'sizes', 'loading', 'decoding', 'data-src', 'data-srcset', 'data-lazy-src']) drop.add(k);
    }
    if (tag === 'source' && el.parentElement && el.parentElement.localName === 'picture') return '';
    if (tag === 'canvas') {
      try {
        const d = el.toDataURL('image/png');
        if (d && d.length > 200 && d.length < 12e6) {
          stats.canvases++;
          over.style = `${cssUrls(el.getAttribute('style') || '', BASE, 'A').replace(/;?\s*$/, ';')}background:url("${d}") 0 0/100% 100% no-repeat;`;
        }
      } catch (e) {}
    }
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      drop.add('value'); drop.add('checked');
      if (type === 'checkbox' || type === 'radio') { if (el.checked) over.checked = true; }
      else if (type !== 'password' && type !== 'file' && !SENSITIVE.test(`${el.name} ${el.id} ${el.autocomplete}`) && el.value) over.value = el.value;
      stats.formFields++;
    }
    if (tag === 'option') { drop.add('selected'); if (el.selected) over.selected = true; }
    if (tag === 'textarea') { inner = SENSITIVE.test(`${el.name} ${el.id}`) ? '' : escT(el.value || ''); stats.formFields++; }
    if (tag === 'iframe' || tag === 'frame') {
      let doc = null; try { doc = el.contentDocument; } catch (e) {}
      if (doc && doc.documentElement && depth < FRAME_DEPTH && doc.body && doc.body.childNodes.length) {
        try { over.srcdoc = documentHtml(doc, depth + 1); drop.add('src'); stats.frames++; } catch (e) {}
      }
    }
    const sr = shadowOf(el);
    if (sr) {
      stats.shadowRoots++; if (sr.mode === 'closed') stats.closedShadowRoots++;
      let adopted = '';
      try { for (const sh of sr.adoptedStyleSheets || []) { const t = sheetText(sh); if (t) { adopted += `<style data-sb-adopted>${guardCss(t)}</style>`; stats.adoptedSheets++; } } } catch (e) {}
      prefix = `<template shadowrootmode="${sr.mode === 'closed' ? 'closed' : 'open'}"${sr.delegatesFocus ? ' shadowrootdelegatesfocus' : ''}>${kids(sr, depth)}${adopted}</template>`;
    }
    const open = `<${tag}${attrs(el, tag, over, drop)}>`;
    size += open.length;
    if (VOID.has(tag)) return open;
    const body = inner !== null ? inner : kids(el, depth);
    return `${open}${prefix}${body}</${tag}>`;
  }

  function documentHtml(doc, depth) {
    const prev = BASE; BASE = doc.baseURI;
    try {
      const de = doc.documentElement;
      const dt = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ''}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ''}>` : '<!DOCTYPE html>';
      let adopted = '';
      try { for (const sh of doc.adoptedStyleSheets || []) { const t = sheetText(sh); if (t) { adopted += `<style data-sb-adopted>${guardCss(t)}</style>`; stats.adoptedSheets++; } } } catch (e) {}
      let fontsCss = '';
      const w = doc.defaultView || window;
      try {
        for (const f of (w.__sbFontFaces ? w.__sbFontFaces() : [])) {
          const src = f.data ? `url("${f.data}")` : f.src ? cssUrls(f.src, BASE, 'C', true) : '';
          if (!src) continue;
          const d = f.descriptors || {};
          fontsCss += `@font-face{font-family:"${String(f.family).replace(/"/g, '')}";src:${src};${d.weight ? `font-weight:${d.weight};` : ''}${d.style ? `font-style:${d.style};` : ''}${d.stretch ? `font-stretch:${d.stretch};` : ''}${d.unicodeRange ? `unicode-range:${d.unicodeRange};` : ''}font-display:${d.display || 'swap'};}\n`;
          stats.jsFonts++;
        }
      } catch (e) {}
      const meta = `<meta charset="utf-8"><meta name="generator" content="site-blueprint snapshot">${depth === 0 ? `<!-- Snapshot of ${escT(location.href)} · ${new Date().toISOString()} · site-blueprint (scripts removed) -->` : ''}`;
      let out = '';
      let sawHead = false;
      for (let n = de.firstChild; n; n = n.nextSibling) {
        if (n === doc.head) { sawHead = true; out += `<head>${meta}${kids(n, depth)}${fontsCss ? `<style data-sb-fonts>${guardCss(fontsCss)}</style>` : ''}</head>`; }
        else if (n === doc.body) out += `<body${attrs(n, 'body', {}, new Set(['nonce']))}>${kids(n, depth)}${adopted}</body>`;
        else out += node(n, depth);
      }
      if (!sawHead) out = `<head>${meta}</head>` + out;
      return `${dt}\n<html${attrs(de, 'html', {}, new Set(['nonce']))}>${out}</html>`;
    } finally { BASE = prev; }
  }

  const html = documentHtml(document, 0);
  return { html, resources: res, url: location.href, title: document.title, stats: { ...stats, bytes: html.length, ms: Date.now() - t0 } };
}
