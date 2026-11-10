// Regression tests for defects found by building the generated project for real (next build + visual comparison):
// tabs without role="tabpanel", <body> base style in globals.css, per-page body differences, MCP stdio transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { enhanceSection } from '../../src/output/interactive.mjs';
import { buildGlobalsCss } from '../../src/output/theme.mjs';
import { pageFile } from '../../src/output/project.mjs';
import { createTw } from '../../src/analyze/tailwind.mjs';

const RULES = [
  'const features = [];', '',
  'export function RulesSection() {', '  return (', '    <section>',
  '      <div className="flex gap-2">',
  '        {features.map((item, i) => (',
  '          <button key={i} type="button" className={`px-3 ${item.textColorClass} ${item.bgClass}`}>{item.label}</button>',
  '        ))}',
  '      </div>',
  '      <div id="rules-panel" className="p-4">',
  '        <p className="my-4">1.1 Читы запрещены.</p>',
  '        <p className="my-4">1.2 Один аккаунт.</p>',
  '      </div>',
  '    </section>', '  );', '}', ''].join('\n');
const rulesData = () => ({ data: [{ name: 'features', fields: ['textColorClass', 'bgClass', 'label'], rows: [
  { textColorClass: 'text-white', bgClass: 'bg-black', label: 'Общие' }, { textColorClass: 'text-gray', bgClass: 'bg-light', label: 'Чат' }, { textColorClass: 'text-gray', bgClass: 'bg-light', label: 'Стройка' }] }] });

test('enhanceSection: кнопки-вкладки без role="tabpanel" переключают текст по данным пробы (added / removedText)', () => {
  const groups = [{ labels: ['Общие', 'Чат', 'Стройка'], heuristic: true, items: [
    { label: 'Общие', active: true, panel: '', added: '', removedText: '' },
    { label: 'Чат', panel: '', added: '2.1 Без оскорблений.\n2.2 Без рекламы.', removedText: '1.1 Читы запрещены.\n1.2 Один аккаунт.' },
    { label: 'Стройка', panel: '', added: '3.1 Не строить в текстурах.', removedText: '1.1 Читы запрещены.\n1.2 Один аккаунт.' }] }];
  const out = enhanceSection(RULES, rulesData(), { tabGroups: groups });
  assert.equal(out.client, true);
  assert.match(out.code, /^'use client';/);
  assert.match(out.code, /const \[tab, setTab\] = useState\(0\);/);
  assert.match(out.code, /const featuresPanels: string\[\]\[\] = \[\["1\.1 Читы запрещены\.","1\.2 Один аккаунт\."\],\["2\.1 Без оскорблений\.","2\.2 Без рекламы\."\],\["3\.1 Не строить в текстурах\."\]\];/);
  assert.match(out.code, /<p className="my-4">\{featuresPanels\[tab\]\[0\]\}<\/p>/);
  // a tab with fewer lines must not leave an empty paragraph behind
  assert.match(out.code, /\{featuresPanels\[tab\]\[1\] \? <p className="my-4">\{featuresPanels\[tab\]\[1\]\}<\/p> : null\}/);
  assert.match(out.code, /i === tab \? "text-white" : "text-gray"/);
});

test('enhanceSection: если содержимое вкладок сопоставить нельзя, состояние всё равно объявлено (раньше next build падал с TS2304)', () => {
  const groups = [{ labels: ['Общие', 'Чат', 'Стройка'], items: [
    { label: 'Общие', active: true, panel: '', added: '' }, { label: 'Чат', panel: '', added: 'что-то новое', addedLines: 1 }, { label: 'Стройка', panel: '', added: 'ещё', addedLines: 1 }] }];
  const out = enhanceSection(RULES, rulesData(), { tabGroups: groups });
  assert.match(out.code, /onClick=\{\(\) => setTab\(i\)\}/);
  assert.equal((out.code.match(/const \[tab, setTab\] = useState\(0\);/g) || []).length, 1);
  assert.match(out.code, /import \{ useState \} from 'react';/);
  assert.match(out.code, /<p className="my-4">1\.1 Читы запрещены\.<\/p>/);
});

const pageOf = (body) => ({ raw: { tree: { i: 1 }, meta: {} }, eff: new Map([[1, body]]), blocks: [], inlines: [] });
const BODY = { color: '#0f172a', 'font-family': '"Brand Sans", Arial, sans-serif', 'font-size': 16, 'font-weight': 400, 'font-style': 'normal', 'line-height': 1.6, 'letter-spacing': 0, 'text-align': 'start', 'text-transform': 'none' };

