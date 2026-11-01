// HTTrack-style resilient downloader on top of Node's fetch (undici):
// - retries with exponential backoff + jitter on network errors and 408/425/429/5xx, honours Retry-After;
// - resumes interrupted transfers with HTTP Range/If-Range (also across runs via a *.part file);
// - idle timeout (no bytes for N ms) instead of a fixed total timeout, hard size limit;
// - HostThrottle: per-host concurrency and an interval that grows on 429/503 and relaxes on success.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sleep } from '../util.mjs';

export const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const NET_ERR = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|terminated|other side closed|fetch failed|UND_ERR|aborted|premature close/i;

export class FetchError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'FetchError'; Object.assign(this, extra); }
}

// Retry-After: seconds or an HTTP date
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(value);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

// "equal jitter": half fixed, half random — avoids thundering herds after an outage
export function backoffMs(attempt, { base = 500, cap = 15000, random = Math.random } = {}) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export class HostThrottle {
  constructor({ concurrency = 4, minIntervalMs = 0, maxIntervalMs = 10000 } = {}) {
    this.concurrency = Math.max(1, concurrency); this.minIntervalMs = minIntervalMs; this.maxIntervalMs = maxIntervalMs;
    this.hosts = new Map();
  }
  state(url) {
    let host = 'unknown'; try { host = new URL(url).host; } catch {}
    if (!this.hosts.has(host)) this.hosts.set(host, { active: 0, queue: [], interval: this.minIntervalMs, last: 0, slowdowns: 0 });
    return this.hosts.get(host);
  }
  async acquire(url) {
    const s = this.state(url);
    if (s.active >= this.concurrency) await new Promise((r) => s.queue.push(r));
    s.active++;
    const wait = s.last + s.interval - Date.now();
    s.last = Math.max(Date.now(), s.last + s.interval);
    if (wait > 0) await sleep(wait);
  }
  release(url, { status = 0, error = null } = {}) {
    const s = this.state(url);
    s.active = Math.max(0, s.active - 1);
    if (status === 429 || status === 503) { s.interval = Math.min(this.maxIntervalMs, s.interval * 2 + 250); s.slowdowns++; }
    else if (!error && status && status < 400) s.interval = Math.max(this.minIntervalMs, Math.round(s.interval * 0.8));
    const next = s.queue.shift(); if (next) next();
  }
  interval(url) { return this.state(url).interval; }
}

async function readPart(partFile) {
  if (!partFile) return { buf: null, meta: null };
  try {
    const [buf, meta] = await Promise.all([fsp.readFile(partFile), fsp.readFile(partFile + '.json', 'utf8').then(JSON.parse).catch(() => null)]);
    return { buf, meta };
  } catch { return { buf: null, meta: null }; }
}

/**
 * Download a URL into memory with retries and resume.
 * @returns {Promise<{buf: Buffer, status: number, contentType: string, headers: Record<string,string>, finalUrl: string, attempts: number, resumed: boolean}>}
 */
