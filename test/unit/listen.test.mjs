// Unit tests: `site-blueprint listen` (src/server/listen.mjs) — the local endpoint of the browser extension.
// Security checks (Host / Origin / X-SB-Client / token / size / type) and the job queue with stub import + pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { startListenServer } from '../../src/server/listen.mjs';
import { ZipWriter } from '../../extension/lib/zip.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function zipBytes(n = 1) { const z = new ZipWriter(); for (let i = 0; i < n; i++) await z.add(`f${i}.txt`, 'x'.repeat(10)); return Buffer.from(z.finishBytes()); }

/** raw HTTP request with full header control (fetch would set Origin/Host itself) */
function req(port, { method = 'GET', path: p = '/health', headers = {}, body = null, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body && !chunked) h['content-length'] = String(body.length);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    r.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(e)));
    if (body && chunked) { const n = Math.ceil(body.length / 4096); for (let i = 0; i < n; i++) r.write(body.subarray(i * 4096, (i + 1) * 4096)); r.end(); }
    else r.end(body || undefined);
  });
}
const C = { 'x-sb-client': 'test' };
async function until(fn, ms = 5000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

async function withServer(opts, deps, fn) {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-listen-'));
  const srv = await startListenServer({ port: 0, out, ...opts }, { pkg: { version: '9.9.9' }, quiet: true, ...deps });
  try { await fn(srv, out); } finally { await srv.close(); }
}

test('listen: только 127.0.0.1, Host = localhost (DNS rebinding), X-SB-Client обязателен', async () => {
  await withServer({}, {}, async (srv) => {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(srv.server.address().address, '127.0.0.1');
    assert.equal((await req(srv.port, { headers: { host: 'evil.example:3005', ...C } })).status, 421);
    assert.equal((await req(srv.port, { headers: { host: `localhost:${srv.port}`, ...C } })).status, 200);
    const noClient = await req(srv.port);
    assert.equal(noClient.status, 400); assert.match(noClient.json.error, /X-SB-Client/);
    const h = await req(srv.port, { headers: C });
    assert.deepEqual({ ...h.json }, { ok: true, name: 'site-blueprint', version: '9.9.9', busy: false, queue: 0, maxUploadMb: 300, tokenRequired: false });
    assert.equal(h.headers['cache-control'], 'no-store');
  });
});

test('listen: веб-страницы (Origin сайта) отвергаются, расширение — разрешено, preflight с Private Network Access', async () => {
  await withServer({ allowOrigin: 'http://localhost:5173' }, {}, async (srv) => {
    const web = await req(srv.port, { headers: { origin: 'https://evil.example', ...C } });
    assert.equal(web.status, 403); assert.equal(web.headers['access-control-allow-origin'], undefined);
    assert.equal((await req(srv.port, { headers: { origin: 'null', ...C } })).status, 403);
    assert.equal((await req(srv.port, { headers: { origin: 'chrome-extension://short', ...C } })).status, 403);
    const ext = await req(srv.port, { headers: { origin: EXT, ...C } });
    assert.equal(ext.status, 200); assert.equal(ext.headers['access-control-allow-origin'], EXT);
    assert.equal((await req(srv.port, { headers: { origin: 'moz-extension://0b2f3c4d-1111-2222-3333-444455556666', ...C } })).status, 200);
    assert.equal((await req(srv.port, { headers: { origin: 'http://localhost:5173', ...C } })).status, 200, '--allow-origin');
    const pre = await req(srv.port, { method: 'OPTIONS', path: '/capture', headers: { origin: EXT, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-sb-client,content-type', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    assert.match(pre.headers['access-control-allow-headers'], /X-SB-Client/);
    assert.equal((await req(srv.port, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403, 'preflight чужого сайта');
  });
});

test('listen: токен (--token / X-SB-Token)', async () => {
  await withServer({ token: 's3cret-token' }, {}, async (srv) => {
    assert.equal((await req(srv.port, { headers: C })).status, 401);
    assert.equal((await req(srv.port, { headers: { ...C, 'x-sb-token': 'wrong' } })).status, 401);
    assert.equal((await req(srv.port, { headers: { ...C, 'x-sb-token': 's3cret-token-but-longer' } })).status, 401);
    const ok = await req(srv.port, { headers: { ...C, 'x-sb-token': 's3cret-token' } });
    assert.equal(ok.status, 200); assert.equal(ok.json.tokenRequired, true);
  });
});

test('listen: POST /capture — тип, размер, сигнатура ZIP, методы, 404', async () => {
  let imported = 0;
  await withServer({ maxUploadMb: 0.05 }, { importImpl: async () => { imported++; return '/nowhere'; } }, async (srv, out) => {
    assert.equal((await req(srv.port, { method: 'GET', path: '/capture', headers: C })).status, 405);
    assert.equal((await req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, 'content-type': 'text/plain' }, body: await zipBytes() })).status, 415);
    const notZip = await req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, 'content-type': 'application/zip' }, body: Buffer.from('hello, not a zip archive') });
    assert.equal(notZip.status, 400); assert.match(notZip.json.error, /not a ZIP/);
    const huge = Buffer.concat([await zipBytes(), Buffer.alloc(120 * 1024)]);
    const declared = await req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, 'content-type': 'application/zip' }, body: huge });
    assert.ok(declared.status === 413 || declared.status === 'reset', 'Content-Length больше лимита → 413');
    const streamed = await req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, 'content-type': 'application/zip' }, body: huge, chunked: true });
    assert.ok(streamed.status === 413 || streamed.status === 'reset', 'поток без Content-Length тоже ограничен');
    assert.equal((await req(srv.port, { path: '/jobs/zzzzzzzz', headers: C })).status, 404);
    assert.equal((await req(srv.port, { path: '/etc/passwd', headers: C })).status, 404);
    await sleep(50);
    const left = await fsp.readdir(path.join(out, '_incoming')).catch(() => []);
    assert.deepEqual(left, [], 'отвергнутые загрузки удалены');
    assert.equal(imported, 0);
  });
});

