import { inc, sortedEntries } from '../util.mjs';

export function analyzeCss(cssFiles, pages) {
  const bp = new Map(); const keyframes = {}; const fontFaces = []; const googleFonts = new Set();
  const addFace = (body, base) => {
    const prop = (k) => { const m = new RegExp('(?:^|;|\\s)' + k + '\\s*:\\s*([^;]+)', 'i').exec(body); return m ? m[1].trim() : ''; };
    const family = prop('font-family').replace(/["']/g, '').trim();
    if (family) fontFaces.push({ family, weight: prop('font-weight') || '400', style: prop('font-style') || 'normal', src: prop('src').slice(0, 1500), base });
  };
  const addMedia = (text) => {
    for (const m of text.matchAll(/\((min|max)-width\s*:\s*([\d.]+)(px|em|rem)\s*\)/gi)) inc(bp, `${m[1].toLowerCase()}:${Math.round(m[3] === 'px' ? +m[2] : +m[2] * 16)}`);
    for (const m of text.matchAll(/\(\s*width\s*(>=|>|<=|<)\s*([\d.]+)(px|em|rem)\s*\)/gi)) inc(bp, `${m[1].startsWith('>') ? 'min' : 'max'}:${Math.round(m[3] === 'px' ? +m[2] : +m[2] * 16)}`);
  };
  for (const { url, text } of cssFiles) {
    try { if (/fonts\.googleapis\.com/.test(url)) for (const f of new URL(url).searchParams.getAll('family')) googleFonts.add(f); } catch {}
    for (const m of text.matchAll(/@media[^{]+\{/g)) addMedia(m[0]);
    for (const m of text.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)) if (!keyframes[m[1]]) keyframes[m[1]] = m[0].slice(0, 2500);
    for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) addFace(m[1], url);
  }
  for (const p of pages) {
    for (const mq of p.mediaQueries || []) addMedia('(' + mq + ')');
    Object.assign(keyframes, Object.fromEntries(Object.entries(p.keyframes || {}).filter(([k]) => !keyframes[k])));
    for (const ff of p.fontFaces || []) fontFaces.push(ff);
    for (const s of p.sheets || []) { try { if (/fonts\.googleapis\.com/.test(s)) for (const f of new URL(s).searchParams.getAll('family')) googleFonts.add(f); } catch {} }
  }
  const seen = new Set();
  const faces = fontFaces.filter((f) => { const k = f.family + '|' + f.weight + '|' + f.style + '|' + (f.src || '').slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
  const breakpoints = sortedEntries(bp).map(([k, count]) => { const [type, px] = k.split(':'); return { type, px: +px, count }; }).filter((b) => b.px >= 320 && b.px <= 2560);
  return { breakpoints, keyframes, fontFaces: faces, googleFonts: [...googleFonts] };
}

export function fontUrlsFromFaces(faces) {
  const out = [];
  for (const f of faces) {
    for (const m of (f.src || '').matchAll(/url\(["']?([^"')]+)["']?\)\s*(?:format\(["']?([\w-]+)["']?\))?/g)) {
      if (m[1].startsWith('data:')) continue;
      try { out.push({ url: new URL(m[1], f.base).href, family: f.family, weight: f.weight, style: f.style, format: m[2] || '' }); } catch {}
    }
  }
  return out;
}
