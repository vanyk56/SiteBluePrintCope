// End-to-end self-test without internet: local fixture site + mock OpenAI-compatible LLM -> full CLI pipeline -> assertions.
// Usage: npm test   (needs: npm i && npx playwright install chromium)
// The self-healing build (`next build` + visual regression) needs Next.js/React/Tailwind in node_modules. Offline it is
// skipped (--deps skip) unless SB_TEST_NEXT_MODULES (or SB_NEXT_MODULES) points to an existing node_modules with next:
//   SB_TEST_NEXT_MODULES=/path/to/some-next-app/node_modules npm test
// Unit tests: npm run test:unit · real browser extension: npm run test:extension
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { serve } from './serve.mjs';
import { startMockLLM } from './mock-llm.mjs';
import { main } from '../src/cli.mjs';

const site = await serve(0);
const mock = await startMockLLM();
const url = `http://127.0.0.1:${site.address().port}/`;
const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'site-blueprint-test-'));
const nextModules = process.env.SB_TEST_NEXT_MODULES || process.env.SB_NEXT_MODULES || '';
const withBuild = !!nextModules && fs.existsSync(path.join(nextModules, 'next', 'package.json'));
if (withBuild) process.env.SB_NEXT_MODULES = nextModules;
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}`); if (!cond) failed++; };

try {
  const t0 = Date.now();
  const code = await main([url, '--out', out, '--max-pages', '9', '--provider', 'custom', '--base-url', mock.url, '--api-key', 'test-key', '--model', 'glm-5.3-flash', ...(withBuild ? [] : ['--deps', 'skip'])]);
  console.log(`\nПроверки (${((Date.now() - t0) / 1000).toFixed(0)} с${withBuild ? ', со сборкой Next.js' : ', без сборки — нет SB_TEST_NEXT_MODULES'}):`);
  ok(code === 0, 'CLI завершился без ошибок');
  const [dir] = (await fsp.readdir(out, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'node_modules').map((d) => path.join(out, d.name));
  const read = (f) => fsp.readFile(path.join(dir, f), 'utf8').catch(() => '');
  const has = async (f) => !!(await fsp.stat(path.join(dir, f)).catch(() => null));
  const bp = await read('SITE_CLONE_BLUEPRINT.md');
  ok(bp.startsWith('# SITE_CLONE_BLUEPRINT'), 'SITE_CLONE_BLUEPRINT.md создан');
  ok(bp.includes('Ты Senior Frontend инженер. Используя спецификацию ниже, собери проект на Next.js + Tailwind CSS'), 'мастер-промпт в начале');
  for (const h of ['## 2. Дизайн-токены', '## 3. Ассеты', '## 4. Контент 1:1', '## 5. Архитектура проекта', '## 6. Компоненты', '## 7. Скрытый контент', '## 9. QA'])
    ok(bp.includes(h), `раздел «${h.replace(/^## /, '')}»`);
  ok(/#6d28d9/i.test(bp) && bp.includes('--color-primary'), 'цвета → токены Tailwind (@theme)');
  ok(bp.includes('Brand Display') && bp.includes('@font-face'), 'шрифты и @font-face');
  ok(/export function \w+(Icon|Logo)\(/.test(bp) && bp.includes('viewBox='), 'SVG-иконки как TSX-код');
  ok(bp.includes('Запускайте продукты') && bp.includes('Простые и честные тарифы'), 'тексты 1:1');
  ok(bp.includes('разница пересчитывается пропорционально'), 'скрытые ответы FAQ (<details>)');
  ok(bp.includes('Документация') && bp.includes('group-hover:block'), 'выпадающее меню из hover-пробы');
  ok(/HeroSection|PricingSection|Footer/.test(bp) && bp.includes('export function Header()'), 'компоненты Header/HeroSection/PricingSection/Footer');
  ok(bp.includes('(mock)') && mock.stats.calls > 0, `LLM вызвана (${mock.stats.calls} запросов, скриншотов: ${mock.stats.images})`);
  ok([...mock.stats.auth].every((a) => a === 'Bearer test-key') && mock.stats.models.has('glm-5.3-flash'), 'ключ и модель передаются в OpenAI-совместимом формате');
  const crawl = JSON.parse(await read('data/crawl.json') || '{}');
  ok((crawl.pages || []).length >= 5, `обход: ${(crawl.pages || []).length} страниц`);
  ok(!(crawl.pages || []).some((p) => /private/.test(p.url)) && (crawl.skipped || []).some((s) => /private/.test(s.url)), 'robots.txt соблюдён (/private пропущен)');
  for (const f of ['project/package.json', 'project/app/layout.tsx', 'project/app/page.tsx', 'project/app/globals.css', 'project/components/icons.tsx', 'project/components/layout/Header.tsx', 'project/components/sections/HeroSection.tsx', 'screenshots/desktop/index.png', 'screenshots/mobile/index.png', 'dom/index.html', 'data/design-tokens.json', 'content/index.md'])
    ok(await has(f), f);
  const dom = await read('dom/index.html');
  ok(dom && !/<script\b/i.test(dom), 'чистый DOM без <script>');
  const css = await read('project/app/globals.css');
  ok(css.includes('@import "tailwindcss"') && css.includes('@theme'), 'globals.css в формате Tailwind v4');
  // optional: syntax check of generated TSX if esbuild is available
  let esbuild = null; try { esbuild = await import('esbuild'); } catch {}
  if (esbuild) {
    const files = [];
    const walk = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
    await walk(path.join(dir, 'project'));
    let bad = 0;
    for (const f of files) { try { await esbuild.transform(await fsp.readFile(f, 'utf8'), { loader: 'tsx', jsx: 'automatic' }); } catch (e) { bad++; console.log('    ' + f + ': ' + String(e.message).split('\n')[0]); } }
    ok(bad === 0, `TSX компилируется (esbuild, ${files.length} файлов)`);
  }
  // ---- shop page: lazy fade-in cards, per-card colours, filters, rule tabs, drawer/modal, canvas, font subsets ----
  const shopRec = JSON.parse(await read('data/pages/shop.json') || '{}');
  const shopImgs = ((shopRec.raw && shopRec.raw.images) || []).filter((im) => /\/shop\/p-\d+\.webp/.test(im.src));
  ok(new Set(shopImgs.map((im) => im.src)).size === 48 && shopImgs.every((im) => im.local), `все 48 лениво загружаемых картинок товаров найдены и скачаны (${new Set(shopImgs.map((im) => im.src)).size})`);
  const proj = [];
  const walkP = async (d) => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') await walkP(p); } else if (/\.(tsx?|css)$/.test(e.name)) proj.push({ p, text: await fsp.readFile(p, 'utf8') }); } };
  await walkP(path.join(dir, 'project'));
  const shopTsx = proj.filter((f) => f.text.includes('Каталог товаров')).map((f) => f.text).join('\n');
  const cardRows = (shopTsx.match(/\{ color: "#[0-9a-f]{6}"/g) || []).length;
  ok(/\.map\(\(item, i\) => (?:i (?:[<>]=?|===) \d+ && (?:i < \d+ && )?)?(?:\w+Shown\.has\(item\) && )?\(\s*<article/.test(shopTsx) && /--item-color/.test(shopTsx) && /var\(--item-color\)/.test(shopTsx) && cardRows >= 40, `карточки товаров → один шаблон .map() (порядок исходника сохранён) + цвета свечения через CSS-переменную (строк данных: ${cardRows})`);
  ok(!/секция усечена/.test(shopTsx), 'секция магазина не усечена по лимиту');
  ok(/disabled/.test(shopTsx) && shopTsx.includes('Недоступно') && shopTsx.includes('Вайп-блок'), 'особая карточка (бейдж + disabled-кнопка) сохранена');
  ok(/line-clamp-2/.test(shopTsx) && !/flow-root[^"]*line-clamp-2/.test(shopTsx), 'line-clamp-2 без конфликтующего display');
  ok(/&nbsp;₽|\\u00a0₽/.test(shopTsx), 'неразрывные пробелы в ценах сохранены (&nbsp; / \\u00a0)');
  const allTsx = proj.map((f) => f.text).join('\n');
  ok(/colSpan=\{3\}/.test(allTsx) && /scope="col"/.test(allTsx), 'таблица: colSpan и scope');
  ok(/canvas-shop-\d+\.png/.test(allTsx) && await has('project/public/images/canvas-shop-1.png'), 'canvas → статичный снимок в каркасе');
  const leftovers = [...proj, { p: 'SITE_CLONE_BLUEPRINT.md', text: bp }].filter((f) => /[\u0001-\u0007]/.test(f.text)).map((f) => path.basename(f.p));
  ok(!leftovers.length, `нет служебных маркеров в коде${leftovers.length ? ': ' + leftovers.join(', ') : ''}`);
  const sec7 = bp.slice(bp.indexOf('## 7. Скрытый контент'), bp.indexOf('## 8.'));
  ok(sec7.includes('2.1 Запрещены оскорбления') && sec7.includes('3.1 Нельзя строить в текстурах'), 'табы-кнопки без role=tab: тексты всех вкладок в разделе 7');
  ok(/фильтр карточек/.test(sec7) && /«Ресурсы»: видны \(16\)/.test(sec7) && /«Привилегии»: видны \(12\)/.test(sec7), 'фильтр категорий: состав каждой вкладки');
  ok(/Окно по кнопке «Корзина/.test(sec7) && /drawer/.test(sec7) && /Окно по кнопке «Вайпы серверов»/.test(sec7) && /dialog-\d+\.png/.test(sec7), 'корзина (drawer) и модалка вайпов со скриншотами');
  const gcss = await read('project/app/globals.css');
  ok((gcss.match(/font-family: "Shop Sans"/g) || []).length === 2 && /unicode-range: U\+400-45F/.test(gcss), 'шрифт с unicode-range: оба набора (латиница + кириллица)');
  ok(/ИИ-ботов/.test(bp) && ((crawl.robots && crawl.robots.aiBlocked) || []).includes('gptbot'), 'предупреждение: robots.txt закрывает сайт для ИИ-ботов');
  ok(/U\+0-FF|U\+0000-00FF/.test(gcss), 'латинский поднабор шрифта');
  // ---- v2: API sniffer → mock route handlers (redacted), trackers, clean asset names, snapshots, interactivity ----
  const apiIdx = JSON.parse(await read('data/api-mocks/index.json') || '{"entries":[]}');
  ok(apiIdx.entries.length >= 3 && apiIdx.entries.some((e) => e.path === '/api/products') && apiIdx.entries.some((e) => e.operation === 'GetReviews'), `API-моки: ${apiIdx.entries.length} (REST + GraphQL по operationName)`);
  ok(!apiIdx.entries.some((e) => /collect|analytics/.test(e.path)), 'аналитика (/collect) не попала в моки');
  const meMock = apiIdx.entries.find((e) => e.path === '/api/me');
  const meText = meMock ? await read(meMock.file) : '';
  ok(!!meMock && !meText.includes('ivan.petrov@nimbus.dev') && !meText.includes('tok_live_9f8e7d6c5b4a3210') && !meText.includes('Иван Петров') && apiIdx.redaction.replaced >= 3, `/api/me: e-mail, токен и имя заменены (замен: ${apiIdx.redaction.replaced})`);
  ok(await has('project/app/api/[...route]/route.ts') && await has('project/mocks/registry.ts') && await has('project/lib/mock-api.ts'), 'catch-all route handler + registry + lib/mock-api.ts');
  const nextCfg = (await read('project/next.config.mjs')) || (await read('project/next.config.ts')) || (await read('project/next.config.js'));
  ok(/source: "\/graphql", destination: "\/api\/__mock\/graphql"/.test(nextCfg), 'next.config: rewrite /graphql → мок');
  const tr = (crawl.trackers && crawl.trackers.found) || [];
  ok(tr.some((x) => x.id === 'ga' && x.ids.includes('G-TEST123')) && tr.some((x) => x.id === 'gtm'), `трекеры задокументированы: ${tr.map((x) => x.name + (x.ids.length ? ' ' + x.ids.join(',') : '')).join('; ')}`);
  ok(!proj.some((f) => /googletagmanager|gtag\(|google-analytics/.test(f.text)), 'трекеры не попали в код клона');
  const pub = [];
  const walkPub = async (d, rel = '') => { for (const e of await fsp.readdir(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) await walkPub(path.join(d, e.name), r); else pub.push(r); } };
  await walkPub(path.join(dir, 'project/public')).catch(() => {});
  const dirty = pub.filter((f) => /[?&%=#\s]|[0-9a-f]{16}/i.test(path.basename(f)) || path.basename(f).length > 70);
  ok(pub.length >= 50 && !dirty.length, `имена ассетов чистые (${pub.length} файлов${dirty.length ? '; плохие: ' + dirty.slice(0, 3).join(', ') : ''})`);
  ok(crawl.assets && crawl.assets.dedup >= 1 && pub.filter((f) => /team-1/.test(f)).length === 1, `дубликаты по содержимому → один файл (dedup: ${crawl.assets && crawl.assets.dedup})`);
  ok(pub.filter((f) => f.startsWith('fonts/')).length >= 4, `шрифты: ${pub.filter((f) => f.startsWith('fonts/')).join(', ')}`);
  const snapIndex = await read('snapshots/index.html'); const snapShop = await read('snapshots/shop.html');
  ok(snapIndex.length > 5000 && snapShop.length > 5000 && !/<script\b/i.test(snapIndex + snapShop) && /\.\.\/project\/public\//.test(snapShop) && /href="\.\/pricing\.html"/.test(snapIndex), 'автономные снимки (SingleFile): без скриптов, ассеты локально, ссылки между страницами');
  const inter = ['Cart', 'Modal', 'MobileMenu', 'Disclosure'].map((n) => proj.find((f) => f.p.endsWith(path.join('components', 'interactive', n + '.tsx'))));
  ok(inter.every((f) => f && /^'use client';/.test(f.text)), 'интерактивные компоненты (корзина, модалки, меню, раскрытия) — "use client"');
  ok(/\w+Shown\.has\(item\)|\w+View\.map\(/.test(shopTsx), 'фильтр категорий действительно применяется к карточкам (а не только подсвечивает вкладку)');
  ok(proj.some((f) => f.text.includes('Правила сервера') && /const \[tab, setTab\] = useState/.test(f.text) && /Panels\[tab\]\[0\]/.test(f.text)), 'вкладки правил без role="tabpanel": состояние объявлено, текст переключается');
  ok(/filterCatalog/.test(shopTsx) && /useState/.test(shopTsx) && await has('project/lib/catalog.ts'), 'каталог: фильтр категорий на useState (поиск/сортировка — опция --catalog-tools)');
  const vr = await read('VERIFICATION_REPORT.md');
  ok(vr.startsWith('# VERIFICATION_REPORT'), 'VERIFICATION_REPORT.md создан');
  if (withBuild) {
    const sc = JSON.parse(await read('verify/selfcheck.json') || '{}');
    ok(sc.build && sc.build.ok, `next build проходит (итераций: ${sc.build && sc.build.iterations})`);
    ok(sc.visual && sc.visual.average >= 0.95 && sc.visual.min >= 0.85, `визуальная регрессия (цель: среднее ≥ 95%, минимум ≥ 85%): среднее ${sc.visual ? (sc.visual.average * 100).toFixed(1) : '—'}%, минимум ${sc.visual ? (sc.visual.min * 100).toFixed(1) : '—'}%`);
    ok(sc.links && sc.links.filter((l) => l.page).every((l) => l.ok), 'все скачанные страницы клона открываются (без 404/500)');
  } else ok(/Пропущена/.test(vr), 'сборка честно помечена как пропущенная');
  // ---- zip bundle for the AI coder ----
  const zipFile = dir + '.zip';
  const zst = await fsp.stat(zipFile).catch(() => null);
  let zipOk = false;
  if (zst) { const buf = await fsp.readFile(zipFile); const names = []; let o = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); const cnt = buf.readUInt16LE(o + 10); let q = buf.readUInt32LE(o + 16); for (let i = 0; i < cnt; i++) { const nl = buf.readUInt16LE(q + 28), el = buf.readUInt16LE(q + 30), cl = buf.readUInt16LE(q + 32); names.push(buf.slice(q + 46, q + 46 + nl).toString('utf8')); q += 46 + nl + el + cl; } const base = path.basename(dir) + '/'; zipOk = names.includes(base + 'SITE_CLONE_BLUEPRINT.md') && names.includes(base + 'project/package.json') && names.some((n) => n.startsWith(base + 'screenshots/')) && !names.some((n) => n.startsWith(base + 'data/pages/')); }
  ok(zipOk, `архив ${path.basename(zipFile)} для ИИ-кодера (${zst ? (zst.size / 1048576).toFixed(1) + ' МБ' : 'нет'})`);
  // ---- verify: the original compared with itself must match ----
  const { verify } = await import('../src/verify.mjs');
  const vcode = await verify(dir, { url: url.replace(/\/$/, ''), routes: '/,/shop', mobile: true });
  const rep = JSON.parse(await read('verify/report.json') || '[]');
  const okRows = rep.filter((r) => !r.fatal);
  const allFound = okRows.every((r) => r.sections.filter((x) => x.drift !== null).length >= r.sections.length * 0.8);
  const maxMissing = Math.max(0, ...okRows.map((r) => r.missing.length));
  ok(vcode === 0 && okRows.length === 4 && allFound && maxMissing <= 2 && (await read('verify/report.md')).includes('# Сверка клона'), `verify: оригинал vs сам себя — секции найдены, нет пропавших текстов (страниц×вьюпортов: ${okRows.length}, макс. пропущено: ${maxMissing})`);
  const vis = okRows.map((r) => r.visual).filter((x) => x !== undefined);
  ok(vis.length === 4 && vis.every((x) => x < 0.12) && await has('verify/index-desktop-compare.png'), `verify: визуальное отличие от самого себя мало (${vis.map((x) => (x * 100).toFixed(1) + '%').join(', ')})`);
  console.log(`\nРезультат теста: ${dir}`);
} catch (e) {
  console.error(e); failed++;
} finally {
  site.close(); mock.server.close();
}
console.log(failed ? `\n\x1b[31m${failed} проверок не прошло\x1b[0m` : '\n\x1b[32mВсе проверки пройдены\x1b[0m');
process.exit(failed ? 1 : 0);
