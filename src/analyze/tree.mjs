export const kids = (n) => (n && n.k ? n.k.filter((k) => typeof k === 'object') : []);
const BLOCK_TAGS = /^(div|p|h[1-6]|li|ul|ol|section|article|header|footer|nav|main|aside|blockquote|figure|figcaption|form|table|tr|td|th|dd|dt|dl|details|summary|label|button)$/;

export function walkTree(n, fn, depth = 0, parent = null) {
  if (!n) return;
  if (fn(n, depth, parent) === false) return;
  if (n.k) for (const k of n.k) if (typeof k === 'object') walkTree(k, fn, depth + 1, n);
}
export function indexTree(root) {
  const byId = new Map(), parent = new Map();
  walkTree(root, (n, d, p) => { byId.set(n.i, n); if (p) parent.set(n.i, p); });
  return { byId, parent };
}
export function ownText(n) { return n && n.k ? n.k.filter((k) => typeof k === 'string').join('').trim() : ''; }
export function textOf(n, max = 1e6) {
  let out = '';
  (function rec(x) {
    if (!x.k) return;
    for (const k of x.k) {
      if (out.length > max) return;
      if (typeof k === 'string') out += k;
      else if (k.t !== 'svg' && k.t !== 'img' && !k.sr) { if (k.t === 'input' && k.a && k.a.value) out += ' ' + k.a.value + ' '; rec(k); if (BLOCK_TAGS.test(k.t)) out += ' '; }
    }
  })(n);
  return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, max);
}
const INH_KEYS = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'text-shadow', '-webkit-text-fill-color', 'cursor'];
export function computeEffective(root) {
  const eff = new Map();
  (function rec(n, pe) {
    let e = pe;
    if (n.s && INH_KEYS.some((k) => n.s[k] !== undefined)) { e = { ...pe }; for (const k of INH_KEYS) if (n.s[k] !== undefined) e[k] = n.s[k]; }
    eff.set(n.i, e);
    if (n.k) for (const k of n.k) if (typeof k === 'object') rec(k, e);
  })(root, {});
  return eff;
}
// effective background (nearest ancestor with background-color)
export function effectiveBg(n, parentMap, fallback) {
  let x = n;
  while (x) { if (x.s && x.s['background-color']) return x.s['background-color']; x = parentMap.get(x.i); }
  return fallback;
}
// path key used to match the same DOM node between desktop and mobile trees
export function pathMap(root) {
  const m = new Map();
  (function rec(n, p) { const key = p + '/' + n.t + ':' + n.n; m.set(key, n); n._p = key; if (n.k) for (const k of n.k) if (typeof k === 'object') rec(k, key); })(root, '');
  return m;
}
