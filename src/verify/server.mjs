// Starts the built clone (`next start`) on a free local port for visual regression; stops the whole process tree
// on every OS (POSIX: process group, Windows: taskkill /T).
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { findNext } from './build.mjs';
import { sleep } from '../util.mjs';

export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export async function startNext(projectRoot, { port = 0, host = '127.0.0.1', timeoutMs = 90000, dev = false } = {}) {
  const nx = findNext(projectRoot);
  if (!nx) throw new Error('next не найден — установи зависимости проекта');
  const p = port || (await freePort(host));
  const isWin = process.platform === 'win32';
  const child = spawn(process.execPath, [nx.bin, dev ? 'dev' : 'start', '-p', String(p), '-H', host], {
    cwd: projectRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', PORT: String(p) }, detached: !isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; if (output.length > 200000) output = output.slice(-100000); });
  child.stderr.on('data', (d) => { output += d; if (output.length > 200000) output = output.slice(-100000); });
  let exited = null; child.on('exit', (code) => { exited = code ?? -1; });
  const url = `http://${host}:${p}`;
  const stop = async () => {
    if (exited !== null) return;
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch { try { child.kill('SIGTERM'); } catch {} }
    for (let i = 0; i < 30 && exited === null; i++) await sleep(100);
    if (exited === null) { try { if (!isWin) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }
  };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited !== null) throw new Error(`next ${dev ? 'dev' : 'start'} завершился (код ${exited}): ${output.trim().split('\n').slice(-5).join(' ').slice(0, 400)}`);
    try { const r = await fetch(url + '/', { signal: AbortSignal.timeout(5000) }); await r.arrayBuffer().catch(() => {}); return { url, port: p, stop, output: () => output }; }
    catch { await sleep(400); }
  }
  await stop();
  throw new Error(`next ${dev ? 'dev' : 'start'} не ответил за ${Math.round(timeoutMs / 1000)} с`);
}
