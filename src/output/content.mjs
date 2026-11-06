// Stage 4 helper: converts an extracted DOM tree node into exact 1:1 Markdown content for SITE_CLONE_BLUEPRINT.md.
import { kids, textOf } from '../analyze/tree.mjs';

export function treeToMarkdown(root, { linkFor = (h) => ({ href: h }), imgFor = () => null, hidden = {}, max = 30000, headingOffset = 0 } = {}) {
  const lines = [];
  let chars = 0;

  const push = (s) => {
    const t = String(s || '').trim();
    if (!t || chars > max) return;
    lines.push(t);
    chars += t.length + 1;
  };

  function inlineText(n) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    const t = n.t;
    if (t === 'img') {
      const im = imgFor(n);
      if (!im) return '';
      return `![${im.alt || ''}](${im.src || ''})`;
    }
    if (t === 'a' && n.a && n.a.href) {
      const txt = kidsText(n).trim() || n.a.label || n.a.href;
      const L = linkFor(n.a.href);
      return `[${txt}](${L ? L.href : n.a.href})`;
    }
    if (t === 'button') {
      const txt = kidsText(n).trim() || (n.a && n.a.label) || '';
      return txt ? `[${txt}]` : '';
    }
    if (t === 'code') {
      const txt = kidsText(n).trim();
      return txt ? `\`${txt}\`` : '';
    }
    if (t === 'strong' || t === 'b') {
      const txt = kidsText(n).trim();
      return txt ? `**${txt}**` : '';
    }
    if (t === 'em' || t === 'i') {
      const txt = kidsText(n).trim();
      return txt ? `*${txt}*` : '';
    }
    return kidsText(n);
  }

  function kidsText(n) {
    return (n.k || []).map((c) => (typeof c === 'string' ? c : inlineText(c))).join(' ').replace(/[ \t]+/g, ' ');
  }

  function walk(n) {
    if (!n || chars > max) return;
    const t = n.t;
    if (/^h([1-6])$/.test(t)) {
      const lvl = Math.min(6, parseInt(t[1], 10) + headingOffset);
      const txt = kidsText(n).trim();
      if (txt) push(`${'#'.repeat(lvl)} ${txt}`);
      return;
    }
    if (t === 'p') {
      const txt = kidsText(n).trim();
      if (txt) push(txt);
      return;
    }
    if (t === 'blockquote') {
      const txt = kidsText(n).trim();
      if (txt) push(`> ${txt.replace(/\n+/g, '\n> ')}`);
      return;
    }
    if (t === 'li') {
      const txt = kidsText(n).trim();
      if (txt) push(`- ${txt}`);
      return;
    }
    if (t === 'details') {
      const sm = kids(n).find((c) => c.t === 'summary');
      const q = sm ? textOf(sm, 300).trim() : '';
      const a = (hidden.details && q && hidden.details(q)) || '';
      if (q) push(`**${q}**`);
      for (const c of kids(n)) {
        if (c !== sm) walk(c);
      }
      if (a && !lines.some((l) => l.includes(a.slice(0, 40)))) push(a);
      return;
    }
    if (t === 'input' || t === 'textarea' || t === 'select') {
      const A = n.a || {};
      const desc = [A.type || t, A.name ? `name="${A.name}"` : '', A.placeholder ? `«${A.placeholder}»` : '', A.label ? `(${A.label})` : ''].filter(Boolean).join(' ');
      push(`- [поле ${desc}]`);
      return;
    }
    if (t === 'img') {
      const im = imgFor(n);
      if (im && (im.alt || im.src)) push(`![${im.alt || ''}](${im.src || ''})`);
      return;
    }
    if (t === 'a' || t === 'button') {
      const s = inlineText(n).trim();
      if (s) push(s);
      return;
    }
    const ch = n.k || [];
    const hasDirectText = ch.some((c) => typeof c === 'string' && c.trim());
    const hasBlockChild = ch.some((c) => typeof c !== 'string' && /^(div|section|article|ul|ol|dl|table|form|blockquote|details|h[1-6]|p|li|header|footer|nav|main|aside)$/.test(c.t));
    if (hasDirectText && !hasBlockChild) {
      const txt = kidsText(n).trim();
      if (txt) push(txt);
      return;
    }
    for (const c of ch) {
      if (typeof c === 'string') {
        if (c.trim()) push(c.trim());
      } else {
        walk(c);
      }
    }
    if (t === 'article' || t === 'section') lines.push('');
  }

  walk(root);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
