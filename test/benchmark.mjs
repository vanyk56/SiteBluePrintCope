#!/usr/bin/env node
// Visual-fidelity benchmark: clones every fixture in test/bench/<name>/index.html (one page, no LLM, real `next build`)
// and prints per-fixture similarity — «по секциям» (main metric), «строгое» (pixel-exact, no alignment) and «раскладка»
// (IoU of text blocks) — for desktop and mobile. The multi-page fixture from `npm test` is included as «nimbus».
//   SB_NEXT_MODULES=/path/to/any-next-app/node_modules npm run bench
//   … npm run bench -- --only saas,legacy --min 0.85 --avg 0.99 --keep
// Without a node_modules containing next the clone cannot be built → the benchmark exits with a hint.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve as serveNimbus } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BENCH = path.join(HERE, 'bench');
const FIXTURE = path.join(HERE, 'fixture');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = (arg('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MIN = Number(arg('--min', '0.85')), AVG = Number(arg('--avg', '0.99'));
const keep = argv.includes('--keep');
const nextModules = process.env.SB_NEXT_MODULES || process.env.SB_TEST_NEXT_MODULES || '';
if (!nextModules || !fs.existsSync(path.join(nextModules, 'next', 'package.json'))) {
  console.log('Бенчмарк собирает клоны через next build: укажи SB_NEXT_MODULES=/путь/к/любому-next-проекту/node_modules');
  process.exit(2);
}

// static server for one bench fixture: /fonts → test/fixture/fonts, /img → test/bench/_img, the rest → test/bench/<name>/ (clean URLs)
function serveBench(name) {
  const dir = path.join(BENCH, name);
  const map = (p) => (p.startsWith('/fonts/') ? path.join(FIXTURE, p) : p.startsWith('/img/') ? path.join(BENCH, '_img', p.slice(5)) : path.join(dir, p));
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nAllow: /\n'); }
      let file = p === '/' ? path.join(dir, 'index.html') : map(p);
      if (!path.extname(file)) file = fs.existsSync(file + '.html') ? file + '.html' : path.join(file, 'index.html');
      if (!(file.startsWith(dir) || file.startsWith(FIXTURE) || file.startsWith(BENCH)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const fixtures = [...fs.readdirSync(BENCH, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(BENCH, d.name, 'index.html'))).map((d) => d.name).sort(), 'nimbus']
  .filter((n) => !only.length || only.includes(n));
const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'site-blueprint-bench-'));
const pct = (x) => (typeof x === 'number' ? (x * 100).toFixed(1) + '%' : '—');
const results = [];
console.log(`Бенчмарк визуального сходства: ${fixtures.join(', ')} → ${outRoot}`);

for (const name of fixtures) {
  const t0 = Date.now();
  const server = name === 'nimbus' ? await serveNimbus(0) : await serveBench(name);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const out = path.join(outRoot, name);
  await fsp.mkdir(out, { recursive: true });
  const logFile = path.join(outRoot, name + '.log');
  const args = [path.join(ROOT, 'bin', 'site-blueprint.mjs'), url, '--out', out, '--max-pages', name === 'nimbus' ? '9' : '1', '--no-llm', '--no-zip'];
  process.stdout.write(`• ${name}: клонирую ${url} … `);
  const code = await new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const ch = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SB_NEXT_MODULES: nextModules, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.pipe(log); ch.stderr.pipe(log);
    ch.on('close', (c) => { log.end(); resolve(c); });
  });
  server.close();
  const [dir] = (await fsp.readdir(out, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'node_modules').map((d) => path.join(out, d.name));
  const sc = dir ? JSON.parse(await fsp.readFile(path.join(dir, 'verify', 'selfcheck.json'), 'utf8').catch(() => '{}')) : {};
  const v = sc.visual;
  const secs = ((Date.now() - t0) / 1000).toFixed(0) + ' с';
  if (!v || !v.pages || !v.pages.length) {
    console.log(`нет результата (код ${code}, ${secs}) — лог: ${logFile}`);
    results.push({ name, error: sc.visualError || (sc.build && !sc.build.ok ? 'сборка не прошла' : `код выхода ${code}`), log: logFile });
    continue;
  }
  console.log(`по секциям ${pct(v.average)} (мин ${pct(v.min)}), строгое ${pct(v.strict && v.strict.average)}, раскладка ${pct(v.layout && v.layout.average)} · ${secs}`);
  results.push({ name, dir, average: v.average, min: v.min, strict: v.strict, layout: v.layout, pages: v.pages.map((r) => ({ route: r.route, view: r.view, similarity: r.similarity, strict: r.strict, layout: r.layout, heightOriginal: r.heightOriginal, heightClone: r.heightClone, diff: r.diff && path.join(dir, r.diff) })) });
}

// summary: one line per fixture × view, then overall (every page × view counts once)
const rows = [];
for (const r of results) {
  if (r.error) { rows.push(`| ${r.name} | — | ✗ ${r.error} | | | | |`); continue; }
  for (const view of ['desktop', 'mobile']) {
    const ps = r.pages.filter((p) => p.view === view); if (!ps.length) continue;
    const avg = (k) => ps.reduce((s, p) => s + (p[k] ?? 0), 0) / ps.length;
    const mn = Math.min(...ps.map((p) => p.similarity));
    rows.push(`| ${r.name} | ${view} | ${ps.length} | ${pct(avg('similarity'))} | ${pct(mn)} | ${pct(avg('strict'))} | ${pct(avg('layout'))} |`);
  }
}
const all = results.flatMap((r) => r.pages || []);
const overall = all.length ? { average: all.reduce((s, p) => s + p.similarity, 0) / all.length, min: Math.min(...all.map((p) => p.similarity)), strict: all.reduce((s, p) => s + (p.strict ?? 0), 0) / all.length, layout: all.reduce((s, p) => s + (p.layout ?? 0), 0) / all.length } : null;
const failed = results.some((r) => r.error) || !overall || overall.min < MIN || overall.average < AVG;
const md = ['# Бенчмарк визуального сходства', '', `Цель: минимум ≥ ${pct(MIN)}, среднее ≥ ${pct(AVG)} (метрика «по секциям»).`, '',
  '| Фикстура | Вид | Страниц | По секциям (сред.) | По секциям (мин.) | Строгое | Раскладка |', '|---|---|---|---|---|---|---|', ...rows, '',
  overall ? `**Итого** (${all.length} снимков): по секциям среднее **${pct(overall.average)}**, минимум **${pct(overall.min)}**; строгое ${pct(overall.strict)}; раскладка ${pct(overall.layout)} — ${failed ? '✗ цель не достигнута' : '✓ цель достигнута'}.` : '**Нет результатов.**', ''].join('\n');
await fsp.writeFile(path.join(outRoot, 'BENCHMARK.md'), md);
await fsp.writeFile(path.join(outRoot, 'bench-results.json'), JSON.stringify({ min: MIN, avg: AVG, overall, results }, null, 2));
console.log('\n' + md);
console.log(`Отчёт: ${path.join(outRoot, 'BENCHMARK.md')}${keep ? '' : ' (папки клонов остаются там же — удали вручную, когда не нужны)'}`);
process.exit(failed ? 1 : 0);
