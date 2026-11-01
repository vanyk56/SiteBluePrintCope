// Prompts for the LLM stage: per-page visual review of the generated skeleton + one global design/architecture pass.
import { TYPE_RU, sectionOutline } from '../analyze/site.mjs';
import { truncate } from '../util.mjs';

const LANG = { ru: 'Отвечай на русском языке.', en: 'Answer in English.' };

export const SYSTEM = [
  'Ты — senior frontend-инженер и дизайнер интерфейсов. Ты помогаешь воссоздать существующий сайт на Next.js (App Router) + Tailwind CSS v4.',
  'Тебе дают данные, извлечённые автоматически из браузера (DOM, computed CSS, тексты, ассеты), и скриншоты. Каркас компонентов уже сгенерирован по этим данным.',
  'Твоя задача — дополнить то, что машинный анализ не видит, и указать расхождения каркаса со скриншотами. Пиши кратко, конкретно, по делу, в Markdown.',
  'Никогда не выдумывай тексты, цифры, ссылки и бренды — весь контент уже извлечён 1:1. Используй классы Tailwind и токены, перечисленные в данных.',
].join('\n');

export function tokensBrief(site) {
  const t = site.tokens; const L = [];
  L.push('Цвета (класс → hex): ' + t.colors.slice(0, 18).map((c) => `${c.name}=${c.hex}${c.role ? ` (${c.role})` : ''}`).join(', '));
  const fm = Object.entries(t.fontMap || {}).map(([fam, k]) => `font-${k} = "${fam}"`);
  if (fm.length) L.push('Шрифты: ' + fm.join(', '));
  if (t.typeScale.length) L.push('Типографика: ' + t.typeScale.slice(0, 9).map((x) => `${x.role} ${x.size}px/${x.lineHeight} w${x.weight}${x.letterSpacing ? ` ls${x.letterSpacing}em` : ''}${x.transform && x.transform !== 'none' ? ' ' + x.transform : ''}`).join('; '));
  if (t.radii.length) L.push('Скругления: ' + t.radii.slice(0, 6).map((r) => r.value + 'px×' + r.count).join(', '));
  if (t.shadows.length) L.push('Тени: ' + t.shadows.slice(0, 4).map((s) => (s.name ? `shadow-${s.name}` : '') + ' ' + s.value).join('; '));
  if (t.containers.length) L.push('Контейнеры: ' + t.containers.slice(0, 4).map((c) => c.px + 'px').join(', '));
  L.push(`Основной брейкпоинт: ${site.bp.prefix} (${site.bp.px}px); скриншоты: десктоп ${site.home.raw.viewport.w}px, мобильный ${site.home.mob ? site.home.mob.raw.viewport.w : 390}px`);
  return L.join('\n');
}

export function frequentClasses(site, max = 8) {
  const cnt = new Map();
  for (const c of site.components) for (const m of c.code.matchAll(/<(Link|a|button)\b[^>]*?className="([^"]+)"/g)) { const k = m[1] === 'Link' ? 'a' : m[1]; const key = k + '|' + m[2]; cnt.set(key, (cnt.get(key) || 0) + 1); }
  return [...cnt.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, n]) => { const [tag, cls] = k.split('|'); return { tag, cls, count: n }; });
}

function sectionBlock(site, p, b, { withCode = true, codeMax = 3500 } = {}) {
  const c = b.comp; const s = b.section;
  const L = [`### ${c.name}`, `Тип: ${TYPE_RU[c.type] || c.type}${b.reused ? ` (общий компонент, уже описан на странице ${c.page})` : ''}${s.heading ? ` · заголовок «${truncate(s.heading, 80)}»` : ''}`];
  if (b.reused) return L.join('\n');
  L.push('Факты:', ...c.facts.map((f) => '- ' + f));
  L.push('Структура и тексты:', '```', sectionOutline(s.node, 1400), '```');
  if (withCode) L.push('Каркас (TSX, может быть сокращён):', '```tsx', truncate(c.render.jsx.replace(/^ {4}/gm, ''), codeMax), '```');
  return L.join('\n');
}

