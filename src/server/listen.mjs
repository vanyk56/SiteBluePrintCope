// `site-blueprint listen --port 3005` — local endpoint for the browser extension ("Отправить в локальный CLI").
// The extension POSTs a capture ZIP (format v1), the server imports it and runs the normal pipeline
// (analysis → Next.js project → LLM → blueprint → self-healing build) one job at a time.
// Security: binds to 127.0.0.1 only; Host header must be localhost (DNS rebinding); requests with a web Origin are
// rejected (only chrome-extension:// / moz-extension:// or no Origin for curl); a custom X-SB-Client header is
// required (forces a CORS preflight, which web pages never pass); optional shared token (--token / SB_LISTEN_TOKEN);
// upload size limit (--max-upload-mb, default 300).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { log, color } from '../log.mjs';
import { ensureDir, humanBytes } from '../util.mjs';

const EXT_ORIGIN = /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36}|safari-web-extension:\/\/[0-9A-Fa-f-]{36})$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const errMsg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 300);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} opts   CLI options: port, host, token, maxUploadMb, out, keepIncoming, allowOrigin
 * @param {object} deps   { pkg, onCapture(dir, job) → Promise<exitCode>, importImpl(file, opts) → Promise<dir> }
 * @returns {Promise<{ server, port, url, jobs, close }>}
 */
