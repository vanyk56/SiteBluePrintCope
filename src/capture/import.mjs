// Import of a capture made by the browser extension (ZIP or unpacked folder, format v1 — see
// extension/lib/package.js) into the same output layout the Playwright crawler writes (data/crawl.json,
// data/pages/*.json, screenshots/, snapshots/, data/api-mocks/, project/public/…). After that the normal
// pipeline (analysis → project → LLM → blueprint → self-healing build) runs unchanged.
// Nothing executes from the archive: JSON is parsed, binaries are copied, names are validated, sizes are capped.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readZip, safeEntryName } from './zipread.mjs';
import { decodePng, cropRows, makeSheets } from './png.mjs';
import { analyzeSections } from '../analyze/page.mjs';
import { AssetStore } from '../crawl/assets.mjs';
import { saveRawAssets } from '../crawl/saveassets.mjs';
import { ApiSniffer } from './network.mjs';
import { SnapshotStore } from './snapshot.mjs';
import { Redactor } from './redact.mjs';
import { scanText, trackerOf, mergeTrackers } from '../sanitize/trackers.mjs';
import { log, color } from '../log.mjs';
import { normalizeUrl, pageSlug, writeJSON, writeText, ensureDir, exists, kebab, humanBytes } from '../util.mjs';

export const CAPTURE_FORMAT = 'site-blueprint-capture';
export const CAPTURE_VERSION = 1;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const errMsg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

/** unpacked capture folder → Map(name → Buffer) with the same limits as the ZIP reader */
async function readFolder(dir, { maxEntries = 50000, maxTotalBytes = 4 * 1024 ** 3 } = {}) {
  const out = new Map(); let total = 0;
  const walk = async (d, rel) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(path.join(d, e.name), r); continue; }
      const name = safeEntryName(r); if (!name) continue;
      const buf = await fsp.readFile(path.join(d, e.name));
      total += buf.length;
      if (out.size >= maxEntries || total > maxTotalBytes) throw new Error('папка захвата превышает лимиты');
      out.set(name, buf);
    }
  };
  await walk(dir, '');
  return out;
}

/** Load + validate. → { files: Map, manifest } */
export async function openCapture(file, opts = {}) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw new Error('файл не найден: ' + file);
  const maxMb = opts.maxUploadMb || 300;
  if (st.isFile() && st.size > maxMb * 1048576 * 1.05) throw new Error(`архив ${humanBytes(st.size)} больше лимита --max-upload-mb ${maxMb}`);
  const files = st.isDirectory() ? await readFolder(file) : readZip(await fsp.readFile(file), { maxTotalBytes: Math.max(maxMb * 4, 1024) * 1048576 });
  const mbuf = files.get('capture.json');
  if (!mbuf) throw new Error('в архиве нет capture.json — это не захват расширения site-blueprint');
  let manifest;
  try { manifest = JSON.parse(mbuf.toString('utf8')); } catch { throw new Error('capture.json повреждён'); }
  if (manifest.format !== CAPTURE_FORMAT) throw new Error('неизвестный формат захвата: ' + String(manifest.format).slice(0, 60));
  if (!(manifest.version >= 1)) throw new Error('неизвестная версия формата');
  if (manifest.version > CAPTURE_VERSION) throw new Error(`захват формата v${manifest.version}, а этот site-blueprint понимает v${CAPTURE_VERSION} — обнови CLI`);
  if (!Array.isArray(manifest.pages) || !manifest.pages.length) throw new Error('в захвате нет страниц');
  for (const p of manifest.pages) {
    if (!p || !p.raw || !files.has(safeEntryName(p.raw) || '')) throw new Error('в захвате нет данных страницы ' + ((p && (p.finalUrl || p.url)) || '?'));
    const u = normalizeUrl(p.finalUrl || p.url);
    if (!u || !/^https?:/i.test(u)) throw new Error('некорректный URL страницы в захвате: ' + String(p.finalUrl || p.url).slice(0, 120));
  }
  return { files, manifest };
}

