// Page-level operations: settling, cookie banners, lazy-load scrolling, screenshots, LLM sheets, probes.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, sleep, limiter } from '../util.mjs';
import { log } from '../log.mjs';

export async function settle(page, ms = 8000) { try { await page.waitForLoadState('networkidle', { timeout: ms }); } catch {} }

const ACCEPT = '^(accept|accept all|accept all cookies|accept cookies|allow all|allow cookies|agree|i agree|i accept|got it|ok|okay|understood|continue|принять|принять все|принять всё|согласен|согласна|согласиться|хорошо|понятно|ок|разрешить|разрешить все|akzeptieren|alle akzeptieren|accepter|tout accepter|aceptar|aceptar todo|accetta|accetta tutto|aceitar|zgadzam się)$';
export async function dismissCookies(page) {
  try {
    return await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 32 || !rx.test(t)) continue;
        const box = el.closest('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="gdpr" i], [class*="privacy" i], [aria-label*="cookie" i], [aria-label*="consent" i], [role="dialog"], [role="alertdialog"]');
        if (!box) continue;
        el.click(); return t;
      }
      return '';
    }, ACCEPT);
  } catch { return ''; }
}

// Lazy images: native loading="lazy" -> eager, data-src / data-srcset -> src / srcset (JS lazy loaders).
export async function forceLazy(page) {
  try {
    return await page.evaluate(() => {
      let n = 0;
      const PH = /(placeholder|blank|spacer|transparent)[^/]*\.(gif|png|svg)(\?|$)/i;
      for (const img of document.querySelectorAll('img')) {
        if (img.loading === 'lazy') { img.loading = 'eager'; n++; }
        for (const [from, to] of [['data-src', 'src'], ['data-lazy-src', 'src'], ['data-original', 'src'], ['data-srcset', 'srcset'], ['data-lazy-srcset', 'srcset']]) {
          const v = img.getAttribute(from); const cur = img.getAttribute(to);
          if (v && v !== cur && (!cur || cur.startsWith('data:') || PH.test(cur))) { img.setAttribute(to, v); n++; }
        }
      }
      for (const s of document.querySelectorAll('source[data-srcset]')) if (!s.getAttribute('srcset')) { s.setAttribute('srcset', s.getAttribute('data-srcset')); n++; }
      return n;
    });
  } catch { return 0; }
}

