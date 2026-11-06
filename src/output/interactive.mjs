// Stage 3: interactive client state for the generated Next.js 16 project (tabs, catalog filter/search/sort,
// cart drawer/buttons, modal dialogs, mobile menu, disclosure/accordions, and scroll/hover animations).
import { jsEsc, jsxText } from '../analyze/skeleton.mjs';

export const ADD_TO_CART_RE = /^(в\s*корзину|купить|добавить(\s+в\s+корзину)?|заказать|add\s+to\s+(cart|bag|basket)|buy(\s+now)?)$/i;

const CART_TRIGGER_RE = /(корзин|cart|basket|bag|checkout|заказ)/i;

const CATALOG_TS = `export type SortMode = 'default' | 'price-asc' | 'price-desc' | 'title-asc';

export interface FilterCatalogOptions<T> {
  category?: string | null;
  categoryOf?: (item: T, index: number) => string | null | undefined;
  query?: string;
  sort?: SortMode;
  price?: (item: T) => unknown;
  text?: (item: T) => string;
}

export function parsePrice(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const s = String(raw ?? '').replace(/[\\u00a0\\u2007\\u2009\\u202f\\s]+/g, ' ').trim();
  if (!s) return NaN;
  const m = /(\\d[\\d .,]*)/.exec(s);
  if (!m) return NaN;
  let num = m[1].trim().replace(/\\s+/g, '');
  if (/^\\d{1,3}(\\.\\d{3})+$/.test(num)) {
    num = num.replace(/\\./g, '');
  } else if (/^\\d{1,3}(,\\d{3})+(\\.\\d+)?$/.test(num)) {
    num = num.replace(/,/g, '');
  } else if (num.includes(',') && !num.includes('.')) {
    num = num.replace(',', '.');
  }
  const v = parseFloat(num);
  return Number.isFinite(v) ? v : NaN;
}

export function formatPrice(amount: number, currency = '₽'): string {
  const rounded = Math.round((Number.isFinite(amount) ? amount : 0) * 100) / 100;
  const parts = String(rounded).split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u00a0');
  const num = parts.join('.');
  return currency ? \`\${num}\\u00a0\${currency}\` : num;
}

export function filterCatalog<T>(items: T[], opts: FilterCatalogOptions<T> = {}): T[] {
  const { category = null, categoryOf, query = '', sort = 'default', price, text } = opts;
  const q = String(query || '').trim().toLowerCase();
  const indexed = items.map((item, index) => ({ item, index }));
  const filtered = indexed.filter(({ item, index }) => {
    if (category && categoryOf) {
      const cat = categoryOf(item, index);
      if (cat && cat !== category) return false;
    }
    if (q) {
      const hay = (text ? text(item) : JSON.stringify(item)).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (sort === 'price-asc' || sort === 'price-desc') {
    const dir = sort === 'price-asc' ? 1 : -1;
    filtered.sort((a, b) => {
      const pa = price ? parsePrice(price(a.item)) : NaN;
      const pb = price ? parsePrice(price(b.item)) : NaN;
      const na = Number.isNaN(pa);
      const nb = Number.isNaN(pb);
      if (na && nb) return a.index - b.index;
      if (na) return 1;
      if (nb) return -1;
      return (pa - pb) * dir || a.index - b.index;
    });
  } else if (sort === 'title-asc' && text) {
    filtered.sort((a, b) => text(a.item).localeCompare(text(b.item)));
  }

  return filtered.map((x) => x.item);
}
`;

