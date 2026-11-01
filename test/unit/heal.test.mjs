// Unit tests: self-healing build (src/verify/build.mjs) — error parsing for webpack/Turbopack/TypeScript output,
// SEARCH/REPLACE patches, deterministic fixers and the heal loop with a fake `next build` and a mock LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { parseBuildErrors, parsePatches, applyPatch, healProject, FIXERS } from '../../src/verify/build.mjs';

const TS_OUT = `   ▲ Next.js 16.0.1
   Creating an optimized production build ...
 ✓ Compiled successfully in 4.2s
   Linting and checking validity of types ...
Failed to compile.

./app/page.tsx:12:5
Type error: Type 'string' is not assignable to type 'number'.

  10 |   return (
  11 |     <main>
> 12 |       <Price value="12" />
     |       ^
  13 |     </main>
Next.js build worker exited with code: 1 and signal: null`;

const root = path.join(os.tmpdir(), 'out', 'shop-20250101-1200', 'project');
const TURBO_OUT = `\x1b[31mError\x1b[39m: Turbopack build failed with 2 errors:
./shop-20250101-1200/project/components/Hero.tsx:5:10
Parsing ecmascript source code failed
  3 | export function Hero() {
  4 |   return (
> 5 |     <div class="hero">
    |          ^
Expected '</', got '<eof>'

${root}/components/Icons.tsx:1:10
Export Star doesn't exist in target module
Module not found: Can't resolve './missing'

Import trace for requested module:
./components/Icons.tsx
./app/page.tsx`;

const MISC_OUT = `Error: You're importing a component that needs \`useState\`. This React Hook only works in a Client Component.
Error: Unexpected token BadUrl(":image/svg+xml;utf8,<svg") while optimizing generated CSS
Error occurred prerendering page "/pricing". Read more: https://nextjs.org/docs/messages/prerender-error
./app/globals.css:42:3
Parsing css source code failed
./components/Badge.tsx:3:10
Type error: Property 'nb-badge' does not exist on type 'JSX.IntrinsicElements'.`;

test('parseBuildErrors: TypeScript (webpack) с code frame', () => {
  const errs = parseBuildErrors(TS_OUT);
  assert.equal(errs.length, 1);
  assert.deepEqual({ ...errs[0], message: undefined }, { file: 'app/page.tsx', line: 12, col: 5, message: undefined, kind: 'type' });
  assert.match(errs[0].message, /not assignable to type 'number'/);
  assert.ok(!/\|/.test(errs[0].message), 'строки code frame не попадают в сообщение');
});

test('parseBuildErrors: Turbopack — ANSI, пути от корня общих зависимостей и абсолютные', () => {
  const errs = parseBuildErrors(TURBO_OUT, root);
  const hero = errs.find((e) => e.file === 'components/Hero.tsx');
  assert.ok(hero, JSON.stringify(errs));
  assert.equal(hero.line, 5); assert.equal(hero.kind, 'syntax'); assert.match(hero.message, /Expected '<\/', got '<eof>'/);
  const icons = errs.find((e) => e.file === 'components/Icons.tsx');
  assert.ok(icons); assert.equal(icons.kind, 'import');
  assert.ok(!errs.some((e) => /Import trace/.test(e.message)));
});

test('parseBuildErrors: ошибки без файла (client, CSS, prerender) и CSS / custom elements', () => {
  const errs = parseBuildErrors(MISC_OUT);
  const kinds = errs.map((e) => e.kind);
  assert.ok(kinds.includes('client'));
  assert.ok(errs.some((e) => e.kind === 'css' && !e.file));
  assert.ok(errs.some((e) => e.kind === 'prerender' && e.route === '/pricing'));
  assert.ok(errs.some((e) => e.file === 'app/globals.css' && e.line === 42 && e.kind === 'css'));
  assert.ok(errs.some((e) => e.file === 'components/Badge.tsx' && e.kind === 'custom-element'));
  assert.deepEqual(parseBuildErrors(' ✓ Compiled successfully\n Route (app)\n ○ /'), []);
});

