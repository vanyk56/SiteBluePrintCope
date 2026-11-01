// API sniffer: records the site's own XHR/fetch traffic (JSON, HTML fragments, XML) while pages are crawled,
// so the clone can run on local mock route handlers instead of the real backend.
//  - noise is filtered: trackers/analytics, static files, Cloudflare/captcha endpoints, HMR, RSC payloads
//  - cache busters (?_=1730…, ?t=…, ?cb=…) are dropped from the match key
//  - GraphQL is recognised (operationName / persisted query hash) — one mock per operation + variables
//  - everything is redacted (tokens, cookies, e-mails, phones, cards) before it touches the disk
// Used as a built-in plugin of the crawler (afterResponse hook) and by the browser-extension importer (record()).
import path from 'node:path';
import crypto from 'node:crypto';
import { isTrackerUrl } from '../sanitize/trackers.mjs';
import { Redactor } from './redact.mjs';
import { writeJSON } from '../util.mjs';
import { safeName } from '../net/filenames.mjs';

const STATIC_EXT = /\.(css|js|mjs|cjs|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|ogg|wav|wasm|pdf|zip|gz|br)$/i;
const NOISE = /\/(cdn-cgi|__nextjs[\w-]*|_next\/webpack-hmr|_next\/static|sockjs-node|__webpack_hmr|recaptcha|hcaptcha|turnstile|challenge-platform|captcha|__vite_ping|livereload)(\/|\.|$)|challenges\.cloudflare\.com|www\.google\.com\/recaptcha|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|\.hot-update\.|\/sentry\/|\/beacon\/|\/collect(\?|$)|\/track(ing)?(\/|\?|$)|\/log(s|ging)?(\/|\?|$)|\/metrics?(\/|\?|$)|\/telemetry(\/|\?|$)|\/rum(\/|\?|$)/i;
const ALWAYS_BUST = /^(_|__|_t|__t|_ts|ts|timestamp|cb|cachebuster|cache_?buster|nocache|no_?cache|rnd|rand|random|_dc|bust|_v|_r|_rnd|_cb)$/i;
const MAYBE_BUST = /^(t|v|ver|r|time|nonce|uid|hash|_hash)$/i;
const looksRandom = (v) => /^\d{9,}$/.test(v) || /^0?\.\d{6,}$/.test(v) || /^[0-9a-f]{12,}$/i.test(v);
export const isCacheBuster = (k, v) => ALWAYS_BUST.test(k) || (MAYBE_BUST.test(k) && looksRandom(String(v)));

const hash = (s, n = 6) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const MAX_BODY = 2 * 1048576;     // raw response bytes we are willing to keep
const MAX_JSON_CHARS = 600000;    // larger JSON is trimmed (long arrays → first 60 items)

function kindOf(ct, body) {
  const c = String(ct || '').toLowerCase();
  if (/json|graphql-response/.test(c)) return 'json';
  if (/text\/x-component|rsc/.test(c)) return null;                 // React Server Components payload — Next internals
  if (/html/.test(c)) return 'html';
  if (/xml/.test(c)) return 'xml';
  if (/text\/plain|^$/.test(c) && body && /^\s*[[{]/.test(body)) { try { JSON.parse(body); return 'json'; } catch {} }
  if (/text\/(plain|csv)/.test(c)) return 'text';
  return null;
}
function trimJson(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => trimJson(x, depth + 1));
  if (v && typeof v === 'object' && depth < 30) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = trimJson(x, depth + 1); return o; }
  if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '…';
  return v;
}
function parseJson(s) { try { return JSON.parse(s); } catch { return undefined; } }

