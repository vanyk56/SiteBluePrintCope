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
async function ask(q) {
  if (!stdin.isTTY) return '';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' с';

export async function main(argv = process.argv.slice(2)) {
  loadEnv();
  const { opts: cli, positional } = parseArgs(argv);
  if (cli.help) { console.log(HELP); return 0; }
  if (cli.version) { console.log(pkg.version); return 0; }
  const opts = { ...DEFAULTS, ...cli };
  log.setVerbose(!!opts.verbose);
  const t0 = Date.now();

  // ---------- source: fresh crawl or existing output (--from) ----------
  let outDir; let crawlSummary = null;
  if (opts.from) {
    outDir = path.resolve(String(opts.from));
    if (!(await exists(path.join(outDir, 'data', 'crawl.json')))) { log.error(`В ${outDir} нет data/crawl.json — укажи папку прошлого запуска.`); return 2; }
    crawlSummary = await readJSON(path.join(outDir, 'data', 'crawl.json'));
    log.step(`Пересборка из ${outDir} (без обхода)`);
  } else {
    let url = positional[0] || opts.url || '';
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
    try { crawlSummary = await crawl(start, opts, outDir); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/Executable doesn't exist|browserType\.launch|chromium/i.test(msg) && /install|Executable/i.test(msg)) log.error('Не найден Chromium для Playwright. Выполни: npx playwright install chromium');
      else log.error('Обход не удался: ' + msg.split('\n')[0]);
      if (opts.verbose) console.error(e);
      return 1;
    }
  }

  // ---------- analysis ----------
  log.step('Анализ дизайн-системы и компонентов');
  const { loadCrawl, buildSite } = await import('./analyze/site.mjs');
  const ta = Date.now();
  const site = buildSite(await loadCrawl(outDir), opts);
  log.ok(`Страниц: ${site.pages.length}, компонентов: ${site.components.length} (общих: ${site.globals.length}), иконок: ${site.icons.length}, цветов: ${site.tokens.colors.length} — ${secs(Date.now() - ta)}`);

  // ---------- starter project ----------
  log.step('Стартовый проект Next.js + Tailwind');
  const { writeProject } = await import('./output/project.mjs');
  const siteName = (new URL(site.origin).hostname.replace(/^www\./, '').split('.')[0] || 'site').toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-clone';
  const project = await writeProject(site, outDir, { siteName });
  log.ok(`project/: ${project.files.length} файлов`);

  // ---------- LLM ----------
  const llmCfg = resolveLLM(opts);
  let llm = null;
  if (llmCfg.enabled) {
    log.step(`LLM: ${llmCfg.model} (${llmCfg.provider}, ${llmCfg.vision ? 'со скриншотами' : 'только текст'})`);
    const { runLLM } = await import('./llm/run.mjs');
    try { llm = await runLLM(site, outDir, llmCfg, { lang: opts.lang }); }
    catch (e) { log.warn('LLM-анализ не удался: ' + String((e && e.message) || e).split('\n')[0]); llm = null; }
    if (llm && llm.fatal) log.warn('LLM: ' + llm.fatal);
  } else if (opts.llm !== false) {
    log.warn(`LLM пропущена: ${llmCfg.problems.join('; ')}. Блюпринт будет без нейро-разбора — настрой .env (см. .env.example).`);
  }

  // ---------- blueprint ----------
  log.step('SITE_CLONE_BLUEPRINT.md');
  const { writeBlueprint } = await import('./blueprint.mjs');
  const bp = await writeBlueprint(site, outDir, { llm, llmInfo: llmCfg, project, version: pkg.version });

  // ---------- summary ----------
  const rel = (f) => { const r = path.relative(process.cwd(), f); return !r ? '.' : r.startsWith('..') ? f : r; };
  const llmLine = llm && !llm.fatal
    ? `${llm.model}: ${llm.calls} запрос(ов)${llm.cached ? `, из кэша ${llm.cached}` : ''}${llm.errors.length ? color.yellow(`, ошибок ${llm.errors.length}`) : ''}${llm.usage && (llm.usage.prompt || llm.usage.completion) ? `, токенов ${llm.usage.prompt}→${llm.usage.completion}` : ''}`
    : llmCfg.enabled ? color.yellow('не удалось (см. лог выше)') : color.yellow('выключена — ' + llmCfg.problems.join('; '));
  console.log('\n' + color.green(color.bold('Готово')) + color.dim(` за ${secs(Date.now() - t0)}`));
  console.log(`  ${color.bold('Блюпринт:')}  ${rel(bp.file)} (${humanBytes(bp.chars)}${bp.mode !== 'full' ? `, код компонентов: ${bp.mode === 'home' ? 'только главная' : 'в pages/*.md'}` : ''})`);
  console.log(`  ${color.bold('Проект:')}    ${rel(project.root)}  → cd в папку, npm install && npm run dev`);
  console.log(`  ${color.bold('Скриншоты:')} ${rel(path.join(outDir, 'screenshots'))}`);
  console.log(`  ${color.bold('Страниц:')}   ${site.pages.length}${crawlSummary && crawlSummary.skipped && crawlSummary.skipped.length ? color.dim(` (пропущено ${crawlSummary.skipped.length}, см. data/crawl.json)`) : ''}`);
  console.log(`  ${color.bold('LLM:')}       ${llmLine}`);
  console.log(color.dim('\nДальше: открой проект в Cursor / Claude Code / Codex и вставь мастер-промпт из раздела 0 блюпринта.\n'));
  return 0;
}