function jsonOf(files, name, fallback = null) {
  const n = name && safeEntryName(name); if (!n || !files.has(n)) return fallback;
  try { return JSON.parse(files.get(n).toString('utf8')); } catch { return fallback; }
}
const emptyProbes = () => ({ hover: [], dropdowns: [], tabs: [], tabGroups: [], expand: [], details: [], dialogs: [] });
function normalizeProbes(st) {
  const p = emptyProbes(); if (!st || typeof st !== 'object') return p;
  for (const k of Object.keys(p)) if (Array.isArray(st[k])) p[k] = st[k];
  p.source = 'extension';
  return p;
}
function trackersOf(t) {
  if (!t) return [];
  const items = scanText(String(t.inline || '').slice(0, 800000));
  const srcs = Array.isArray(t.srcs) ? t.srcs.map(String).slice(0, 600) : [];
  for (const x of scanText(srcs.join('\n'))) { const cur = items.find((y) => y.id === x.id); if (cur) cur.ids = [...new Set([...cur.ids, ...x.ids])]; else items.push(x); }
  const have = new Set(items.map((x) => x.id));
  for (const u of srcs) { const k = trackerOf(u); if (k && !have.has(k.id)) { have.add(k.id); items.push({ id: k.id, name: k.name, ids: [], widget: !!k.widget }); } }
  return items;
}

/**
 * @param {string} file  capture ZIP (or unpacked folder)
 * @param {object} opts  CLI options (out, assets, api, redact, maxMocks, snapshot, offline…)
 * @returns {Promise<string>} output folder ready for runPipeline()
 */