const CART_TSX = `'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { parsePrice, formatPrice } from '@/lib/catalog';

export interface CartItemInput {
  id?: string;
  title?: string;
  price?: string | number;
  image?: string;
}

export interface CartEntry extends CartItemInput {
  key: string;
  qty: number;
  unitPrice: number;
}

export interface CartLook {
  side?: 'left' | 'right' | 'center' | 'bottom';
  width?: number;
  bg?: string;
  fg?: string;
  radius?: string;
  backdrop?: string;
}

export interface CartConfig {
  title?: string;
  emptyText?: string;
  totalLabel?: string;
  currency?: string;
  look?: CartLook;
}

interface CartCtx {
  items: CartEntry[];
  isOpen: boolean;
  open: () => void;
  close: () => void;
  add: (item: CartItemInput) => void;
  remove: (key: string) => void;
  clear: () => void;
  count: number;
  total: number;
  config: CartConfig;
}

const Context = createContext<CartCtx | null>(null);
const STORAGE_KEY = 'sb-clone-cart-v1';

export function CartProvider({ children, config = {} }: { children: React.ReactNode; config?: CartConfig }) {
  const [items, setItems] = useState<CartEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setItems(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items]);

  const add = (input: CartItemInput) => {
    const title = String(input.title || 'Товар').trim();
    const key = String(input.id || title);
    const unit = parsePrice(input.price);
    setItems((prev) => {
      const idx = prev.findIndex((x) => x.key === key);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { ...input, title, key, qty: 1, unitPrice: Number.isNaN(unit) ? 0 : unit }];
    });
    setIsOpen(true);
  };

  const remove = (key: string) => setItems((prev) => prev.filter((x) => x.key !== key));
  const clear = () => setItems([]);
  const count = items.reduce((a, x) => a + x.qty, 0);
  const total = items.reduce((a, x) => a + x.unitPrice * x.qty, 0);

  const look = config.look || {};
  const side = look.side || 'right';
  const currency = config.currency || '₽';

  return (
    <Context.Provider value={{ items, isOpen, open: () => setIsOpen(true), close: () => setIsOpen(false), add, remove, clear, count, total, config }}>
      {children}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex"
          style={{ backgroundColor: look.backdrop || 'rgba(0,0,0,0.6)', justifyContent: side === 'left' ? 'flex-start' : side === 'center' ? 'center' : 'flex-end', alignItems: side === 'center' ? 'center' : 'stretch' }}
          onClick={() => setIsOpen(false)}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={config.title || 'Корзина'}
            className="relative flex flex-col justify-between p-6 shadow-2xl overflow-y-auto"
            style={{ width: look.width ? \`\${look.width}px\` : '380px', maxWidth: '100vw', backgroundColor: look.bg || '#12121a', color: look.fg || '#f5f5f7', borderRadius: look.radius || '0px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <div className="flex items-center justify-between border-b border-current/10 pb-4 mb-4">
                <h2 className="text-lg font-bold">{config.title || 'Корзина'}</h2>
                <button type="button" onClick={() => setIsOpen(false)} aria-label="Закрыть" className="text-xl leading-none opacity-70 hover:opacity-100 cursor-pointer">×</button>
              </div>
              {items.length === 0 ? (
                <p className="py-8 text-sm opacity-75">{config.emptyText || 'В корзине пока пусто.'}</p>
              ) : (
                <ul className="space-y-3">
                  {items.map((it) => (
                    <li key={it.key} className="flex items-center justify-between gap-3 border-b border-current/10 pb-3 text-sm">
                      <div>
                        <div className="font-medium">{it.title}</div>
                        <div className="opacity-70">{it.qty} × {formatPrice(it.unitPrice, currency)}</div>
                      </div>
                      <button type="button" onClick={() => remove(it.key)} className="text-xs opacity-60 hover:opacity-100 cursor-pointer">Удалить</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-current/10 pt-4 mt-4 flex items-center justify-between font-semibold">
              <span>{config.totalLabel || 'Итого'}:</span>
              <span>{formatPrice(total, currency)}</span>
            </div>
          </aside>
        </div>
      )}
    </Context.Provider>
  );
}

export function CartButton({ children }: { children: React.ReactNode }) {
  const ctx = useContext(Context);
  if (!ctx) return <>{children}</>;
  return (
    <span onClick={() => ctx.open()} className="contents cursor-pointer">
      {children}
    </span>
  );
}

export function AddToCart({ item = {}, children }: { item?: CartItemInput; children: React.ReactNode }) {
  const ctx = useContext(Context);
  if (!ctx) return <>{children}</>;
  return (
    <span onClick={() => ctx.add(item)} className="contents cursor-pointer">
      {children}
    </span>
  );
}
`;

