// SVG markup -> clean React (TSX) component code.
const KEEP = new Set(['viewBox', 'preserveAspectRatio', 'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform', 'patternContentUnits', 'maskUnits', 'maskContentUnits', 'clipPathUnits', 'filterUnits', 'primitiveUnits', 'spreadMethod', 'stdDeviation', 'baseFrequency', 'numOctaves', 'tableValues', 'kernelMatrix', 'specularExponent', 'surfaceScale', 'diffuseConstant', 'pathLength', 'textLength', 'lengthAdjust', 'startOffset', 'refX', 'refY', 'markerWidth', 'markerHeight', 'markerUnits', 'xChannelSelector', 'yChannelSelector']);
function styleObj(css) {
  const pairs = css.split(';').map((x) => x.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':'); if (i < 0) return null;
    const k = d.slice(0, i).trim(); const v = d.slice(i + 1).trim();
    const key = k.startsWith('--') ? JSON.stringify(k) : k.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return `${key}: ${JSON.stringify(v)}`;
  }).filter(Boolean);
  return `{ ${pairs.join(', ')} }`;
}
export function prefixIds(markup, prefix) {
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  if (!ids.length) return markup;
  let s = markup;
  for (const id of new Set(ids)) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\sid="${esc}"`, 'g'), ` id="${prefix}-${id}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, 'g'), `url(#${prefix}-${id})`)
      .replace(new RegExp(`(href|xlink:href)="#${esc}"`, 'g'), `$1="#${prefix}-${id}"`);
  }
  return s;
}
export function svgToJsx(markup, idPrefix) {
  let s = idPrefix ? prefixIds(markup, idPrefix) : markup;
  s = s.replace(/<svg\b([^>]*)>/, (m, a) => `<svg${a.replace(/\sxmlns(:xlink)?="[^"]*"/g, '')} {...props}>`);
  s = s.replace(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)=("[^"]*"|'[^']*')/g, (m, name, val) => {
    if (name === 'style') return ` style={${styleObj(val.slice(1, -1))}}`;
    if (name === 'class') return ` className=${val}`;
    if (name.startsWith('data-') || name.startsWith('aria-') || KEEP.has(name)) return m;
    if (name === 'xlink:href') return ` href=${val}`;
    if (name === 'xml:space') return ` xmlSpace=${val}`;
    if (name.startsWith('xmlns')) return '';
    return ' ' + name.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase()) + '=' + val;
  });
  s = s.replace(/<([a-zA-Z][\w:-]*)([^<>]*?)><\/\1>/g, '<$1$2 />');
  s = s.replace(/>([^<]*[{}][^<]*)</g, (m, t) => `>{${JSON.stringify(t)}}<`);
  return s;
}
export function iconComponent(name, jsx, comment) {
  const lines = [];
  if (comment) lines.push(`/** ${comment.replace(/\*\//g, '* /')} */`);
  lines.push(`export function ${name}(props: IconProps) {`, `  return (`, `    ${jsx}`, `  );`, `}`);
  return lines.join('\n');
}