export function pagePrompt(site, p, { lang = 'ru', images = [], budget = 90000 } = {}) {
  const meta = p.raw.meta || {};
  const blocks = [...(p === site.home ? site.globals.filter((g) => g.page === p.slug).map((g) => ({ comp: g, section: p.sections.find((s) => s.index === g.index) })).filter((b) => b.section) : []), ...p.blocks].sort((a, b) => a.section.index - b.section.index);
  let withCode = true; let codeMax = 3500;
  const build = () => blocks.map((b) => sectionBlock(site, p, b, { withCode, codeMax })).join('\n\n');
  let body = build();
  if (body.length > budget) { codeMax = 1200; body = build(); }
  if (body.length > budget) { withCode = false; body = build(); }
  body = truncate(body, budget);
  const shots = images.length ? `Приложено скриншотов: ${images.length} — ${images.map((i) => i.label).join('; ')}. Листы идут сверху вниз по странице.` : 'Скриншотов нет (модель без зрения) — опирайся на данные.';
  const text = [
    `Страница: «${meta.title || p.slug}» — ${p.rec.finalUrl} (маршрут Next.js: ${p.route}, файл ${p.appDir}/page.tsx)`,
    shots, '',
    'Дизайн-токены (уже подключены в globals.css как классы Tailwind):', tokensBrief(site), '',
    'Секции страницы сверху вниз (имя компонента → данные):', '', body, '',
    '---',
    'ЗАДАНИЕ. Для КАЖДОЙ секции выше (кроме помеченных как «общий компонент, уже описан») напиши блок, который начинается строкой `### ИмяКомпонента` — ровно с тем же именем. Внутри блока до ~180 слов, пунктами:',
    '- **Визуал:** что видно на скриншоте, но не передано данными — декоративные фигуры и фоны, иллюстрации, бейджи, разделители, эффекты (blur, градиенты, тени), выравнивание и плотность.',
    '- **Сетка и адаптив:** колонки на десктопе и мобильном, что скрывается/переставляется, sticky/fixed.',
    '- **Интерактив и анимации:** hover, появление при скролле, слайдеры, табы, аккордеоны, меню — если видно или указано в фактах. То, что в фактах помечено «Уже работает в сгенерированном коде» (MobileMenu, ModalTrigger, CartButton/AddToCart, Disclosure, табы/фильтры каталога), не переписывай — только поправь вид, если он расходится со скриншотом.',
    '- **Правки каркаса:** только конкретные расхождения со скриншотом с точными Tailwind-классами. Если всё совпадает — напиши «Каркас соответствует скриншоту».',
    'Не повторяй тексты страницы и не переписывай каркас целиком. ' + (LANG[lang] || LANG.ru),
  ].join('\n');
  return text;
}

export function globalPrompt(site, { lang = 'ru', images = [] } = {}) {
  const L = [];
  L.push(`Сайт: ${site.origin} — «${site.home.raw.meta.title || ''}». Технологии исходника (по признакам): ${(site.home.raw.tech || []).join(', ') || 'не определены'}.`);
  L.push(images.length ? `Приложены скриншоты главной: ${images.map((i) => i.label).join('; ')}.` : 'Скриншотов нет.');
  L.push('', 'Страницы:');
  for (const p of site.pages) L.push(`- ${p.route} — «${truncate(p.raw.meta.title || '', 70)}»: ${p.sections.map((s) => TYPE_RU[s.type] || s.type).join(' → ')}`);
  L.push('', 'Компоненты (сгенерированы):');
  for (const c of site.components) L.push(`- ${c.name} (${TYPE_RU[c.type] || c.type}${c.global ? ', общий в layout' : ''}; страницы: ${[...c.usedOn].join(', ')})`);
  L.push('', 'Дизайн-токены:', tokensBrief(site));
  const fc = frequentClasses(site);
  if (fc.length) { L.push('', 'Часто повторяющиеся классы кнопок/ссылок (кандидаты в UI-примитивы):'); for (const f of fc) L.push(`- <${f.tag}> ×${f.count}: ${f.cls}`); }
  L.push('', '---', 'ЗАДАНИЕ. Напиши в Markdown ровно эти разделы:',
    '## Дизайн-язык',
    '5–8 пунктов: характер стиля, сетка и контейнер, ритм отступов, иерархия типографики, роли цветов (какие токены для чего), скругления/тени/бордеры, иконки и иллюстрации, анимации.',
    '## UI-примитивы',
    'Для 3–6 повторяющихся элементов (кнопки и их варианты, карточка, бейдж, поле ввода, контейнер секции) дай короткий TSX-компонент (Next.js + Tailwind v4, классы из токенов выше, без внешних библиотек; варианты через проп `variant`). Классы бери из данных, не выдумывай.',
    '## Порядок сборки',
    'Нумерованный план для разработчика: что сделать сначала, что вынести в общие компоненты, на что смотреть при сверке со скриншотами.',
    '## Риски',
    'Что легко упустить при клонировании именно этого сайта (шрифты, анимации, адаптив, интерактив, контент за взаимодействием).',
    '## Дополнения к мастер-промпту',
    '3–6 коротких строк-инструкций для ИИ-кодера, специфичных для этого сайта.',
    LANG[lang] || LANG.ru);
  return L.join('\n');
}