const MODAL_TSX = `'use client';

import React, { useState } from 'react';

export interface ModalLook {
  side?: 'center' | 'left' | 'right' | 'bottom' | 'full';
  width?: number;
  bg?: string;
  fg?: string;
  radius?: string;
  backdrop?: string;
}

export function ModalTrigger({
  title,
  lines = [],
  look = {},
  children,
}: {
  title?: string;
  lines?: string[];
  look?: ModalLook;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)} className="contents cursor-pointer">
        {children}
      </span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: look.backdrop || 'rgba(0,0,0,0.6)' }}
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Диалог'}
            className="relative max-h-[90vh] overflow-y-auto p-6 shadow-2xl"
            style={{
              width: look.width ? \`\${look.width}px\` : '480px',
              maxWidth: '100%',
              backgroundColor: look.bg || '#ffffff',
              color: look.fg || '#111111',
              borderRadius: look.radius || '16px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4 mb-4">
              {title && <h2 className="text-lg font-bold">{title}</h2>}
              <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть" className="ml-auto text-xl leading-none opacity-70 hover:opacity-100 cursor-pointer">×</button>
            </div>
            <div className="space-y-2 text-sm">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
`;

const MOBILE_MENU_TSX = `'use client';

import React, { useState } from 'react';
import Link from 'next/link';

export interface MenuLink {
  href: string;
  text: string;
  external?: boolean;
}

export function MobileMenu({
  links = [],
  bg = '#ffffff',
  fg = '#111111',
  children,
}: {
  links?: MenuLink[];
  bg?: string;
  fg?: string;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <span onClick={() => setIsOpen((v) => !v)} className="contents cursor-pointer">
        {children}
      </span>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex flex-col p-6 overflow-y-auto" style={{ backgroundColor: bg, color: fg }}>
          <div className="flex justify-end mb-4">
            <button type="button" onClick={() => setIsOpen(false)} aria-label="Закрыть меню" className="text-2xl leading-none p-2 cursor-pointer">×</button>
          </div>
          <nav className="flex flex-col gap-3 text-lg font-medium">
            {links.map((l, i) =>
              l.external ? (
                <a key={i} href={l.href} target="_blank" rel="noopener noreferrer" onClick={() => setIsOpen(false)} className="py-2 hover:opacity-80">
                  {l.text}
                </a>
              ) : (
                <Link key={i} href={l.href} onClick={() => setIsOpen(false)} className="py-2 hover:opacity-80">
                  {l.text}
                </Link>
              )
            )}
          </nav>
        </div>
      )}
    </>
  );
}
`;

const DISCLOSURE_TSX = `'use client';

import React, { useState } from 'react';

export function Disclosure({
  panel,
  defaultOpen = false,
  children,
}: {
  panel: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div onClick={() => setOpen((v) => !v)} aria-expanded={open} className="cursor-pointer">
        {children}
      </div>
      {open && panel}
    </div>
  );
}
`;

const SCROLL_REVEAL_TSX = `'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface AnimateOnScrollProps {
  children: React.ReactNode;
  preset?: 'fade-up' | 'fade-down' | 'fade-left' | 'fade-right' | 'zoom-in' | 'fade-in';
  durationMs?: number;
  delayMs?: number;
  easing?: string;
  once?: boolean;
  className?: string;
}

const INITIAL_TRANSFORM: Record<string, string> = {
  'fade-up': 'translate3d(0, 28px, 0)',
  'fade-down': 'translate3d(0, -28px, 0)',
  'fade-left': 'translate3d(28px, 0, 0)',
  'fade-right': 'translate3d(-28px, 0, 0)',
  'zoom-in': 'scale(0.94)',
  'fade-in': 'none',
};

export function AnimateOnScroll({
  children,
  preset = 'fade-up',
  durationMs = 600,
  delayMs = 0,
  easing = 'cubic-bezier(0.16, 1, 0.3, 1)',
  once = true,
  className = '',
}: AnimateOnScrollProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1200);
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            clearTimeout(timer);
            if (once) obs.disconnect();
          } else if (!once) {
            setVisible(false);
          }
        }
      },
      { threshold: 0.01, rootMargin: '50px 0px 50px 0px' }
    );
    obs.observe(el);
    return () => {
      clearTimeout(timer);
      obs.disconnect();
    };
  }, [once]);

  const initTf = INITIAL_TRANSFORM[preset] || INITIAL_TRANSFORM['fade-up'];

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : initTf,
        transitionProperty: 'opacity, transform',
        transitionDuration: \`\${durationMs}ms\`,
        transitionTimingFunction: easing,
        transitionDelay: delayMs ? \`\${delayMs}ms\` : undefined,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}
`;

