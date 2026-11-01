// Unit tests: interactive state (tabs, catalog filter/search/sort, cart, modal/menu props) + lib/catalog.ts helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { enhanceSection, dialogProps, cartProps, menuLinks, isCartDialog, clientImports, ADD_TO_CART_RE, INTERACTIVE_FILES } from '../../src/output/interactive.mjs';

const FOOD = ['Борщ', 'Плов', 'Пельмени'], DRINK = ['Морс', 'Квас', 'Чай'];
const titles = [...FOOD, ...DRINK];
const tabsData = { name: 'plans', fields: ['ariaSelected', 'bgClass', 'label'], rows: [
  { ariaSelected: true, bgClass: 'bg-primary', label: 'Все' }, { ariaSelected: false, bgClass: 'bg-muted', label: 'Еда' }, { ariaSelected: false, bgClass: 'bg-muted', label: 'Напитки' }] };
const gridData = { name: 'plans2', fields: ['title', 'price'], rows: titles.map((t, i) => ({ title: t, price: `${(i + 1) * 150}\u00a0₽` })) };
const SHOP = [
  "// Интерактив (tabs): добавь 'use client' и useState для открытия/переключения — см. раздел «Интерактив».",
  '',
  'const plans = [];', '', 'const plans2 = [];', '',
  'export function ShopSection() {',
  '  return (',
  '    <section className="py-16">',
  '      <div role="tablist" className="flex mb-6 gap-2">',
  '        {plans.map((item, i) => (',
  '          <button key={i} role="tab" aria-selected={item.ariaSelected} className={`px-4 ${item.bgClass}`}>{item.label}</button>',
  '        ))}',
  '      </div>',
  '      <div className="grid grid-cols-3 gap-4">',
  '        {plans2.map((item, i) => (',
  '          <article key={i} className="p-4">',
  '            <h3 className="font-bold">{item.title}</h3>',
  '            <span className="font-bold">{item.price}</span>',
  '            <button type="button" className="px-3">В корзину</button>',
  '          </article>',
  '        ))}',
  '        {/* элемент №7 оформлен иначе остальных (позиция 7 в исходнике) */}',
  '        <article className="p-4">',
  '          <h3 className="font-bold">Компот</h3>',
  '          <span className="font-bold">90&nbsp;₽</span>',
  '        </article>',
  '      </div>',
  '    </section>',
  '  );',
  '}', '',
].join('\n');
const shopGroups = [{ labels: ['Все', 'Еда', 'Напитки'], items: [
  { label: 'Все', active: true, heads: [...titles, 'Компот'] }, { label: 'Еда', heads: FOOD }, { label: 'Напитки', heads: [...DRINK, 'Компот'] }] }];