test('listen: очередь — 202 → running → done; ошибки импорта и самопроверки; файлы входящих удаляются', async () => {
  const seen = []; let release; const gate = new Promise((r) => { release = r; });
  const importImpl = async (file, o) => {
    const buf = await fsp.readFile(file);
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    seen.push({ file, out: o.out });
    if (seen.length === 1) await gate;          // first job blocks → second waits in the queue
    if (seen.length === 3) throw new Error('capture.json повреждён');
    return path.join(o.out, 'site-' + seen.length);
  };
  const onCapture = async (dir) => (dir.endsWith('-2') ? 2 : 0);
  await withServer({}, { importImpl, onCapture }, async (srv, out) => {
    const send = async (name) => req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, origin: EXT, 'content-type': 'application/zip', 'x-sb-filename': name }, body: await zipBytes(3) });
    const a = await send('shop capture.zip');
    assert.equal(a.status, 202); assert.equal(a.headers.location, '/jobs/' + a.json.id);
    assert.equal(a.json.filename, 'shop_capture.zip');
    assert.equal(a.headers['access-control-allow-origin'], EXT);
    await until(async () => (await req(srv.port, { path: '/jobs/' + a.json.id, headers: C })).json.status === 'running');
    const b = await send('second.zip');
    assert.equal(b.json.status, 'queued'); assert.equal(b.json.position, 1);
    const health = await req(srv.port, { headers: C });
    assert.equal(health.json.busy, true); assert.equal(health.json.queue, 1);
    release();
    const ja = await until(async () => { const r = await req(srv.port, { path: '/jobs/' + a.json.id, headers: C }); return r.json.status === 'done' && r.json; });
    assert.equal(ja.exitCode, 0); assert.equal(ja.outDir, path.join(out, 'site-1'));
    assert.equal(ja.project, path.join(out, 'site-1', 'project'));
    assert.equal(ja.blueprint, path.join(out, 'site-1', 'SITE_CLONE_BLUEPRINT.md'));
    const jb = await until(async () => { const r = await req(srv.port, { path: '/jobs/' + b.json.id, headers: C }); return r.json.finishedAt && r.json; });
    assert.equal(jb.status, 'failed'); assert.equal(jb.exitCode, 2); assert.match(jb.error, /VERIFICATION_REPORT/);
    const c = await send('third.zip');
    const jc = await until(async () => { const r = await req(srv.port, { path: '/jobs/' + c.json.id, headers: C }); return r.json.finishedAt && r.json; });
    assert.equal(jc.status, 'error'); assert.match(jc.error, /повреждён/);
    const list = await req(srv.port, { path: '/jobs', headers: C });
    assert.deepEqual(list.json.jobs.map((j) => j.status), ['done', 'failed', 'error']);
    assert.deepEqual(seen.map((s) => s.out), [out, out, out]);
    assert.ok(!fs.existsSync(seen[0].file) && !fs.existsSync(seen[1].file), 'обработанные ZIP удалены');
  });
});

test('listen: --keep-incoming оставляет ZIP', async () => {
  let file;
  await withServer({ keepIncoming: true }, { importImpl: async (f, o) => { file = f; return o.out; } }, async (srv) => {
    const r = await req(srv.port, { method: 'POST', path: '/capture', headers: { ...C, 'content-type': 'application/octet-stream' }, body: await zipBytes() });
    assert.equal(r.status, 202);
    await until(async () => (await req(srv.port, { path: '/jobs/' + r.json.id, headers: C })).json.status === 'done');
    assert.ok(fs.existsSync(file));
  });
});

test('listen: занятый порт → понятная ошибка', async () => {
  await withServer({}, {}, async (srv) => {
    await assert.rejects(startListenServer({ port: srv.port, out: os.tmpdir() }, { quiet: true }), /EADDRINUSE/);
  });
});