export const INTERACTIVE_FILES = {
  'lib/catalog.ts': CATALOG_TS,
  'components/interactive/Cart.tsx': CART_TSX,
  'components/interactive/Modal.tsx': MODAL_TSX,
  'components/interactive/MobileMenu.tsx': MOBILE_MENU_TSX,
  'components/interactive/Disclosure.tsx': DISCLOSURE_TSX,
  'components/interactive/AnimateOnScroll.tsx': SCROLL_REVEAL_TSX,
};

function isLightHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex || ''));
  if (!m) return true;
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  return (r * 299 + g * 587 + b * 114) / 1000 >= 140;
}

export function isCartDialog(dlg) {
  if (!dlg) return false;
  const trig = String(dlg.trigger || '');
  const txt = ((dlg.overlays || []).map((o) => `${o.label || ''}\n${o.text || ''}`).join('\n'));
  return CART_TRIGGER_RE.test(trig) || /(корзин|в корзине|итого|subtotal|checkout|your cart)/i.test(txt);
}

export function dialogProps(dlg, vp = { w: 1440, h: 900 }) {
  const W = vp.w || 1440, H = vp.h || 900;
  const o = (dlg && dlg.overlays && dlg.overlays[0]) || {};
  const panel = o.panel || null;
  const rect = (panel && panel.rect) || o.rect || [0, 0, 480, 320];
  const [x, y, w, h] = rect;
  const side = h >= H * 0.85 && x + w >= W - 4 && w < W * 0.75 ? 'right'
    : h >= H * 0.85 && x <= 4 && w < W * 0.75 ? 'left'
    : w >= W * 0.85 && y + h >= H - 4 && h < H * 0.8 ? 'bottom'
    : 'center';
  const bg = (panel && panel.bg) || o.bg || '#ffffff';
  const radius = (panel && panel.radius) || o.radius || (side === 'center' ? '16px' : '0px');
  const backdrop = (dlg && dlg.backdrop && dlg.backdrop.bg) || (panel && o.bg && o.bg !== bg ? o.bg : '#00000099');
  const fg = isLightHex(bg) ? '#111111' : '#f5f5f7';
  const rawLines = String(o.text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[×✕✖xX]$/.test(l));
  let title = String(o.label || '').trim();
  if (!title && rawLines.length) title = rawLines[0];
  const lines = rawLines.filter((l, i) => !(i === 0 && l === title));
  return {
    title,
    lines,
    look: { side, width: w || 480, bg, radius, backdrop, fg },
  };
}

export function cartProps(dlg, vp = { w: 1440, h: 900 }) {
  const base = dialogProps(dlg, vp);
  const all = [base.title, ...base.lines].join('\n');
  const emptyLine = base.lines.find((l) => /пуст|empty/i.test(l)) || 'В корзине пока пусто.';
  const totalLine = base.lines.find((l) => /^(итого|всего|total|subtotal)/i.test(l)) || 'Итого';
  const totalLabel = totalLine.split(':')[0].trim() || 'Итого';
  const curMatch = /([₽$€£₸₴])/.exec(all + ' ' + (dlg.trigger || ''));
  const currency = curMatch ? curMatch[1] : '₽';
  const look = { ...base.look };
  if (look.side === 'center' && look.width <= 520) look.side = 'right';
  return {
    title: base.title || 'Корзина',
    emptyText: emptyLine,
    totalLabel,
    currency,
    look,
  };
}