// "### Name" blocks -> Map(name -> text)
export function splitByComponent(text, names) {
  const out = new Map(); const known = new Set(names);
  const parts = String(text || '').split(/^#{2,4}\s+/m);
  const pre = parts.shift();
  for (const part of parts) {
    const nl = part.indexOf('\n'); const head = (nl < 0 ? part : part.slice(0, nl)).trim(); const body = nl < 0 ? '' : part.slice(nl + 1).trim();
    const name = (head.match(/[A-Z][A-Za-z0-9]+/g) || []).find((w) => known.has(w)) || [...known].find((n) => head.includes(n));
    if (name) out.set(name, ((out.get(name) || '') + '\n' + body).trim());
    else out.set('_other', ((out.get('_other') || '') + `\n#### ${head}\n${body}`).trim());
  }
  if (pre && pre.trim()) out.set('_intro', pre.trim());
  return out;
}

// "## Section" -> Map(title -> text)
export function splitSections(text) {
  const out = new Map(); const parts = String(text || '').split(/^##\s+/m); const pre = parts.shift();
  for (const part of parts) { const nl = part.indexOf('\n'); const head = (nl < 0 ? part : part.slice(0, nl)).trim().replace(/[*#]/g, ''); out.set(head, nl < 0 ? '' : part.slice(nl + 1).trim()); }
  if (pre && pre.trim()) out.set('_intro', pre.trim());
  return out;
}

// ---------- self-healing build: minimal patches for compile errors ----------
export const FIX_SYSTEM = [
  'You fix build errors in a generated Next.js 16 (App Router, TypeScript, React 19) + Tailwind CSS v4 project.',
  'Rules: change as little as possible; keep texts, classes and structure; never delete whole components;',
  "client hooks/handlers need 'use client' at the top of the file; custom elements need a JSX type declaration;",
  'do not add dependencies; do not touch package.json; keep components/interactive/* and lib/catalog.ts APIs (MobileMenu, ModalTrigger, CartProvider/CartButton/AddToCart, Disclosure, filterCatalog) — fix the call site instead.',
  'Answer ONLY with SEARCH/REPLACE blocks, one per change, exactly in this format:',
  'FILE: path/relative/to/project.tsx',
  '<<<<<<< SEARCH',
  'exact existing lines (copied verbatim, enough to be unique)',
  '=======',
  'replacement lines',
  '>>>>>>> REPLACE',
].join('\n');

export function fixPrompt({ files, output = '' }) {
  const L = ['`next build` failed. Fix the errors below.', ''];
  for (const f of files) {
    L.push(`### ${f.file}`, '', 'Errors:');
    for (const e of f.errors.slice(0, 8)) L.push(`- ${e.line ? `line ${e.line}${e.col ? ':' + e.col : ''}: ` : ''}${e.message}`);
    L.push('', '```tsx', f.text.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n'), '```', '');
  }
  if (output) L.push('Build output (tail):', '```', output.slice(-3000), '```', '');
  L.push('Line numbers ("  12| ") are for orientation only — do NOT include them in SEARCH/REPLACE blocks.');
  return L.join('\n');
}
