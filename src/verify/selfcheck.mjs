// Post-generation self-check (default on, --no-verify to skip):
//   1. dependencies (shared node_modules next to the results, or project-local)      → build.mjs ensureDeps
//   2. self-healing `next build` loop (deterministic fixers + LLM patches)             → build.mjs healProject
//   3. `next start` + visual regression against the crawl screenshots (pixelmatch)    → visual.mjs
//   4. internal links of the clone (routes + hrefs) answer without 404/500
// Result: VERIFICATION_REPORT.md in the output folder (+ verify/selfcheck.json, diff images in verify/visual/).
import path from 'node:path';
import { log, color } from '../log.mjs';
import { writeText, writeJSON } from '../util.mjs';
import { ensureDeps, healProject } from './build.mjs';

const pct = (x) => (x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%');
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' с';
// pages of the crawl must answer; links to pages that were not downloaded fall into not-found (expected)
export function linkSummary(links) {
  const pages = links.filter((l) => l.page); const other = links.filter((l) => !l.page);
  const okP = pages.filter((l) => l.ok).length; const miss = other.filter((l) => !l.ok).length;
  return `страницы ${okP}/${pages.length}${other.length ? `, прочие ссылки ${other.length - miss}/${other.length}${miss ? ` (${miss} → не скачанные страницы)` : ''}` : ''}`;
}

async function checkLinks(baseUrl, site, limit = 120) {
  const paths = new Set(site.pages.map((p) => p.route));
  for (const p of site.pages) for (const l of (p.raw.links || []).slice(0, 200)) {
    try { const L = site.linkFor(l.href); if (L && L.internal && typeof L.href === 'string' && L.href.startsWith('/')) paths.add(L.href.split('#')[0] || '/'); } catch {}
  }
  const out = [];
  for (const p of [...paths].slice(0, limit)) {
    let status = 0;
    try { const r = await fetch(baseUrl + p, { redirect: 'manual', signal: AbortSignal.timeout(15000) }); status = r.status; await r.arrayBuffer().catch(() => {}); } catch { status = -1; }
    out.push({ path: p, status, ok: status >= 200 && status < 400, page: paths.has(p) && site.pages.some((x) => x.route === p) });
  }
  return out;
}

export async function selfCheck({ outDir, projectRoot, site, opts, llmCfg = null, hooks = null, version = '' }) {
  const t0 = Date.now();
  log.step('Самопроверка: next build → самоисправление → визуальная регрессия');
  const report = { version, startedAt: new Date().toISOString(), deps: null, build: null, visual: null, links: null };
  report.deps = await ensureDeps(projectRoot, { mode: opts.deps || 'shared', outDir });
  if (!report.deps.ok) log.warn('Сборка пропущена: ' + report.deps.reason);
  else {
    const llm = llmCfg && llmCfg.enabled ? llmCfg : null;
    report.build = await healProject(projectRoot, {
      iterations: opts.healIterations ?? 4, llm, outDir,
      onIteration: (s) => log.info(`next build #${s.iteration}: ${s.ok ? color.green('OK') : color.red(`ошибок ${s.errors.length}`)} ${color.dim(secs(s.ms || 0))}${s.errors.length ? color.dim(' — ' + s.errors.slice(0, 2).map((e) => (e.file ? e.file + ': ' : '') + e.message.slice(0, 90)).join(' | ')) : ''}`),
    });
    const fixes = report.build.history.flatMap((h) => h.fixes.filter((f) => f.files).map((f) => `${f.by}: ${f.files.join(', ')}`));
    if (report.build.ok) log.ok(`Сборка прошла${report.build.iterations > 1 ? ` после ${report.build.iterations - 1} итерац. исправлений` : ' с первого раза'}${fixes.length ? ` (${fixes.length} исправл.)` : ''}`);
    else log.warn(`Сборка не прошла за ${report.build.iterations} итерац. — детали в VERIFICATION_REPORT.md`);
  }
  if (report.build && report.build.ok && opts.visual !== false) {
    const { startNext } = await import('./server.mjs');
    let srv = null;
    try {
      srv = await startNext(projectRoot, { host: '127.0.0.1' });
      const { visualRegression } = await import('./visual.mjs');
      report.visual = await visualRegression({ site, outDir, baseUrl: srv.url, opts });
      const minSim = opts.minSimilarity ?? 0.85;
      if (opts.visualHeal !== false && report.visual && (report.visual.min ?? 1) < minSim) {
        const { healVisualDrift } = await import('./visual-heal.mjs');
        const llm = llmCfg && llmCfg.enabled ? llmCfg : null;
        const vh = await healVisualDrift({ projectRoot, outDir, site, visualReport: report.visual, llm, minSimilarity: minSim });
        report.visualHeal = vh;
        if (vh.fixed > 0) {
          log.info(`Визуальное самоисправление: обновлено компонентов ${vh.fixed}/${vh.attempted}, пересборка…`);
          await srv.stop(); srv = null;
          const rebuild = await healProject(projectRoot, { iterations: 2, llm, outDir });
          if (rebuild.ok) {
            srv = await startNext(projectRoot, { host: '127.0.0.1' });
            report.visual = await visualRegression({ site, outDir, baseUrl: srv.url, opts });
          }
        }
      }
      report.links = await checkLinks(srv.url, site);
      const v = report.visual;
      log.ok(`Визуальное сходство (по секциям): среднее ${pct(v.average)}, минимум ${pct(v.min)} · строгое ${pct(v.strict && v.strict.average)} / ${pct(v.strict && v.strict.min)} · раскладка ${pct(v.layout && v.layout.average)}; ссылки: ${linkSummary(report.links)}`);
    } catch (e) { report.visualError = String((e && e.message) || e).split('\n')[0]; log.warn('Визуальная проверка: ' + report.visualError); }
    finally { if (srv) await srv.stop(); }
  }
  report.ms = Date.now() - t0;
  const md = renderReport(report, site, opts);
  const reportFile = path.join(outDir, 'VERIFICATION_REPORT.md');
  await writeText(reportFile, md);
  await writeJSON(path.join(outDir, 'verify', 'selfcheck.json'), report);
  if (hooks) await hooks.emit('afterProject', { root: projectRoot, files: [], site, verification: report });
  const min = opts.minSimilarity ?? 0.85;
  const okBuild = !!(report.build && report.build.ok);
  const summaryLine = !report.deps.ok ? 'сборка пропущена (нет зависимостей)' : `${okBuild ? 'build ✓' : 'build ✗'}${report.visual ? `, сходство ${pct(report.visual.average)}` : ''}${report.links ? `, ${linkSummary(report.links)}` : ''}`;
  const passed = okBuild && (!report.visual || (report.visual.min ?? 1) >= min);
  return { ...report, reportFile, summaryLine, passed, exitCode: opts.strict && !passed ? 3 : 0 };
}

export function renderReport(r, site, opts = {}) {
  const min = opts.minSimilarity ?? 0.85;
  const L = [`# VERIFICATION_REPORT — ${site.home.raw.meta.title || site.origin}`, '', `> ${site.origin} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · site-blueprint ${r.version} · ${secs(r.ms || 0)}`, ''];
  L.push('## 1. Сборка (`next build`)', '');
  if (!r.deps || !r.deps.ok) L.push(`⚠ Пропущена: ${r.deps ? r.deps.reason : 'нет данных'}.`, '', 'Запусти вручную: `cd project && npm install && npm run build`, затем `site-blueprint heal <папка>`.', '');
  else if (r.build) {
    L.push(`**Итог:** ${r.build.ok ? '✅ сборка проходит' : '❌ сборка не проходит'} · итераций: ${r.build.iterations} · LLM-исправлений: ${r.build.llmCalls || 0} · зависимости: ${r.deps.mode}${r.deps.location ? ' (`' + r.deps.location + '`)' : ''}`, '');
    L.push('| # | Результат | Ошибки | Исправления |', '|---|---|---|---|');
    for (const h of r.build.history) L.push(`| ${h.iteration} | ${h.ok ? 'OK' : 'ошибка'} | ${h.errors.slice(0, 4).map((e) => `${e.file ? '`' + e.file + (e.line ? ':' + e.line : '') + '` ' : ''}${e.message.replace(/\|/g, '\\|').slice(0, 140)}`).join('<br>') || '—'} | ${h.fixes.map((f) => `${f.by}${f.files ? ': ' + f.files.map((x) => '`' + x + '`').join(', ') : f.error ? ' (ошибка: ' + f.error + ')' : ''}`).join('<br>') || '—'} |`);
    L.push('');
    if (!r.build.ok) L.push('Хвост вывода последней сборки:', '', '```', r.build.tail || '', '```', '');
  }
  L.push('## 2. Визуальная регрессия (оригинал vs клон)', '');
  if (r.visual) {
    const v = r.visual;
    L.push(`Порог pixelmatch: ${opts.threshold ?? 0.1}; целевое сходство: ≥ ${pct(min)}.`, '');
    L.push(`- **Сходство по секциям** (основная метрика): среднее **${pct(v.average)}**, минимум **${pct(v.min)}** — каждая секция оригинала сравнивается с клоном на своём вертикальном смещении (полосы до 600 px, эластичный поиск сдвига), разница высоты страницы засчитывается как отличие, области canvas/video/iframe исключены (меняются сами по себе).`);
    if (v.strict) L.push(`- **Строгое** (без выравнивания и масок, пиксель в пиксель по всей высоте): среднее ${pct(v.strict.average)}, минимум ${pct(v.strict.min)} — один лишний перенос строки сверху делает красным всё ниже.`);
    if (v.layout) L.push(`- **Раскладка** (IoU текстовых блоков с тем же текстом, взвешено по площади): среднее ${pct(v.layout.average)}, минимум ${pct(v.layout.min)}.`);
    L.push('');
    L.push('| Страница | Вид | HTTP | По секциям | Строгое | Раскладка | Высота ориг./клон | Сравнение |', '|---|---|---|---|---|---|---|---|');
    for (const p of v.pages) L.push(`| ${p.route} | ${p.view} | ${p.status ?? '—'} | ${p.error ? '⚠ ' + p.error.slice(0, 80) : `${p.similarity >= min ? '✅' : '❌'} ${pct(p.similarity)}`} | ${p.error ? '—' : pct(p.strict)} | ${p.error ? '—' : `${pct(p.layout)}${typeof p.layoutMatched === 'number' && p.layoutMatched < 0.95 ? ` (найдено ${Math.round(p.layoutMatched * 100)}% текстов)` : ''}`} | ${p.heightOriginal || '—'} / ${p.heightClone || '—'} | ${p.composite ? `[compare](${p.composite}) · [diff](${p.diff})` : '—'} |`);
    L.push('');
    const worst = v.pages.flatMap((p) => (p.bands || []).map((b) => ({ ...b, route: p.route, view: p.view }))).sort((a, b) => a.similarity - b.similarity).slice(0, 12);
    if (worst.length) {
      L.push('### Секции с наибольшими расхождениями', '', '| Страница | Вид | Секция | Y | Высота | Сходство | Строгое | Сдвиг клона |', '|---|---|---|---|---|---|---|---|');
      for (const b of worst) L.push(`| ${b.route} | ${b.view} | ${b.name.replace(/\|/g, '/')} | ${Math.round(b.y)} | ${Math.round(b.h)} | ${pct(b.similarity)} | ${pct(b.strict)} | ${b.offset ? (b.offset > 0 ? '+' : '') + b.offset + ' px' : '0'} |`);
      L.push('', 'Красное на diff-картинках — отличающиеся пиксели после выравнивания секций, голубое — исключённые области (canvas/video/iframe). «Сдвиг клона» — насколько секция клона выше/ниже, чем в оригинале: растущий сдвиг означает, что секция выше по странице длиннее оригинала (перенос строки, отступы, шрифт). Частые причины красного: другой шрифт/межстрочный интервал, не скачанная картинка, динамический контент (даты, счётчики).', '');
    }
    if (r.visualHeal && r.visualHeal.attempted > 0) {
      L.push('### Автоматическое исправление вёрстки (Visual Auto-Heal)', '', `Проверено проблемных секций: ${r.visualHeal.attempted}, пропатчено: ${r.visualHeal.fixed}.`, '');
      L.push('| Компонент | Файл | Маршрут | Исходное сходство | Метод |', '|---|---|---|---|---|');
      for (const d of r.visualHeal.details || []) {
        L.push(`| \`${d.name}\` | \`${d.file}\` | ${d.route} (${d.view}) | ${pct(d.beforeSimilarity)} | ${d.method || '—'} |`);
      }
      L.push('');
    }
  } else if (r.visualError) L.push(`⚠ Не выполнена: ${r.visualError}`, '');
  else L.push('Не выполнялась (сборка не прошла или `--no-visual`).', '');
  L.push('## 3. Ссылки клона', '');
  if (r.links) {
    const bad = r.links.filter((l) => !l.ok);
    L.push(`Проверено ${r.links.length} внутренних путей, без ошибок: ${r.links.length - bad.length}.`, '');
    if (bad.length) { L.push('| Путь | HTTP | Страница из обхода |', '|---|---|---|'); for (const l of bad.slice(0, 60)) L.push(`| \`${l.path}\` | ${l.status} | ${l.page ? 'да' : 'нет (ссылка на не скачанную страницу)'} |`); L.push(''); }
  } else L.push('Не проверялись.', '');
  L.push('## 4. Что дальше', '', '- `site-blueprint heal <папка>` — повторить сборку и самоисправление после ручных правок.', '- `site-blueprint verify <папка> --url http://localhost:3000` — сверка запущенного клона (тексты, якоря, переполнение, шрифты).', '- Мастер-промпт из `SITE_CLONE_BLUEPRINT.md` + этот отчёт → ИИ-кодеру: «доведи секции с наименьшим сходством».', '');
  return L.join('\n');
}