// Scrolls the page in steps; at every step waits (briefly) for images that are loading in/near the viewport.
export async function autoScroll(page, { maxSteps = 90, budgetMs = 25000 } = {}) {
  try {
    await page.evaluate(async ({ maxSteps, budgetMs }) => {
      const t0 = Date.now();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const H = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      const step = Math.max(300, Math.round(innerHeight * 0.7));
      const to = (top) => window.scrollTo({ top, left: 0, behavior: 'instant' });
      const loadingNear = () => [...document.images].filter((i) => { if (i.complete) return false; const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > -300 && r.top < innerHeight + 600; });
      let y = 0, n = 0;
      while (y < H() && n < maxSteps && Date.now() - t0 < budgetMs) {
        y += step; to(y); n++;
        await sleep(120);
        const p = loadingNear();
        if (p.length) await Promise.race([Promise.all(p.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(900)]);
      }
      await sleep(250);
      to(0);
      await sleep(350);
      if (window.scrollY !== 0) { document.documentElement.style.scrollBehavior = 'auto'; to(0); await sleep(200); }
    }, { maxSteps, budgetMs });
  } catch {}
}

// Finite CSS transitions / animations (scroll-reveal, entrance effects) jump to their end state, so styles are captured
// settled instead of mid-fade (opacity 0.9, translate-y 2px on the first row of cards).
export async function finishAnimations(page) {
  try {
    return await page.evaluate(async () => {
      let n = 0;
      for (const a of document.getAnimations ? document.getAnimations() : []) {
        try {
          if (a.playState === 'finished') continue;
          const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          if (!t || !Number.isFinite(t.endTime) || t.endTime > 60000) continue;
          a.finish(); n++;
        } catch (e) {}
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return n;
    });
  } catch { return 0; }
}

// Waits for fonts and for images that are still loading — while they keep finishing (stops after 3 s without progress).
export async function waitAssets(page, ms = 12000) {
  try {
    await page.evaluate(async (ms) => {
      const t0 = Date.now(); const sleep = (x) => new Promise((r) => setTimeout(r, x));
      const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      await Promise.race([fonts, sleep(Math.min(ms, 4000))]);
      let last = -1, stall = 0;
      while (Date.now() - t0 < ms) {
        const left = [...document.images].filter((i) => !i.complete).length;
        if (!left) break;
        if (left === last) { stall += 250; if (stall >= 3000) break; } else { stall = 0; last = left; }
        await sleep(250);
      }
    }, ms);
  } catch {}
}

export async function fullScreenshot(page, file, docH, maxH = 16000) {
  await ensureDir(path.dirname(file));
  const vp = page.viewportSize();
  try {
    if (docH > maxH) await page.screenshot({ path: file, fullPage: true, animations: 'disabled', timeout: 90000, clip: { x: 0, y: 0, width: vp.width, height: maxH } });
    else await page.screenshot({ path: file, fullPage: true, animations: 'disabled', timeout: 90000 });
    return { file, truncated: docH > maxH };
  } catch (e) {
    log.warn('Полный скриншот не удался, делаю обрезанный:', String(e.message).split('\n')[0]);
    try { await page.screenshot({ path: file, fullPage: true, timeout: 60000, clip: { x: 0, y: 0, width: vp.width, height: Math.min(docH, 6000) } }); return { file, truncated: true }; } catch { return null; }
  }
}

export async function sectionShots(page, sections, dir, slugBase) {
  await ensureDir(dir);
  const vp = page.viewportSize(); const out = [];
  for (const s of sections) {
    const [x, y, w, h] = s.node.r;
    if (h < 8 || w < 8) continue;
    const name = `${String(s.index + 1).padStart(2, '0')}-${s.type}.png`;
    const file = path.join(dir, name);
    try {
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled', timeout: 30000, clip: { x: 0, y: Math.max(0, y), width: vp.width, height: Math.min(h, 5000) } });
      out.push({ index: s.index, type: s.type, file });
    } catch (e) { log.debug('section shot failed', slugBase, s.index, e.message); }
  }
  return out;
}

// --- downscaled JPEG "sheets" for vision LLMs, produced with a canvas in a helper page (no native deps) ---
export function createSheetMaker(context) {
  let helper = null; let current = null; const lock = limiter(1);
  async function ensure() {
    if (helper && !helper.isClosed()) return helper;
    helper = await context.newPage();
    await helper.route('http://sb.local/**', (route) => {
      if (route.request().url().includes('/img')) return route.fulfill({ status: 200, contentType: 'image/png', body: current });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
    });
    await helper.goto('http://sb.local/blank');
    return helper;
  }
  return {
    make: (pngFile, outPrefix, { width = 1000, maxH = 2000, max = 4, quality = 0.72, dpr = 1 } = {}) => lock(async () => {
      if (max <= 0) return [];
      current = await fsp.readFile(pngFile);
      const h = await ensure();
      const res = await h.evaluate(async ({ width, maxH, max, quality }) => {
        const img = new Image(); img.src = '/img?' + Date.now(); await img.decode();
        const W0 = img.naturalWidth, H0 = img.naturalHeight;
        let scale = Math.min(1, width / W0);
        let n = Math.ceil((H0 * scale) / maxH);
        if (n > max) { scale = Math.max(Math.min(scale, (max * maxH) / H0), Math.min(scale, 640 / W0)); n = Math.ceil((H0 * scale) / maxH); }
        const step = Math.ceil(maxH / scale);
        let pick = [...Array(n).keys()];
        if (n > max) { const p = new Set(); for (let i = 0; i < max; i++) p.add(Math.round((i * (n - 1)) / Math.max(1, max - 1))); pick = [...p]; }
        const sheets = [];
        for (const i of pick) {
          const sy = i * step, sh = Math.min(step, H0 - sy); if (sh <= 0) continue;
          const c = document.createElement('canvas'); c.width = Math.round(W0 * scale); c.height = Math.max(1, Math.round(sh * scale));
          const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, sy, W0, sh, 0, 0, c.width, c.height);
          sheets.push({ i, y0: sy, y1: sy + sh, data: c.toDataURL('image/jpeg', quality) });
        }
        return { total: n, sheets };
      }, { width, maxH, max, quality });
      const out = [];
      await ensureDir(path.dirname(outPrefix));
      for (const s of res.sheets) {
        const file = `${outPrefix}-${s.i + 1}.jpg`;
        await fsp.writeFile(file, Buffer.from(s.data.split(',')[1], 'base64'));
        out.push({ file, y0: Math.round(s.y0 / dpr), y1: Math.round(s.y1 / dpr), part: s.i + 1, of: res.total });
      }
      return out;
    }),
    close: async () => { try { if (helper) await helper.close(); } catch {} },
  };
}

// --- probes ---
const NO_ANIM = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important}';
function diffState(a, b) { const d = {}; if (!a || !b) return d; for (const k of Object.keys(a)) if (a[k] !== b[k] && k !== 'hostText') d[k] = [a[k], b[k]]; return d; }

