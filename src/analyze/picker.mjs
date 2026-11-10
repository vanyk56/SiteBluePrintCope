// Standalone Component Picker & JSX Serializer:
// Converts any extracted DOM subtree (or matched section from a crawl) into a clean, self-contained
// React 19 + Tailwind CSS v4 TypeScript component (.tsx).
import { pascal } from '../util.mjs';

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'source', 'track', 'wbr']);
const INLINE_TAGS = new Set(['span', 'a', 'strong', 'b', 'em', 'i', 'small', 'code', 'label', 'time']);

const TW_SPACE = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3', 14: '3.5',
  16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10', 44: '11', 48: '12',
  56: '14', 64: '16', 80: '20', 96: '24', 112: '28', 128: '32',
};
const TW_TEXT = {
  12: 'text-xs', 14: 'text-sm', 16: 'text-base', 18: 'text-lg', 20: 'text-xl',
  24: 'text-2xl', 30: 'text-3xl', 36: 'text-4xl', 48: 'text-5xl', 60: 'text-6xl', 72: 'text-7xl',
};
const TW_WEIGHT = {
  100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal',
  500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black',
};
const TW_RADIUS = { 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl' };

function spVal(px) {
  const n = Math.round(Number(px) || 0);
  if (n === 0) return null;
  const abs = Math.abs(n);
  const tok = TW_SPACE[abs] || `[${abs}px]`;
  return { neg: n < 0 ? '-' : '', tok };
}

function spCls(prefix, px) {
  const r = spVal(px);
  return r ? `${r.neg}${prefix}-${r.tok}` : '';
}

function boxShorthand(prefix, arr) {
  if (!Array.isArray(arr) || arr.length < 4) return '';
  const [t, r, b, l] = arr.map((x) => Math.round(Number(x) || 0));
  if (!t && !r && !b && !l) return '';
  if (t === r && r === b && b === l) return spCls(prefix, t);
  const out = [];
  if (t === b && l === r) {
    if (t) out.push(spCls(prefix + 'y', t));
    if (l) out.push(spCls(prefix + 'x', l));
    return out.filter(Boolean).join(' ');
  }
  if (t) out.push(spCls(prefix + 't', t));
  if (r) out.push(spCls(prefix + 'r', r));
  if (b) out.push(spCls(prefix + 'b', b));
  if (l) out.push(spCls(prefix + 'l', l));
  return out.filter(Boolean).join(' ');
}

function arb(v) {
  return String(v || '').trim().replace(/\s+/g, '_');
}

export function styleToTailwind(s = {}, tag = 'div', rect = null) {
  const cls = [];
  const disp = s.display;
  if (disp === 'flex' || disp === 'inline-flex' || disp === 'grid' || disp === 'inline-grid' || disp === 'hidden' || disp === 'none') {
    cls.push(disp === 'none' ? 'hidden' : disp);
  } else if (disp === 'block' && INLINE_TAGS.has(tag)) {
    cls.push('block');
  }
  if (s.position && s.position !== 'static') cls.push(s.position);
  if (s['flex-direction'] === 'column') cls.push('flex-col');
  else if (s['flex-direction'] === 'row-reverse') cls.push('flex-row-reverse');
  if (s['flex-wrap'] === 'wrap') cls.push('flex-wrap');
  if (s['justify-content']) {
    const jMap = { center: 'justify-center', 'space-between': 'justify-between', 'space-around': 'justify-around', 'flex-end': 'justify-end', end: 'justify-end', 'flex-start': 'justify-start' };
    if (jMap[s['justify-content']]) cls.push(jMap[s['justify-content']]);
  }
  if (s['align-items']) {
    const aMap = { center: 'items-center', 'flex-start': 'items-start', start: 'items-start', 'flex-end': 'items-end', end: 'items-end', baseline: 'items-baseline', stretch: 'items-stretch' };
    if (aMap[s['align-items']]) cls.push(aMap[s['align-items']]);
  }
  if (s['grid-template-columns']) {
    const tracks = String(s['grid-template-columns']).trim().split(/\s+/).filter(Boolean);
    if (tracks.length >= 1 && tracks.length <= 12 && tracks.every((t) => /px$|fr$/.test(t))) {
      const nums = tracks.map((t) => parseFloat(t));
      if (nums.length > 1 && Math.max(...nums) - Math.min(...nums) <= 4) cls.push(`grid-cols-${nums.length}`);
      else cls.push(`grid-cols-[${arb(s['grid-template-columns'])}]`);
    }
  }
  if (s.gap) {
    if (Array.isArray(s.gap)) {
      const [rg, cg] = s.gap;
      if (rg === cg && rg > 0) cls.push(spCls('gap', rg));
      else {
        if (rg > 0) cls.push(spCls('gap-y', rg));
        if (cg > 0) cls.push(spCls('gap-x', cg));
      }
    } else if (typeof s.gap === 'number' && s.gap > 0) {
      cls.push(spCls('gap', s.gap));
    }
  }
  if (s.padding) cls.push(boxShorthand('p', s.padding));
  if (s.margin) cls.push(boxShorthand('m', s.margin));
  if (s['max-width']) {
    const mw = Number(s['max-width']);
    const mwMap = { 1280: 'max-w-7xl', 1152: 'max-w-6xl', 1024: 'max-w-5xl', 896: 'max-w-4xl', 768: 'max-w-3xl', 672: 'max-w-2xl' };
    cls.push(mwMap[mw] || `max-w-[${ typeof s['max-width'] === 'number' ? s['max-width'] + 'px' : arb(s['max-width']) }]`);
  }
  if (s['background-color'] && s['background-color'] !== 'rgba(0, 0, 0, 0)' && s['background-color'] !== 'transparent' && !/^#[0-9a-f]{6}00$/i.test(s['background-color'])) {
    cls.push(`bg-[${arb(s['background-color'])}]`);
  }
  if (s['background-image'] && s['background-image'] !== 'none') {
    cls.push(`bg-[${arb(s['background-image'])}]`);
  }
  if (s.color) cls.push(`text-[${arb(s.color)}]`);
  if (s['font-size']) {
    const fs = Math.round(Number(s['font-size']) || 0);
    if (fs > 0) cls.push(TW_TEXT[fs] || `text-[${fs}px]`);
  }
  if (s['font-weight']) {
    const fw = Number(s['font-weight']);
    if (fw && fw !== 400 && TW_WEIGHT[fw]) cls.push(TW_WEIGHT[fw]);
  }
  if (s['text-align'] && s['text-align'] !== 'start' && s['text-align'] !== 'left') {
    const ta = { center: 'text-center', right: 'text-right', justify: 'text-justify' }[s['text-align']];
    if (ta) cls.push(ta);
  }
  if (s.radius) {
    const r = Array.isArray(s.radius) ? s.radius[0] : Number(s.radius);
    if (r >= 999) cls.push('rounded-full');
    else if (r > 0) cls.push(TW_RADIUS[r] || `rounded-[${r}px]`);
  }
  if (s['border-width']) {
    const bw = Array.isArray(s['border-width']) ? s['border-width'][0] : Number(s['border-width']);
    if (bw > 0) {
      cls.push(bw === 1 ? 'border' : `border-[${bw}px]`);
      if (s['border-color'] && typeof s['border-color'] === 'string') cls.push(`border-[${arb(s['border-color'])}]`);
    }
  }
  if (s['box-shadow'] && s['box-shadow'] !== 'none') cls.push(`shadow-[${arb(s['box-shadow'])}]`);
  if (s.overflow === 'hidden') cls.push('overflow-hidden');
  if ((tag === 'img' || tag === 'svg') && rect && rect[2] > 0 && rect[3] > 0 && rect[2] <= 240) {
    cls.push(`w-[${Math.round(rect[2])}px]`, `h-[${Math.round(rect[3])}px]`);
  }
  return cls.filter(Boolean).join(' ');
}

function escapeJsx(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

export function nodeToJsx(node, { raw = null, indent = '    ', depth = 0, maxDepth = 18 } = {}) {
  if (!node || depth > maxDepth) return '';
  if (typeof node === 'string') {
    const txt = node.trim();
    return txt ? `${indent}${escapeJsx(txt)}` : '';
  }
  const tag = /^[a-z][a-z0-9]*$/i.test(node.t || 'div') ? node.t.toLowerCase() : 'div';
  const cls = styleToTailwind({ ...(node.s || {}), ...(node.e || {}) }, tag, node.r);
  const attrs = [];
  if (cls) attrs.push(`className="${escapeAttr(cls)}"`);
  if (tag === 'a') attrs.push(`href="${escapeAttr(node.href || '#')}"`);
  if (tag === 'img') {
    const im = raw && raw.images && node.img >= 0 ? raw.images[node.img] : null;
    const src = (im && (im.local || im.src)) || node.src || '/placeholder.svg';
    const alt = (im && im.alt) || node.alt || '';
    attrs.push(`src="${escapeAttr(src)}"`, `alt="${escapeAttr(alt)}"`);
  }
  if (node.ph && (tag === 'input' || tag === 'textarea')) attrs.push(`placeholder="${escapeAttr(node.ph)}"`);
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (VOID_TAGS.has(tag)) return `${indent}<${tag}${attrStr} />`;

  const children = (node.k || [])
    .map((k) => nodeToJsx(k, { raw, indent: indent + '  ', depth: depth + 1, maxDepth }))
    .filter(Boolean);

  if (!children.length) {
    if (node.txt) return `${indent}<${tag}${attrStr}>${escapeJsx(node.txt)}</${tag}>`;
    return `${indent}<${tag}${attrStr} />`;
  }
  if (children.length === 1 && typeof (node.k || [])[0] === 'string' && children[0].length < 80) {
    return `${indent}<${tag}${attrStr}>${children[0].trim()}</${tag}>`;
  }
  return `${indent}<${tag}${attrStr}>\n${children.join('\n')}\n${indent}</${tag}>`;
}

export function renderStandaloneComponent(node, { name = 'PickedSection', raw = null } = {}) {
  const compName = pascal(String(name || 'PickedSection').replace(/([a-z0-9])([A-Z])/g, '$1 $2'), 3) || 'PickedSection';
  const body = nodeToJsx(node, { raw, indent: '    ' }) || '    <div />';
  return `import React from 'react';\n\nexport default function ${compName}() {\n  return (\n${body}\n  );\n}\n`;
}

/**
 * Find a component or section in a built `site` model by query (type, component name, heading substring, or index).
 */
export function pickSiteComponent(site, query = '') {
  if (!site || !site.components || !site.components.length) return null;
  const q = String(query || '').trim().toLowerCase();
  if (!q || q === '0') return site.components[0];
  if (/^\d+$/.test(q)) {
    const idx = Number(q);
    return site.components[idx] || null; // out of range: no silent fallback to another component
  }
  // Match by exact name or type
  let hit = site.components.find((c) => c.name.toLowerCase() === q || c.type.toLowerCase() === q);
  if (hit) return hit;
  // Match by partial name, type, or heading
  hit = site.components.find(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.type.toLowerCase().includes(q) ||
      (c.heading && c.heading.toLowerCase().includes(q))
  );
  return hit || null;
}

/** one line per component: "0  HeroSection  hero  «Heading»" — shown when a query matches nothing */
export function listSiteComponents(site) {
  return ((site && site.components) || []).map((c, i) => `${String(i).padStart(3)}  ${c.name}  [${c.type}]${c.heading ? '  «' + String(c.heading).slice(0, 60) + '»' : ''}`);
}
