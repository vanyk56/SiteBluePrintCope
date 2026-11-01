// Plugin system in the spirit of website-scraper "actions".
// Every stage of the pipeline calls named hooks; a plugin is a plain object
//   { name: 'my-plugin', hooks: { afterResponse(ctx) {...}, generateFilename(name, ctx) {...} } }
// or a class/object with apply(register) — register('afterResponse', fn). Errors inside a plugin are logged
// and never break the crawl. Plugins are loaded with --plugin ./file.mjs (ESM, default export).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from '../log.mjs';

export const HOOKS = Object.freeze({
  beforeStart: 'старт обхода: { startUrl, opts, outDir }',
  beforeRequest: 'запрос страницы: { url, method, resourceType } → { abort: true } | { headers } | undefined',
  afterResponse: 'ответ сети: { response, url, status, resourceType, page, slug }',
  beforeExtract: 'перед извлечением DOM: { page, url, slug, view }',
  afterExtract: 'после извлечения: { page, raw, url, slug, view }',
  generateFilename: 'имя ассета: (name, { url, kind, category, ext, hint }) → имя файла',
  onAssetSaved: 'ассет сохранён: { url, web, file, bytes, category }',
  onAssetError: 'ассет не скачан: { url, error }',
  beforeWrite: 'файл проекта: (text, { file }) → новый текст',
  afterProject: 'проект записан: { root, files, site }',
  afterFinish: 'конвейер завершён: { outDir, site }',
  error: 'ошибка этапа: { stage, error }',
});

export class Hooks {
  constructor(plugins = []) {
    this.handlers = new Map(Object.keys(HOOKS).map((h) => [h, []]));
    this.plugins = [];
    for (const p of plugins) this.use(p);
  }
  // accepts { name, hooks }, { name, apply(register) }, a factory function or a plain map of hook functions
  use(plugin, owner) {
    if (!plugin) return this;
    if (typeof plugin === 'function' && !plugin.prototype?.apply) plugin = plugin();
    else if (typeof plugin === 'function') plugin = new plugin(); // eslint-disable-line new-cap
    const name = owner || plugin.name || `plugin-${this.plugins.length + 1}`;
    if (typeof plugin.apply === 'function') plugin.apply((hook, fn) => this.on(hook, fn, name));
    else for (const [k, fn] of Object.entries(plugin.hooks || plugin)) if (typeof fn === 'function' && k !== 'apply') this.on(k, fn, name);
    this.plugins.push(name);
    return this;
  }
  on(hook, fn, owner = 'anonymous') {
    if (!this.handlers.has(hook)) throw new Error(`неизвестный хук "${hook}" (есть: ${Object.keys(HOOKS).join(', ')})`);
    this.handlers.get(hook).push({ fn, owner });
    return this;
  }
  has(hook) { return (this.handlers.get(hook) || []).length > 0; }
  _fail(hook, owner, e) { log.warn(`плагин ${owner} (${hook}): ${String((e && e.message) || e).split('\n')[0]}`); }
  // call every handler in order; results are ignored
  async emit(hook, payload) {
    for (const { fn, owner } of this.handlers.get(hook) || []) { try { await fn(payload); } catch (e) { this._fail(hook, owner, e); } }
  }
  // each handler may transform the value (generateFilename, beforeWrite)
  async waterfall(hook, value, payload) {
    let v = value;
    for (const { fn, owner } of this.handlers.get(hook) || []) { try { const r = await fn(v, payload); if (r !== undefined && r !== null) v = r; } catch (e) { this._fail(hook, owner, e); } }
    return v;
  }
  // first non-empty answer wins (beforeRequest)
  async first(hook, payload) {
    for (const { fn, owner } of this.handlers.get(hook) || []) { try { const r = await fn(payload); if (r !== undefined && r !== null) return r; } catch (e) { this._fail(hook, owner, e); } }
    return undefined;
  }
}

// --plugin ./a.mjs,./b.mjs or npm package names; paths work on Windows (C:\…) and POSIX
export async function loadPlugins(specs, { cwd = process.cwd() } = {}) {
  const list = (Array.isArray(specs) ? specs : String(specs || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const out = [];
  for (const spec of list) {
    const isPath = /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(spec) || /\.(m?js|cjs)$/.test(spec);
    const id = isPath ? pathToFileURL(path.resolve(cwd, spec)).href : spec;
    const mod = await import(id);
    const plugin = mod.default || mod.plugin || mod;
    out.push({ spec, plugin });
  }
  return out;
}

export async function createHooks(opts = {}, builtins = []) {
  const hooks = new Hooks();
  for (const b of builtins) hooks.use(b);
  const specs = [opts.plugin, process.env.SB_PLUGINS].filter((x) => x && x !== true).join(',');
  if (specs) {
    for (const { spec, plugin } of await loadPlugins(specs)) {
      hooks.use(plugin, plugin.name || path.basename(spec));
      log.info(`плагин подключён: ${plugin.name || spec}`);
    }
  }
  return hooks;
}
