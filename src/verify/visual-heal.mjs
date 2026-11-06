// Closed-loop Visual Auto-Heal:
// Inspects section bands from visual.mjs where similarity < minSimilarity (default 0.85),
// maps them back to their generated Next.js component (.tsx), applies deterministic layout-drift fixes
// and optional LLM SEARCH/REPLACE patches, and backs up originals in verify/visual-heal-backup/.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists } from '../util.mjs';
import { parsePatches, applyPatch } from './build.mjs';

/**
 * Match degraded bands from `visualReport` back to `site.components`.
 */
export function findDegradedSections(visualReport, site, { minSimilarity = 0.85 } = {}) {
  if (!visualReport || ! Array.isArray(visualReport.pages) || !site || !Array.isArray(site.components)) return [];
  const byFile = new Map();

  for (const pageRow of visualReport.pages) {
    if (!Array.isArray(pageRow.bands)) continue;
    const sitePage = (site.pages || []).find((p) => p.slug === pageRow.slug || p.route === pageRow.route);
    for (const band of pageRow.bands) {
      if (typeof band.similarity !== 'number' || band.similarity >= minSimilarity) continue;
      // Band names have format: "<index+1>. <type> «<heading>»"
      const m = /^(\d+)\.\s+([a-z0-9_-]+)/i.exec(band.name || '');
      const secIdx = m ? Number(m[1]) - 1 : -1;
      const secType = m ? m[2] : '';

      let comp = null;
      if (sitePage && secIdx >= 0) {
        const block = (sitePage.blocks || []).find((b) => b.section && b.section.index === secIdx);
        if (block && block.comp) comp = block.comp;
      }
      if (!comp && secIdx >= 0) {
        comp = site.components.find((c) => c.page === pageRow.slug && c.index === secIdx);
      }
      if (!comp && secType) {
        comp = site.components.find((c) => c.type === secType && (!sitePage || c.usedOn?.has(sitePage.slug)));
      }
      if (!comp) continue;

      const prev = byFile.get(comp.file);
      if (!prev || band.similarity < prev.band.similarity) {
        byFile.set(comp.file, {
          comp,
          band,
          route: pageRow.route,
          view: pageRow.view,
        });
      }
    }
  }

  return [...byFile.values()].sort((a, b) => a.band.similarity - b.band.similarity);
}

/**
 * Deterministic layout-drift fixes for a component whose visual similarity dropped:
 * 1. Rigid fixed pixel widths >= 900px (`w-[1200px]`) without `max-w-full` -> adds `max-w-full` to prevent viewport overflow.
 * 2. Large vertical offset drift (`|offset| > 80px`) with fixed pixel heights `h-[...px]` on non-media containers -> `min-h-[...px]`.
 */
export function fixVisualDriftDeterministic(code, band = {}) {
  let out = String(code || '');
  let fixes = 0;

  // 1. Clamp rigid desktop widths (>= 900px) with max-w-full so they never overflow container/viewport
  out = out.replace(/\bclassName="([^"]*)"/g, (full, cls) => {
    const tokens = cls.split(/\s+/).filter(Boolean);
    let changed = false;
    for (let i = 0; i < tokens.length; i++) {
      const m = /^w-\[(\d+(?:\.\d+)?)px\]$/.exec(tokens[i]);
      if (m && parseFloat(m[1]) >= 900 && !tokens.includes('max-w-full')) {
        tokens.splice(i + 1, 0, 'max-w-full');
        changed = true;
        fixes++;
        break;
      }
    }
    return changed ? `className="${tokens.join(' ')}"` : full;
  });

  // 2. If vertical drift is severe (|offset| >= 80px), convert rigid container height h-[NNNpx] (NNN >= 320) on <section>/<div> to min-h-[NNNpx]
  if (Math.abs(band.offset || 0) >= 80) {
    out = out.replace(/<(section|div|article|main)\b([^>]*?)\bclassName="([^"]*)"/g, (full, tag, pre, cls) => {
      const tokens = cls.split(/\s+/).filter(Boolean);
      let changed = false;
      for (let i = 0; i < tokens.length; i++) {
        const m = /^h-\[(\d+(?:\.\d+)?)px\]$/.exec(tokens[i]);
        if (m && parseFloat(m[1]) >= 320) {
          tokens[i] = `min-h-[${m[1]}px]`;
          changed = true;
          fixes++;
        }
      }
      return changed ? `<${tag}${pre}className="${tokens.join(' ')}"` : full;
    });
  }

  return { code: out, changed: out !== code, fixes };
}

