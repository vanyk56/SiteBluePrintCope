// Opened by the service worker in a background tab: Blob from IndexedDB → blob: URL → chrome.downloads.
import { idbGet, idbDel } from './lib/idb.js';

const id = new URLSearchParams(location.search).get('id') || '';
const msg = document.getElementById('msg');
const report = (data) => chrome.runtime.sendMessage({ type: 'sb:downloaded', id, ...data }).catch(() => {});

(async () => {
  const rec = await idbGet(id);
  if (!rec || !rec.blob) { msg.textContent = 'Захват не найден (уже сохранён?)'; await report({ ok: false, error: 'capture not found' }); return; }
  const url = URL.createObjectURL(rec.blob);
  const downloadId = await chrome.downloads.download({ url, filename: rec.filename, conflictAction: 'uniquify', saveAs: false });
  msg.textContent = 'Загрузка: ' + rec.filename;
  chrome.downloads.onChanged.addListener(async (d) => {
    if (d.id !== downloadId || !d.state || (d.state.current !== 'complete' && d.state.current !== 'interrupted')) return;
    const ok = d.state.current === 'complete';
    let file = rec.filename;
    try { const [item] = await chrome.downloads.search({ id: downloadId }); if (item && item.filename) file = item.filename; } catch (e) {}
    await idbDel(id).catch(() => {});
    URL.revokeObjectURL(url);
    msg.textContent = ok ? 'Готово: ' + file : 'Загрузка прервана';
    await report({ ok, downloadId, file, error: ok ? null : (d.error && d.error.current) || 'interrupted' });
    setTimeout(() => window.close(), 400);
  });
})().catch(async (e) => { msg.textContent = 'Ошибка: ' + (e && e.message); await report({ ok: false, error: String(e && e.message || e) }); });