test('buildGlobalsCss: body получает реальные color / font-size / line-height оригинала, а не «самый частый цвет текста»', () => {
  const css = buildGlobalsCss({ home: pageOf(BODY), tokens: { roles: { foreground: '#9a9ab0', background: '#ffffff' }, pageBg: '#ffffff', fontMap: { 'Brand Sans': 'sans' }, fonts: { body: { family: 'Brand Sans' }, all: [] } } });
  const body = css.slice(css.lastIndexOf('body {'));
  assert.match(body, /color: #0f172a;/);
  assert.doesNotMatch(body, /#9a9ab0/);
  assert.match(body, /font-family: var\(--font-sans\);/);
  assert.match(body, /font-size: 16px;/);
  assert.match(body, /line-height: 1\.6;/);
  assert.doesNotMatch(body, /font-weight|letter-spacing|text-align/);
  // no crawl data for body → previous behaviour (role colours)
  assert.match(buildGlobalsCss({ tokens: { roles: { foreground: '#222222' } } }), /color: #222222;/);
});

test('pageFile: страница с другим стилем body получает отличия на своей обёртке', () => {
  const tw = createTw({ colorMap: {}, fontMap: {} });
  const home = pageOf(BODY); const dark = pageOf({ ...BODY, color: '#e5e7eb', 'font-size': 14 });
  const site = { home, tw };
  assert.match(pageFile(site, home), /<main>/);
  const code = pageFile(site, dark);
  assert.match(code, /<main className="[^"]*text-\[#e5e7eb\][^"]*">/);
  assert.match(code, /text-sm/);
  // layout already renders <main class="grid …">: blocks stay its direct children (fragment / display:contents)
  const shell = { ...site, layoutMain: { cls: 'grid grid-cols-3' } };
  assert.match(pageFile(shell, home), /return \(\n    <>\n[\s\S]*<\/>\n  \);/);
  assert.doesNotMatch(pageFile(shell, home), /<main|<div/);
  assert.match(pageFile(shell, dark), /<div className="contents [^"]*text-\[#e5e7eb\]/);
});

test('MCP stdio: ответы строго по порядку, ошибка разбора → -32700, сервер завершается при закрытии входа', async () => {
  const { startMcpServer } = await import('../../src/server/mcp.mjs');
  const input = new PassThrough(); const out = [];
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  try {
    const done = startMcpServer({ input, write: (s) => out.push(s) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('not json\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n[{"jsonrpc":"2.0","id":3,"method":"ping"},{"jsonrpc":"2.0","id":4,"method":"nope"}]\n');
    input.end();
    assert.equal(await done, 0);
  } finally { Object.assign(console, saved); }
  const msgs = out.join('').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(msgs.find((m) => m.error && m.error.code === -32700).id, null);
  const ordered = msgs.filter((m) => !Array.isArray(m) && m.id != null).map((m) => m.id);
  assert.deepEqual(ordered, [1, 2]);
  const batch = msgs.find(Array.isArray);
  assert.deepEqual(batch.map((m) => m.id), [3, 4]);
  assert.equal(batch[1].error.code, -32601);
});

test('enhanceSection: тексты с «$1» / «$&» (цены) не ломают вставку состояния', () => {
  const groups = [{ labels: ['Общие', 'Чат', 'Стройка'], items: [
    { label: 'Общие', active: true, panel: '', added: '' },
    { label: 'Чат', panel: '', added: '$129 only\n$& sale', removedText: '1.1 Читы запрещены.\n1.2 Один аккаунт.' },
    { label: 'Стройка', panel: '', added: "$' x\n$1", removedText: '1.1 Читы запрещены.\n1.2 Один аккаунт.' }] }];
  const out = enhanceSection(RULES, rulesData(), { tabGroups: groups });
  assert.equal((out.code.match(/export function RulesSection\(\) \{/g) || []).length, 1);
  assert.ok(out.code.includes('["$129 only","$& sale"]') && out.code.includes(`["$' x","$1"]`));
});

test('proxySettings: --proxy / SB_PROXY → настройки Playwright, логин и пароль отдельно', async () => {
  const { proxySettings } = await import('../../src/browser.mjs');
  assert.equal(proxySettings(''), null);
  assert.equal(proxySettings('ftp://x'), null);
  assert.equal(proxySettings('proxy.local:3128').server, 'http://proxy.local:3128');
  const p = proxySettings('http://user:p%40ss@10.0.0.1:8080');
  assert.deepEqual([p.server, p.username, p.password], ['http://10.0.0.1:8080', 'user', 'p@ss']);
  assert.equal(proxySettings('socks5://127.0.0.1:1080').server, 'socks5://127.0.0.1:1080');
});
