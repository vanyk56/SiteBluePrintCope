import { walkTree, ownText } from './tree.mjs';
import { inc, sortedEntries, parseHex, hsl, contrast, isSaturated, hueName, hueDist, kebab, fmtTransition } from '../util.mjs';

const TW_TEXT = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const firstFamily = (stack) => String(stack || '').split(',')[0].replace(/["']/g, '').trim();

function roleOf(n, parentTag, e) {
  const t = n.t, s = n.s || {};
  if (/^h[1-6]$/.test(t)) return t;
  if (t === 'button' || (t === 'a' && s.padding && (s['background-color'] || s['border-width']))) return 'button';
  if (t === 'a') return n._area === 'header' ? 'nav-link' : n._area === 'footer' ? 'footer-link' : 'link';
  if (t === 'p') return 'body';
  if (t === 'li') return 'list-item';
  if (t === 'small' || t === 'figcaption') return 'small';
  if (t === 'label') return 'label';
  if (t === 'blockquote' || t === 'q') return 'quote';
  if ((t === 'span' || t === 'div') && e['text-transform'] === 'uppercase' && (e['font-size'] || 16) <= 15) return 'eyebrow';
  return null;
}

export function buildTokens(pages, cssInfo) {
  const text = new Map(), bg = new Map(), border = new Map(), btnBg = new Map(), link = new Map(), grads = new Map();
  const fam = new Map(), famStack = new Map(), sizes = new Map(), weights = new Map(), radii = new Map(), shadows = new Map(), spacing = new Map(), maxW = new Map(), trans = new Map(), secPad = new Map();
  const roleStyles = new Map(); const onBg = new Map();
  const pageBgs = new Map();
  for (const p of pages) {
    inc(pageBgs, p.raw.pageBg, 1);
    const eff = p.eff;
    const areaOf = new Map();
    walkTree(p.raw.tree, (n, d, parent) => {
      const pa = parent ? areaOf.get(parent.i) : 'main';
      const area = n.t === 'header' || n.t === 'nav' ? 'header' : n.t === 'footer' ? 'footer' : pa || 'main';
      areaOf.set(n.i, area); n._area = area;
      const s = n.s || {}; const e = eff.get(n.i) || {};
      const own = ownText(n).length;
      if (own) {
        inc(text, e.color, own); inc(fam, firstFamily(e['font-family']), own); famStack.set(firstFamily(e['font-family']), e['font-family']);
        inc(sizes, e['font-size'], own); inc(weights, e['font-weight'], own);
        const role = roleOf(n, parent && parent.t, e);
        if (role) {
          const key = JSON.stringify([firstFamily(e['font-family']), e['font-size'], e['font-weight'], e['line-height'], e['letter-spacing'], e['text-transform'] || 'none', e.color]);
          if (!roleStyles.has(role)) roleStyles.set(role, new Map());
          inc(roleStyles.get(role), key, own);
        }
        if (n.t === 'a') inc(link, e.color, own);
      }
      if (s['background-color']) {
        inc(bg, s['background-color'], Math.min(n.r[2] * n.r[3], 1440 * 1200) / 100);
        if (n.t === 'button' || (n.t === 'a' && s.padding)) { inc(btnBg, s['background-color'], 1); const tc = e.color; if (!onBg.has(s['background-color'])) onBg.set(s['background-color'], new Map()); inc(onBg.get(s['background-color']), tc, 1); }
      }
      if (s['border-width'] && s['border-color']) for (const c of [].concat(s['border-color'])) inc(border, c, 1);
      if (s['background-image'] && s['background-image'].includes('gradient')) inc(grads, s['background-image'], 1);
      if (s.radius) { const r = s.radius; const k = r.every((v) => v === r[0]) ? String(r[0]) : r.join(' '); inc(radii, k, 1); }
      if (s['box-shadow']) inc(shadows, s['box-shadow'], 1);
      for (const v of [...(s.padding || []), ...(s.gap || [])]) if (v > 0 && v < 400) inc(spacing, v, 1);
      if (s.margin) { const [mt, mr, mb, ml] = s.margin; for (const v of [mt, mb]) if (v > 0 && v < 400) inc(spacing, v, 1); if (!(mr === ml && mr > 40)) for (const v of [mr, ml]) if (v > 0 && v < 400) inc(spacing, v, 1); }
      if (typeof s['max-width'] === 'number' && s['max-width'] >= 480 && s['max-width'] <= 2400) inc(maxW, s['max-width'], 1);
      if (s.transition) { const v = fmtTransition(s.transition, { withProps: false }); if (v) inc(trans, v, 1); }
    });
    for (const sec of p.sections) { const pd = sec.node.s && sec.node.s.padding; if (pd && pd[0] >= 24) inc(secPad, pd[0] + '/' + pd[2], 1); }
  }
  const pageBg = sortedEntries(pageBgs)[0]?.[0] || '#ffffff';
  // ---- colors ----
  const score = new Map(); const usage = new Map();
  const norm = (m, w, kind) => { const tot = [...m.values()].reduce((a, b) => a + b, 0) || 1; for (const [c, v] of m) { if (!parseHex(c)) continue; inc(score, c, (v / tot) * w); if (!usage.has(c)) usage.set(c, {}); usage.get(c)[kind] = Math.round((v / tot) * 1000) / 10; } };
  norm(text, 1, 'text'); norm(bg, 1, 'bg'); norm(border, 0.4, 'border'); norm(btnBg, 0.8, 'button'); norm(link, 0.3, 'link');
  inc(score, pageBg, 2);
  const ranked = sortedEntries(score).map(([c]) => c).filter((c) => (parseHex(c)?.a ?? 1) > 0);
  const topOf = (m, pred = () => true) => sortedEntries(m).map(([c]) => c).find((c) => parseHex(c) && pred(c));
  const roles = {};
  roles.background = pageBg;
  const bodyColor = pages[0] && (pages[0].eff.get(pages[0].raw.tree.i) || {}).color;
  const textTot = [...text.values()].reduce((a, b) => a + b, 0) || 1;
  roles.foreground = bodyColor && parseHex(bodyColor) && (text.get(bodyColor) || 0) / textTot >= 0.1 ? bodyColor : topOf(text) || '#000000';
  roles['muted-foreground'] = topOf(text, (c) => c !== roles.foreground && hsl(c).s < 0.3 && contrast(c, pageBg) < contrast(roles.foreground, pageBg) && contrast(c, pageBg) > 1.8);
  roles.surface = topOf(bg, (c) => c !== pageBg && !isSaturated(c) && Math.abs(hsl(c).l - hsl(pageBg).l) < 0.2 && (parseHex(c)?.a ?? 1) > 0.5);
  roles.primary = topOf(btnBg, isSaturated) || topOf(link, isSaturated) || ranked.find(isSaturated);
  if (roles.primary && onBg.has(roles.primary)) roles['primary-foreground'] = topOf(onBg.get(roles.primary));
  roles.accent = roles.primary ? ranked.find((c) => isSaturated(c) && hsl(c).s > 0.45 && hsl(c).l > 0.25 && c !== roles.primary && hueDist(c, roles.primary) > 30) : undefined;
  roles.border = topOf(border);
  // CSS variable names for colors
  const varByHex = new Map();
  for (const p of pages) for (const [k, v] of Object.entries(p.raw.cssVars || {})) if (v.hex && !k.startsWith('--tw-') && !varByHex.has(v.hex)) varByHex.set(v.hex, k);
  const colors = []; const colorMap = {}; const usedNames = new Set();
  const add = (hex, name, role) => {
    if (!hex || colorMap[hex]) return;
    let nm = name; let i = 2; while (usedNames.has(nm)) nm = name + '-' + i++;
    usedNames.add(nm); colorMap[hex] = nm;
    colors.push({ name: nm, hex, role: role || '', usage: usage.get(hex) || {}, cssVar: varByHex.get(hex) || '' });
  };
  for (const [role, hex] of Object.entries(roles)) add(hex, role, role);
  const hueCount = {};
  for (const c of ranked.slice(0, 40)) {
    if (colors.length >= 28) break;
    if (colorMap[c]) continue;
    const v = varByHex.get(c);
    let name = v ? kebab(v.replace(/^--(color-)?/, ''), 30) : null;
    if (!name) { const hn = hueName(c); hueCount[hn] = (hueCount[hn] || 0) + 1; name = hn + '-' + hueCount[hn]; }
    add(c, name, '');
  }
  // ---- typography ----
  const fams = sortedEntries(fam);
  const totalChars = fams.reduce((a, [, v]) => a + v, 0) || 1;
  const typeScale = [];
  const ROLE_ORDER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'eyebrow', 'body', 'link', 'nav-link', 'button', 'list-item', 'label', 'small', 'quote', 'footer-link'];
  for (const role of ROLE_ORDER) {
    const m = roleStyles.get(role); if (!m) continue;
    const [key, cnt] = sortedEntries(m)[0];
    const [family, size, weight, lh, ls, transform, color] = JSON.parse(key);
    typeScale.push({ role, family, size, weight, lineHeight: lh, letterSpacing: ls, transform, color, samples: cnt, variants: m.size });
  }
  const headingFam = typeScale.filter((x) => /^h[1-3]$/.test(x.role)).map((x) => x.family)[0];
  const bodyFam = fams[0] ? fams[0][0] : 'system-ui';
  const fonts = {
    body: { family: bodyFam, stack: famStack.get(bodyFam) || bodyFam },
    heading: headingFam && headingFam !== bodyFam ? { family: headingFam, stack: famStack.get(headingFam) || headingFam } : null,
    mono: fams.map(([f]) => f).find((f) => /mono|code|courier|consolas|menlo/i.test(f)) || null,
    all: fams.slice(0, 8).map(([f, v]) => ({ family: f, stack: famStack.get(f), share: Math.round((v / totalChars) * 1000) / 10 })),
  };
  const fontSizes = sortedEntries(sizes).map(([px, count]) => ({ px: +px, count, tw: TW_TEXT[px] ? 'text-' + TW_TEXT[px] : `text-[${px}px]` })).sort((a, b) => b.px - a.px);
  const fontWeights = sortedEntries(weights).map(([w, count]) => ({ weight: +w || w, count }));
  // ---- spacing / radii / shadows / containers ----
  const spVals = sortedEntries(spacing).slice(0, 24).map(([px, count]) => ({ px: +px, count })).sort((a, b) => a.px - b.px);
  const tot = spVals.reduce((a, b) => a + b.count, 0) || 1;
  const on8 = spVals.filter((v) => v.px % 8 === 0).reduce((a, b) => a + b.count, 0) / tot;
  const on4 = spVals.filter((v) => v.px % 4 === 0).reduce((a, b) => a + b.count, 0) / tot;
  const spacingInfo = { base: on8 > 0.75 ? 8 : on4 > 0.7 ? 4 : null, gridFit: { on4: Math.round(on4 * 100), on8: Math.round(on8 * 100) }, values: spVals };
  const radiiList = sortedEntries(radii).slice(0, 10).map(([value, count]) => ({ value, count }));
  const SHADOW_NAMES = ['subtle', 'card', 'raised', 'float', 'deep', 'xl2'];
  const blurOf = (v) => { const m = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(v); return m ? +m[3] : 0; };
  const shadowList = sortedEntries(shadows).slice(0, 6).map(([value, count]) => ({ value, count })).sort((a, b) => blurOf(a.value) - blurOf(b.value)).map((s, i) => ({ ...s, name: SHADOW_NAMES[i] }));
  const shadowMap = Object.fromEntries(shadowList.map((s) => [s.value, s.name]));
  const containers = sortedEntries(maxW).slice(0, 6).map(([px, count]) => ({ px: +px, count }));
  const transitions = sortedEntries(trans).slice(0, 6).map(([value, count]) => ({ value, count }));
  const gradients = sortedEntries(grads).slice(0, 8).map(([value, count]) => ({ value, count }));
  const sectionPadding = sortedEntries(secPad).slice(0, 5).map(([value, count]) => ({ value, count }));
  // Font tokens for tailwind: sans = body, heading = heading
  const fontMap = { [bodyFam]: 'sans' };
  if (fonts.heading) fontMap[fonts.heading.family] = 'heading';
  if (fonts.mono) fontMap[fonts.mono] = 'mono';
  return {
    pageBg, colors, colorMap, roles, fonts, fontMap, typeScale, fontSizes, fontWeights, spacing: spacingInfo, radii: radiiList,
    shadows: shadowList, shadowMap, containers, transitions, gradients, sectionPadding,
    breakpoints: cssInfo.breakpoints, keyframes: cssInfo.keyframes, fontFaces: cssInfo.fontFaces, googleFonts: cssInfo.googleFonts,
  };
}

export function mainBreakpoint(tokens, desktopW, mobileW) {
  const cands = (tokens.breakpoints || []).filter((b) => b.px > mobileW && b.px <= desktopW);
  if (!cands.length) return { prefix: 'lg', px: 1024 };
  const best = cands.slice().sort((a, b) => b.count - a.count)[0];
  const px = best.type === 'max' ? best.px + 1 : best.px;
  const named = { 640: 'sm', 768: 'md', 1024: 'lg', 1280: 'xl', 1536: '2xl' };
  return { prefix: named[px] || `min-[${px}px]`, px };
}
