// LLM stage: per-page review (with screenshots) + global design pass. Results are cached in data/llm/ by prompt hash.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { chat } from './client.mjs';
import { SYSTEM, pagePrompt, globalPrompt, splitByComponent, splitSections } from './prompts.mjs';
import { limiter, sha, exists, readJSON, writeJSON, writeText } from '../util.mjs';
import { log, color } from '../log.mjs';

async function imagePart(outDir, rel) {
  const buf = await fsp.readFile(path.join(outDir, rel));
  const ext = path.extname(rel).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } };
}

function pickImages(p, max, { mobileFirst = 2 } = {}) {
  const d = ((p.rec.shots && p.rec.shots.llm) || []).map((s) => ({ file: s.file, label: `десктоп ${s.part}/${s.of} (y ${s.y0}–${s.y1}px)` }));
  const m = ((p.rec.mobile && p.rec.mobile.llm) || []).map((s) => ({ file: s.file, label: `мобильный ${s.part}/${s.of}` }));
  const mob = m.slice(0, Math.min(mobileFirst, Math.max(0, max - 1)));
  return [...d.slice(0, Math.max(0, max - mob.length)), ...mob];
}

export async function runLLM(site, outDir, llm, { lang = 'ru' } = {}) {
  const res = { provider: llm.provider, model: llm.model, vision: llm.vision, global: null, globalSections: new Map(), pages: new Map(), errors: [], calls: 0, cached: 0, usage: { prompt: 0, completion: 0 }, ms: 0 };
  const dir = path.join(outDir, 'data', 'llm');
  const lim = limiter(Math.max(1, llm.concurrency || 1));
  let fatal = null;
  async function call(key, label, text, imgs) {
    if (fatal) throw fatal;
    const files = llm.vision ? imgs : [];
    const hash = sha(JSON.stringify([llm.model, SYSTEM, text, files.map((f) => f.file)]), 16);
    const cacheFile = path.join(dir, key + '.json');
    if (await exists(cacheFile)) { try { const c = await readJSON(cacheFile); if (c.hash === hash && c.text) { res.cached++; log.info(`${label}: из кэша`); return c.text; } } catch {} }
    const content = [{ type: 'text', text }];
    for (const f of files) { try { content.push(await imagePart(outDir, f.file)); } catch {} }
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: files.length ? content : text }];
    const t0 = Date.now();
    log.info(`${label}: запрос к ${llm.model}${files.length ? ` (+${files.length} скриншотов)` : ''}…`);
    const r = await chat(llm, messages, { label });
    res.calls++; res.ms += Date.now() - t0;
    res.usage.prompt += r.usage.prompt_tokens || 0; res.usage.completion += r.usage.completion_tokens || 0;
    await writeJSON(cacheFile, { hash, model: r.model, finish: r.finish, usage: r.usage, ms: r.ms, text: r.text });
    await writeText(path.join(dir, key + '.md'), r.text + '\n');
    log.ok(`${label}: ${r.text.length} символов за ${(r.ms / 1000).toFixed(1)} с${r.finish === 'length' ? color.yellow(' (обрезано по LLM_MAX_TOKENS)') : ''}`);
    return r.text;
  }
  const jobs = [];
  for (const p of site.pages) {
    const names = [...(p === site.home ? site.globals.map((g) => g.name) : []), ...p.blocks.filter((b) => !b.reused).map((b) => b.comp.name)];
    if (!names.length) continue;
    jobs.push(lim(async () => {
      try {
        const imgs = pickImages(p, llm.maxImages || 6);
        const text = pagePrompt(site, p, { lang, images: llm.vision ? imgs : [] });
        const out = await call('page-' + p.slug, `LLM ${p.route}`, text, imgs);
        res.pages.set(p.slug, { text: out, byComponent: splitByComponent(out, names) });
      } catch (e) { if (e.fatal) fatal = e; res.errors.push({ page: p.slug, error: e.message }); log.warn(`LLM ${p.route}: ${e.message}`); }
    }));
  }
  jobs.push(lim(async () => {
    try {
      const imgs = [...pickImages(site.home, 2, { mobileFirst: 1 })];
      const text = globalPrompt(site, { lang, images: llm.vision ? imgs : [] });
      const out = await call('global', 'LLM дизайн-система', text, imgs);
      res.global = out; res.globalSections = splitSections(out);
    } catch (e) { if (e.fatal) fatal = e; res.errors.push({ page: '_global', error: e.message }); log.warn(`LLM дизайн-система: ${e.message}`); }
  }));
  await Promise.all(jobs);
  if (fatal) res.fatal = fatal.message;
  return res;
}
