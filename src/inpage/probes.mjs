/* In-page interaction probes for the browser extension. The Playwright crawler drives the same window.__sb
 * helpers (installed by extractPage) with real mouse events in src/crawl/pageops.mjs; here everything happens
 * inside the page: synthetic pointer/mouse events, Escape, close buttons. Output has the crawler's probe format
 * (tabGroups / expand / details / dialogs / dropdowns), so the analyzer turns it into the same "use client" code.
 * Safety: links to other pages, form submits and window.open are blocked while probing; buttons whose text looks
 * destructive or transactional (delete, logout, pay, checkout, subscribe, send…) are never clicked.
 * Self-contained: serialized with Function.prototype.toString. */
export async function probeStateInPage({ interactive = [], budgetMs = 20000, dialogs = true, maxDialogs = 8, maxExpand = 24, maxGroups = 6, dropdowns = true, maxDropdowns = 10 } = {}) {
  const t0 = Date.now();
  const res = { hover: [], dropdowns: [], tabs: [], tabGroups: [], expand: [], details: [], dialogs: [], source: 'extension', clicks: 0, blocked: 0 };
  const sb = window.__sb;
  if (!sb) return Object.assign(res, { error: 'extractPage() has not run in this page' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (id) => document.querySelector('[data-sb-id="' + id + '"]');
  const over = () => Date.now() - t0 > budgetMs;
  const startHref = location.href.split('#')[0];
  const sx = window.scrollX, sy = window.scrollY;
  const DANGER = /удал|delete|remove|выйти|выход|log ?out|sign ?out|оплат|\bpay\b|buy|купить|заказать|оформить|checkout|подписаться|subscribe|отправить|\bsend\b|submit|сохранить|\bsave\b|принять|accept|отклонить|decline|reject/i;
  const LIKELY = /корзин|cart|bag|меню|menu|фильтр|filter|поиск|search|вайп|wipe|расписан|schedule|подробн|details|info|инфо|войти|login|sign ?in|контакт|contact|заявк|call|видео|video|play|галере|gallery|share|подел/i;

  // ---------- guards: stay on this page ----------
  const guard = (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!a) return;
    let u = null; try { u = new URL(a.getAttribute('href'), location.href); } catch (x) {}
    const tgt = (a.getAttribute('target') || '').toLowerCase();
    if (!u || (tgt && tgt !== '_self') || a.hasAttribute('download') || u.href.split('#')[0] !== startHref) { e.preventDefault(); res.blocked++; }
  };
  const noSubmit = (e) => { e.preventDefault(); res.blocked++; };
  const origOpen = window.open;
  window.addEventListener('click', guard, true);
  window.addEventListener('submit', noSubmit, true);
  try { window.open = function () { res.blocked++; return null; }; } catch (e) {}
  const unguard = () => { window.removeEventListener('click', guard, true); window.removeEventListener('submit', noSubmit, true); try { window.open = origOpen; } catch (e) {} };

  // ---------- synthetic input ----------
  const center = (el) => { const r = el.getBoundingClientRect(); return { clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) }; };
  const fire = (el, type, extra) => {
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: type.endsWith('down') ? 1 : 0 }, extra || {});
    const E = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    if (E === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    try { el.dispatchEvent(new E(type, init)); } catch (e) {}
  };
  const clickable = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const t = el.tagName.toLowerCase();
    if ((t === 'button' || t === 'input') && (el.type || '').toLowerCase() === 'submit' && el.form) return false;
    const a = el.closest('a[href]');
    if (a) { let u = null; try { u = new URL(a.getAttribute('href'), location.href); } catch (e) {} if (!u || u.href.split('#')[0] !== startHref) return false; }
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const press = async (el) => {
    if (!clickable(el)) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
    const c = center(el);
    fire(el, 'pointerover', c); fire(el, 'mouseover', c);
    fire(el, 'pointerdown', c); fire(el, 'mousedown', c);
    try { el.focus({ preventScroll: true }); } catch (e) {}
    fire(el, 'pointerup', c); fire(el, 'mouseup', c);
    try { el.click(); } catch (e) {}
    res.clicks++;
    await sleep(220);
    return location.href.split('#')[0] === startHref;
  };
  const escape = () => {
    for (const t of [document.activeElement, document.body, document]) {
      if (!t) continue;
      try { t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true })); } catch (e) {}
      try { t.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true })); } catch (e) {}
    }
  };
  const clickOutside = () => {
    const el = document.elementFromPoint(5, 5) || document.body; const c = { clientX: 5, clientY: 5 };
    fire(el, 'pointerdown', c); fire(el, 'mousedown', c); fire(el, 'pointerup', c); fire(el, 'mouseup', c); fire(el, 'click', c);
  };

  try {
    // ---------- tab groups (content tabs and category filters) ----------
    const groups = new Map();
    for (const t of interactive.filter((x) => x.kind === 'tab')) { const g = t.group || 'g0'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
    let gn = 0;
    for (const [g, tabs] of groups) {
      if (++gn > maxGroups || over()) break;
      const ids = tabs.map((t) => t.id);
      const base = sb.region(ids);
      if (!base) continue;
      const baseSet = new Set(base.lines);
      const active = tabs.find((t) => t.active) || tabs[0];
      const rec = { group: g, labels: tabs.map((t) => t.text), active: active.text, heuristic: !!active.heur, baseHeads: base.heads.slice(0, 300), items: [] };
      for (const t of tabs.slice(0, 16)) {
        if (over()) break;
        if (t !== active) { if (!(await press(q(t.id)))) break; await sleep(260); }
        const p = sb.tabPanel(t.id);
        const snap = t === active ? base : sb.region(ids);
        if (!snap) continue;
        const now = new Set(snap.lines);
        const added = snap.lines.filter((l) => !baseSet.has(l));
        const removed = base.lines.filter((l) => !now.has(l)).length;
        rec.items.push({ id: t.id, label: (p && p.label) || t.text, active: t === active, panel: p && p.text ? p.text.slice(0, 4000) : '', added: added.join('\n').slice(0, 5000), addedLines: added.length, removed, heads: snap.heads.slice(0, 300) });
      }
      await press(q(active.id)); await sleep(200);
      if (rec.items.some((x) => !x.active && (x.addedLines || x.removed || x.panel))) res.tabGroups.push(rec);
    }

    // ---------- aria-expanded accordions ----------
    for (const x of interactive.filter((i) => i.kind === 'expand' && i.expanded === 'false').slice(0, maxExpand)) {
      if (over()) break;
      const el = q(x.id);
      if (!el || DANGER.test(x.text || '')) continue;
      if (!(await press(el))) break;
      await sleep(150);
      const r = sb.expandedText(x.id);
      if (r && r.text) res.expand.push({ id: x.id, area: x.area, label: r.label || x.text, text: r.text });
      if (el.getAttribute('aria-expanded') === 'true') { await press(el); await sleep(120); }
    }

    // ---------- hover menus (JS mouseenter handlers; CSS :hover menus are read while hidden) ----------
    if (dropdowns) {
      const hosts = []; const seen = new Set();
      for (const nav of document.querySelectorAll('header, nav, [role="navigation"], [role="banner"]')) {
        for (const el of nav.querySelectorAll('li, div, span, button, a')) {
          if (hosts.length >= maxDropdowns) break;
          const r = el.getBoundingClientRect(); if (r.width < 10 || r.height < 10 || r.top > 300) continue;
          const hid = [...el.children].find((c) => { const cs = getComputedStyle(c); return (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') && c.querySelectorAll('a').length >= 2; });
          if (!hid || seen.has(hid)) continue;
          seen.add(hid); hosts.push({ el, menu: hid });
        }
      }
      for (const h of hosts) {
        if (over()) break;
        const c = center(h.el);
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) fire(h.el, t, Object.assign({ bubbles: !t.endsWith('enter') }, c));
        await sleep(180);
        const m = h.menu; const cs = getComputedStyle(m);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && m.getClientRects().length > 0;
        const links = [...m.querySelectorAll('a')].slice(0, 60).map((a) => ({ text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100), href: a.href }));
        res.dropdowns.push({
          label: ((h.el.innerText || '').trim().split('\n')[0] || h.el.getAttribute('aria-label') || '').slice(0, 60),
          text: (visible ? m.innerText : m.textContent || '').trim().replace(/[ \t]+/g, ' ').slice(0, 3000), links,
          style: { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, padding: cs.padding, minWidth: cs.minWidth },
          screenshot: null, visible, opened: visible ? 'js-hover' : 'css-hover (read while hidden)',
        });
        for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) fire(h.el, t, { bubbles: !t.endsWith('leave'), clientX: 1, clientY: 1 });
        await sleep(80);
      }
    }

    // ---------- buttons that open overlays (cart drawer, modal, popup) ----------
    if (dialogs) {
      const sigCount = new Map(); for (const x of interactive) sigCount.set(x.sig, (sigCount.get(x.sig) || 0) + 1);
      const seen = new Set();
      const cands = interactive
        .filter((x) => (x.kind === 'button' || x.kind === 'expand') && x.tag !== 'input' && x.area !== 'footer' && (sigCount.get(x.sig) || 0) <= 2 && !DANGER.test(x.text || ''))
        .filter((x) => { const k = x.sig + '|' + x.text; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (LIKELY.test(b.text || '') ? 1 : 0) - (LIKELY.test(a.text || '') ? 1 : 0))
        .slice(0, maxDialogs);
      const fresh = (was) => sb.overlays().filter((o) => !was.has(o.id));
      for (const it of cands) {
        if (over()) break;
        const el = q(it.id); if (!clickable(el)) continue;
        const was = new Set(sb.overlays().map((o) => o.id));
        if (!(await press(el))) break;
        await sleep(450);
        let now = fresh(was);
        if (now.length) {
          const W = innerWidth, H = innerHeight;
          const backdrop = now.find((o) => !o.text && o.rect[2] >= W * 0.9 && o.rect[3] >= H * 0.9);
          const main = now.filter((o) => o !== backdrop && (o.text || o.panel));
          if (main.length) res.dialogs.push({ trigger: it.text, triggerId: it.id, area: it.area, screenshot: null, backdrop: backdrop ? { bg: backdrop.bg, blur: backdrop.blur } : null, overlays: main.slice(0, 2) });
          escape(); await sleep(300); now = fresh(was);
          if (now.length) {
            for (const o of now) {
              const box = document.querySelector('[data-sb-ov="' + o.id + '"]'); if (!box) continue;
              const b = [...box.querySelectorAll('button, [role="button"], a')].find((x) => /close|закры|отмен|cancel|^\s*[×✕✖x]\s*$/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '') + ' ' + (x.innerText || '')));
              if (b && clickable(b)) await press(b);
            }
            await sleep(300); now = fresh(was);
          }
          if (now.length) { clickOutside(); await sleep(300); now = fresh(was); }
          if (now.length) break; // could not close it — stop rather than probe a covered page
        }
      }
    }

    // ---------- <details> (opened last: it changes the layout) ----------
    try { res.details = sb.openDetails(); } catch (e) {}
  } catch (e) {
    res.error = String((e && e.message) || e).slice(0, 300);
  } finally {
    unguard();
    try { window.scrollTo({ top: sy, left: sx, behavior: 'instant' }); } catch (e) {}
  }
  res.ms = Date.now() - t0;
  return res;
}