export async function startListenServer(opts = {}, { pkg = { version: '0' }, onCapture = null, importImpl = null, quiet = false } = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port === 0 ? 0 : +(opts.port || 3005);
  const token = opts.token || process.env.SB_LISTEN_TOKEN || '';
  const maxBytes = Math.round((+opts.maxUploadMb || 300) * 1048576);
  const allow = new Set(String(opts.allowOrigin || '').split(',').map((s) => s.trim()).filter(Boolean));
  const inbox = path.resolve(String(opts.out || 'output'), '_incoming');
  const jobs = new Map(); const queue = []; let running = null;
  const doImport = importImpl || (async (file, o) => (await import('../capture/import.mjs')).importCapture(file, o));

  const pub = (j) => ({ id: j.id, status: j.status, stage: j.stage, createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null, bytes: j.bytes, filename: j.filename, outDir: j.outDir || null, project: j.outDir ? path.join(j.outDir, 'project') : null, blueprint: j.outDir ? path.join(j.outDir, 'SITE_CLONE_BLUEPRINT.md') : null, exitCode: j.exitCode ?? null, error: j.error || null, position: j.status === 'queued' ? queue.indexOf(j) + 1 : 0 });

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift(); running = job;
    job.status = 'running'; job.stage = 'import'; job.startedAt = new Date().toISOString();
    try {
      if (!quiet) log.step(`Захват ${job.id} (${humanBytes(job.bytes)}) — импорт`);
      job.outDir = await doImport(job.file, { ...opts, maxUploadMb: opts.maxUploadMb });
      job.stage = 'pipeline';
      const code = onCapture ? await onCapture(job.outDir, job) : 0;
      job.exitCode = typeof code === 'number' ? code : 0;
      job.status = job.exitCode ? 'failed' : 'done';
      if (job.exitCode) job.error = `самопроверка завершилась с кодом ${job.exitCode} (см. VERIFICATION_REPORT.md)`;
      if (!opts.keepIncoming) await fsp.rm(job.file, { force: true }).catch(() => {});
      if (!quiet) log.ok(`Захват ${job.id}: ${job.status === 'done' ? 'готово' : 'с ошибками'} → ${job.outDir}`);
    } catch (e) {
      job.status = 'error'; job.error = errMsg(e);
      if (!quiet) log.error(`Захват ${job.id}: ${job.error}`);
    } finally {
      job.stage = null; job.finishedAt = new Date().toISOString(); running = null;
      const done = [...jobs.values()].filter((j) => j.finishedAt);
      for (const j of done.slice(0, Math.max(0, done.length - 50))) jobs.delete(j.id);
      setImmediate(pump);
    }
  }

  const send = (res, code, body, headers = {}) => {
    if (res.headersSent) return;
    const data = body == null ? '' : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = {};
    try {
      // DNS rebinding: only literal localhost names in Host
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (!LOCAL_HOSTS.has(hostName) && !(opts.host && hostName === String(opts.host).toLowerCase())) return send(res, 421, { error: 'wrong Host header' });
      if (origin) {
        if (!(EXT_ORIGIN.test(origin) || allow.has(origin))) return send(res, 403, { error: 'origin not allowed: only the site-blueprint browser extension may call this endpoint' });
        Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        const h = { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-SB-Client, X-SB-Token, X-SB-Filename', 'Access-Control-Max-Age': '600' };
        if (req.headers['access-control-request-private-network']) h['Access-Control-Allow-Private-Network'] = 'true';
        res.writeHead(204, h); return res.end();
      }
      if (!req.headers['x-sb-client']) return send(res, 400, { error: 'X-SB-Client header is required' }, cors);
      if (token && !safeEqual(req.headers['x-sb-token'] || '', token)) return send(res, 401, { error: 'bad or missing X-SB-Token' }, cors);

      if (url.pathname === '/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, name: 'site-blueprint', version: pkg.version, busy: !!running, queue: queue.length, maxUploadMb: Math.round(maxBytes / 1048576), tokenRequired: !!token }, cors);
      }
      if (url.pathname === '/jobs' && req.method === 'GET') return send(res, 200, { jobs: [...jobs.values()].map(pub) }, cors);
      const jm = /^\/jobs\/([a-z0-9-]{6,40})$/.exec(url.pathname);
      if (jm && req.method === 'GET') { const j = jobs.get(jm[1]); return j ? send(res, 200, pub(j), cors) : send(res, 404, { error: 'no such job' }, cors); }
      if (url.pathname === '/capture') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { ...cors, Allow: 'POST, OPTIONS' });
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct && ct !== 'application/zip' && ct !== 'application/octet-stream' && ct !== 'application/x-zip-compressed') return send(res, 415, { error: 'expected application/zip' }, cors);
        const len = +(req.headers['content-length'] || 0);
        if (len > maxBytes) { req.resume(); return send(res, 413, { error: `capture is larger than --max-upload-mb ${Math.round(maxBytes / 1048576)}` }, { ...cors, Connection: 'close' }); }
        const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
        await ensureDir(inbox);
        const file = path.join(inbox, id + '.zip');
        let bytes = 0; let tooLarge = false; let head = null;
        const out = fs.createWriteStream(file);
        await new Promise((resolve, reject) => {
          req.on('data', (chunk) => {
            if (tooLarge) return;
            bytes += chunk.length;
            if (!head) head = chunk.subarray(0, 4);
            if (bytes > maxBytes) { tooLarge = true; out.destroy(); req.unpipe?.(); resolve(); return; }
            if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
          });
          req.on('end', () => (tooLarge ? resolve() : out.end(resolve)));
          req.on('error', reject); out.on('error', (e) => (tooLarge ? resolve() : reject(e)));
        });
        if (tooLarge) { await fsp.rm(file, { force: true }).catch(() => {}); return send(res, 413, { error: `capture is larger than --max-upload-mb ${Math.round(maxBytes / 1048576)}` }, { ...cors, Connection: 'close' }); }
        if (!head || head.length < 4 || head.readUInt32LE(0) !== 0x04034b50) { await fsp.rm(file, { force: true }).catch(() => {}); return send(res, 400, { error: 'body is not a ZIP archive' }, cors); }
        const job = { id, file, bytes, filename: String(req.headers['x-sb-filename'] || '').replace(/[^\w.-]+/g, '_').slice(0, 120), status: 'queued', stage: null, createdAt: new Date().toISOString() };
        jobs.set(id, job); queue.push(job);
        if (!quiet) log.info(`Получен захват ${id}: ${humanBytes(bytes)}${job.filename ? ' (' + job.filename + ')' : ''}${running ? ', в очереди: ' + queue.length : ''}`);
        setImmediate(pump);
        return send(res, 202, pub(job), { ...cors, Location: '/jobs/' + id });
      }
      return send(res, 404, { error: 'not found' }, cors);
    } catch (e) {
      return send(res, 500, { error: errMsg(e) }, cors);
    }
  });
  server.requestTimeout = 0; server.headersTimeout = 60000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`;
  if (!quiet) {
    console.log(color.bold(`\nsite-blueprint ${pkg.version} — слушаю ${base}`) + color.dim(' (Ctrl+C — остановить)'));
    console.log(color.dim(`  Расширение → «Отправить в локальный CLI» → POST ${base}/capture`));
    console.log(color.dim(`  Результаты: ${path.dirname(inbox)}${token ? '  · требуется X-SB-Token' : ''}  · лимит ${Math.round(maxBytes / 1048576)} МБ`));
    if (!LOCAL_HOSTS.has(host)) log.warn(`Сервер слушает ${host} — он доступен не только с этого компьютера. Используй --token.`);
  }
  return { server, port: actual, url: base, jobs, close: () => new Promise((r) => server.close(() => r())) };
}
