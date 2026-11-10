// CLI pipeline: URL -> crawl (Playwright) -> design-system analysis -> starter project -> LLM -> SITE_CLONE_BLUEPRINT.md
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadEnv, parseArgs, resolveLLM, DEFAULTS, HELP, TOOL_DIR } from './config.mjs';
import { log, color } from './log.mjs';
import { exists, normalizeUrl, humanBytes, readJSON } from './util.mjs';

const pkg = JSON.parse(await fsp.readFile(path.join(TOOL_DIR, 'package.json'), 'utf8'));

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
async function ask(q, { allowPiped = false } = {}) {
  if (!stdin.isTTY && !allowPiped) return '';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } catch { return ''; } finally { rl.close(); }
}
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' с';

async function runInteractiveMenu(opts) {
  const askMenu = (q) => ask(q, { allowPiped: true });
  console.log(color.cyan(`\n` +
    `  ╔══════════════════════════════════════════════════════════════════╗\n` +
    `  ║        ⚡ site-blueprint v${pkg.version} — Простой консольный CLI         ║\n` +
    `  ╚══════════════════════════════════════════════════════════════════╝\n`));
  console.log(`  ${color.bold('1.')} 🚀 Клонировать сайт (пошаговая настройка)`);
  console.log(`  ${color.bold('2.')} ⚡ Быстрый клон (1 страница в Next.js 16 + Tailwind v4)`);
  console.log(`  ${color.bold('3.')} 🌐 Запустить сервер для расширения Chrome (listen :${opts.port || 3005})`);
  console.log(`  ${color.bold('4.')} 🔍 Сверить запущенный клон с оригиналом (verify)`);
  console.log(`  ${color.bold('5.')} 🩹 Собрать проект и починить ошибки (heal)`);
  console.log(`  ${color.bold('6.')} 📦 Импортировать capture.zip из расширения`);
  console.log(`  ${color.bold('7.')} 🔌 Запустить MCP-сервер (для Cursor / Claude Code)`);
  console.log(`  ${color.bold('0.')} ❌ Выход\n`);

  const choice = (await askMenu(color.bold('  Выберите действие [1-7, 0] (по умолч. 1): '))) || '1';
  if (choice === '0' || choice.toLowerCase() === 'q') {
    console.log('  До встречи!');
    return { exit: true, code: 0 };
  }
  if (choice === '7') {
    return { cmd: 'mcp' };
  }
  if (choice === '2') {
    let url = await askMenu(color.bold('  Вставь ссылку на сайт: '));
    if (!url) { log.error('Не указан URL.'); return { exit: true, code: 2 }; }
    opts.depth = 1;
    opts.maxPages = 1;
    return { cmd: 'crawl', url };
  }
  if (choice === '3') {
    const p = await askMenu(`  Порт (по умолч. ${opts.port || 3005}): `);
    if (p && /^\d+$/.test(p)) opts.port = Number(p);
    return { cmd: 'listen' };
  }
  if (choice === '4') {
    const dir = await askMenu('  Папка клона (например output/...): ');
    const testUrl = (await askMenu('  URL клона (по умолч. http://localhost:3000): ')) || 'http://localhost:3000';
    opts.url = testUrl;
    return { cmd: 'verify', arg: dir };
  }
  if (choice === '5') {
    const dir = await askMenu('  Папка клона для исправления (например output/...): ');
    return { cmd: 'heal', arg: dir };
  }
  if (choice === '6') {
    const zip = await askMenu('  Путь к capture.zip: ');
    return { cmd: 'import', arg: zip };
  }

  // Option 1: Full clone
  let url = await askMenu(color.bold('  Вставь ссылку на сайт: '));
  if (!url) { log.error('Не указан URL.'); return { exit: true, code: 2 }; }

  const depthStr = await askMenu(`  Глубина обхода (по умолч. ${opts.depth}): `);
  if (depthStr && /^\d+$/.test(depthStr)) opts.depth = Number(depthStr);

  const pagesStr = await askMenu(`  Максимум страниц (по умолч. ${opts.maxPages}): `);
  if (pagesStr && /^\d+$/.test(pagesStr)) opts.maxPages = Number(pagesStr);

  const apiStr = await askMenu(`  Создавать API-моки? [Y/n] (по умолч. Да): `);
  if (/^n/i.test(apiStr)) opts.api = false;

  const snapStr = await askMenu(`  Сохранять SingleFile HTML-снимки? [Y/n] (по умолч. Да): `);
  if (/^n/i.test(snapStr)) opts.snapshot = false;

  const healStr = await askMenu(`  Проверка и самовосстановление (Heal & Verify)? [Y/n] (по умолч. Да): `);
  if (/^n/i.test(healStr)) { opts.verify = false; opts.visual = false; }

  const aiStr = await askMenu(`  Использовать AI (LLM для компонентов)? [Y/n] (по умолч. Да): `);
  if (/^n/i.test(aiStr)) opts.llm = false;

  return { cmd: 'crawl', url };
}

