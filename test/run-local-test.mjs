// End-to-end self-test without internet: local fixture site + mock OpenAI-compatible LLM -> full CLI pipeline -> assertions.
// Usage: npm test   (needs: npm i && npx playwright install chromium)
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { serve } from './serve.mjs';
import { startMockLLM } from './mock-llm.mjs';
import { main } from '../src/cli.mjs';

const site = await serve(0);
const mock = await startMockLLM();
const url = `http://127.0.0.1:${site.address().port}/`;
const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'site-blueprint-test-'));
let failed = 0;
const ok = (cond, name) => { console.log(`${cond ? '  \x1b[32m✓\x1b[0m' : '  \x1b[31m✗\x1b[0m'} ${name}`); if (!cond) failed++; };

try {
  const t0 = Date.now();
  const code = await main([url, '--out', out, '--max-pages', '8', '--provider', 'custom', '--base-url', mock.url, '--api-key', 'test-key', '--model', 'glm-5.3-flash']);
  console.log(`\nПроверки (${((Date.now() - t0) / 1000).toFixed(0)} с):`);
  ok(code === 0, 'CLI завершился без ошибок');
  const [dir] = (await fsp.readdir(out)).map((d) => path.join(out, d));
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
  console.log(`\nРезультат теста: ${dir}`);
} catch (e) {
  console.error(e); failed++;
} finally {
  site.close(); mock.server.close();
}
console.log(failed ? `\n\x1b[31m${failed} проверок не прошло\x1b[0m` : '\n\x1b[32mВсе проверки пройдены\x1b[0m');
process.exit(failed ? 1 : 0);