export function menuLinks(burger, pageLinks = [], linkFor = (h) => ({ href: h, internal: false })) {
  const out = [];
  const seen = new Set();
  const add = (href, text) => {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!t || !href) return;
    const L = linkFor(href);
    const key = `${L.href}|${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(L.internal ? { href: L.href, text: t } : { href: L.href, text: t, external: true });
  };
  if (burger && Array.isArray(burger.links) && burger.links.length) {
    for (const l of burger.links) add(l.href, l.text);
    return out;
  }
  const byText = new Map();
  for (const l of pageLinks || []) {
    const t = String(l.text || '').trim().toLowerCase();
    if (t && !byText.has(t)) byText.set(t, l.href);
  }
  for (const line of String((burger && burger.text) || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const href = byText.get(t.toLowerCase());
    if (href) add(href, t);
  }
  return out;
}

const IMPORT_GROUP = {
  AddToCart: '@/components/interactive/Cart',
  CartButton: '@/components/interactive/Cart',
  CartProvider: '@/components/interactive/Cart',
  ModalTrigger: '@/components/interactive/Modal',
  MobileMenu: '@/components/interactive/MobileMenu',
  Disclosure: '@/components/interactive/Disclosure',
  AnimateOnScroll: '@/components/interactive/AnimateOnScroll',
};

export function clientImports(names = []) {
  const byMod = new Map();
  for (const n of names) {
    const mod = IMPORT_GROUP[n];
    if (!mod) continue;
    if (!byMod.has(mod)) byMod.set(mod, new Set());
    byMod.get(mod).add(n);
  }
  return [...byMod.entries()].map(([mod, set]) => `import { ${[...set].sort().join(', ')} } from '${mod}';`);
}

function mergeModuleImport(code, mod, symbols) {
  const syms = [...new Set(symbols)].sort();
  const re = new RegExp(`^import\\s+\\{([^}]+)\\}\\s+from\\s+['"]${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"];?\\s*$`, 'm');
  const m = re.exec(code);
  if (m) {
    const existing = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...syms])].sort();
    return code.replace(re, `import { ${merged.join(', ')} } from '${mod}';`);
  }
  const line = `import { ${syms.join(', ')} } from '${mod}';`;
  const lines = code.split('\n');
  let insertAt = 0;
  while (insertAt < lines.length && (/^\/\/|^'use client'|^"use client"|^import\s/.test(lines[insertAt].trim()) || !lines[insertAt].trim())) {
    if (/^const\s|^export\s/.test(lines[insertAt].trim())) break;
    insertAt++;
  }
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