// skip: Set of signatures already probed on earlier pages (shared header/footer are hovered only once per crawl)
export async function probeHover(page, interactive, { max = 36, budgetMs = 15000, skip = null } = {}) {
  const t0 = Date.now(); const out = [];
  const seen = new Set();
  const uniq = interactive.filter((x) => x.kind === 'link' || x.kind === 'button' || x.kind === 'tab')
    .filter((x) => { if (seen.has(x.sig) || (skip && skip.has(x.sig))) return false; seen.add(x.sig); return true; });
  // round-robin over areas so that the footer is not starved by a long header/main
  const byArea = new Map(); for (const x of uniq) { const a = x.area === 'nav' ? 'header' : x.area; if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(x); }
  const queues = ['header', 'main', 'footer'].map((a) => byArea.get(a) || []); const cands = [];
  while (cands.length < max && queues.some((q) => q.length)) for (const q of queues) if (q.length && cands.length < max) cands.push(q.shift());
  if (!cands.length) return out;
  try { await page.addStyleTag({ content: NO_ANIM }); } catch {}
  for (const it of cands) {
    if (Date.now() - t0 > budgetMs) break;
    if (skip) skip.add(it.sig);
    try {
      const before = await page.evaluate((id) => window.__sb && window.__sb.hoverState(id), it.id);
      if (!before) continue;
      await page.locator(`[data-sb-id="${it.id}"]`).first().hover({ timeout: 1200, force: true });
      await sleep(70);
      const after = await page.evaluate((id) => window.__sb.hoverState(id), it.id);
      const self = diffState(before.self, after.self);
      const kidDiffs = (before.kids || []).map((k, i) => diffState(k, (after.kids || [])[i])).map((d, i) => ({ i, d })).filter((x) => Object.keys(x.d).length);
      let reveals = '';
      if (after.hostText && after.hostText.length > (before.hostText || '').length + 15) reveals = after.hostText.slice(0, 2500);
      if (Object.keys(self).length || kidDiffs.length || reveals) out.push({ id: it.id, sig: it.sig, area: it.area, text: it.text, diff: self, kids: kidDiffs, reveals });
      await page.mouse.move(1, 1);
    } catch (e) { log.debug('hover', it.id, String(e.message).split('\n')[0]); }
  }
  try { await page.mouse.move(1, 1); } catch {}
  return out;
}

