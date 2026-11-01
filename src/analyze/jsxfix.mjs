// Deterministic JSX repairs for code that was written by hand or by an LLM from the blueprint
// (the generator itself already emits valid JSX): HTML attributes → React props, HTML comments, void tags.
const SVG_ATTRS = ['stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-rule', 'fill-opacity', 'clip-rule', 'clip-path', 'stop-color', 'stop-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'xlink:href', 'xml:space', 'color-interpolation-filters', 'flood-color', 'flood-opacity', 'lighting-color', 'marker-end', 'marker-start', 'paint-order', 'vector-effect'];
const camel = (a) => a.replace(/[:-]([a-z])/g, (m, c) => c.toUpperCase());
const VOID = 'img|br|hr|input|meta|link|source|track|wbr|area|col|embed';

export function fixNesting(src) {
  let s = String(src);
  // <!-- comment --> → {/* comment */}
  s = s.replace(/<!--([\s\S]*?)-->/g, (m, c) => `{/*${c.replace(/\*\//g, '* /')}*/}`);
  // class= / for= → className= / htmlFor=  (only inside a tag head without JS expressions before the attribute)
  s = s.replace(/(<[a-zA-Z][\w.-]*\b[^<>{}]*?)\sclass=(["{])/g, '$1 className=$2');
  s = s.replace(/(<(?:label|output)\b[^<>{}]*?)\sfor=(["{])/g, '$1 htmlFor=$2');
  // kebab-case SVG presentation attributes → camelCase
  const re = new RegExp(`(<[a-zA-Z][\\w.-]*\\b[^<>{}]*?)\\s(${SVG_ATTRS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})=`, 'g');
  for (let k = 0; k < 4; k++) { const n = s.replace(re, (m, pre, attr) => `${pre} ${camel(attr)}=`); if (n === s) break; s = n; }
  // void elements must be self-closed: <img ...> → <img ... />, and </img> / </br> removed
  s = s.replace(new RegExp(`<(${VOID})\\b([^<>{}]*?)(?<!/)>`, 'g'), '<$1$2 />');
  s = s.replace(new RegExp(`</(${VOID})>`, 'g'), '');
  // style="a: b; c: d" → style={{ a: 'b', c: 'd' }}
  s = s.replace(/\sstyle="([^"{}]*)"/g, (m, css) => {
    const parts = css.split(';').map((x) => x.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); if (i < 0) return null; const k = d.slice(0, i).trim(); const v = d.slice(i + 1).trim().replace(/'/g, "\\'"); return k.startsWith('--') ? `'${k}': '${v}'` : `${camel(k)}: '${v}'`; }).filter(Boolean);
    return parts.length ? ` style={{ ${parts.join(', ')} }}` : '';
  });
  return s;
}