// ---- naming icons by geometry (stroke icons: Lucide/Feather/Heroicons/Tabler…) ----
function polylinesOf(markup) {
  const lines = [];
  for (const m of markup.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)) {
    const d = m[1]; if (/[CcSsQqTtAa]/.test(d)) return null;
    const tk = d.match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
    let cmd = '', x = 0, y = 0, cur = null, sx = 0, sy = 0, i = 0;
    const num = () => parseFloat(tk[i++]);
    while (i < tk.length) {
      if (/^[A-Za-z]$/.test(tk[i])) { cmd = tk[i++]; if (cmd === 'Z' || cmd === 'z') { if (cur) cur.push([sx, sy]); x = sx; y = sy; cur = null; continue; } }
      if (!cmd || i >= tk.length) break;
      if (cmd === 'M' || cmd === 'm') { const nx = num(), ny = num(); x = cmd === 'm' ? x + nx : nx; y = cmd === 'm' ? y + ny : ny; sx = x; sy = y; cur = [[x, y]]; lines.push(cur); cmd = cmd === 'm' ? 'l' : 'L'; continue; }
      if (!cur) { cur = [[x, y]]; lines.push(cur); }
      if (cmd === 'L') { x = num(); y = num(); } else if (cmd === 'l') { x += num(); y += num(); }
      else if (cmd === 'H') x = num(); else if (cmd === 'h') x += num(); else if (cmd === 'V') y = num(); else if (cmd === 'v') y += num();
      else return null;
      if (Number.isNaN(x) || Number.isNaN(y)) return null;
      cur.push([x, y]);
    }
  }
  for (const m of markup.matchAll(/<line\b([^>]*)>/g)) { const a = (k) => parseFloat((new RegExp(`\\s${k}="([^"]+)"`).exec(m[1]) || [])[1]); lines.push([[a('x1'), a('y1')], [a('x2'), a('y2')]]); }
  for (const m of markup.matchAll(/<polyline\b[^>]*\spoints="([^"]+)"/g)) { const n = m[1].trim().split(/[\s,]+/).map(Number); const pts = []; for (let j = 0; j + 1 < n.length; j += 2) pts.push([n[j], n[j + 1]]); lines.push(pts); }
  if (/<(circle|rect|ellipse|polygon)\b/.test(markup.replace(/<rect\b[^>]*fill="none"[^>]*\/>/g, ''))) return null;
  let out = lines.filter((l) => l.length >= 2 && l.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b)));
  // join 2-point strokes that share an endpoint into one polyline (e.g. "M13.5 4.5 21 12m0 0-7.5 7.5")
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) for (let j = i + 1; j < out.length && !changed; j++) {
      const a = out[i], b = out[j]; if (a.length !== 2 || b.length !== 2) continue;
      let m = null;
      if (same(a[1], b[0])) m = [a[0], a[1], b[1]]; else if (same(a[0], b[0])) m = [a[1], a[0], b[1]]; else if (same(a[1], b[1])) m = [a[0], a[1], b[0]]; else if (same(a[0], b[1])) m = [a[1], a[0], b[0]];
      if (m) { out.splice(j, 1); out[i] = m; changed = true; }
    }
  }
  return out;
}
export function guessIconName(markup) {
  const L = polylinesOf(String(markup || ''));
  if (!L || !L.length || L.length > 3) return null;
  const E = 0.75;
  const horiz = (l) => l.length === 2 && Math.abs(l[0][1] - l[1][1]) < E && Math.abs(l[0][0] - l[1][0]) > 3;
  const vert = (l) => l.length === 2 && Math.abs(l[0][0] - l[1][0]) < E && Math.abs(l[0][1] - l[1][1]) > 3;
  const diag = (l) => l.length === 2 && Math.abs(Math.abs(l[0][0] - l[1][0]) - Math.abs(l[0][1] - l[1][1])) < E && Math.abs(l[0][0] - l[1][0]) > 3;
  const chevron = (l) => {
    if (l.length !== 3) return null;
    const [a, b, c] = l;
    if (b[1] > a[1] && b[1] > c[1] && Math.abs(a[1] - c[1]) < E && a[0] < b[0] !== c[0] < b[0]) return 'down';
    if (b[1] < a[1] && b[1] < c[1] && Math.abs(a[1] - c[1]) < E && a[0] < b[0] !== c[0] < b[0]) return 'up';
    if (b[0] > a[0] && b[0] > c[0] && Math.abs(a[0] - c[0]) < E && a[1] < b[1] !== c[1] < b[1]) return 'right';
    if (b[0] < a[0] && b[0] < c[0] && Math.abs(a[0] - c[0]) < E && a[1] < b[1] !== c[1] < b[1]) return 'left';
    const lo = b[1] > a[1] && b[1] > c[1];
    if (lo && Math.min(a[0], c[0]) < b[0] && Math.max(a[0], c[0]) > b[0]) { const right = a[0] > b[0] ? a : c, left = a[0] > b[0] ? c : a; if (right[1] < left[1] - E && (right[0] - b[0]) > (b[0] - left[0])) return 'check'; }
    return null;
  };
  if (L.length === 1) { const ch = chevron(L[0]); if (ch === 'check') return 'Check'; if (ch) return 'Chevron' + ch[0].toUpperCase() + ch.slice(1); if (horiz(L[0])) return 'Minus'; return null; }
  if (L.length === 2) {
    const [p, q] = L;
    for (const [ln, cv] of [[p, q], [q, p]]) { const ch = chevron(cv); if (ch && ch !== 'check' && ((horiz(ln) && (ch === 'right' || ch === 'left')) || (vert(ln) && (ch === 'up' || ch === 'down')))) return 'Arrow' + ch[0].toUpperCase() + ch.slice(1); }
    if (diag(p) && diag(q)) return 'Close';
    if ((horiz(p) && vert(q)) || (vert(p) && horiz(q))) return 'Plus';
    return null;
  }
  if (L.every(horiz)) return 'Menu';
  return null;
}