// Hover-revealed menus (dropdowns / mega-menus) in header & nav: hosts that contain a hidden block with links.
export async function probeDropdowns(page, dir, slug, { max = 10 } = {}) {
  const out = [];
  let hosts = [];
  try {
    hosts = await page.evaluate((max) => {
      const res = []; const seen = new Set();
      for (const nav of document.querySelectorAll('header, nav, [role="navigation"], [role="banner"]')) {
        for (const el of nav.querySelectorAll('li, div, span, button, a')) {
          if (res.length >= max) break;
          const r = el.getBoundingClientRect(); if (r.width < 10 || r.height < 10 || r.top > 300) continue;
          const hid = [...el.children].find((c) => { const cs = getComputedStyle(c); return (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') && c.querySelectorAll('a').length >= 2; });
          if (!hid || seen.has(hid)) continue;
          seen.add(hid);
          el.setAttribute('data-sb-dd', String(res.length)); hid.setAttribute('data-sb-ddm', String(res.length));
          res.push({ i: res.length, label: ((el.innerText || '').trim().split('\n')[0] || el.getAttribute('aria-label') || '').slice(0, 60) });
        }
      }
      return res;
    }, max);
  } catch { return out; }
  for (const h of hosts) {
    try {
      await page.locator(`[data-sb-dd="${h.i}"]`).first().hover({ timeout: 1200, force: true });
      await sleep(180);
      const info = await page.evaluate((i) => {
        const m = document.querySelector(`[data-sb-ddm="${i}"]`); const host = document.querySelector(`[data-sb-dd="${i}"]`);
        if (!m) return null; const cs = getComputedStyle(m);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && m.getClientRects().length > 0;
        const links = [...m.querySelectorAll('a')].slice(0, 60).map((a) => ({ text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 100), href: a.href }));
        const a = host.getBoundingClientRect(), b = m.getBoundingClientRect();
        return { visible, text: (m.innerText || m.textContent || '').trim().slice(0, 3000), links, box: { x: Math.min(a.left, b.left), y: Math.min(a.top, b.top), x2: Math.max(a.right, b.right), y2: Math.max(a.bottom, b.bottom) }, style: { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, padding: cs.padding, minWidth: cs.minWidth } };
      }, h.i);
      if (info && info.visible) {
        let shot = null;
        try {
          const vp = page.viewportSize(); const pad = 16;
          const clip = { x: Math.max(0, info.box.x - pad), y: Math.max(0, info.box.y - pad) }; clip.width = Math.min(vp.width - clip.x, info.box.x2 - info.box.x + pad * 2); clip.height = Math.min(vp.height - clip.y, info.box.y2 - info.box.y + pad * 2);
          if (clip.width > 20 && clip.height > 20) { const f = path.join(dir, `${slug}-dropdown-${h.i + 1}.png`); await ensureDir(dir); await page.screenshot({ path: f, clip }); shot = f; }
        } catch {}
        out.push({ label: h.label, text: info.text, links: info.links, style: info.style, screenshot: shot });
      }
      await page.mouse.move(1, 1); await sleep(80);
    } catch (e) { log.debug('dropdown', h.i, String(e.message).split('\n')[0]); }
  }
  return out;
}

async function guardedClick(page, id, startUrl) {
  await page.locator(`[data-sb-id="${id}"]`).first().click({ timeout: 1500, force: true });
  await sleep(220);
  if (page.url().split('#')[0] !== startUrl.split('#')[0]) { try { await page.goBack({ timeout: 15000 }); } catch {} return false; }
  return true;
}

export async function probeInteractions(page, interactive, { budgetMs = 25000 } = {}) {
  const t0 = Date.now(); const res = { tabs: [], tabGroups: [], expand: [], details: [] };
  const startUrl = page.url();
  page.on('popup', (p) => p.close().catch(() => {}));
  // tab groups (role="tab" and rows of buttons with one active): click each tab and diff the main area.
  // Content tabs -> the text that appears; filters (category tabs over a grid) -> which item headings stay visible.
  const groups = new Map();
  for (const t of interactive.filter((x) => x.kind === 'tab')) { const g = t.group || 'g0'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  let gn = 0;
  for (const [g, tabs] of groups) {
    if (++gn > 6 || Date.now() - t0 > budgetMs) break;
    const ids = tabs.map((t) => t.id);
    const region = () => page.evaluate((ids) => window.__sb.region(ids), ids).catch(() => null);
    const base = await region();
    if (!base) continue;
    const baseSet = new Set(base.lines);
    const active = tabs.find((t) => t.active) || tabs[0];
    const rec = { group: g, labels: tabs.map((t) => t.text), active: active.text, heuristic: !!active.heur, baseHeads: base.heads.slice(0, 300), items: [] };
    for (const t of tabs.slice(0, 16)) {
      if (Date.now() - t0 > budgetMs) break;
      try {
        if (t !== active) { if (!(await guardedClick(page, t.id, startUrl))) return res; await sleep(260); }
        const p = await page.evaluate((id) => window.__sb.tabPanel(id), t.id).catch(() => null);
        const snap = t === active ? base : await region();
        if (!snap) continue;
        const now = new Set(snap.lines);
        const added = snap.lines.filter((l) => !baseSet.has(l));
        const removed = base.lines.filter((l) => !now.has(l)).length;
        rec.items.push({ id: t.id, label: (p && p.label) || t.text, active: t === active, panel: p && p.text ? p.text.slice(0, 4000) : '', added: added.join('\n').slice(0, 5000), addedLines: added.length, removed, heads: snap.heads.slice(0, 300) });
      } catch (e) { log.debug('tab', t.id, String(e.message).split('\n')[0]); }
    }
    if (active) { try { await page.locator(`[data-sb-id="${active.id}"]`).first().click({ timeout: 1500, force: true }); await sleep(200); } catch {} }
    if (rec.items.some((x) => !x.active && (x.addedLines || x.removed || x.panel))) res.tabGroups.push(rec);
  }
  // aria-expanded accordions / dropdowns
  for (const x of interactive.filter((i) => i.kind === 'expand' && i.expanded === 'false').slice(0, 24)) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      if (!(await guardedClick(page, x.id, startUrl))) return res;
      await sleep(150);
      const r = await page.evaluate((id) => window.__sb.expandedText(id), x.id);
      if (r && r.text) res.expand.push({ id: x.id, area: x.area, label: r.label || x.text, text: r.text });
    } catch (e) { log.debug('expand', x.id, String(e.message).split('\n')[0]); }
  }
  // <details>
  try { res.details = await page.evaluate(() => window.__sb.openDetails()); } catch {}
  return res;
}

// Buttons that open overlays (cart drawer, modal, popup): click, diff visible overlays, screenshot, close.
const DANGER = /удал|delete|remove|выйти|выход|log ?out|sign ?out|оплат|\bpay\b|buy|купить|заказать|оформить|checkout|подписаться|subscribe|отправить|\bsend\b|submit|сохранить|\bsave\b/i;
const LIKELY = /корзин|cart|bag|меню|menu|фильтр|filter|поиск|search|вайп|wipe|расписан|schedule|подробн|details|info|инфо|войти|login|sign ?in|контакт|contact|заявк|call|видео|video|play|галере|gallery|share|подел/i;
export async function probeDialogs(page, interactive, dir, slug, { max = 8, budgetMs = 20000, skip = null } = {}) {
  const t0 = Date.now(); const out = [];
  const startUrl = page.url();
  const sigCount = new Map(); for (const x of interactive) sigCount.set(x.sig, (sigCount.get(x.sig) || 0) + 1);
  const seen = new Set();
  const cands = interactive
    .filter((x) => (x.kind === 'button' || x.kind === 'expand') && x.tag !== 'input' && x.area !== 'footer' && (sigCount.get(x.sig) || 0) <= 2 && !DANGER.test(x.text || ''))
    .filter((x) => { const k = x.sig + '|' + x.text; if (seen.has(k) || (skip && skip.has(k))) return false; seen.add(k); return true; })
    .sort((a, b) => (LIKELY.test(b.text || '') ? 1 : 0) - (LIKELY.test(a.text || '') ? 1 : 0))
    .slice(0, max);
  let n = 0;
  for (const it of cands) {
    if (Date.now() - t0 > budgetMs) break;
    if (skip) skip.add(it.sig + '|' + it.text);
    try {
      const before = await page.evaluate(() => window.__sb.overlays()).catch(() => null);
      if (!before) break;
      const was = new Set(before.map((o) => o.id));
      if (!(await guardedClick(page, it.id, startUrl))) break; // navigated away: in-page helpers are gone
      await sleep(450);
      const after = await page.evaluate(() => window.__sb.overlays()).catch(() => []);
      const fresh = after.filter((o) => !was.has(o.id));
      if (fresh.length) {
        const vp = page.viewportSize() || { width: 1440, height: 900 };
        const backdrop = fresh.find((o) => !o.text && o.rect[2] >= vp.width * 0.9 && o.rect[3] >= vp.height * 0.9);
        const main = fresh.filter((o) => o !== backdrop && (o.text || o.panel));
        if (main.length) {
          const file = path.join(dir, `${slug}-dialog-${++n}.png`);
          await ensureDir(dir);
          await page.screenshot({ path: file, animations: 'disabled' }).catch(() => {});
          out.push({ trigger: it.text, triggerId: it.id, area: it.area, screenshot: file, backdrop: backdrop ? { bg: backdrop.bg, blur: backdrop.blur } : null, overlays: main.slice(0, 2) });
        }
      }
      if (fresh.length) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
        let still = (await page.evaluate(() => window.__sb.overlays()).catch(() => [])).filter((o) => !was.has(o.id));
        if (still.length) {
          await page.evaluate((ids) => {
            for (const id of ids) {
              const el = document.querySelector('[data-sb-ov="' + id + '"]'); if (!el) continue;
              const b = [...el.querySelectorAll('button, [role="button"], a')].find((x) => /close|закры|отмен|cancel|^\s*[×✕✖x]\s*$/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('title') || '') + ' ' + (x.innerText || '')));
              if (b) b.click();
            }
          }, still.map((o) => o.id)).catch(() => {});
          await sleep(300);
          still = (await page.evaluate(() => window.__sb.overlays()).catch(() => [])).filter((o) => !was.has(o.id));
        }
        if (still.length) { await page.mouse.click(5, 5).catch(() => {}); await sleep(300); still = (await page.evaluate(() => window.__sb.overlays()).catch(() => [])).filter((o) => !was.has(o.id)); }
        if (still.length) break; // could not close — stop here rather than probe a covered page
      }
    } catch (e) { log.debug('dialog', it.id, String(e.message).split('\n')[0]); }
  }
  return out;
}