test('parsePatches / applyPatch: несколько блоков, кодовые заборы, ФАЙЛ:, отступы, спецсимволы $', () => {
  const text = [
    'Here is the fix:', '', 'FILE: `./app/page.tsx`', '```tsx', '<<<<<<< SEARCH', '      <Price value="12" />', '=======', '      <Price value={12} />', '>>>>>>> REPLACE', '```', '',
    'ФАЙЛ: components/Hero.tsx', '<<<<<<< SEARCH', 'const a = 1;', '=======', "const a = '$&$1';", '>>>>>>> REPLACE',
  ].join('\n');
  const ps = parsePatches(text);
  assert.deepEqual(ps.map((p) => p.file), ['app/page.tsx', 'components/Hero.tsx']);
  assert.equal(applyPatch('x\nconst a = 1;\ny', ps[1]), "x\nconst a = '$&$1';\ny", 'replace без интерпретации $&');
  const src = 'function P() {\n  return (\n    <main>\n        <Price value="12" />\n    </main>\n  );\n}';
  const fixed = applyPatch(src, ps[0]);
  assert.match(fixed, /<Price value=\{12\} \/>/, 'совпадение без учёта отступов');
  assert.equal(applyPatch(src, { search: 'nothing like this', replace: 'x' }), null);
  assert.equal(applyPatch(src, { search: '   ', replace: 'x' }), null);
  assert.deepEqual(parsePatches('no patches here'), []);
});

async function project(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-heal-'));
  const r = path.join(dir, 'project');
  for (const [f, t] of Object.entries(files)) { await fsp.mkdir(path.dirname(path.join(r, f)), { recursive: true }); await fsp.writeFile(path.join(r, f), t); }
  return { dir, root: r, read: (f) => fsp.readFile(path.join(r, f), 'utf8') };
}