// GraphQL: { operationName, query, variables, extensions.persistedQuery } (POST body, batched array, or GET params)
export function graphqlInfo(u, body) {
  const ops = [];
  const take = (b) => {
    if (!b || typeof b !== 'object') return;
    const q = typeof b.query === 'string' ? b.query : '';
    const name = b.operationName || (/(query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(q) || [])[2] || (b.extensions && b.extensions.persistedQuery && 'persisted-' + String(b.extensions.persistedQuery.sha256Hash || '').slice(0, 10)) || '';
    if (q || name) ops.push({ operationName: name || 'anonymous', type: (/^\s*(mutation|subscription)/.exec(q) || [, 'query'])[1], variables: b.variables && typeof b.variables === 'object' ? b.variables : null });
  };
  if (Array.isArray(body)) body.forEach(take); else take(body);
  if (!ops.length && u.searchParams.has('query')) take({ query: u.searchParams.get('query'), operationName: u.searchParams.get('operationName'), variables: parseJson(u.searchParams.get('variables') || '') });
  if (!ops.length && /\/(graphql|gql)\/?$/i.test(u.pathname) && u.searchParams.has('operationName')) take({ operationName: u.searchParams.get('operationName'), extensions: parseJson(u.searchParams.get('extensions') || '') });
  return ops.length ? { operationName: ops.map((o) => o.operationName).join('+'), type: ops[0].type, variables: ops.length === 1 ? ops[0].variables : ops.map((o) => o.variables) } : null;
}

export class ApiSniffer {
  constructor({ outDir, origin, redact = true, maxMocks = 250, sameSiteOnly = false } = {}) {
    this.outDir = outDir; this.origin = origin; this.maxMocks = maxMocks; this.sameSiteOnly = sameSiteOnly;
    this.redactor = new Redactor({ enabled: redact !== false });
    this.entries = new Map(); this.pending = new Set();
    this.skipped = { trackers: 0, static: 0, noise: 0, errors: 0, large: 0, other: 0, limit: 0 };
    let host = ''; try { host = new URL(origin).hostname.replace(/^www\./, ''); } catch {}
    this.siteHost = host;
  }
  _sameSite(h) { const x = h.replace(/^www\./, ''); return !this.siteHost || x === this.siteHost || x.endsWith('.' + this.siteHost) || this.siteHost.endsWith('.' + x); }
  // quick pre-filter on metadata (before the body is read)
  accepts({ url, method = 'GET', resourceType = 'fetch', status = 200 }) {
    let u; try { u = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (/^(OPTIONS|HEAD)$/i.test(method)) return false;
    if (resourceType && !/^(xhr|fetch|eventsource|other)$/.test(resourceType)) return false;
    if (isTrackerUrl(url)) { this.skipped.trackers++; return false; }
    if (NOISE.test(u.pathname + u.search) || NOISE.test(u.hostname + '/')) { this.skipped.noise++; return false; }
    if (STATIC_EXT.test(u.pathname)) { this.skipped.static++; return false; }
    if (status >= 400 && status !== 401 && status !== 403) { this.skipped.errors++; return false; }
    if (status >= 300 && status < 400) return false;
    if (this.sameSiteOnly && !this._sameSite(u.hostname)) { this.skipped.other++; return false; }
    return true;
  }
  // Playwright response (crawler hook)
  onResponse({ response, page, resourceType }) {
    try {
      const req = response.request();
      const meta = { url: response.url(), method: req.method(), resourceType: resourceType || req.resourceType(), status: response.status() };
      if (!this.accepts(meta)) return;
      const headers = response.headers();
      const len = +(headers['content-length'] || 0);
      if (len > MAX_BODY) { this.skipped.large++; return; }
      const p = (async () => {
        let buf; try { buf = await response.body(); } catch { return; }
        if (!buf) return;
        let reqBody = null; try { reqBody = req.postData(); } catch {}
        this.record({ ...meta, contentType: headers['content-type'] || '', requestHeaders: req.headers(), requestBody: reqBody, body: buf, page });
      })().catch(() => {}).finally(() => this.pending.delete(p));
      this.pending.add(p);
    } catch {}
  }
  // generic entry point (also used for traffic captured by the browser extension)
  record({ url, method = 'GET', status = 200, contentType = '', requestHeaders = {}, requestBody = null, body, page = null, resourceType = 'fetch' }) {
    if (!this.accepts({ url, method, resourceType, status })) return null;
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body));
    if (raw.length > MAX_BODY) { this.skipped.large++; return null; }
    const text = raw.toString('utf8');
    const kind = kindOf(contentType, text);
    if (!kind) { this.skipped.other++; return null; }
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams) if (!isCacheBuster(k, v)) query[k] = v;
    const reqJson = typeof requestBody === 'string' && /^\s*[[{]/.test(requestBody) ? parseJson(requestBody) : undefined;
    const gql = graphqlInfo(u, reqJson);
    const external = !this._sameSite(u.hostname);
    const m = String(method).toUpperCase();
    const qKey = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join('&');
    const bodyKey = m === 'GET' ? '' : gql ? gql.operationName + JSON.stringify(gql.variables || '') : reqJson !== undefined ? JSON.stringify(reqJson) : String(requestBody || '').slice(0, 2000);
    const key = `${m} ${u.host}${u.pathname}?${qKey}#${bodyKey}`;
    const pageRef = page ? (page.__sbRef || page) : null;
    const prev = this.entries.get(key);
    if (prev) { prev.hits++; if (pageRef) prev.pageRefs.add(pageRef); return prev.id; }
    if (this.entries.size >= this.maxMocks) { this.skipped.limit++; return null; }
    const R = this.redactor;
    let parsed; let truncated = false;
    if (kind === 'json') {
      parsed = parseJson(text);
      if (parsed === undefined) return null;
      if (text.length > MAX_JSON_CHARS) { parsed = trimJson(parsed); truncated = true; }
      parsed = R.json(parsed);
    }
    const label = gql ? `gql-${gql.operationName}` : `${m.toLowerCase()}-${u.pathname.replace(/\/+$/, '') || 'root'}`;
    const id = `${safeName(label.replace(/[/.]+/g, '-'), 48)}-${hash(key)}`;
    const entry = {
      id, method: m, host: u.host, path: u.pathname, query: R.json(query), external,
      url: R.url(url).slice(0, 2000), graphql: gql ? { ...gql, variables: R.json(gql.variables) } : null,
      request: { headers: R.headers(requestHeaders), body: reqJson !== undefined ? R.json(reqJson) : requestBody ? R.text(String(requestBody)).slice(0, 4000) : null },
      status, contentType: String(contentType || '').split(';')[0].trim() || (kind === 'json' ? 'application/json' : 'text/plain'), kind,
      ...(kind === 'json' ? { body: parsed } : { bodyText: R.text(text).slice(0, 300000) }),
      bytes: raw.length, truncated, hits: 1, pageRefs: new Set(pageRef ? [pageRef] : []),
    };
    this.entries.set(key, entry);
    return id;
  }
  async flush() { await Promise.allSettled([...this.pending]); }
  // plugin interface for the crawler hooks
  plugin() {
    return { name: 'api-sniffer', hooks: { afterResponse: (ctx) => this.onResponse(ctx) } };
  }
  list() {
    return [...this.entries.values()].map(({ pageRefs, ...e }) => ({ ...e, pages: [...new Set([...pageRefs].map((r) => (typeof r === 'string' ? r : r && r.slug)).filter(Boolean))] }));
  }
  async write() {
    await this.flush();
    const dir = path.join(this.outDir, 'data', 'api-mocks');
    const list = this.list();
    const index = [];
    for (const e of list) {
      const file = `data/api-mocks/${e.id}.json`;
      await writeJSON(path.join(dir, e.id + '.json'), e);
      index.push({ id: e.id, method: e.method, host: e.host, path: e.path, query: e.query, external: e.external, operation: e.graphql ? e.graphql.operationName : null, status: e.status, contentType: e.contentType, kind: e.kind, bytes: e.bytes, truncated: e.truncated, hits: e.hits, pages: e.pages, file });
    }
    const summary = { version: 1, origin: this.origin, generatedAt: new Date().toISOString(), redaction: this.redactor.report(), count: index.length, skipped: this.skipped, entries: index };
    if (index.length || Object.values(this.skipped).some(Boolean)) await writeJSON(path.join(dir, 'index.json'), summary);
    return summary;
  }
}