// canvas / WebGL: element screenshot with everything else hidden -> static fallback image for the clone
export async function snapshotCanvases(page, media, fileFor, { max = 4 } = {}) {
  const out = [];
  const list = (media || []).map((m, i) => ({ m, i })).filter(({ m }) => m.type === 'canvas' && m.w >= 80 && m.h >= 40).slice(0, max);
  for (const { i } of list) {
    try {
      await page.evaluate((i) => {
        const el = document.querySelector('[data-sb-media="' + i + '"]'); if (!el) return;
        const st = document.createElement('style'); st.id = '__sb_cv';
        st.textContent = 'html,body{background:transparent!important}*{visibility:hidden!important}[data-sb-media="' + i + '"]{visibility:visible!important}';
        document.head.appendChild(st);
      }, i);
      await sleep(120);
      const file = fileFor(i);
      await ensureDir(path.dirname(file));
      await page.locator(`[data-sb-media="${i}"]`).first().screenshot({ path: file, omitBackground: true, timeout: 8000 });
      out.push({ index: i, file });
    } catch (e) { log.debug('canvas', i, String(e.message).split('\n')[0]); }
    finally { await page.evaluate(() => { const st = document.getElementById('__sb_cv'); if (st) st.remove(); }).catch(() => {}); }
  }
  return out;
}

export async function probeBurger(page, file) {
  try {
    const id = await page.evaluate(() => window.__sb && window.__sb.findBurger());
    if (!id) return null;
    const startUrl = page.url();
    const before = await page.evaluate(() => window.__sb.visibleLinks()).catch(() => []);
    await page.locator(`[data-sb-id="${id}"]`).first().click({ timeout: 2000, force: true });
    await sleep(600);
    if (page.url().split('#')[0] !== startUrl.split('#')[0]) { try { await page.goBack(); } catch {} return null; }
    await ensureDir(path.dirname(file));
    await page.screenshot({ path: file, animations: 'disabled' });
    const text = await page.evaluate(() => window.__sb.menuText());
    const menu = await page.evaluate((b) => window.__sb.menuLinks(b), before).catch(() => null);
    return { id, screenshot: file, text, links: (menu && menu.links) || [], style: (menu && menu.style) || null };
  } catch (e) { log.debug('burger', String(e.message).split('\n')[0]); return null; }
}