export async function main(argv = process.argv.slice(2)) {
  loadEnv();
  const { opts: cli, positional } = parseArgs(argv);
  if (cli.help) { console.log(HELP); return 0; }
  if (cli.version) { console.log(pkg.version); return 0; }
  const badNum = Object.entries(cli).find(([k, v]) => typeof v === 'number' && !Number.isFinite(v));
  if (badNum) { log.error(`Опция --${badNum[0].replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())} ждёт число. См. site-blueprint --help`); return 2; }
  const opts = { ...DEFAULTS, ...cli };
  log.setVerbose(!!opts.verbose);
  const t0 = Date.now();
  let cmd = positional[0];
  let url = '';

  // Shorthand: site-blueprint https://example.com 1 5
  if (cmd && /^https?:\/\//i.test(cmd)) {
    url = cmd;
    cmd = 'crawl';
    if (positional[1] && /^\d+$/.test(positional[1]) && cli.depth === undefined) opts.depth = Number(positional[1]);
    if (positional[2] && /^\d+$/.test(positional[2]) && cli.maxPages === undefined) opts.maxPages = Number(positional[2]);
  }

  // Interactive menu if launched with no arguments or --interactive in interactive terminal
  if ((!cmd && !opts.from && !opts.url && stdin.isTTY) || cli.interactive) {
    const res = await runInteractiveMenu(opts);
    if (res.exit) return res.code ?? 0;
    cmd = res.cmd;
    if (res.url) url = res.url;
    if (res.arg) positional[1] = res.arg;
  }
  // site-blueprint mcp — Model Context Protocol server over stdio
  if (cmd === 'mcp') {
    const { startMcpServer } = await import('./server/mcp.mjs');
    return startMcpServer();
  }
  // site-blueprint pick <dir> [query] — extract a standalone React+Tailwind component (.tsx)
  if (cmd === 'pick') {
    const dir = path.resolve(String(positional[1] || opts.from || '.'));
    if (!(await exists(path.join(dir, 'data', 'crawl.json')))) { log.error(`В ${dir} нет data/crawl.json`); return 2; }
    const { loadCrawl, buildSite } = await import('./analyze/site.mjs');
    const { pickSiteComponent, listSiteComponents } = await import('./analyze/picker.mjs');
    const site = buildSite(await loadCrawl(dir), opts);
    const query = String(positional[2] ?? '').trim();
    const list = () => listSiteComponents(site).join('\n');
    // no query: show what can be picked (stdout stays pipe-friendly when a component is printed)
    if (!query) { console.log(list() || 'В этом захвате нет компонентов.'); console.error(color.dim(`\nУкажи тип, имя, текст заголовка или номер: site-blueprint pick ${positional[1] || '.'} pricing`)); return 0; }
    const comp = pickSiteComponent(site, query);
    if (!comp) { log.error(`Компонент «${query}» не найден. Доступные:\n${list()}`); return 1; }
    console.log(comp.code);
    return 0;
  }
  // site-blueprint verify <dir> --url http://localhost:3000 — compare the running clone with the crawl
  if (cmd === 'verify') {
    const { verify } = await import('./verify/index.mjs');
    return verify(positional[1] || opts.from, opts);
  }
  // site-blueprint heal <dir> — build the generated project and fix compile errors (no crawl)
  if (cmd === 'heal') {
    const dir = path.resolve(String(positional[1] || opts.from || '.'));
    if (!(await exists(path.join(dir, 'data', 'crawl.json')))) { log.error(`В ${dir} нет data/crawl.json — укажи папку, которую создал site-blueprint.`); return 2; }
    return runPipeline(dir, { ...opts, only: 'verify' }, { t0 });
  }
  // site-blueprint listen --port 3005 — local endpoint for the browser extension
  if (cmd === 'listen') {
    const { startListenServer } = await import('./server/listen.mjs');
    try { await startListenServer(opts, { pkg, onCapture: (dir) => runPipeline(dir, opts, { t0: Date.now(), source: 'extension' }) }); }
    catch (e) {
      if (e && e.code === 'EADDRINUSE') log.error(`Порт ${opts.port} уже занят (второй listen или другой сервер). Запусти с --port <другой> и укажи этот порт в настройках расширения.`);
      else if (e && e.code === 'EACCES') log.error(`Нет прав слушать порт ${opts.port} — выбери порт выше 1024.`);
      else log.error('listen: ' + String((e && e.message) || e).split('\n')[0]);
      return 1;
    }
    return new Promise(() => {}); // runs until Ctrl+C
  }
  // site-blueprint import capture.zip — capture made by the browser extension
  if (cmd === 'import') {
    const file = positional[1];
    if (!file) { log.error('Укажи ZIP от расширения: site-blueprint import capture.zip'); return 2; }
    const { importCapture } = await import('./capture/import.mjs');
    let dir;
    try { dir = await importCapture(path.resolve(file), opts); }
    catch (e) { log.error('Импорт не удался: ' + String((e && e.message) || e).split('\n')[0]); if (opts.verbose) console.error(e); return 1; }
    return runPipeline(dir, opts, { t0, source: 'extension' });
  }

  // ---------- source: fresh crawl or existing output (--from) ----------
  let outDir; let crawlSummary = null;
  const { createHooks } = await import('./core/hooks.mjs');
  const hooks = await createHooks(opts);
  if (opts.from) {
    outDir = path.resolve(String(opts.from));
    if (!(await exists(path.join(outDir, 'data', 'crawl.json')))) { log.error(`В ${outDir} нет data/crawl.json — укажи папку прошлого запуска.`); return 2; }
    crawlSummary = await readJSON(path.join(outDir, 'data', 'crawl.json'));
    log.step(`Пересборка из ${outDir} (без обхода)`);
  } else {
    if (!url) url = (cmd && cmd !== 'crawl' ? cmd : positional[1]) || opts.url || '';
    if (!url) url = await ask(color.bold('Вставь ссылку на сайт: '));
    if (!url) { console.log(HELP); log.error('Не указан URL.'); return 2; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const start = normalizeUrl(url);
    if (!start) { log.error('Некорректный URL: ' + url); return 2; }
    const host = new URL(start).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
    outDir = path.resolve(String(opts.out || 'output'), `${host}-${stamp()}`);
    console.log(color.bold(`\nsite-blueprint ${pkg.version}`) + color.dim(` → ${outDir}`));
    if (!opts.robots) log.warn('robots.txt игнорируется — используй только для своих сайтов или с разрешения владельца.');
    const { crawl } = await import('./crawler.mjs');
    try { crawlSummary = await crawl(start, { ...opts, hooks }, outDir); }
    catch (e) {
      const msg = String((e && e.message) || e);
      await hooks.emit('error', { stage: 'crawl', error: e });
      if (/Executable doesn't exist|browserType\.launch|chromium/i.test(msg) && /install|Executable/i.test(msg)) log.error('Не найден Chromium для Playwright. Выполни: npx playwright install chromium');
      else log.error('Обход не удался: ' + msg.split('\n')[0]);
      if (opts.verbose) console.error(e);
      return 1;
    }
  }
  return runPipeline(outDir, opts, { t0, crawlSummary, hooks });
}

// analysis → starter project → LLM → blueprint → self-healing build + visual regression → zip.
// Shared by the crawler, --from, `import` (extension ZIP) and `listen` (extension → localhost).
/** result of the most recent pipeline run in this process (used by the MCP server to report where the output is) */
export const lastRun = { outDir: null, pages: 0, components: 0, check: null };

export async function runPipeline(outDir, opts, { t0 = Date.now(), crawlSummary = null, hooks = null, source = 'crawl' } = {}) {
  opts = { ...DEFAULTS, ...opts };
  Object.assign(lastRun, { outDir, pages: 0, components: 0, check: null });
  if (!hooks) { const { createHooks } = await import('./core/hooks.mjs'); hooks = await createHooks(opts); }
  if (!crawlSummary) crawlSummary = await readJSON(path.join(outDir, 'data', 'crawl.json')).catch(() => null);
  const verifyOnly = opts.only === 'verify';

  // ---------- analysis ----------
  log.step('Анализ дизайн-системы и компонентов');
  const { loadCrawl, buildSite } = await import('./analyze/site.mjs');
  const { loadApiMocks } = await import('./output/api.mjs');
  const ta = Date.now();
  const site = buildSite(await loadCrawl(outDir), opts);
  site.api = await loadApiMocks(outDir);
  site.source = source;
  log.ok(`Страниц: ${site.pages.length}, компонентов: ${site.components.length} (общих: ${site.globals.length}), иконок: ${site.icons.length}, цветов: ${site.tokens.colors.length}${site.api && site.api.count ? `, API-моков: ${site.api.count}` : ''} — ${secs(Date.now() - ta)}`);

  // ---------- starter project ----------
  const siteName = (new URL(site.origin).hostname.replace(/^www\./, '').split('.')[0] || 'site').toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-clone';
  let project;
  if (verifyOnly && (await exists(path.join(outDir, 'project', 'package.json')))) project = { root: path.join(outDir, 'project'), files: [], assets: 0, mocks: site.api ? site.api.count : 0, rewrites: [] };
  else {
    log.step('Стартовый проект Next.js + Tailwind');
    const { writeProject } = await import('./output/project.mjs');
    project = await writeProject(site, outDir, { siteName, hooks, api: site.api });
    log.ok(`project/: ${project.files.length} файлов${project.mocks ? `, мок-API: ${project.mocks} ответ(ов)` : ''}`);
  }

  // ---------- LLM ----------
  const llmCfg = resolveLLM(opts);
  let llm = null;
  if (!verifyOnly && llmCfg.enabled) {
    log.step(`LLM: ${llmCfg.model} (${llmCfg.provider}, ${llmCfg.vision ? 'со скриншотами' : 'только текст'})`);
    const { runLLM } = await import('./llm/run.mjs');
    try { llm = await runLLM(site, outDir, llmCfg, { lang: opts.lang }); }
    catch (e) { log.warn('LLM-анализ не удался: ' + String((e && e.message) || e).split('\n')[0]); llm = null; await hooks.emit('error', { stage: 'llm', error: e }); }
    if (llm && llm.fatal) log.warn('LLM: ' + llm.fatal);
  } else if (!verifyOnly && opts.llm !== false) {
    log.warn(`LLM пропущена: ${llmCfg.problems.join('; ')}. Блюпринт будет без нейро-разбора — настрой .env (см. .env.example).`);
  }

  // ---------- blueprint ----------
  let bp = null;
  if (!verifyOnly) {
    log.step('SITE_CLONE_BLUEPRINT.md');
    const { writeBlueprint } = await import('./blueprint.mjs');
    bp = await writeBlueprint(site, outDir, { llm, llmInfo: llmCfg, project, version: pkg.version });
  }

  // ---------- self-healing build + visual regression ----------
  let check = null;
  if (opts.verify !== false) {
    const { selfCheck } = await import('./verify/selfcheck.mjs');
    try { check = await selfCheck({ outDir, projectRoot: project.root, site, opts, llmCfg, hooks, version: pkg.version }); }
    catch (e) { log.warn('Самопроверка не удалась: ' + String((e && e.message) || e).split('\n')[0]); if (opts.verbose) console.error(e); await hooks.emit('error', { stage: 'verify', error: e }); }
  }

  // ---------- one archive for the AI coder ----------
  let zip = null;
  if (opts.zip !== false && !verifyOnly) {
    try { const { bundle } = await import('./output/zip.mjs'); zip = await bundle(outDir); }
    catch (e) { log.warn('Архив не создан: ' + String((e && e.message) || e).split('\n')[0]); }
  }
  await hooks.emit('afterFinish', { outDir, site, project, check });
  Object.assign(lastRun, { outDir, pages: site.pages.length, components: site.components.length, check: check ? { summary: check.summaryLine, exitCode: check.exitCode || 0 } : null });

  // ---------- summary ----------
  const rel = (f) => { const r = path.relative(process.cwd(), f); return !r ? '.' : r.startsWith('..') ? f : r; };
  const llmLine = llm && !llm.fatal
    ? `${llm.model}: ${llm.calls} запрос(ов)${llm.cached ? `, из кэша ${llm.cached}` : ''}${llm.errors.length ? color.yellow(`, ошибок ${llm.errors.length}`) : ''}${llm.usage && (llm.usage.prompt || llm.usage.completion) ? `, токенов ${llm.usage.prompt}→${llm.usage.completion}` : ''}`
    : llmCfg.enabled ? color.yellow('не удалось (см. лог выше)') : color.yellow('выключена — ' + llmCfg.problems.join('; '));
  console.log('\n' + color.green(color.bold('Готово')) + color.dim(` за ${secs(Date.now() - t0)}`));
  if (bp) console.log(`  ${color.bold('Блюпринт:')}  ${rel(bp.file)} (${humanBytes(bp.chars)}${bp.mode !== 'full' ? `, код компонентов: ${bp.mode === 'home' ? 'только главная' : 'в pages/*.md'}` : ''})`);
  console.log(`  ${color.bold('Проект:')}    ${rel(project.root)}  → cd в папку, npm install && npm run dev`);
  if (!verifyOnly) {
    console.log(`  ${color.bold('Скриншоты:')} ${rel(path.join(outDir, 'screenshots'))}`);
    console.log(`  ${color.bold('Страниц:')}   ${site.pages.length}${crawlSummary && crawlSummary.skipped && crawlSummary.skipped.length ? color.dim(` (пропущено ${crawlSummary.skipped.length}, см. data/crawl.json)`) : ''}`);
    console.log(`  ${color.bold('LLM:')}       ${llmLine}`);
  }
  if (check) console.log(`  ${color.bold('Проверка:')}  ${check.summaryLine} → ${rel(check.reportFile)}`);
  if (zip) console.log(`  ${color.bold('Архив:')}     ${rel(zip.file)} (${humanBytes(zip.bytes)}, ${zip.files} файлов) — архив для ИИ-кодера, отправляй его целиком`);
  if (!verifyOnly) {
    console.log(color.dim('\nДальше: открой проект в Cursor / Claude Code / Codex и вставь мастер-промпт из раздела 0 блюпринта.'));
    console.log(color.dim(`Когда клон запущен (npm run dev): node bin/site-blueprint.mjs verify ${rel(outDir)} --url http://localhost:3000 — отчёт о расхождениях.\n`));
  }
  return check && check.exitCode ? check.exitCode : 0;
}