/**
 * Run Visual Auto-Heal on degraded sections.
 */
export async function healVisualDrift({ projectRoot, outDir, site, visualReport, llm = null, minSimilarity = 0.85, maxSections = 3 } = {}) {
  const degraded = findDegradedSections(visualReport, site, { minSimilarity }).slice(0, maxSections);
  if (!degraded.length) return { attempted: 0, fixed: 0, details: [] };

  const backupDir = path.join(outDir, 'verify', 'visual-heal-backup');
  const details = [];
  let fixed = 0;

  for (const item of degraded) {
    const { comp, band, route, view } = item;
    const absFile = path.join(projectRoot, comp.file);
    if (!(await exists(absFile))) continue;
    const origCode = await fsp.readFile(absFile, 'utf8');
    let nextCode = origCode;
    let method = null;

    // 1. Deterministic pass
    const det = fixVisualDriftDeterministic(nextCode, band);
    if (det.changed) {
      nextCode = det.code;
      method = 'deterministic';
    }

    // 2. Optional LLM pass if configured
    if (llm && llm.enabled) {
      try {
        const { chat } = await import('../llm/client.mjs');
        const prompt = [
          `Компонент \`${comp.file}\` на маршруте \`${route}\` (${view}) показал низкое визуальное сходство с оригиналом: ${(band.similarity * 100).toFixed(1)}% (вертикальный сдвиг: ${band.offset || 0}px, высота секции оригинала: ${band.h}px).`,
          comp.facts && comp.facts.length ? `Факты о секции:\n${comp.facts.join('\n')}` : '',
          `Исправь классы Tailwind в файле \`${comp.file}\`, чтобы устранить переполнение, съехавшую сетку или неверные отступы. Верни патч строго в формате:`,
          `FILE: ${comp.file}\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE`,
          `\nТекущий код \`${comp.file}\`:\n\`\`\`tsx\n${nextCode.slice(0, 30000)}\n\`\`\``,
        ].filter(Boolean).join('\n\n');

        const res = await chat(
          llm,
          [
            { role: 'system', content: 'Ты эксперт по Next.js 16 и Tailwind CSS v4. Возвращай только точные SEARCH/REPLACE патчи для исправления визуальных расхождений.' },
            { role: 'user', content: prompt },
          ],
          { maxTokens: 4000, temperature: 0.1, label: 'visual-heal' }
        );
        const patches = parsePatches(res.text);
        for (const p of patches) {
          const patched = applyPatch(nextCode, p);
          if (patched && patched !== nextCode) {
            nextCode = patched;
            method = method ? `${method}+llm` : 'llm';
          }
        }
      } catch {}
    }

    if (nextCode !== origCode) {
      const backupFile = path.join(backupDir, comp.file);
      await ensureDir(path.dirname(backupFile));
      await fsp.writeFile(backupFile, origCode, 'utf8');
      await fsp.writeFile(absFile, nextCode, 'utf8');
      comp.code = nextCode;
      fixed++;
      details.push({ file: comp.file, name: comp.name, route, view, beforeSimilarity: band.similarity, method });
    } else {
      details.push({ file: comp.file, name: comp.name, route, view, beforeSimilarity: band.similarity, method: 'unchanged' });
    }
  }

  return { attempted: degraded.length, fixed, details };
}