export async function download(url, {
  headers = {}, method = 'GET', retries = 3, idleTimeoutMs = 20000, totalTimeoutMs = 180000, maxBytes = Infinity,
  partFile = null, throttle = null, fetchImpl = globalThis.fetch, onRetry = null, backoff = {},
} = {}) {
  const t0 = Date.now();
  let chunks = []; let received = 0; let validator = null; let canResume = false; let resumed = false;
  const part = await readPart(partFile);
  if (part.buf && part.buf.length && part.meta && part.meta.url === url && (part.meta.etag || part.meta.lastModified)) {
    chunks = [part.buf]; received = part.buf.length; validator = part.meta.etag || part.meta.lastModified; canResume = true;
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (Date.now() - t0 > totalTimeoutMs) break;
    const ac = new AbortController();
    let idle = null; const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('idle timeout')), idleTimeoutMs); };
    const total = setTimeout(() => ac.abort(new Error('total timeout')), Math.max(1000, totalTimeoutMs - (Date.now() - t0)));
    const h = { ...headers };
    if (received > 0 && canResume) { h.Range = `bytes=${received}-`; if (validator) h['If-Range'] = validator; }
    let status = 0; let res = null;
    if (throttle) await throttle.acquire(url);
    try {
      arm();
      res = await fetchImpl(url, { method, headers: h, redirect: 'follow', signal: ac.signal });
      status = res.status;
      if (RETRY_STATUS.has(status)) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt, backoff);
        try { await res.body?.cancel(); } catch {}
        throw new FetchError(`HTTP ${status}`, { status, retryable: true, wait: Math.min(wait, 60000) });
      }
      if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new FetchError(`HTTP ${status}`, { status, retryable: false }); }
      const ar = (res.headers.get('accept-ranges') || '').toLowerCase();
      const etag = res.headers.get('etag'); const lm = res.headers.get('last-modified');
      if (status === 206 && received > 0) {
        const cr = /bytes\s+(\d+)-/.exec(res.headers.get('content-range') || '');
        if (!cr || Number(cr[1]) !== received) { chunks = []; received = 0; } else resumed = true;
      } else if (received > 0) { chunks = []; received = 0; } // server ignored Range: start over
      if (ar.includes('bytes') || etag || lm) { canResume = ar !== 'none'; validator = etag || lm || validator; }
      const len = Number(res.headers.get('content-length') || 0);
      if (Number.isFinite(maxBytes) && len && received + len > maxBytes) { try { await res.body?.cancel(); } catch {} throw new FetchError('too large', { status, retryable: false, tooLarge: true }); }
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          const b = Buffer.from(value); chunks.push(b); received += b.length;
          if (received > maxBytes) { ac.abort(); throw new FetchError('too large', { status, retryable: false, tooLarge: true }); }
        }
      }
      clearTimeout(idle); clearTimeout(total);
      if (throttle) throttle.release(url, { status });
      if (partFile) { await fsp.rm(partFile, { force: true }).catch(() => {}); await fsp.rm(partFile + '.json', { force: true }).catch(() => {}); }
      const hdrs = {}; res.headers.forEach((v, k) => { hdrs[k] = v; });
      return { buf: Buffer.concat(chunks), status: status === 206 ? 200 : status, contentType: res.headers.get('content-type') || '', headers: hdrs, finalUrl: res.url || url, attempts: attempt + 1, resumed };
    } catch (e) {
      clearTimeout(idle); clearTimeout(total);
      if (throttle) throttle.release(url, { status, error: e });
      const reason = ac.signal.aborted && ac.signal.reason ? ac.signal.reason.message : '';
      const err = e instanceof FetchError ? e : new FetchError(reason || String((e && e.cause && e.cause.message) || (e && e.message) || e), { retryable: NET_ERR.test(String(e && (e.cause?.code || e.cause?.message || e.message))) || !!reason, network: true });
      if (err.tooLarge) throw err;
      lastErr = err;
      // keep the partial body for the next run (big media): resume from here with Range
      if (partFile && received > 0 && validator) {
        await fsp.mkdir(path.dirname(partFile), { recursive: true }).catch(() => {});
        await fsp.writeFile(partFile, Buffer.concat(chunks)).catch(() => {});
        await fsp.writeFile(partFile + '.json', JSON.stringify({ url, etag: validator.startsWith('"') || validator.startsWith('W/') ? validator : null, lastModified: validator.startsWith('"') || validator.startsWith('W/') ? null : validator })).catch(() => {});
      }
      if (!err.retryable || attempt >= retries) break;
      const wait = err.wait ?? backoffMs(attempt, backoff);
      if (onRetry) { try { onRetry({ url, attempt: attempt + 1, error: err, wait, received }); } catch {} }
      if (!(canResume && received > 0)) { chunks = []; received = 0; }
      await sleep(wait);
    }
  }
  throw lastErr || new FetchError('download failed');
}
