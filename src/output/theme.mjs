// Stage 3: generates app/globals.css for Tailwind CSS v4 (@import "tailwindcss", @font-face with unicode-range,
// @theme tokens: colors, fonts, shadows, animations & @keyframes, plus @theme static for long/data-URI values).

/** effective (inherited) text style of <body> of a page: { color, 'font-family', 'font-size', 'line-height', … } */
export function bodyStyleOf(p) {
  try { return (p && p.eff && p.raw && p.raw.tree && p.eff.get(p.raw.tree.i)) || null; } catch { return null; }
}
const firstFamilyOf = (stack) => String(stack || '').split(',')[0].replace(/["']/g, '').trim();

export function buildGlobalsCss(site) {
  const t = site.tokens || {};
  const lines = ['@import "tailwindcss";', ''];

  // 1. Long / data-URI CSS custom properties (CssVarRegistry)
  if (site.cssVars && typeof site.cssVars.css === 'function') {
    const varsBlock = site.cssVars.css();
    if (varsBlock) lines.push(varsBlock);
  }

  // 2. @font-face declarations (with unicode-range subsets preserved)
  const fonts = (site.crawl && site.crawl.fonts) || [];
  if (fonts.length) {
    for (const f of fonts) {
      if (!f.web && !f.url) continue;
      const srcUrl = f.web || f.url;
      const ext = (srcUrl.split('?')[0].split('.').pop() || '').toLowerCase();
      const fmt = ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : '';
      lines.push('@font-face {');
      lines.push(`  font-family: "${String(f.family || '').replace(/"/g, '')}";`);
      lines.push(`  src: url("${srcUrl}")${fmt ? ` format("${fmt}")` : ''};`);
      if (f.weight) lines.push(`  font-weight: ${f.weight};`);
      if (f.style && f.style !== 'normal') lines.push(`  font-style: ${f.style};`);
      lines.push(`  font-display: ${f.display || 'swap'};`);
      if (f.unicodeRange) lines.push(`  unicode-range: ${f.unicodeRange};`);
      lines.push('}', '');
    }
  }

  // 3. @theme block (colors, fonts, shadows, animations, keyframes)
  lines.push('@theme {');
  for (const c of t.colors || []) {
    if (c.name && c.hex) lines.push(`  --color-${c.name}: ${c.hex};`);
  }
  for (const [family, key] of Object.entries(t.fontMap || {})) {
    const entry = ((t.fonts && t.fonts.all) || []).find((x) => x.family === family);
    const stack = (entry && entry.stack) || `"${family}", sans-serif`;
    lines.push(`  --font-${key}: ${stack};`);
  }
  for (const s of t.shadows || []) {
    if (s.name && s.value) lines.push(`  --shadow-${s.name}: ${s.value};`);
  }
  if (t. animations && Array.isArray(t.animations)) {
    for (const a of t.animations) {
      if (a.name && a.value) lines.push(`  --animate-${a.name}: ${a.value};`);
    }
  }

  // Keyframes used by components or declared in the site's CSS
  const kfMap = t.keyframes || {};
  const kfKeys = site.keyframesUsed && site.keyframesUsed.size
    ? [...new Set([...site.keyframesUsed, ...Object.keys(kfMap).slice(0, 12)])]
    : Object.keys(kfMap).slice(0, 15);
  for (const k of kfKeys) {
    if (kfMap[k]) {
      lines.push('  ' + String(kfMap[k]).trim().replace(/\n/g, '\n  '));
    }
  }

  // Built-in scroll-reveal / micro-interaction keyframes
  if (!kfMap['sb-fade-up']) {
    lines.push('  @keyframes sb-fade-up { from { opacity: 0; transform: translate3d(0, 24px, 0); } to { opacity: 1; transform: translate3d(0, 0, 0); } }');
  }
  if (!kfMap['sb-fade-in']) {
    lines.push('  @keyframes sb-fade-in { from { opacity: 0; } to { opacity: 1; } }');
  }

  lines.push('}', '');

  // Sections are generated relative to the real computed style of <body> (skeleton: ctx.bodyEff), so body must carry
  // exactly that style — not a statistical "most common text colour" — and also the inherited font-size / line-height
  // (Tailwind preflight would otherwise force line-height 1.5 on every element that inherits it).
  const be = bodyStyleOf(site.home) || {};
  const bodyFont = firstFamilyOf(be['font-family']) || (t.fonts && t.fonts.body && t.fonts.body.family);
  const fg = (/^#[0-9a-f]{3,8}$/i.test(be.color || '') && be.color) || (t.roles && t.roles.foreground) || '#111111';
  const bg = t.pageBg || (t.roles && t.roles.background) || '#ffffff';
  lines.push('body {');
  lines.push(`  background-color: ${bg};`);
  lines.push(`  color: ${fg};`);
  if (bodyFont && t.fontMap && t.fontMap[bodyFont]) {
    lines.push(`  font-family: var(--font-${t.fontMap[bodyFont]});`);
  } else if (be['font-family']) {
    lines.push(`  font-family: ${be['font-family']};`);
  } else if (bodyFont) {
    const stack = (t.fonts.body && t.fonts.body.stack) || `"${bodyFont}", sans-serif`;
    lines.push(`  font-family: ${stack};`);
  }
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  if (num(be['font-size']) && be['font-size'] > 0) lines.push(`  font-size: ${r3(be['font-size'])}px;`);
  if (num(be['line-height']) && be['line-height'] > 0) lines.push(`  line-height: ${r3(be['line-height'])};`);
  else if (be['line-height'] === 'normal') lines.push('  line-height: normal;');
  if (num(be['font-weight']) && be['font-weight'] !== 400) lines.push(`  font-weight: ${be['font-weight']};`);
  if (num(be['letter-spacing']) && be['letter-spacing'] !== 0) lines.push(`  letter-spacing: ${r3(be['letter-spacing'])}em;`);
  if (be['font-style'] && be['font-style'] !== 'normal') lines.push(`  font-style: ${be['font-style']};`);
  if (be['text-transform'] && be['text-transform'] !== 'none') lines.push(`  text-transform: ${be['text-transform']};`);
  if (be['text-align'] && !/^(start|left)$/.test(be['text-align'])) lines.push(`  text-align: ${be['text-align']};`);
  lines.push('  margin: 0;');
  lines.push('}', '');

  return lines.join('\n');
}
