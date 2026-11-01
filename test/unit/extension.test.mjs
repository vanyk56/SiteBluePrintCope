// Static checks of the Chrome MV3 extension (extension/): generated files in sync with src/, manifest permissions,
// popup labels, local-only code (no eval / remote scripts), every JS file parses, the in-page bundle is self-contained.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const jsFiles = () => { const out = []; const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name.endsWith('.js')) out.push(r); } }; walk(EXT); return out; };

test('extension/lib/*.js и версия manifest синхронизированы с src/ (npm run build:extension)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-extension.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(manifest.version, pkg.version.replace(/[^0-9.]/g, ''));
});

test('manifest: MV3, нужные разрешения, доступ ко всем сайтам только опционально', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const p of ['activeTab', 'scripting', 'downloads', 'webRequest']) assert.ok(manifest.permissions.includes(p), p);
  assert.ok(!manifest.permissions.some((p) => /webRequestBlocking|debugger|cookies|history|<all_urls>|tabs$/.test(p)), 'лишних разрешений нет');
  assert.ok(manifest.host_permissions.every((h) => /^http:\/\/(127\.0\.0\.1|localhost)\/\*$/.test(h)), 'обязательный доступ — только к локальному CLI');
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.equal(manifest.background.type, 'module');
  assert.ok(!manifest.content_scripts, 'никаких автоматически внедряемых скриптов на все сайты');
  assert.ok(!JSON.stringify(manifest.content_security_policy || {}).includes('unsafe-eval'));
  for (const f of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});

test('popup: кнопки и опции из ТЗ', () => {
  const html = read('popup.html');
  for (const label of ['Клонировать страницу', 'Клонировать сайт (с краулингом ссылок)', 'Захватить API-запросы', 'Захватить интерактивный стейт', 'Скачать ZIP', 'Отправить в локальный CLI (localhost:3005)']) assert.ok(html.includes(label), label);
  assert.match(read('popup.css'), /color-scheme:\s*dark|background:\s*#(0|1)/i, 'тёмная тема');
});

test('только локальный код: нет eval/new Function/удалённых скриптов, все импорты и <script src> существуют', () => {
  for (const f of jsFiles()) {
    const src = read(f);
    assert.ok(!/\beval\s*\(|new Function\s*\(|importScripts\s*\(\s*['"]https?:/.test(src), f);
    for (const m of src.matchAll(/^import [^;]+? from '(\.[^']+)';/gm)) assert.ok(fs.existsSync(path.join(EXT, path.dirname(f), m[1])), `${f} → ${m[1]}`);
  }
  for (const f of ['popup.html', 'download.html']) {
    for (const m of read(f).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) { assert.ok(!/^https?:/.test(m[1]), m[1]); assert.ok(fs.existsSync(path.join(EXT, m[1])), m[1]); }
  }
});

test('каждый JS-файл расширения синтаксически корректен', () => {
  for (const f of jsFiles()) {
    const r = spawnSync(process.execPath, ['--check', path.join(EXT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('lib/inpage.js и lib/hooks.js самодостаточны (без import/require) и регистрируют window.__sbLib', () => {
  const code = read('lib/inpage.js');
  assert.ok(!/^\s*import\s|\brequire\(/m.test(code));
  const window = {};
  vm.runInNewContext(code, { window, Object });
  const lib = window.__sbLib;
  assert.equal(lib.version, pkg.version);
  for (const fn of ['extractPage', 'snapshotPage', 'probeStateInPage']) assert.equal(typeof lib[fn], 'function', fn);
  assert.ok(Object.isFrozen(lib));
  vm.runInNewContext(code, { window, Object });
  assert.equal(window.__sbLib, lib, 'повторное внедрение той же версии ничего не меняет');
  assert.ok(!/^\s*import\s|\brequire\(/m.test(read('lib/hooks.js')));
});

test('api-hook: секретные заголовки не сохраняются, лимиты заданы', () => {
  const src = read('inject/api-hook.js');
  assert.match(src, /authorization/i); assert.match(src, /cookie/i);
  assert.match(src, /400|2e6|2 \* 1024|MAX/);
});