test('healProject: детерминированные фиксеры — use client, custom elements, импорт, CSS-переменные', async () => {
  const p = await project({
    'app/page.tsx': "import { Hero } from '@/components/Hero';\nexport const metadata = { title: 'x' };\nexport default function Page() { return <main><Hero /><Promo /><nb-badge>new</nb-badge></main>; }\n",
    'components/Hero.tsx': "import { useState } from 'react';\nexport function Hero() { const [o, setO] = useState(false); return <button onClick={() => setO(!o)} className=\"bg-[url(data:image/svg+xml;utf8,<svg_xmlns='http://www.w3.org/2000/svg'><path_d='M0_0h1'/></svg>)]\">x</button>; }\n",
    'components/Promo.tsx': 'export function Promo() { return <aside>promo</aside>; }\n',
    'app/globals.css': '@import "tailwindcss";\n\nbody { margin: 0; }\n',
  });
  let n = 0;
  const build = async () => {
    n++;
    const page = await p.read('app/page.tsx'); const hero = await p.read('components/Hero.tsx');
    const errs = [];
    if (!/^'use client'/.test(hero)) errs.push("./components/Hero.tsx:1:10\nError: You're importing a component that needs `useState`. This React Hook only works in a Client Component.");
    if (!fs.existsSync(path.join(p.root, 'types/custom-elements.d.ts'))) errs.push("./app/page.tsx:3:80\nType error: Property 'nb-badge' does not exist on type 'JSX.IntrinsicElements'.");
    if (!page.includes("import { Promo }")) errs.push("./app/page.tsx:3:62\nType error: Cannot find name 'Promo'.");
    if (hero.includes('url(data:')) errs.push('Error: Unexpected token BadUrl while optimizing generated CSS');
    return { code: errs.length ? 1 : 0, output: errs.join('\n\n') || ' ✓ Compiled successfully', ms: 1 };
  };
  const steps = [];
  const r = await healProject(p.root, { iterations: 3, build, outDir: p.dir, onIteration: (s) => steps.push(s) });
  assert.equal(r.ok, true, JSON.stringify(r.history, null, 1));
  assert.equal(r.iterations, 2); assert.equal(n, 2); assert.equal(r.llmCalls, 0);
  const by = r.history[0].fixes.map((f) => f.by).sort();
  assert.deepEqual(by, ['css-vars', 'custom-elements', 'imports', 'use-client']);
  assert.match(await p.read('components/Hero.tsx'), /^'use client';/);
  assert.match(await p.read('components/Hero.tsx'), /bg-\(image:--sb-bgi-1\)/);
  assert.match(await p.read('app/globals.css'), /@theme static \{\n {2}--sb-bgi-1: url\("data:image\/svg\+xml;utf8,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg'%3E/);
  assert.match(await p.read('types/custom-elements.d.ts'), /'nb-badge': DetailedHTMLProps/);
  assert.match(await p.read('app/page.tsx'), /^import \{ Promo \} from '@\/components\/Promo';/m);
  assert.ok(!(await p.read('app/page.tsx')).startsWith("'use client'"), 'страница с metadata не становится клиентской');
  assert.ok(fs.existsSync(path.join(p.dir, 'verify/heal-backup/1/components/Hero.tsx')), 'резервная копия до правки');
  assert.equal(JSON.parse(await fsp.readFile(path.join(p.dir, 'verify/heal.json'), 'utf8')).ok, true);
  assert.equal(steps.length, 2);
});

test('healProject: без прогресса останавливается сразу; успешная сборка — одна итерация', async () => {
  const p = await project({ 'app/page.tsx': 'export default function Page() { return <main />; }\n' });
  let n = 0;
  const bad = await healProject(p.root, { iterations: 4, outDir: p.dir, build: async () => { n++; return { code: 1, output: './app/page.tsx:1:1\nError: something odd failed', ms: 1 }; } });
  assert.equal(bad.ok, false); assert.equal(n, 1, 'нечего исправить и нет LLM → одна сборка');
  const good = await healProject(p.root, { outDir: p.dir, build: async () => ({ code: 0, output: 'ok', ms: 1 }) });
  assert.equal(good.ok, true); assert.equal(good.iterations, 1);
});

function mockLLM(answer) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body); calls.push({ url: req.url, auth: req.headers.authorization, data });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof answer === 'function' ? answer(data) : answer } }], usage: {} }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('healProject: LLM-патч (OpenAI-совместимый API, SEARCH/REPLACE), защита от выхода за пределы проекта', async () => {
  const p = await project({ 'app/page.tsx': "export default function Page() {\n  const total: number = 'oops';\n  return <main>{total}</main>;\n}\n" });
  const llm = await mockLLM([
    'FILE: app/page.tsx', '<<<<<<< SEARCH', "const total: number = 'oops';", '=======', 'const total: number = 42;', '>>>>>>> REPLACE', '',
    'FILE: ../../etc/evil.tsx', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE',
  ].join('\n'));
  try {
    const build = async () => {
      const t = await p.read('app/page.tsx');
      return t.includes("'oops'") ? { code: 1, output: "./app/page.tsx:2:9\nType error: Type 'string' is not assignable to type 'number'.", ms: 1 } : { code: 0, output: 'ok', ms: 1 };
    };
    const r = await healProject(p.root, { iterations: 3, outDir: p.dir, build, llm: { provider: 'custom', baseUrl: llm.baseUrl, model: 'river-test', apiKey: 'sk-test', vision: false, maxTokens: 2000, timeoutMs: 10000 } });
    assert.equal(r.ok, true); assert.equal(r.llmCalls, 1); assert.equal(r.iterations, 2);
    assert.deepEqual(r.history[0].fixes, [{ by: 'llm', files: ['app/page.tsx'] }]);
    assert.match(await p.read('app/page.tsx'), /const total: number = 42;/);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].url, '/v1/chat/completions'); assert.equal(llm.calls[0].auth, 'Bearer sk-test'); assert.equal(llm.calls[0].data.model, 'river-test');
    const prompt = llm.calls[0].data.messages.map((m) => m.content).join('\n');
    assert.match(prompt, /SEARCH\/REPLACE/); assert.match(prompt, /line 2:9: Type error/); assert.match(prompt, / 2\| {3}const total: number = 'oops';/);
  } finally { llm.server.close(); }
});

test('FIXERS: у каждого есть id, match и apply', () => {
  const ids = FIXERS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of FIXERS) { assert.equal(typeof f.match, 'function'); assert.equal(typeof f.apply, 'function'); }
  for (const id of ['use-client', 'custom-elements', 'imports', 'nesting', 'css-vars']) assert.ok(ids.includes(id), id);
});
