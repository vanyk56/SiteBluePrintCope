// Unit tests: Tailwind v4 / Lightning CSS sanitizer (src/analyze/cssvars.mjs) and JSX repairs (src/analyze/jsxfix.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { decodeArb, mapCssUrls, normalizeUrls, isDirty, CssVarRegistry, sanitizeClass, sanitizeClassList, sanitizeProjectClasses } from '../../src/analyze/cssvars.mjs';
import { fixNesting } from '../../src/analyze/jsxfix.mjs';

const SVG_BG = "bg-[url(data:image/svg+xml;utf8,<svg_xmlns='http://www.w3.org/2000/svg'_viewBox='0_0_8_8'><path_d='M0_0h8v8'_fill='%23f00'/></svg>)]";

test('decodeArb / mapCssUrls: "_" = пробел, "\\_" = подчёркивание, url() с кавычками и скобками внутри', () => {
  assert.equal(decodeArb('a_b\\_c'), 'a b_c');
  const seen = [];
  const out = mapCssUrls(`a url("data:image/svg+xml,<svg fill='rgb(1,2,3)'/>") b url( /img/x.png ) c URL('q.png')`, (inner, q) => { seen.push([inner, q]); return 'U'; });
  assert.equal(out, 'a U b U c U');
  assert.deepEqual(seen, [["data:image/svg+xml,<svg fill='rgb(1,2,3)'/>", '"'], ['/img/x.png', ''], ['q.png', "'"]]);
});

