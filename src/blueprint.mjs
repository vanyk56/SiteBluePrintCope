// Stage 4: SITE_CLONE_BLUEPRINT.md (+ per-page detail files, content/*.md, data/design-tokens.json).
import path from 'node:path';
import { writeText, writeJSON, truncate, humanBytes, templateKey, normalizeUrl, sameSite } from './util.mjs';
import { TYPE_RU } from './analyze/site.mjs';
import { treeToMarkdown } from './output/content.mjs';
import { iconsFile, layoutFile, pageFile, PKG_VERSIONS } from './output/project.mjs';
import { buildGlobalsCss } from './output/theme.mjs';
import { frequentClasses } from './llm/prompts.mjs';
import { apiTable } from './output/api.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '_нет данных_');
const code = (lang, s) => { const fence = /```/.test(s) ? '````' : '```'; return `${fence}${lang}\n${String(s).replace(/\s+$/, '')}\n${fence}`; };
const pct = (u) => Object.entries(u || {}).filter(([, v]) => v >= 1).map(([k, v]) => `${({ text: 'текст', bg: 'фон', border: 'рамки', button: 'кнопки', link: 'ссылки' })[k] || k} ${Math.round(v)}%`).join(', ');
const demote = (md, by = 2) => String(md || '').replace(/^(#{1,4})\s/gm, (m, h) => '#'.repeat(Math.min(6, h.length + by)) + ' ');

// Exact page texts per component. fenced=true: each component's text goes into a ```md block with real heading levels
// (h1 = #), so the page outline never collides with the blueprint's own headings and nothing gets re-rendered.
function pageContent(site, p, { fenced = true, level = 4 } = {}) {
  const imgFor = (n) => { const im = p.raw.images[n.img]; return im ? { src: im.local || im.src, alt: im.alt } : null; };
  const det = new Map(((p.rec.probes && p.rec.probes.details) || []).map((x) => [x.q.trim(), x.a]));
  const parts = [];
  for (const s of p.sections) {
    const blk = p.blocks.find((b) => b.section === s);
    const g = site.globals.find((c) => c.page === p.slug && c.index === s.index); // shared blocks: printed once, on the page where they were first seen
    if (!blk && !g) continue;
    const name = blk ? blk.comp.name : g.name;
    const md = treeToMarkdown(s.node, { linkFor: site.linkFor, imgFor, hidden: { details: (q) => det.get(q) }, max: 30000, headingOffset: fenced ? 0 : level });
    if (!md.trim()) continue;
    const head = `${'#'.repeat(level)} ${name}${blk && blk.reused ? ' (общий блок)' : ''}`;
    const fence = md.includes('```') ? '~~~~' : '```';
    parts.push(fenced ? `${head}\n\n${fence}md\n${md}\n${fence}` : `${head}\n\n${md}`);
  }
  return parts.join('\n\n');
}

function imagesTable(site) {
  const rows = []; const seen = new Set();
  for (const p of site.pages) {
    const secAt = (y) => { const s = p.sections.find((x) => y >= x.node.r[1] && y < x.node.r[1] + x.node.r[3]); if (!s) return ''; const b = p.blocks.find((bb) => bb.section === s); const g = site.globals.find((c) => c.page === p.slug && c.index === s.index); return (b && b.comp.name) || (g && g.name) || TYPE_RU[s.type] || s.type; };
    for (const im of p.raw.images || []) {
      const key = im.local || im.src; if (!key || seen.has(key)) continue; seen.add(key);
      rows.push([im.local ? '`' + im.local + '`' : '⚠ не скачано: ' + truncate(im.src, 80), im.alt || '—', im.nw && im.nh ? `${im.nw}×${im.nh}` : '—', `${im.w}×${im.h}`, `${p.route} · ${secAt(im.y)}`]);
    }
    for (const b of p.raw.bgImages || []) {
      const key = b.local || b.src; if (!key || seen.has(key) || String(b.src).startsWith('data:')) continue; seen.add(key);
      rows.push([b.local ? '`' + b.local + '` (фон)' : '⚠ фон не скачан: ' + truncate(b.src, 80), '—', '—', `${b.w}×${b.h}`, `${p.route}${b.size ? ' · background-size ' + b.size : ''}`]);
    }
  }
  return rows;
}

function internalTargets(site) {
  const crawled = new Set(site.pages.map((p) => p.route.split('?')[0]));
  const out = new Map();
  for (const p of site.pages) for (const l of p.raw.links || []) {
    if (!sameSite(l.href, site.origin, true)) continue;
    const L = site.linkFor(l.href); if (!L.internal) continue;
    const r = L.href.split('#')[0].split('?')[0] || '/';
    if (crawled.has(r) || /\.(pdf|zip|png|jpe?g|svg|webp|mp4|xml|txt)$/i.test(r)) continue;
    if (!out.has(r)) out.set(r, l.text || '');
  }
  return [...out.entries()].slice(0, 60);
}

function templateGroups(site) {
  const g = new Map();
  for (const p of site.pages) { if (p === site.home) continue; const k = templateKey(p.rec.finalUrl); if (!k.includes('*')) continue; const sig = p.sections.map((s) => s.type).join('>'); const key = k + '|' + sig; if (!g.has(key)) g.set(key, { key: k, pages: [] }); g.get(key).pages.push(p); }
  return [...g.values()].filter((x) => x.pages.length >= 2);
}

const CARD_NAME = { features: 'FeatureCard', pricing: 'PricingCard', testimonials: 'TestimonialCard', team: 'TeamMemberCard', blog: 'PostCard', faq: 'FaqItem', stats: 'StatItem', logos: 'LogoItem', footer: 'FooterColumn', gallery: 'GalleryItem', tabs: 'TabButton', header: 'NavItem', hero: 'HeroItem', cta: 'CtaItem', form: 'FormField' };
function cardCandidates(site) {
  const out = []; const names = new Set();
  for (const c of site.components) for (const k of (c.render && c.render.cards) || []) {
    let base = CARD_NAME[c.type] || c.name.replace(/(Section)?$/, 'Item');
    let name = base, i = 2; while (names.has(name)) name = base + i++;
    names.add(name);
    const note = k.mode === 'template' ? (k.name ? `данные: \`${k.name}\`` : 'одинаковые элементы')
      : k.mode === 'mixed' ? `данные: \`${k.name || '—'}\`; часть элементов оформлена иначе → проп \`variant\``
      : k.mode === 'full' ? `элементы различаются оформлением (${k.variants} варианта) → проп \`variant\`/\`featured\``
      : 'первые элементы в разметке, остальные — массивом данных (текст, картинка, ссылка)';
    out.push({ name, where: c.name, count: k.count, fields: k.fields || [], note });
  }
  return out;
}

// tab groups (role=tab or rows of toggle buttons): content tabs -> text of each tab, filters -> which items stay visible
function tabGroupLines(g) {
  const items = g.items || [];
  const common = new Set(items.length ? items[0].heads || [] : []);
  for (const it of items) { const hs = new Set(it.heads || []); for (const h of [...common]) if (!hs.has(h)) common.delete(h); }
  const others = items.filter((x) => !x.active);
  // filter = other tabs only hide items (nothing new appears) and the set of visible item headings changes
  const isFilter = others.length > 0 && others.every((x) => x.removed > 0 && x.addedLines <= 2) && items.some((x) => (x.heads || []).some((h) => !common.has(h)));
  const kind = isFilter ? 'фильтр карточек (useState + .filter по категории)' : 'переключение содержимого (useState, содержимое каждого таба — ниже)';
  const L = [`- **${g.heuristic ? 'Кнопки-переключатели' : 'Табы (role="tab")'} «${g.labels.join(' / ')}»** — ${kind}; по умолчанию активен «${g.active}»:`];
  for (const it of items) {
    const hs = (it.heads || []).filter((h) => !common.has(h));
    const parts = [];
    if (it.panel && !isFilter) parts.push(truncate(it.panel.replace(/\n+/g, ' / '), 700));
    else if (it.added && it.addedLines && !isFilter) parts.push(truncate(it.added.replace(/\n+/g, ' / '), 700));
    if (hs.length && (isFilter || !parts.length)) parts.push(`видны (${hs.length}): ${truncate(hs.join(' · '), 600)}`);
    if (it.active && !parts.length) parts.push('содержимое по умолчанию — уже в разметке секции');
    if (parts.length) L.push(`  - «${it.label}»${it.active ? ' (активен)' : ''}: ${parts.join(' — ')}`);
  }
  return L.length > 1 ? L : [];
}
// overlays opened by a click (cart drawer, modal, popup)
function dialogLines(d, vp) {
  const W = vp.w || 1440, H = vp.h || 900; const L = [];
  for (const o of d.overlays || []) {
    const R = (o.panel && o.panel.rect) || o.rect; const [x, y, w, h] = R;
    const bg = (o.panel && o.panel.bg) || o.bg; const rad = (o.panel && o.panel.radius) || o.radius;
    const kind = h >= H * 0.9 && x + w >= W - 2 && w < W * 0.75 ? 'выезжающая справа панель (drawer)'
      : h >= H * 0.9 && x <= 2 && w < W * 0.75 ? 'выезжающая слева панель (drawer)'
        : w >= W * 0.9 && y + h >= H - 2 && h < H * 0.8 ? 'нижняя шторка (bottom sheet)'
          : w >= W * 0.9 && h >= H * 0.9 ? 'полноэкранный слой' : 'модальное окно по центру';
    const props = [kind, `${w}×${h}px`, bg ? `фон ${bg}` : '', rad && rad !== '0px' ? `скругление ${rad}` : '', o.blur ? `backdrop ${o.blur}` : '', d.backdrop ? `подложка ${d.backdrop.bg}${d.backdrop.blur ? ' + ' + d.backdrop.blur : ''}` : '', o.modal ? 'aria-modal' : ''].filter(Boolean).join(', ');
    L.push(`- **Окно по кнопке «${truncate(d.trigger, 60)}»** (${props})${o.label ? ` «${truncate(o.label, 80)}»` : ''}: ${truncate(String(o.text || '').replace(/\n+/g, ' / '), 800)}${d.screenshot ? ` — скриншот \`${d.screenshot}\`` : ''}`);
  }
  return L;
}

function hoverLines(site, max = 14) {
  const out = []; const seen = new Set();
  const fmtTf = (v) => {
    if (!v || v === 'none') return 'нет';
    const m = /^matrix\(([^)]+)\)$/.exec(v); if (!m) return v;
    const [a, b, c, d, e, f] = m[1].split(',').map(Number);
    const tr = (e ? `translateX(${e}px) ` : '') + (f ? `translateY(${f}px)` : '');
    if (a === 1 && b === 0 && c === 0 && d === 1) return tr.trim() || 'нет';
    if (b === 0 && c === 0) return (`scale(${a}${a !== d ? ', ' + d : ''}) ` + tr).trim();
    return v;
  };
  const fmtDiff = (d0) => {
    const d = { ...d0 };
    if (d.border && d.color && d.border[1] === d.color[1]) delete d.border; // border-color follows currentColor
    return Object.entries(d).map(([k, [a, b]]) => {
      const name = ({ color: 'цвет', bg: 'фон', border: 'рамка', shadow: 'тень', opacity: 'прозрачность', transform: 'сдвиг/масштаб', decoration: 'подчёркивание', filter: 'filter', bgi: 'фон-картинка', scale: 'scale', translate: 'translate' })[k] || k;
      const f = (v) => (k === 'transform' ? fmtTf(v) : /^#[0-9a-f]{6}00$/i.test(v || '') ? 'прозрачный' : truncate(v || 'нет', 60));
      return `${name}: ${f(a)} → ${f(b)}`;
    }).join('; ');
  };
  for (const p of site.pages) for (const h of (p.rec.probes && p.rec.probes.hover) || []) {
    if (!h.diff || !Object.keys(h.diff).length) continue;
    const k = h.sig + JSON.stringify(h.diff); if (seen.has(k)) continue; seen.add(k);
    out.push(`- «${truncate(h.text || h.sig, 50)}» (${h.area || 'main'}, ${p.route}): ${fmtDiff(h.diff)}${h.reveals ? ` — при наведении показывает: «${truncate(h.reveals, 120)}»` : ''}`);
    if (out.length >= max) return out;
  }
  return out;
}

function masterPrompt(site, llm, ctx) {
  const t = site.tokens; const host = new URL(site.origin).host;
  const fonts = Object.keys(t.fontMap || {}).join(', ') || (t.fonts.body && t.fonts.body.family) || '—';
  const L = [
    `Ты Senior Frontend инженер. Используя спецификацию ниже, собери проект на Next.js + Tailwind CSS, который визуально и по контенту 1:1 повторяет сайт ${site.origin} (${site.pages.length} стр.: ${site.pages.map((p) => p.route).join(', ')}).`,
    '',
    'Стек и правила:',
    `1. Next.js (App Router, TypeScript, Server Components по умолчанию) + Tailwind CSS v4 (CSS-first: \`@import "tailwindcss"\` и \`@theme\` в app/globals.css, конфиг tailwind.config не нужен). Без UI-библиотек и CSS-in-JS. Версии: next ${PKG_VERSIONS.next}, react ${PKG_VERSIONS.react}, tailwindcss ${PKG_VERSIONS.tailwindcss}.`,
    '2. Стартовый проект уже сгенерирован в папке `project/` (layout, страницы, секции, иконки, токены, картинки и шрифты в public/). Начни с него: `cd project && npm install && npm run dev`. Не переписывай с нуля — доводи каркас до пиксель-в-пиксель по скриншотам.',
    `3. Дизайн-токены — раздел 2 (цвета bg-primary / text-foreground / border-border…, шрифты ${fonts}, тени shadow-*). Новые цвета и размеры не придумывай: бери значения из токенов и из классов каркаса.`,
    '4. Тексты — раздел 4 и код компонентов: переносить дословно (пунктуация, регистр, эмодзи, неразрывные пробелы). Ничего не сокращай и не перефразируй.',
    '5. Иконки и логотипы — components/icons.tsx (раздел 3, SVG как код). Картинки и шрифты уже лежат в public/, пути в коде прописаны.',
    `6. Адаптив mobile-first: классы без префикса = мобильная версия (${site.home.mob ? site.home.mob.raw.viewport.w : 390}px), префиксы sm:/md:/lg: = десктоп (${site.home.raw.viewport.w}px). Брейкпоинты взяты из media queries исходника. Сверяйся со скриншотами \`screenshots/desktop/*.png\`, \`screenshots/mobile/*.png\` и кадрами секций \`screenshots/sections/\`.`,
    '7. Интерактив (раздел 7) уже частично работает: `components/interactive/` — `<MobileMenu>` (бургер, isOpen), `<ModalTrigger>` (модалки), `<CartProvider>/<CartButton>/<AddToCart>` (корзина), `<Disclosure>` (aria-expanded), а секции с табами/фильтрами — клиентские (`\'use client\'` + useState, `filterCatalog` из `lib/catalog.ts`: категория, поиск, сортировка по цене). Сохрани эти компоненты и их состояние; где в начале файла секции стоит `// Интерактив (…)` — допиши вручную (маленькие клиентские компоненты, useState). Hover-состояния и transitions уже есть в классах, скрытый контент (ответы FAQ, панели табов, пункты меню) уже извлечён.',
    '8. Повторяющиеся элементы держи в массивах данных + .map() (как в каркасе). Индивидуальные цвета карточек заданы CSS-переменными (`style={{ \'--item-color\': item.color }}` + классы с `var(--item-color)`) — сохрани этот приём. Общие кнопки/карточки вынеси в components/ui (раздел 5).',
    '9. Где в разделе 6 написано «DOM мобильной версии отличается» — адаптив делай по мобильному скриншоту. Canvas/WebGL/видео-фоны — по скриншоту и ассетам.',
    '10. Не подключай аналитику, трекеры, чат-виджеты и сторонние скрипты исходника. Внешние ссылки оставь как есть.',
    '11. Неразрывные пробелы (`&nbsp;` в JSX, `\\u00a0` в строках данных) стоят там же, где в исходнике (цены, единицы, предлоги) — не заменяй их обычными пробелами.',
    '12. Табы, фильтры, корзина/модальные окна — в разделе 7 есть содержимое каждого таба, состав каждого фильтра и вид каждого окна со скриншотом.',
    '13. Готово, когда выполнен чек-лист раздела 9: каждая секция совпадает со скриншотом на десктопе и мобильном, `npm run build` проходит без ошибок, а `site-blueprint heal <папка>` (сборка + визуальная регрессия → `VERIFICATION_REPORT.md`) показывает сходство не ниже целевого и `site-blueprint verify <папка> --url http://localhost:3000` не находит расхождений.',
  ];
  if (site.api && site.api.count) L.push(`14. Данные, которые исходник подгружал через fetch/XHR (${site.api.count} ответ(ов), раздел 7 → «API и данные»), уже записаны в \`project/mocks/data/*.json\` и отдаются маршрутом \`app/api/[...route]/route.ts\` (реестр \`mocks/registry.ts\`, хелперы \`lib/mock-api.ts\`). Клиентские компоненты запрашивают тот же путь, что и оригинал (\`/api/...\`; другие пути перенаправлены rewrites в next.config) — мок вернёт записанный ответ. Персональные данные и токены в моках заменены заглушками — не возвращай настоящие. Когда появится свой бэкенд, замени мок на реальный запрос.`);
  const add = llm && llm.globalSections && [...llm.globalSections.entries()].find(([k]) => /мастер|промпт|prompt/i.test(k));
  if (add && add[1].trim()) L.push('', `Особенности этого сайта (анализ ${llm.model}):`, add[1].trim());
  if (ctx.templates.length) L.push('', 'Страницы одного шаблона: ' + ctx.templates.map((g) => `${g.key} (${g.pages.map((p) => p.route).join(', ')})`).join('; ') + ' — сделай один динамический маршрут [slug] + массив данных.');
  void host;
  return L.join('\n');
}

export async function writeBlueprint(site, outDir, { llm = null, llmInfo = {}, project = null, budget = 450000, version = '1.0.0' } = {}) {
  const t = site.tokens;
  const ctx = { templates: templateGroups(site) };
  const pageFiles = new Map();
  const llmFor = (c) => { if (!llm) return ''; const pr = llm.pages.get(c.page); return (pr && pr.byComponent.get(c.name)) || ''; };
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const compBlock = (c, { withCode }) => {
    const L = [`#### ${c.name} — ${TYPE_RU[c.type] || c.type}`, '', `\`${c.file}\` · страницы: ${[...c.usedOn].map((s) => (site.pages.find((p) => p.slug === s) || {}).route || s).join(', ')}${c.heading ? ` · «${truncate(c.heading, 70)}»` : ''}`];
    if (c.shot) L.push('', `![${c.name}](${c.shot})`);
    L.push('', '**Факты (DOM/CSS):**', ...c.facts.map((f) => '- ' + f));
    const n = llmFor(c); if (n) L.push('', `**Визуальный разбор (${llm.model}):**`, '', demote(n, 3));
    if (c.render.notes.length && !c.facts.some((f) => c.render.notes.includes(f))) L.push('', '> ' + c.render.notes.join(' '));
    if (withCode) L.push('', code('tsx', c.code));
    else L.push('', `_Код: \`project/${c.file}\` (не включён в этот файл из-за размера)._`);
    return L.join('\n');
  };

  const render = (mode) => {
    // mode: 'full' | 'home' (code only for layout + home) | 'none'
    const S = [];
    const llmTag = llm ? `${llm.model} (${llm.provider}${llm.vision ? ', со скриншотами' : ', без скриншотов'})` : `не использовалась${llmInfo.reason ? ' — ' + llmInfo.reason : ''}`;
    S.push(`# SITE_CLONE_BLUEPRINT — ${site.home.raw.meta.title || new URL(site.origin).host}`, '');
    S.push(`> Источник: ${site.origin} · снято ${date} · страниц: ${site.pages.length} · десктоп ${site.home.raw.viewport.w}px / мобильный ${site.home.mob ? site.home.mob.raw.viewport.w + 'px' : '—'} · LLM: ${llmTag} · site-blueprint ${version}`, '');
    S.push('## 0. Мастер-промпт для ИИ-кодера', '', 'Скопируй блок ниже в Cursor / Claude Code / Codex / Windsurf вместе с этим файлом и папкой `project/`.', '', code('text', masterPrompt(site, llm, ctx)), '');
    S.push('**Оглавление:** 1. Обзор · 2. Дизайн-токены · 3. Ассеты (SVG, картинки, шрифты) · 4. Контент 1:1 · 5. Архитектура · 6. Компоненты (код) · 7. Скрытый контент и интерактив · 8. Адаптив и анимации · 9. QA-чеклист', '');

    // 1. overview
    S.push('## 1. Обзор сайта', '');
    S.push(table(['Маршрут', 'Title', 'Секции', 'Файл', 'Скриншоты'], site.pages.map((p) => [p.route, truncate(p.raw.meta.title || '', 70), p.sections.map((s) => TYPE_RU[s.type] || s.type).join(' → '), `${p.appDir}/page.tsx`, `${p.rec.shots && p.rec.shots.desktop ? p.rec.shots.desktop : '—'}${p.rec.mobile && p.rec.mobile.screenshot ? ', ' + p.rec.mobile.screenshot : ''}`])), '');
    const tech = site.home.raw.tech || [];
    S.push(`- **Технологии исходника (по признакам):** ${tech.join(', ') || 'не определены'}`);
    S.push(`- **Язык:** ${site.home.raw.meta.lang || '—'} · **фон страницы:** ${t.pageBg} · **основной шрифт:** ${(t.fonts.body && t.fonts.body.family) || '—'}${t.fonts.heading && t.fonts.heading.family !== (t.fonts.body && t.fonts.body.family) ? ` · **заголовки:** ${t.fonts.heading.family}` : ''}`);
    if (site.crawl.skipped && site.crawl.skipped.length) S.push(`- **Пропущено при обходе:** ${site.crawl.skipped.length} URL (подробно: data/crawl.json → skipped)${site.crawl.robots && site.crawl.robots.rules ? ' · robots.txt учтён' : ''}`);
    const tr = site.crawl.trackers || {};
    const trNames = [...new Set([...(tr.found || []).map((x) => x.name + (x.ids && x.ids.length ? ' (' + x.ids.slice(0, 3).join(', ') + ')' : '')), ...(tr.blocked || []).map((x) => x.name)])];
    if (trNames.length) S.push(`- **Аналитика/трекеры/виджеты исходника (в клон не перенесены):** ${trNames.slice(0, 12).join(', ')}${(tr.blocked || []).length ? ` · заблокировано запросов при обходе: ${(tr.blocked || []).reduce((a, x) => a + (x.count || 0), 0)}` : ''}`);
    if (site.api && site.api.count) S.push(`- **API исходника:** записано ${site.api.count} ответ(ов) fetch/XHR → мок-API в \`project/app/api/[...route]/route.ts\` (раздел 7 → «API и данные»)`);
    const aiB = (site.crawl.robots && site.crawl.robots.aiBlocked) || [];
    if (aiB.length) S.push(`- **⚠ robots.txt закрывает сайт для ИИ-ботов** (${aiB.slice(0, 8).join(', ')}${aiB.length > 8 ? '…' : ''}): владелец против использования контента нейросетями. Используй клон только с разрешения владельца или как основу со своим контентом.`);
    for (const g of ctx.templates) S.push(`- **Шаблон ${g.key}:** ${g.pages.map((p) => p.route).join(', ')} — одинаковая структура, сделай \`app${g.key.replace(/\/\*/g, '/[slug]')}/page.tsx\` и данные для каждой записи.`);
    const gd = llm && llm.globalSections && [...llm.globalSections.entries()].find(([k]) => /дизайн-язык|design/i.test(k));
    if (gd) S.push('', `### Дизайн-язык (анализ ${llm.model})`, '', demote(gd[1], 2));
    S.push('');

    // 2. tokens
    S.push('## 2. Дизайн-токены', '', '### 2.1 Цвета', '');
    S.push(table(['Токен (Tailwind)', 'HEX', 'Роль', 'Где используется', 'CSS-переменная исходника'], t.colors.map((c) => [`\`${c.name}\` → bg-${c.name} / text-${c.name}`, `\`${c.hex}\``, c.role || '—', pct(c.usage) || '—', c.cssVar ? '`' + c.cssVar + '`' : '—'])), '');
    if (t.gradients.length) S.push('**Градиенты:**', ...t.gradients.slice(0, 8).map((g) => `- \`${g.value}\` ×${g.count}`), '');
    S.push('### 2.2 Типографика', '');
    S.push(table(['Семейство', 'Tailwind', 'Стек', 'Доля текста'], (t.fonts.all || []).slice(0, 6).map((f) => [f.family, t.fontMap[f.family] ? `font-${t.fontMap[f.family]}` : '—', `\`${f.stack}\``, (f.share ?? '—') + '%'])), '');
    S.push(table(['Роль', 'Шрифт', 'Размер', 'Насыщ.', 'Интерлиньяж', 'Трекинг', 'Регистр', 'Цвет'], t.typeScale.map((x) => [x.role, x.family, x.size + 'px', x.weight, x.lineHeight, x.letterSpacing ? x.letterSpacing + 'em' : '0', x.transform && x.transform !== 'none' ? x.transform : '—', `${x.color}${t.colorMap[x.color] ? ' (' + t.colorMap[x.color] + ')' : ''}`])), '');
    S.push(`Шкала размеров: ${t.fontSizes.map((f) => `${f.px}px (${f.tw})`).join(', ')}`, '', `Насыщенности: ${t.fontWeights.map((w) => `${w.weight} ×${w.count}`).join(', ')}`, '');
    S.push('### 2.3 Отступы, контейнеры, скругления, тени', '');
    const sp = t.spacing || {};
    S.push(`- **Шаг сетки:** ${sp.base || 4}px (кратно 4: ${sp.gridFit ? sp.gridFit.on4 : '—'}%, кратно 8: ${sp.gridFit ? sp.gridFit.on8 : '—'}%)`);
    S.push(`- **Отступы (частые):** ${(sp.values || []).slice().sort((a, b) => b.count - a.count).slice(0, 14).sort((a, b) => a.px - b.px).map((v) => v.px + 'px').join(', ')}`);
    S.push(`- **Вертикальные отступы секций (верх/низ):** ${t.sectionPadding.map((s) => s.value + 'px ×' + s.count).join(', ') || '—'}`);
    S.push(`- **Контейнеры (max-width):** ${t.containers.map((c) => c.px + 'px ×' + c.count).join(', ') || '—'}`);
    S.push(`- **Скругления:** ${t.radii.map((r) => r.value + (/^\d+$/.test(r.value) ? 'px' : '') + ' ×' + r.count).join(', ') || '—'}`);
    if (t.shadows.length) S.push('- **Тени:**', ...t.shadows.slice(0, 8).map((s) => `  - ${s.name ? '`shadow-' + s.name + '` = ' : ''}\`${s.value}\` ×${s.count}`));
    S.push('', '### 2.4 Брейкпоинты, анимации, переходы', '');
    S.push(`- **Media queries исходника:** ${t.breakpoints.map((b) => `${b.type}-width ${b.px}px ×${b.count}`).join(', ') || 'не найдены'} · основной для каркаса: \`${site.bp.prefix}:\` (${site.bp.px}px); у отдельных элементов префикс выбран по их собственным media-правилам`);
    if (t.transitions.length) S.push(`- **Transitions:** ${t.transitions.slice(0, 6).map((x) => '`' + x.value + '` ×' + x.count).join(', ')}`);
    const kfs = Object.keys(t.keyframes || {});
    if (kfs.length) S.push(`- **@keyframes:** ${kfs.slice(0, 20).join(', ')}${site.keyframesUsed.size ? ` (в компонентах используются: ${[...site.keyframesUsed].join(', ')})` : ''}`);
    S.push('', '### 2.5 app/globals.css (Tailwind v4)', '', code('css', buildGlobalsCss(site)), '');

    // 3. assets
    S.push('## 3. Ассеты', '', `### 3.1 SVG-иконки и логотипы (${site.icons.length})`, '');
    S.push(table(['Компонент', 'Размер', 'Где', 'Рядом с текстом', 'Кол-во', 'Файл'], site.icons.map((i) => [`\`<${i.name} />\`${i.logo ? ' (логотип)' : ''}`, `${i.w}×${i.h}`, [...i.where].slice(0, 4).join(', ') || [...i.pages].join(', '), i.label ? '«' + truncate(i.label, 40) + '»' : '—', i.count ? `${i.count}${i.pages.size > 1 ? ` (${i.pages.size} стр.)` : ''}` : 'моб.', `public/${i.file}`])), '');
    const icons = iconsFile(site);
    S.push(icons.length < 90000 || mode === 'full' ? code('tsx', icons) : `_Код иконок: \`project/components/icons.tsx\` (${humanBytes(icons.length)})._`, '');
    const imgs = imagesTable(site);
    S.push(`### 3.2 Изображения (${imgs.length})`, '', table(['Файл (public)', 'alt', 'Оригинал', 'На странице', 'Где'], imgs.slice(0, 250)), '');
    if (imgs.length > 250) S.push(`_…ещё ${imgs.length - 250}, полный список — data/crawl.json → assets._`, '');
    S.push('### 3.3 Шрифты', '', table(['Семейство', 'Насыщ.', 'Стиль', 'Символы', 'Файл'], (site.crawl.fonts || []).map((f) => [f.family, f.weight, f.style, f.subset || (f.unicodeRange ? truncate(f.unicodeRange, 40) : 'все'), f.web ? '`public' + f.web + '`' : '⚠ не скачан: ' + truncate(f.url, 80)])), '');
    if ((site.crawl.fonts || []).some((f) => f.unicodeRange)) S.push('_Шрифт разбит на наборы символов (unicode-range): все файлы уже подключены в globals.css с теми же диапазонами — кириллица и латиница грузятся отдельно, удалять «лишние» файлы нельзя._', '');
    if ((t.googleFonts || []).length) S.push(`Google Fonts: ${t.googleFonts.join(', ')} — подключи через \`next/font/google\`.`, '');
    const m = site.home.raw.meta;
    S.push('### 3.4 Favicon и соцсети', '', `- favicon: ${(m.favicons || []).map((f) => f.local ? '`public' + f.local + '`' : f.href).join(', ') || '—'}`, `- og:image: ${m.ogImageLocal ? '`public' + m.ogImageLocal + '`' : m.ogImage || '—'}`, `- theme-color: ${m.themeColor || '—'}`, '');

    // 4. content
    S.push('## 4. Контент 1:1', '', 'Тексты в порядке появления на странице, по компонентам. Общие блоки (шапка, подвал) — один раз, на первой странице, где они встретились. Обозначения внутри блоков: `#`…`######` — заголовок h1…h6, `[текст](url)` — ссылка, `![alt](src)` — картинка, `[кнопка]`, `- [поле …]` — поле формы, `>` — цитата, пустая строка разделяет повторяющиеся карточки.', '');
    for (const p of site.pages) {
      const c = pageContent(site, p);
      S.push(`### ${p.route} — ${truncate(p.raw.meta.title || p.slug, 80)}`, '', `title: «${p.raw.meta.title || ''}»${p.raw.meta.description ? ` · description: «${p.raw.meta.description}»` : ''}`, '', c || '_нет текстового контента_', '');
    }

    // 5. architecture
    S.push('## 5. Архитектура проекта', '');
    const rows = [['├─ app/', ''], ['│  ├─ layout.tsx', 'общие блоки: ' + (site.globals.map((g) => g.name).join(', ') || '—')], ['│  ├─ globals.css', 'токены Tailwind v4 (@theme)']];
    for (const p of site.pages) rows.push([`│  ├─ ${p.appDir.replace(/^app\/?/, '') ? p.appDir.replace(/^app\//, '') + '/page.tsx' : 'page.tsx'}`, p.route]);
    rows.push(['├─ components/', ''], ['│  ├─ icons.tsx', site.icons.length + ' SVG-компонентов'], ['│  ├─ layout/', site.globals.map((g) => g.name + '.tsx').join(', ') || '—'], ['│  ├─ sections/', site.components.filter((c) => !c.global).length + ' секций'], ['│  └─ ui/', '(создай) Button, Container, Card…'], ['└─ public/', 'images/, fonts/, icons/, svg/']);
    const padTo = Math.min(48, Math.max(...rows.map(([a]) => a.length)) + 2);
    const tree = ['project/', ...rows.map(([a, b]) => (b ? a.padEnd(padTo) + '← ' + b : a))];
    S.push(code('text', tree.join('\n')), '');
    S.push(table(['Компонент', 'Тип', 'Файл', 'Страницы', 'Адаптив'], site.components.map((c) => [c.name, TYPE_RU[c.type] || c.type, c.file, truncate([...c.usedOn].map((sl) => (site.pages.find((x) => x.slug === sl) || {}).route || sl).join(', '), 160), c.render.responsive ? 'mobile+desktop' : site.home.mob ? 'по скриншоту' : 'только десктоп'])), '');
    const cards = cardCandidates(site);
    if (cards.length) {
      S.push('**Под-компоненты (карточки из повторяющихся элементов):** в каркасе они развёрнуты через `.map()` по массиву данных — вынеси разметку элемента в отдельный компонент:', '');
      S.push(table(['Компонент', 'Где', 'Кол-во', 'Props (поля массива данных)', 'Заметка'], cards.map((c) => [`\`components/ui/${c.name}.tsx\``, c.where, c.count, c.fields.length ? c.fields.map((f) => '`' + f + '`').join(', ') : '—', c.note])), '');
    }
    const fc = frequentClasses(site);
    if (fc.length) S.push('### 5.1 Кандидаты в UI-примитивы (повторяющиеся классы)', '', ...fc.map((f) => `- \`<${f.tag}>\` ×${f.count}: \`${f.cls}\``), '');
    const prim = llm && llm.globalSections && [...llm.globalSections.entries()].find(([k]) => /примитив|primitive/i.test(k));
    if (prim) S.push(`### 5.2 UI-примитивы (${llm.model})`, '', demote(prim[1], 2), '');
    const order = llm && llm.globalSections && [...llm.globalSections.entries()].find(([k]) => /порядок|план|order/i.test(k));
    if (order) S.push(`### 5.3 Порядок сборки (${llm.model})`, '', demote(order[1], 2), '');

    // 6. components
    S.push('## 6. Компоненты', '', '### 6.1 Layout', '', code('tsx', layoutFile(site)), '');
    for (const c of site.globals) S.push(compBlock(c, { withCode: mode !== 'none' }), '');
    for (const p of site.pages) {
      const own = p.blocks.filter((b) => !b.reused);
      S.push(`### 6.${site.pages.indexOf(p) + 2} Страница ${p.route}`, '', `Скриншоты: \`${(p.rec.shots && p.rec.shots.desktop) || '—'}\`${p.rec.mobile && p.rec.mobile.screenshot ? ` · \`${p.rec.mobile.screenshot}\`` : ''}`, '', code('tsx', pageFile(site, p)), '');
      const reused = p.blocks.filter((b) => b.reused).map((b) => b.comp.name);
      if (reused.length) S.push(`Повторно используемые блоки: ${[...new Set(reused)].join(', ')} (описаны выше).`, '');
      const withCode = mode === 'full' || (mode === 'home' && p === site.home);
      for (const b of own) S.push(compBlock(b.comp, { withCode }), '');
      const pr = llm && llm.pages.get(p.slug);
      const other = pr && pr.byComponent.get('_other');
      if (other) S.push(`**Прочие заметки ${llm.model}:**`, '', demote(other, 3), '');
    }

    // 7. hidden content & interactions
    S.push('## 7. Скрытый контент и интерактив', '');
    const ready = site.components.filter((c) => (c.render.features || []).length || (c.render.client || []).length);
    if (ready.length) {
      S.push('**Уже реализовано в `project/` (рабочее состояние, не заглушки):**', '');
      for (const c of ready) S.push(`- \`${c.file}\`${c.client ? ' (`\'use client\'`)' : ''}: ${[...(c.render.features || []), ...(c.render.client || []).map((x) => '`<' + x + '>`')].join('; ')}`);
      if (site.cart) S.push(`- \`app/layout.tsx\`: \`<CartProvider>\` — корзина «${site.cart.title || 'Корзина'}» (дроуэр ${site.cart.look && site.cart.look.side === 'left' ? 'слева' : 'справа'}${site.cart.look && site.cart.look.width ? ', ' + site.cart.look.width + 'px' : ''}), состояние в localStorage, без реальной оплаты.`);
      S.push('');
    }
    const seen7 = new Set(); let dup7 = 0;
    const once = (key) => { if (seen7.has(key)) { dup7++; return false; } seen7.add(key); return true; };
    for (const p of site.pages) {
      const pr = p.rec.probes || {}; const L = [];
      for (const d of pr.dropdowns || []) if (once('dd|' + d.label + '|' + (d.links || []).map((l) => l.href).join(','))) L.push(`- **Выпадающее меню «${d.label}»** (hover): ${(d.links || []).map((l) => `[${l.text}](${site.linkFor(l.href).href})`).join(' · ') || truncate(d.text, 300)}${d.screenshot ? ` — \`${d.screenshot}\`` : ''}`);
      if (p.rec.mobile && p.rec.mobile.burger && once('burger|' + p.rec.mobile.burger.text)) { const b = p.rec.mobile.burger; L.push(`- **Мобильное меню (бургер):** ${String(b.text || '').split('\n').map((x) => x.trim()).filter(Boolean).join(' · ')}${b.screenshot ? ` — \`${b.screenshot}\`` : ''}`); }
      for (const x of pr.tabs || []) if (once('tab|' + x.label + '|' + String(x.text || '').slice(0, 300))) L.push(`- **Таб «${x.label}»:** ${truncate(String(x.text || '').replace(/\n+/g, ' / '), 500)}`);
      for (const g of pr.tabGroups || []) if (once('tg|' + g.labels.join('|') + '|' + g.items.map((x) => (x.added || x.panel || '').slice(0, 80)).join('|'))) L.push(...tabGroupLines(g));
      for (const d of pr.dialogs || []) if (once('dlg|' + d.trigger + '|' + d.overlays.map((o) => String(o.text || '').slice(0, 160)).join('|'))) L.push(...dialogLines(d, p.raw.viewport || {}));
      for (const m of p.raw.media || []) if (m.snapshot && once('cv|' + m.snapshot)) L.push(`- **Canvas/WebGL ${m.w || ''}${m.h ? '×' + m.h : ''}:** в исходнике рисуется скриптом; в каркас подставлен статичный снимок \`project/public${m.snapshot}\` — при желании замени анимацией.`);
      for (const x of pr.details || []) if (once('det|' + x.q + '|' + String(x.a || '').slice(0, 200))) L.push(`- **Аккордеон «${truncate(x.q, 120)}»:** ${truncate(String(x.a || '').replace(/\n+/g, ' '), 600)}`);
      for (const x of pr.expand || []) if (x.text && once('exp|' + x.label + '|' + String(x.text).slice(0, 200))) L.push(`- **Раскрывающийся блок «${truncate(x.label, 100)}»:** ${truncate(String(x.text).replace(/\n+/g, ' '), 500)}`);
      for (const f of p.raw.forms || []) {
        if (!once('form|' + f.action + '|' + f.fields.map((x) => x.name || x.label).join(','))) continue;
        L.push(`- **Форма** \`${f.method.toUpperCase()} ${f.action || '(без action)'}\` → кнопка «${f.submit}»:`);
        for (const fl of f.fields) L.push(`  - ${fl.tag}${fl.type ? '[' + fl.type + ']' : ''} \`${fl.name || '—'}\`: «${fl.label || fl.placeholder || ''}»${fl.placeholder ? ` placeholder «${fl.placeholder}»` : ''}${fl.required ? ' · обязательное' : ''}${fl.options ? ' · варианты: ' + fl.options.join(' / ') : ''}`);
      }
      if (L.length) S.push(`### ${p.route}`, '', ...L, '');
    }
    if (!seen7.size) S.push('_Скрытого интерактивного контента не найдено._', '');
    if (dup7) S.push(`_Интерактив общих блоков (шапка, повторяющиеся секции) описан один раз — у первой страницы, где он встретился (повторов пропущено: ${dup7})._`, '');
    const at = apiTable(site.api);
    if (at.length) {
      const red = site.api.redaction || {};
      const redLine = Object.entries(red.kinds || {}).filter(([, v]) => v).map(([k, v]) => `${k} ×${v}`).join(', ');
      S.push('### API и данные (мок-API)', '', 'Ответы fetch/XHR/GraphQL, записанные при обходе. В проекте их отдаёт `app/api/[...route]/route.ts` по методу, пути, query и operationName (GraphQL); JSON лежит в `project/mocks/data/`, пути вне `/api` перенаправлены rewrites в `next.config.mjs`.', '', ...at, '');
      S.push(red.enabled === false
        ? '_⚠ Редакция секретов выключена (`--no-redact`): проверь моки вручную перед публикацией. Трекинговые запросы (аналитика, пиксели, beacon) не записывались._'
        : `_Секреты и персональные данные заменены заглушками (заголовки Authorization/Cookie удалены${redLine ? '; замены: ' + redLine : ''}). Трекинговые запросы (аналитика, пиксели, beacon) не записывались._`, '');
    }
    const hv = hoverLines(site);
    if (hv.length) S.push('### Hover-состояния (замерены в браузере)', '', ...hv, '');
    S.push('### SEO', '', table(['Маршрут', 'title', 'description', 'og:title'], site.pages.map((p) => [p.route, p.raw.meta.title || '—', truncate(p.raw.meta.description || '—', 160), truncate(p.raw.meta.ogTitle || '—', 80)])), '');

    // 8. responsive & motion
    S.push('## 8. Адаптив и анимации', '');
    for (const c of site.components) {
      const notes = [];
      const mob = c.facts.find((f) => f.startsWith('Блок:')); if (mob && /мобильный/.test(mob)) notes.push(mob.replace(/^Блок: /, ''));
      for (const f of c.facts) if (/^(Повтор|CSS-анимации|Scroll-reveal анимации|Transitions|Интерактив)/.test(f)) notes.push(f);
      if (!c.render.responsive && site.home.mob) notes.push('⚠ мобильная версия — по скриншоту');
      if (/sticky|fixed/.test(c.code.slice(0, 400))) notes.push(/sticky/.test(c.code.slice(0, 400)) ? 'sticky' : 'fixed');
      S.push(`- **${c.name}:** ${notes.join(' · ') || '—'}`);
    }
    const waapi = site.pages.flatMap((p) => {
      const anims = p.raw.animations;
      const list = Array.isArray(anims) ? anims : (anims && Array.isArray(anims.webAnimations) ? anims.webAnimations : []);
      return list.map((a) => ({ ...a, route: p.route }));
    });
    if (waapi.length) {
      S.push('', '### 8.1 Web Animations API / Keyframes (зафиксированы в браузере)', '');
      const seenWa = new Set();
      for (const a of waapi) {
        const key = `${a.name}|${a.tag}.${a.cls}|${a.duration}`;
        if (seenWa.has(key)) continue;
        seenWa.add(key);
        S.push(`- \`<${a.tag}${a.cls ? '.' + a.cls : ''}>\` (${a.route}): \`${a.name}\` · ${a.duration}ms · ${a.easing}${a.iterations && a.iterations !== 1 ? ` · ×${a.iterations}` : ''}`);
        if (seenWa.size >= 15) break;
      }
    }
    const risks = llm && llm.globalSections && [...llm.globalSections.entries()].find(([k]) => /риск|risk/i.test(k));
    if (risks) S.push('', `### Риски (${llm.model})`, '', demote(risks[1], 2));
    S.push('');

    // 9. QA
    S.push('## 9. QA-чеклист', '');
    const Q = [];
    Q.push(`- [ ] \`npm run build\` проходит без ошибок и предупреждений TypeScript`);
    Q.push(`- [ ] Шрифты ${Object.keys(t.fontMap || {}).join(', ') || ''} реально загружаются (DevTools → Network → Font), нет FOUT/подмены`);
    Q.push(`- [ ] Цвета совпадают с токенами (пипеткой): фон ${t.pageBg}, текст ${t.roles.foreground || '—'}, акцент ${t.roles.primary || '—'}`);
    for (const p of site.pages) Q.push(`- [ ] ${p.route}: все секции (${p.sections.length}) совпадают со скриншотом на ${site.home.raw.viewport.w}px и ${site.home.mob ? site.home.mob.raw.viewport.w : 390}px — \`${(p.rec.shots && p.rec.shots.desktop) || ''}\``);
    const hvCount = site.pages.reduce((a, p) => a + ((p.rec.probes && p.rec.probes.hover) || []).filter((h) => h.diff && Object.keys(h.diff).length).length, 0);
    if (hvCount) Q.push(`- [ ] Hover-состояния (${hvCount} шт., раздел 7) и transitions`);
    const inter = new Set(site.components.flatMap((c) => c.render.interactive));
    if (inter.size) Q.push(`- [ ] Интерактив работает: ${[...inter].join(', ')}`);
    if (site.pages.some((p) => (p.raw.forms || []).length)) Q.push('- [ ] Формы: поля, подписи, placeholder, required, состояния focus/ошибки; отправка — заглушка или свой API');
    Q.push('- [ ] title/description/og на каждой странице (раздел 7 → SEO), favicon');
    Q.push('- [ ] Все картинки имеют корректные alt, нет битых путей в public/');
    const tg = internalTargets(site);
    if (tg.length) Q.push(`- [ ] Внутренние ссылки на непросканированные страницы (создай заглушки или оставь): ${tg.slice(0, 30).map(([r]) => '`' + r + '`').join(', ')}${tg.length > 30 ? ' …' : ''}`);
    Q.push('- [ ] Нет аналитики/трекеров/скриптов исходного сайта');
    if (site.api && site.api.count) Q.push('- [ ] Данные из API приходят из мок-API (`/api/...` → `mocks/data/*.json`), в моках нет настоящих токенов и персональных данных');
    Q.push('- [ ] `VERIFICATION_REPORT.md`: сборка ✅, сходство каждой страницы не ниже целевого (пересчёт: `site-blueprint heal <папка>`)');
    Q.push('- [ ] Автосверка: запусти клон (`npm run dev`) и `site-blueprint verify <папка этого blueprint> --url http://localhost:3000` → отчёт `verify/report.md` (высоты секций, битые картинки, ошибки консоли, горизонтальный скролл, % отличий скриншотов)');
    S.push(...Q, '');
    S.push('---', '', '**Файлы рядом с этим документом:** `project/` — стартовый Next.js-проект · `screenshots/` — desktop, mobile, sections, interactions, llm · `content/` — тексты страниц в Markdown · `pages/` — детальные спецификации страниц · `dom/` — очищенный HTML (без скриптов) · `data/` — сырые данные (crawl.json, pages/*.json, css/, design-tokens.json, api-mocks/, llm/) · `snapshots/` — автономные HTML-снимки страниц (SingleFile-подобные) · `VERIFICATION_REPORT.md` + `verify/` — результат автопроверки клона.', '');
    return S.join('\n');
  };

  let mode = 'full'; let md = render(mode);
  if (md.length > budget) { mode = 'home'; md = render(mode); }
  if (md.length > budget) { mode = 'none'; md = render(mode); }
  const file = path.join(outDir, 'SITE_CLONE_BLUEPRINT.md');
  await writeText(file, md);

  // per-page detail files + content
  for (const p of site.pages) {
    const L = [`# ${p.route} — ${p.raw.meta.title || p.slug}`, '', `Источник: ${p.rec.finalUrl} · файл \`project/${p.appDir}/page.tsx\``, '', code('tsx', pageFile(site, p)), ''];
    const blocks = [...(p === site.home ? site.globals.map((g) => ({ comp: g })) : []), ...p.blocks.filter((b) => !b.reused)];
    for (const b of blocks) L.push(compBlock(b.comp, { withCode: true }), '');
    const content = pageContent(site, p, { fenced: false, level: 2 });
    await writeText(path.join(outDir, 'content', p.slug + '.md'), `# ${p.route} — ${p.raw.meta.title || ''}\n\n${content}\n`);
    await writeText(path.join(outDir, 'pages', p.slug + '.md'), L.join('\n'));
    pageFiles.set(p.slug, `pages/${p.slug}.md`);
  }
  const { colorMap, shadowMap, fontMap, ...tokens } = t;
  await writeJSON(path.join(outDir, 'data', 'design-tokens.json'), { ...tokens, tailwind: { colorMap, shadowMap, fontMap, breakpoint: site.bp } });
  return { file, chars: md.length, mode, pageFiles };
}