test('enhanceSection: табы → useState, каталог с фильтром по категории, поиском и сортировкой, «в корзину»', () => {
  const r = { data: [structuredClone(tabsData), structuredClone(gridData)] };
  const out = enhanceSection(SHOP, r, { tabGroups: shopGroups, lang: 'ru', catalogTools: true, cart: true });
  const c = out.code;
  assert.equal(out.client, true);
  assert.equal(c.split('\n')[0], "'use client';");
  assert.match(c, /import \{ useState \} from 'react';/);
  assert.match(c, /import \{ filterCatalog, type SortMode \} from '@\/lib\/catalog';/);
  assert.match(c, /import \{ AddToCart \} from '@\/components\/interactive\/Cart';/);
  assert.doesNotMatch(c, /Интерактив \(/, 'подсказка про use client убрана');
  assert.match(c, /const \[tab, setTab\] = useState\(0\);/);
  assert.match(c, /onClick=\{\(\) => setTab\(i\)\}/);
  assert.match(c, /aria-selected=\{i === tab\}/);
  assert.match(c, /\$\{i === tab \? "bg-primary" : "bg-muted"\}/);
  assert.match(c, /const plans2Category: \(string \| null\)\[\] = \["Еда","Еда","Еда","Напитки","Напитки","Напитки"\];/);
  assert.match(c, /const tabCategory: \(string \| null\)\[\] = \[null,"Еда","Напитки"\];/);
  assert.match(c, /const plans2View = filterCatalog\(plans2, \{ category: tabCategory\[tab\], categoryOf: \(_, k\) => plans2Category\[k\], query, sort, price: \(item\) => item\.price, text: \(item\) => \[item\.title\]\.join\(' '\) \}\);/);
  assert.match(c, /\{plans2View\.map\(\(item, i\) => \(/);
  assert.match(c, /<input type="search" value=\{query\}/);
  assert.match(c, /<option value="price-asc">Сначала дешевле<\/option>/);
  assert.match(c, /plans2View\.length === 0 \?/);
  assert.match(c, /<AddToCart item=\{\{ title: item\.title, price: item\.price \}\}>\n\s+<button type="button" className="px-3">В корзину<\/button>\n\s+<\/AddToCart>/);
  // the single item outside the data array follows the same filter (category by probe, search by its text)
  assert.match(c, /\{showItem\("Напитки", "Компот 90\\u00a0₽"\) && \(/);
  assert.match(c, /const showItem = \(cat: string \| null, text: string\) => \(!tabCategory\[tab\] \|\| tabCategory\[tab\] === cat\)/);
  assert.ok(out.features.some((f) => f.startsWith('catalog: фильтр «Все / Еда / Напитки»')));
  assert.ok(out.features.some((f) => f.startsWith('cart:')));
  // balanced JSX blocks: every opened wrapper is closed
  assert.equal((c.match(/<AddToCart\b/g) || []).length, (c.match(/<\/AddToCart>/g) || []).length);
});

test('enhanceSection: панели табов (role="tabpanel") переключаются на текст из пробы', () => {
  const code = [
    'const tabs = [];', '',
    'export function TabsSection() {', '  return (', '    <section>',
    '      <div role="tablist" className="flex gap-2">',
    '        {tabs.map((item, i) => (',
    '          <button key={i} role="tab" aria-selected={item.ariaSelected} className={`px-4 ${item.textClass}`}>{item.label}</button>',
    '        ))}',
    '      </div>',
    '      <div role="tabpanel" className="p-8">',
    '        <h3 className="font-bold">Шаг 1. Импорт</h3>',
    '        <p className="my-4">Подключите репозиторий.</p>',
    '      </div>',
    '    </section>', '  );', '}', ''].join('\n');
  const r = { data: [{ name: 'tabs', fields: ['ariaSelected', 'textClass', 'label'], rows: [
    { ariaSelected: true, textClass: 'text-white', label: 'Импорт' }, { ariaSelected: false, textClass: 'text-muted', label: 'Превью' }, { ariaSelected: false, textClass: 'text-muted', label: 'Масштаб' }] }] };
  const groups = [{ labels: ['Импорт', 'Превью', 'Масштаб'], items: [
    { label: 'Импорт', active: true, panel: 'Шаг 1. Импорт\n\nПодключите репозиторий.' },
    { label: 'Превью', panel: 'Шаг 2. Превью\n\nКаждая ветка — своё окружение.' },
    { label: 'Масштаб', panel: 'Шаг 3. Масштаб\n\nАвтоскейлинг по нагрузке.' }] }];
  const out = enhanceSection(code, r, { tabGroups: groups });
  assert.equal(out.client, true);
  assert.match(out.code, /const tabsPanels: string\[\]\[\] = \[\["Шаг 1\. Импорт","Подключите репозиторий\."\],\["Шаг 2\. Превью","Каждая ветка — своё окружение\."\],\["Шаг 3\. Масштаб","Автоскейлинг по нагрузке\."\]\];/);
  assert.match(out.code, /<h3 className="font-bold">\{tabsPanels\[tab\]\[0\]\}<\/h3>/);
  assert.match(out.code, /<p className="my-4">\{tabsPanels\[tab\]\[1\]\}<\/p>/);
  assert.ok(out.features[0].includes('переключение панелей'));
});

test('enhanceSection: без проб и корзины код не меняется; disabled-кнопки не оборачиваются', () => {
  const r = { data: [structuredClone(gridData)] };
  assert.deepEqual(enhanceSection(SHOP, r, {}), { code: SHOP, client: false, uses: [], features: [] });
  const dis = SHOP.replace('<button type="button" className="px-3">В корзину</button>', '<button type="button" disabled className="px-3">В корзину</button>');
  assert.equal(enhanceSection(dis, { data: [structuredClone(gridData)] }, { cart: true }).code, dis);
  // cart only (no tabs): AddToCart import merged into the existing import line, no 'use client' needed for the section
  const withImport = "import { CartButton } from '@/components/interactive/Cart';\n" + SHOP;
  const out = enhanceSection(withImport, { data: [structuredClone(gridData)] }, { cart: true });
  assert.equal(out.client, false);
  assert.match(out.code, /^\/\/ Интерактив \(tabs\)/m, 'необработанные табы остаются в подсказке');
  assert.match(out.code, /import \{ AddToCart, CartButton \} from '@\/components\/interactive\/Cart';/);
  assert.doesNotMatch(out.code, /^'use client';/m);
});

test('dialogProps / cartProps / isCartDialog: вид и тексты оверлея из пробы', () => {
  const vp = { w: 1440, h: 900 };
  const modal = { trigger: 'Вайпы серверов', overlays: [{ rect: [0, 0, 1440, 900], bg: '#00000099', label: 'Расписание вайпов', text: '×\nРасписание вайпов\nMain #1 — пятница\nClassic #2 — четверг', panel: { rect: [480, 200, 480, 300], bg: '#ffffff', radius: '16px' } }] };
  const p = dialogProps(modal, vp);
  assert.deepEqual(p.look, { side: 'center', width: 480, bg: '#ffffff', radius: '16px', backdrop: '#00000099', fg: '#111111' });
  assert.equal(p.title, 'Расписание вайпов');
  assert.deepEqual(p.lines, ['Main #1 — пятница', 'Classic #2 — четверг']);
  const cart = { trigger: 'Корзина · 0 ₽', overlays: [{ rect: [1060, 0, 380, 900], bg: '#12121a', text: '×\nКорзина\n\nВ корзине пока пусто.\n\nИтого: 0 ₽' }] };
  assert.equal(isCartDialog(cart), true);
  assert.equal(isCartDialog(modal), false);
  const c = cartProps(cart, vp);
  assert.equal(c.look.side, 'right'); assert.equal(c.look.width, 380); assert.equal(c.look.fg, '#f5f5f7');
  assert.equal(c.title, 'Корзина'); assert.equal(c.emptyText, 'В корзине пока пусто.'); assert.equal(c.totalLabel, 'Итого'); assert.equal(c.currency, '₽');
  assert.ok(ADD_TO_CART_RE.test('В корзину') && ADD_TO_CART_RE.test('Add to cart') && !ADD_TO_CART_RE.test('Подробнее'));
});

test('menuLinks: ссылки открытого меню, фолбэк по текстам ссылок страницы', () => {
  const linkFor = (h) => (h.startsWith('https://site.test') ? { href: new URL(h).pathname, internal: true } : { href: h, internal: false });
  assert.deepEqual(menuLinks({ links: [{ text: ' Тарифы ', href: 'https://site.test/pricing' }, { text: 'GitHub', href: 'https://github.com/x' }, { text: 'Тарифы', href: 'https://site.test/pricing' }] }, [], linkFor),
    [{ href: '/pricing', text: 'Тарифы' }, { href: 'https://github.com/x', text: 'GitHub', external: true }]);
  assert.deepEqual(menuLinks({ text: 'Блог\nО нас\nНеизвестно' }, [{ text: 'Блог', href: 'https://site.test/blog' }, { text: 'О нас', href: 'https://site.test/about' }], linkFor),
    [{ href: '/blog', text: 'Блог' }, { href: '/about', text: 'О нас' }]);
  assert.deepEqual(clientImports(['AddToCart', 'MobileMenu', 'CartButton']), ["import { AddToCart, CartButton } from '@/components/interactive/Cart';", "import { MobileMenu } from '@/components/interactive/MobileMenu';"]);
});

test('lib/catalog.ts: parsePrice / filterCatalog (TypeScript без сборки — type stripping Node 22.6+)', async (t) => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 18)) return t.skip('нужен Node с type stripping');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-cat-'));
  const f = path.join(dir, 'catalog.ts');
  await fsp.writeFile(f, INTERACTIVE_FILES['lib/catalog.ts']);
  const m = await import(pathToFileURL(f).href);
  assert.equal(m.parsePrice('1\u00a0050\u00a0₽'), 1050);
  assert.equal(m.parsePrice('$1,299.99'), 1299.99);
  assert.equal(m.parsePrice('12,50 €'), 12.5);
  assert.equal(m.parsePrice('1.234.567 ₽'), 1234567);
  assert.equal(m.parsePrice('от 990 руб.'), 990);
  assert.ok(Number.isNaN(m.parsePrice('бесплатно')));
  const items = [{ t: 'Борщ', p: '300 ₽', c: 'food' }, { t: 'Квас', p: '90 ₽', c: 'drink' }, { t: 'Плов', p: '450 ₽', c: 'food' }, { t: 'Подарок', p: 'бесплатно', c: 'food' }];
  const q = (o) => m.filterCatalog(items, { categoryOf: (x) => x.c, price: (x) => x.p, text: (x) => x.t, ...o }).map((x) => x.t);
  assert.deepEqual(q({ category: 'food' }), ['Борщ', 'Плов', 'Подарок']);
  assert.deepEqual(q({ query: 'кв' }), ['Квас']);
  assert.deepEqual(q({ sort: 'price-asc' }), ['Квас', 'Борщ', 'Плов', 'Подарок'], 'без цены — в конце');
  assert.deepEqual(q({ sort: 'price-desc', category: 'food' }), ['Плов', 'Борщ', 'Подарок']);
  assert.equal(m.formatPrice(3675, '₽'), '3\u00a0675\u00a0₽');
  await fsp.rm(dir, { recursive: true, force: true });
});