test('normalizeUrls: data:SVG экранируется и берётся в кавычки, base64 и обычные URL не портятся', () => {
  assert.equal(normalizeUrls('url(data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>)'),
    `url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0h1'/%3E%3C/svg%3E")`);
  assert.equal(normalizeUrls('url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)'), 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")', 'уже закодированное не кодируется дважды');
  assert.equal(normalizeUrls('url(data:image/png;base64,iVBORw0K==)'), 'url("data:image/png;base64,iVBORw0K==")');
  assert.equal(normalizeUrls('url(/img/a b.png) no-repeat, url("x.png")'), 'url("/img/a b.png") no-repeat, url("x.png")');
  assert.equal(normalizeUrls('url(data:image/svg+xml;utf8,<svg><g fill="#000">{x}</g></svg>)'), `url("data:image/svg+xml;utf8,%3Csvg%3E%3Cg fill='%23000'%3E%7Bx%7D%3C/g%3E%3C/svg%3E")`);
});

test('isDirty: длинные значения, data:-URL, url() с пробелами/кавычками, <>{};', () => {
  assert.equal(isDirty('#fff'), false);
  assert.equal(isDirty('linear-gradient(90deg,#000,#fff)'), false);
  assert.equal(isDirty('url(/a.png)'), false);
  assert.equal(isDirty('x'.repeat(141)), true);
  assert.equal(isDirty('url(data:image/png;base64,AAAA)'), true);
  assert.equal(isDirty("url('/a b.png')"), true);
  assert.equal(isDirty('a;b'), true);
});

test('sanitizeClass: проблемные arbitrary values → CSS-переменные в @theme static, варианты и ! сохраняются', () => {
  const reg = new CssVarRegistry();
  assert.equal(sanitizeClass(SVG_BG, reg), 'bg-(image:--sb-bgi-1)');
  assert.equal(sanitizeClass('md:hover:' + SVG_BG, reg), 'md:hover:bg-(image:--sb-bgi-1)', 'то же значение → та же переменная');
  assert.equal(sanitizeClass('bg-[#0f172a]', reg), null);
  assert.equal(sanitizeClass('bg-[url(/img/hero.png)]', reg), null, 'чистый url() остаётся в классе');
  assert.equal(sanitizeClass("content-['a;b']", reg), 'content-(--sb-content-1)');
  const longShadow = 'shadow-[' + Array.from({ length: 6 }, (_, i) => `0_${i}px_${i * 2}px_rgba(0,0,0,.${i})`).join(',') + ']';
  assert.equal(sanitizeClass('lg:!' + longShadow, reg), 'lg:!shadow-(--sb-shadow-1)');
  const clip = '[clip-path:polygon(' + Array.from({ length: 30 }, (_, i) => `${i}%_${100 - i}%`).join(',') + ')]';
  assert.equal(sanitizeClass(clip, reg), '[clip-path:var(--sb-clip-1)]');
  assert.equal(sanitizeClass('[mask-image:url(data:image/svg+xml;utf8,<svg/>)]', reg), '[mask-image:var(--sb-mask-1)]');
  assert.equal(sanitizeClass('[grid-template-areas:"a_b"_"c_d"]', reg), null, 'короткое безопасное значение не трогаем');
  assert.equal(sanitizeClass('flex', reg), null);
  const css = reg.css();
  assert.match(css, /^\/\* long \/ data-URI values moved out of class names/);
  assert.match(css, /@theme static \{/);
  assert.match(css, /--sb-bgi-1: url\("data:image\/svg\+xml;utf8,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 8 8'%3E%3Cpath d='M0 0h8v8' fill='%23f00'\/%3E%3C\/svg%3E"\);/);
  assert.match(css, /--sb-content-1: 'a;b';/);
  assert.match(css, /--sb-clip-1: polygon\(0% 100%,1% 99%/);
  assert.equal(reg.size, 5);
  assert.equal(new CssVarRegistry().css(), '');
});

test('sanitizeClassList: меняет только плохие классы и возвращает ту же строку, если менять нечего', () => {
  const reg = new CssVarRegistry();
  const clean = 'flex items-center gap-4 bg-[#fff]';
  assert.equal(sanitizeClassList(clean, reg), clean);
  assert.equal(sanitizeClassList(`relative ${SVG_BG}  p-4`, reg), 'relative bg-(image:--sb-bgi-1) p-4');
});

test('sanitizeProjectClasses: переписывает TSX (className, cls: в данных, шаблонные строки) и продолжает нумерацию', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-css-'));
  const w = async (f, t) => { await fsp.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fsp.writeFile(path.join(root, f), t); };
  await w('app/globals.css', '@import "tailwindcss";\n\n@theme static {\n  --sb-bgi-3: url("x.png");\n}\n');
  await w('components/Hero.tsx', `export function Hero() { return <section className="py-20 ${SVG_BG}">x</section>; }\n`);
  await w('lib/data.ts', `export const items = [{ cls: '${SVG_BG.replace(/'/g, "\\'")}' }, { cls: 'p-2' }];\n`);
  await w('components/Ok.tsx', 'export const Ok = () => <div className="flex" />;\n');
  await w('node_modules/x/index.tsx', `<div className="${SVG_BG}" />`);
  const changed = await sanitizeProjectClasses(root);
  assert.deepEqual(changed.sort(), ['app/globals.css', 'components/Hero.tsx', 'lib/data.ts']);
  assert.match(await fsp.readFile(path.join(root, 'components/Hero.tsx'), 'utf8'), /className="py-20 bg-\(image:--sb-bgi-4\)"/);
  assert.match(await fsp.readFile(path.join(root, 'lib/data.ts'), 'utf8'), /cls: 'bg-\(image:--sb-bgi-4\)'/);
  const g = await fsp.readFile(path.join(root, 'app/globals.css'), 'utf8');
  assert.match(g, /^@import "tailwindcss";\n+\/\* long/, 'блок вставлен сразу после @import');
  assert.match(g, /--sb-bgi-4: url\("data:/); assert.match(g, /--sb-bgi-3: url\("x\.png"\)/);
  assert.match(await fsp.readFile(path.join(root, 'node_modules/x/index.tsx'), 'utf8'), /url\(data:/, 'node_modules не трогаем');
  assert.deepEqual(await sanitizeProjectClasses(root), [], 'повторный запуск ничего не меняет');
});

test('fixNesting: HTML → JSX (class, for, комментарии, void-теги, SVG-атрибуты, style)', () => {
  const src = [
    '<div class="card"><!-- price -->',
    '  <label for="q" class="sr-only">Поиск</label><input id="q" type="search">',
    '  <img src="/a.png" alt=""><br></br><hr>',
    '  <svg viewBox="0 0 24 24"><path stroke-width="2" fill-rule="evenodd" stroke-linecap="round" d="M0 0"/></svg>',
    '  <p style="color: red; margin-top: 4px; --accent: #f00">x</p>',
    '</div>',
  ].join('\n');
  const out = fixNesting(src);
  assert.match(out, /<div className="card">\{\/\* price \*\/\}/);
  assert.match(out, /<label htmlFor="q" className="sr-only">/);
  assert.match(out, /<input id="q" type="search" \/>/);
  assert.match(out, /<img src="\/a\.png" alt="" \/><br \/><hr \/>/);
  assert.match(out, /<path strokeWidth="2" fillRule="evenodd" strokeLinecap="round" d="M0 0"\/>/);
  assert.match(out, /style=\{\{ color: 'red', marginTop: '4px', '--accent': '#f00' \}\}/);
  assert.equal(fixNesting(out), out, 'идемпотентно');
  const jsx = '<div className={cn("a", b && "c")} style={{ color: "red" }} onClick={() => go(1)}><img src={x} alt="" /></div>';
  assert.equal(fixNesting(jsx), jsx, 'корректный JSX не меняется');
});
