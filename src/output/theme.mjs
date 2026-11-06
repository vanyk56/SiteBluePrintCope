// Stage 3: generates app/globals.css for Tailwind CSS v4 (@import "tailwindcss", @font-face with unicode-range,
// @theme tokens: colors, fonts, shadows, animations & @keyframes, plus @theme static for long/data-URI values).

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

  // 4. Base body styles
  const bodyFont = t.fonts && t.fonts.body && t.fonts.body.family;
  const fg = (t.roles && t.roles.foreground) || '#111111';
  const bg = t.pageBg || (t.roles && t.roles.background) || '#ffffff';
  lines.push('body {');
  lines.push(`  background-color: ${bg};`);
  lines.push(`  color: ${fg};`);
  if (bodyFont) {
    const stack = (t.fonts.body && t.fonts.body.stack) || `"${bodyFont}", sans-serif`;
    lines.push(`  font-family: ${stack};`);
  }
  lines.push('  margin: 0;');
  lines.push('}', '');

  return lines.join('\n');
}