export function enhanceSection(code, render, opts = {}) {
  const { tabGroups = [], lang = 'ru', catalogTools = true, cart = false } = opts;
  const data = (render && render.data) || [];
  let next = code;
  let client = false;
  const uses = new Set();
  const features = [];

  // 1. Match tab data array against probed tabGroups
  let matchedGroup = null;
  let tabArr = null;
  for (const d of data) {
    if (!Array.isArray(d.rows) || d.rows.length < 2) continue;
    const labels = d.rows.map((r) => String(r.label || r.title || r.text || '').trim());
    if (labels.some((l) => !l)) continue;
    const grp = tabGroups.find((g) => Array.isArray(g.labels) && g.labels.length === labels.length && g.labels.every((l, i) => l.trim() === labels[i]));
    if (grp) { matchedGroup = grp; tabArr = d; break; }
  }

  let tabCategoryExpr = null;
  let catByTitle = null;

  if (matchedGroup && tabArr) {
    client = true;
    const items = matchedGroup.items || [];
    const activeIdx = Math.max(0, items.findIndex((x) => x.active));
    const classField = (tabArr.fields || []).find((f) => /Class$/.test(f));
    let activeCls = '', inactiveCls = '';
    if (classField) {
      const vals = tabArr.rows.map((r) => r[classField]);
      activeCls = vals[activeIdx] || vals[0] || '';
      inactiveCls = vals.find((v, i) => i !== activeIdx && v !== activeCls) || activeCls;
    }

    // Replace tab button rendering with interactive onClick & aria-selected={i === tab}
    next = next.replace(
      new RegExp(`(\\{${tabArr.name}\\.map\\(\\(item,\\s*i\\)\\s*=>\\s*\\(\\s*<(?:button|a)\\b[^>]*?)>`),
      (full) => {
        let s = full;
        s = s.replace(/aria-(?:selected|pressed)=\{item\.\w+\}/, 'aria-selected={i === tab}');
        if (!/onClick=/.test(s)) s = s.replace(/key=\{i\}/, 'key={i} onClick={() => setTab(i)}');
        if (classField && activeCls && inactiveCls && activeCls !== inactiveCls) {
          s = s.replace(`\${item.${classField}}`, `\${i === tab ? ${jsEsc(activeCls)} : ${jsEsc(inactiveCls)}}`);
        }
        return s;
      }
    );

    // Check if there is a catalog grid array whose titles match the tabGroup's heads
    const allHeads = new Set(items.flatMap((it) => it.heads || []));
    const gridArr = allHeads.size > 0 ? data.find((d) => d !== tabArr && Array.isArray(d.rows) && d.rows.length >= 2 && d.rows.some((r) => allHeads.has(String(r.title || r.label || '').trim()))) : null;

    if (gridArr) {
      // Category filter mode
      const nonAll = items.filter((it) => !it.active && (it.heads || []).length > 0);
      catByTitle = new Map();
      for (const it of nonAll) {
        for (const h of it.heads || []) if (!catByTitle.has(h)) catByTitle.set(h, it.label);
      }
      const itemCats = gridArr.rows.map((r) => catByTitle.get(String(r.title || r.label || '').trim()) || null);
      const tabCats = items.map((it) => (it.active ? null : it.label));
      tabCategoryExpr = 'tabCategory[tab]';

      const textFields = (gridArr.fields || []).filter((f) => /^(title|description|subtitle|text|label)$/.test(f));
      const textFn = `(item) => [${(textFields.length ? textFields : ['title']).map((f) => `item.${f}`).join(', ')}].join(' ')`;
      const hasPrice = (gridArr.fields || []).includes('price');

      const stateLines = [
        `  const [tab, setTab] = useState(${activeIdx});`,
        ...(catalogTools ? [`  const [query, setQuery] = useState('');`, `  const [sort, setSort] = useState<SortMode>('default');`] : []),
        `  const ${gridArr.name}Category: (string | null)[] = ${JSON.stringify(itemCats)};`,
        `  const tabCategory: (string | null)[] = ${JSON.stringify(tabCats)};`,
        `  const ${gridArr.name}View = filterCatalog(${gridArr.name}, { category: tabCategory[tab], categoryOf: (_, k) => ${gridArr.name}Category[k]${catalogTools ? `, query, sort` : ''}${hasPrice ? `, price: (item) => item.price` : ''}, text: ${textFn} });`,
      ];

      // Check for single ungrouped articles outside .map() in the same grid
      const singleRe = /(\{\/\*\s*элемент №\d+[^*]*\*\/\}\s*\n)(\s*)(<(?:article|div|li)\b[\s\S]*?<\/(?:article|div|li)>)/g;
      let hasSingle = false;
      next = next.replace(singleRe, (m, cmt, ind, block) => {
        const hMatch = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/.exec(block);
        const rawTitle = hMatch ? hMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '\u00a0').trim() : '';
        const plainText = block.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, '\u00a0').replace(/[ \t\r\n]+/g, ' ').trim();
        const cat = catByTitle.get(rawTitle) || null;
        hasSingle = true;
        return `${cmt}${ind}{showItem(${JSON.stringify(cat)}, ${jsEsc(plainText)}) && (\n${block}\n${ind})}`;
      });
      if (hasSingle) {
        stateLines.push(`  const showItem = (cat: string | null, text: string) => (!tabCategory[tab] || tabCategory[tab] === cat)${catalogTools ? ` && (!query.trim() || text.toLowerCase().includes(query.trim().toLowerCase()))` : ''};`);
      }

      // Inject search & sort toolbar right after role="tablist" block if catalogTools is enabled
      if (catalogTools) {
        const isEn = lang === 'en';
        const toolbar = [
          `      <div className="flex flex-wrap items-center gap-3 mb-4">`,
          `        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="${isEn ? 'Search…' : 'Поиск…'}" className="px-3 py-1.5 rounded border border-current/15 bg-transparent text-sm" />`,
          ...(hasPrice ? [
            `        <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} className="px-3 py-1.5 rounded border border-current/15 bg-transparent text-sm">`,
            `          <option value="default">${isEn ? 'Default order' : 'По умолчанию'}</option>`,
            `          <option value="price-asc">${isEn ? 'Price: low to high' : 'Сначала дешевле'}</option>`,
            `          <option value="price-desc">${isEn ? 'Price: high to low' : 'Сначала дороже'}</option>`,
            `        </select>`,
          ] : []),
          `      </div>`,
        ].join('\n');
        next = next.replace(/(<div[^>]*role="tablist"[\s\S]*?<\/div>)/, `$1\n${toolbar}`);
      }

      // Replace gridArr.map with gridArrView.map + empty state
      next = next.replace(new RegExp(`\\{${gridArr.name}\\.map\\(\\(item,\\s*i\\)\\s*=>\\s*\\(`), `{${gridArr.name}View.map((item, i) => (`);
      const emptyMsg = lang === 'en' ? 'Nothing found.' : 'Ничего не найдено.';
      next = next.replace(
        new RegExp(`(\\{${gridArr.name}View\\.map\\(\\(item,\\s*i\\)\\s*=>\\s*\\([\\s\\S]*?\\n\\s*\\)\\)\\})`),
        `$1\n        {${gridArr.name}View.length === 0 ? <p className="col-span-full py-8 text-center opacity-70">${emptyMsg}</p> : null}`
      );

      next = next.replace(/(export function \w+\(\)\s*\{\n)/, `$1${stateLines.join('\n')}\n`);
      features.push(`catalog: фильтр «${matchedGroup.labels.join(' / ')}»${catalogTools ? ', поиск, сортировка' : ''}`);
    } else if (items.some((it) => it.panel)) {
      // Tab panel text switching mode
      const panelParagraphs = items.map((it) => String(it.panel || '').split(/\n{2,}|\r?\n/).map((s) => s.trim()).filter(Boolean));
      const maxSlots = Math.max(0, ...panelParagraphs.map((p) => p.length));
      if (maxSlots > 0) {
        const panelVar = `${tabArr.name}Panels`;
        next = next.replace(/role="tabpanel"[^>]*>([\s\S]*?)<\/div>/, (full, inner) => {
          let slotIdx = 0;
          const replaced = inner.replace(/<(h[1-6]|p|div|span)([^>]*)>([^<]+)<\/\1>/g, (m, tag, attrs, txt) => {
            if (slotIdx >= maxSlots) return m;
            return `<${tag}${attrs}>{${panelVar}[tab][${slotIdx++}]}</${tag}>`;
          });
          return full.replace(inner, replaced);
        });
        const stateLines = [
          `  const [tab, setTab] = useState(${activeIdx});`,
          `  const ${panelVar}: string[][] = ${JSON.stringify(panelParagraphs)};`,
        ];
        next = next.replace(/(export function \w+\(\)\s*\{\n)/, `$1${stateLines.join('\n')}\n`);
        features.push(`tabs: переключение панелей «${matchedGroup.labels.join(' / ')}»`);
      }
    }
  }

  // 2. Wrap "Add to cart" buttons inside template maps (or standalone) if cart is enabled
  if (cart) {
    const btnRe = /([ \t]*)<button\b([^>]*)>([^<]+)<\/button>/g;
    let wrappedCount = 0;
    next = next.replace(btnRe, (full, ind, attrs, label) => {
      if (/\bdisabled\b/.test(attrs)) return full;
      const clean = label.replace(/&nbsp;/g, ' ').trim();
      if (!ADD_TO_CART_RE.test(clean)) return full;
      wrappedCount++;
      const inMap = /\{item\.\w+\}/.test(next);
      const itemProp = inMap ? ` item={{ title: item.title, price: item.price }}` : '';
      return `${ind}<AddToCart${itemProp}>\n${ind}  <button${attrs}>${label}</button>\n${ind}</AddToCart>`;
    });
    if (wrappedCount > 0) {
      uses.add('AddToCart');
      features.push(`cart: добавление в корзину (×${wrappedCount})`);
    }
  }

  // 3. Clean up comments & add imports / 'use client'
  if (client) {
    next = next.replace(/^\/\/ Интерактив \([^\n]*\n\n?/m, '');
    if (tabCategoryExpr) next = mergeModuleImport(next, '@/lib/catalog', ['filterCatalog', 'type SortMode']);
    next = mergeModuleImport(next, 'react', ['useState']);
  }
  if (uses.has('AddToCart')) {
    next = mergeModuleImport(next, '@/components/interactive/Cart', ['AddToCart']);
  }
  if (client && !/^['"]use client['"];/.test(next.trim())) {
    next = `'use client';\n` + next;
  }

  return { code: next, client, uses: [...uses], features };
}