export async function importCapture(file, opts = {}) {
  const t0 = Date.now();
  const { files, manifest } = await openCapture(file, opts);
  const first = manifest.pages[0];
  const start = normalizeUrl(manifest.start || first.url) || normalizeUrl(first.finalUrl);
  const origin = manifest.origin && /^https?:\/\//.test(manifest.origin) ? new URL(manifest.origin).origin : new URL(start).origin;
  const host = new URL(origin).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
  let outDir = opts.outDir ? path.resolve(opts.outDir) : path.resolve(String(opts.out || 'output'), `${host}-${stamp()}-ext`);
  if (!opts.outDir) { const base = outDir; let i = 2; while (await exists(outDir)) outDir = `${base}-${i++}`; }
  await ensureDir(outDir);
  const rel = (f) => (f ? path.relative(outDir, f).split(path.sep).join('/') : null);
  const ext = manifest.extension || {};
  log.step(`Импорт захвата из расширения${ext.version ? ' ' + ext.version : ''}: ${origin} (${manifest.pages.length} стр., режим ${manifest.mode || 'page'})`);
  console.log(color.dim(`  → ${outDir}`));
  if (opts.assets === false) log.info('Ассеты не сохраняются (--no-assets)');

  // ---------- assets the extension already fetched (browser cache / cookies of the user's session) ----------
  const offline = !!opts.offline;
  const assets = new AssetStore(outDir, offline ? { ...opts, assetRetries: 0 } : opts, null, {
    headers: { ...(manifest.userAgent ? { 'User-Agent': String(manifest.userAgent).slice(0, 300) } : {}), Referer: origin + '/' },
    ...(offline ? { fetchImpl: async () => { throw new Error('offline: файл не пришёл в захвате'); } } : {}),
  });
  let offered = 0;
  for (const a of jsonOf(files, manifest.assets, []) || []) {
    const n = a && safeEntryName(a.file || ''); if (!n || !files.has(n) || !a.url) continue;
    assets.offer(String(a.url), files.get(n), String(a.contentType || '')); offered++;
  }
  const css = new Map();
  for (const c of jsonOf(files, manifest.css, []) || []) {
    const n = c && safeEntryName(c.file || ''); if (!n || !files.has(n) || !c.url) continue;
    if (!css.has(c.url)) css.set(String(c.url), files.get(n).toString('utf8'));
  }

  // ---------- pages ----------
  const sniffer = opts.api !== false ? new ApiSniffer({ outDir, origin, redact: opts.redact !== false, maxMocks: opts.maxMocks || 250 }) : null;
  const snaps = opts.snapshot !== false ? new SnapshotStore(outDir, { assets: opts.assets === false ? null : assets }) : null;
  const redactor = new Redactor({ enabled: opts.redact !== false });
  const fonts = new Map(); const pages = []; const pageTrackers = []; const slugMap = new Map(); const slugs = new Set();
  const skipped = Array.isArray(manifest.skipped) ? manifest.skipped.slice(0, 500) : [];
  let hydrationBlobs = 0;
  const shotDir = path.join(outDir, 'screenshots');
  for (const p of manifest.pages) {
    const t1 = Date.now();
    const finalUrl = normalizeUrl(p.finalUrl || p.url);
    let slug = pageSlug(finalUrl); { const b = slug; let i = 2; while (slugs.has(slug)) slug = `${b}-${i++}`; } slugs.add(slug);
    slugMap.set(p.slug, slug);
    const raw = jsonOf(files, p.raw);
    if (!raw || raw.error || !raw.tree) { skipped.push({ url: finalUrl, reason: 'страница без DOM-дерева: ' + ((raw && raw.error) || 'нет данных') }); continue; }
    if (raw.html) await writeText(path.join(outDir, 'dom', slug + '.html'), raw.html);
    delete raw.html;
    // canvas frames read in the page (toDataURL) → static fallback images
    let ci = 0;
    for (const m of raw.media || []) {
      const d = m && typeof m.snapshotData === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(m.snapshotData) : null;
      if (m) delete m.snapshotData;
      if (!d || opts.assets === false) continue;
      const name = `canvas-${slug}-${++ci}.${d[1] === 'jpeg' ? 'jpg' : d[1]}`;
      await ensureDir(path.join(outDir, 'project', 'public', 'images'));
      await fsp.writeFile(path.join(outDir, 'project', 'public', 'images', name), Buffer.from(d[2], 'base64'));
      m.snapshot = '/images/' + name;
    }
    const { sections } = analyzeSections(raw);
    // screenshot (stitched by the extension) → desktop shot, section crops, LLM sheets
    const shots = { desktop: null, desktopTruncated: false, sections: [], llm: [] };
    const sn = p.screenshot && safeEntryName(p.screenshot);
    if (sn && files.has(sn)) {
      const png = files.get(sn);
      const full = path.join(shotDir, 'desktop', slug + '.png');
      await ensureDir(path.dirname(full)); await fsp.writeFile(full, png);
      shots.desktop = rel(full);
      const img = await decodePng(png);
      if (img) {
        shots.desktopTruncated = !!(p.screenshotInfo && p.screenshotInfo.truncated) || img.height + 40 < (raw.docHeight || 0);
        for (const s of sections) {
          const [, y, w, h] = s.node.r; if (h < 8 || w < 8) continue;
          const buf = await cropRows(img, y, Math.min(h, 5000)); if (!buf) continue;
          const f = path.join(shotDir, 'sections', slug, `${String(s.index + 1).padStart(2, '0')}-${s.type}.png`);
          await ensureDir(path.dirname(f)); await fsp.writeFile(f, buf);
          shots.sections.push({ index: s.index, type: s.type, file: rel(f) });
        }
        try { shots.llm = (await makeSheets(img, path.join(shotDir, 'llm', slug + '-desktop'), { width: 1000, maxH: 1800, max: 4 })).map((s) => ({ ...s, file: rel(s.file) })); }
        catch (e) { log.debug('sheets', slug, errMsg(e)); }
      } else log.warn(`${slug}: скриншот не удалось разобрать (нет pngjs?) — секционные кадры пропущены`);
    }
    const probes = normalizeProbes(jsonOf(files, p.state));
    pageTrackers.push({ page: slug, items: trackersOf(jsonOf(files, p.trackers)) });
    const hyd = jsonOf(files, p.hydration);
    if (hyd && Array.isArray(hyd.blobs)) {
      const blobs = [];
      for (const b of hyd.blobs.slice(0, 40)) {
        let data; try { data = JSON.parse(b.json); } catch { continue; }
        blobs.push({ kind: String(b.kind || ''), ...(b.name ? { name: String(b.name) } : {}), ...(b.id ? { id: String(b.id) } : {}), data: redactor.json(data) });
      }
      if (blobs.length || hyd.storage) { await writeJSON(path.join(outDir, 'data', 'hydration', slug + '.json'), { url: finalUrl, redacted: redactor.enabled, blobs, storageKeys: hyd.storage || null }); hydrationBlobs += blobs.length; }
    }
    const snap = jsonOf(files, p.snapshot);
    if (snaps && snap && snap.html) await snaps.add(slug, snap);
    if (opts.assets !== false) await saveRawAssets(raw, assets, fonts, { timeoutMs: offline ? 20000 : 180000 });
    const rec = {
      url: normalizeUrl(p.url) || finalUrl, finalUrl, slug, depth: +p.depth || 0, from: p.from ? slugMap.get(p.from) || null : null, status: 200,
      title: (raw.meta && raw.meta.title) || p.title || '', crawledAt: manifest.createdAt || new Date().toISOString(), ms: +p.ms || Date.now() - t1,
      sectionsFound: sections.map((s) => s.type), shots, probes, raw, mobile: null, source: 'extension',
    };
    await writeJSON(path.join(outDir, 'data', 'pages', slug + '.json'), rec, false);
    pages.push({ url: rec.url, finalUrl, slug, depth: rec.depth, from: rec.from, status: 200, title: rec.title, crawledAt: rec.crawledAt, ms: rec.ms, sectionsFound: rec.sectionsFound, shots, source: 'extension' });
    log.ok(`${slug}: ${raw.stats ? raw.stats.nodes : '?'} узлов, ${sections.length} секций, ${(raw.images || []).length} изобр.${probes.tabGroups.length || probes.dialogs.length || probes.expand.length ? `, стейт: вкладки ${probes.tabGroups.length}, диалоги ${probes.dialogs.length}, раскрытия ${probes.expand.length}` : ''}`);
  }
  if (!pages.length) throw new Error('ни одна страница захвата не содержит DOM-дерева');

  // ---------- API responses captured in the tab ----------
  if (sniffer) {
    for (const e of jsonOf(files, manifest.api, []) || []) {
      if (!e || !e.url) continue;
      const body = e.encoding === 'base64' ? Buffer.from(String(e.body || ''), 'base64') : e.body;
      try {
        sniffer.record({ url: String(e.url), method: e.method || 'GET', status: +e.status || 200, contentType: e.contentType || '', requestHeaders: e.requestHeaders || {}, requestBody: e.requestBody ?? null, body, page: (e.page && slugMap.get(e.page)) || null, resourceType: e.resourceType || 'fetch' });
      } catch (x) { log.debug('api', errMsg(x)); }
    }
  }

  // ---------- snapshots, CSS, summary ----------
  let snapList = null;
  if (snaps && snaps.items.length) {
    try { snapList = await snaps.finalize(pages); log.ok(`Автономные HTML-снимки: ${snapList.length} → snapshots/`); }
    catch (e) { log.warn('Снимки страниц: ' + errMsg(e)); }
  }
  const cssIndex = []; let n = 0;
  for (const [url, text] of css) {
    let base = 'style'; try { base = kebab(path.basename(new URL(url).pathname).replace(/\.css$/i, ''), 40) || 'style'; } catch {}
    const f = path.join(outDir, 'data', 'css', `${String(++n).padStart(2, '0')}-${base}.css`);
    await writeText(f, text); cssIndex.push({ url, file: rel(f), bytes: text.length });
  }
  const am = assets.manifest();
  const api = sniffer ? await sniffer.write() : null;
  if (api && api.count) log.ok(`API: ${api.count} ответ(ов) → data/api-mocks (редакция: ${api.redaction.enabled ? api.redaction.replaced + ' замен' : 'выключена'})`);
  const trackers = { found: mergeTrackers(pageTrackers), blocked: [] };
  const firstRaw = jsonOf(files, first.raw) || {};
  const viewport = firstRaw.viewport ? `${firstRaw.viewport.w}x${firstRaw.viewport.h}` : '1440x900';
  const summary = {
    start, origin, startedAt: manifest.createdAt || new Date(t0).toISOString(), durationMs: Date.now() - t0,
    options: { depth: Math.max(0, ...pages.map((p) => p.depth)), maxPages: pages.length, perTemplate: null, viewport, mobileViewport: null, robots: !!(manifest.options && manifest.options.robots !== false) },
    robots: { extension: true, checked: !!(manifest.options && manifest.options.robots !== false), mode: manifest.mode || 'page' }, sitemapCount: 0,
    pages, skipped, css: cssIndex, fonts: [...fonts.values()], assets: am,
    api: api ? { count: api.count, skipped: api.skipped, redaction: api.redaction, index: api.count ? 'data/api-mocks/index.json' : null } : null,
    trackers, snapshots: snapList ? { count: snapList.length, dir: 'snapshots', items: snapList } : null,
    hydration: hydrationBlobs ? { blobs: hydrationBlobs, dir: 'data/hydration', redacted: redactor.enabled } : null,
    source: 'extension',
    capture: { file: path.basename(file), createdAt: manifest.createdAt || null, mode: manifest.mode || 'page', extension: { name: ext.name || 'site-blueprint', version: ext.version || null }, userAgent: manifest.userAgent || null, offered, options: manifest.options || {}, counts: manifest.counts || null, warnings: (manifest.warnings || []).slice(0, 50) },
  };
  await writeJSON(path.join(outDir, 'data', 'crawl.json'), summary);
  log.ok(`Импорт завершён: ${pages.length} стр., ассетов ${am.saved.length} (${humanBytes(am.bytes)}; из захвата ${offered}), CSS ${cssIndex.length} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return outDir;
}
