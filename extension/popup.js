// Popup: settings, permission requests (must happen inside the click = user gesture), progress of the job that
// runs in the service worker (the popup may be closed at any time — the job continues).
const $ = (s) => document.querySelector(s);
const DEFAULTS = { api: true, state: true, delivery: 'zip', maxPages: 10, depth: 2, robots: true, port: 3005, token: '', cdn: false };
let settings = { ...DEFAULTS };
let tab = null;
let pollTimer = null;

async function targetTab() {
  const q = new URLSearchParams(location.search).get('tab'); // popup.html?tab=<id> (tests / pinned popup window)
  if (q) return chrome.tabs.get(+q);
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
const capturable = (u) => /^https?:\/\//i.test(u || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(u);

function render() {
  $('#opt-api').checked = settings.api; $('#opt-state').checked = settings.state;
  for (const r of document.querySelectorAll('input[name="delivery"]')) r.checked = r.value === settings.delivery;
  $('#opt-max').value = settings.maxPages; $('#opt-depth').value = settings.depth; $('#opt-robots').checked = settings.robots;
  $('#set-port').value = settings.port; $('#set-token').value = settings.token; $('#set-cdn').checked = settings.cdn;
  $('#cli-label').textContent = `Отправить в локальный CLI (localhost:${settings.port})`;
}
function readForm() {
  settings = {
    api: $('#opt-api').checked, state: $('#opt-state').checked,
    delivery: (document.querySelector('input[name="delivery"]:checked') || {}).value || 'zip',
    maxPages: Math.max(1, Math.min(200, +$('#opt-max').value || 10)), depth: Math.max(1, Math.min(5, +$('#opt-depth').value || 2)),
    robots: $('#opt-robots').checked, port: Math.max(1, Math.min(65535, +$('#set-port').value || 3005)), token: $('#set-token').value.trim(), cdn: $('#set-cdn').checked,
  };
  chrome.storage.local.set({ settings });
  $('#cli-label').textContent = `Отправить в локальный CLI (localhost:${settings.port})`;
}

async function checkCli() {
  const el = $('#cli');
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${settings.port}/health`, { headers: { 'X-SB-Client': 'site-blueprint-extension/' + chrome.runtime.getManifest().version, ...(settings.token ? { 'X-SB-Token': settings.token } : {}) }, signal: ctl.signal });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) { el.textContent = `CLI ${d.version}${d.busy ? ' · занят' : ''}`; el.className = 'cli on'; el.title = `site-blueprint listen на 127.0.0.1:${settings.port}`; return; }
    el.textContent = r.status === 401 ? 'CLI: нужен токен' : 'CLI: ошибка'; el.className = 'cli off';
  } catch (e) { el.textContent = 'CLI: не запущен'; el.className = 'cli off'; el.title = 'Запусти: node bin/site-blueprint.mjs listen --port ' + settings.port; }
}

function showJob(j) {
  const box = $('#status');
  if (!j) { box.classList.add('hidden'); document.body.classList.remove('busy'); return; }
  box.classList.remove('hidden', 'running', 'error');
  const running = j.status === 'running';
  box.classList.toggle('running', running); box.classList.toggle('error', j.status === 'error' || j.status === 'cancelled');
  document.body.classList.toggle('busy', running);
  $('#stage').textContent = j.status === 'error' ? 'Ошибка: ' + (j.error || '') : j.status === 'cancelled' ? 'Отменено' : j.stage || '';
  const pct = j.status === 'done' ? 100 : j.pages && j.pages.total ? Math.min(95, Math.round((j.pages.done / j.pages.total) * 100) + 5) : 10;
  $('#bar').style.width = pct + '%';
  $('#log').replaceChildren(...(j.log || []).map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
  $('#log').scrollTop = 1e6;
  const res = $('#result'); res.replaceChildren();
  if (j.status === 'done' && j.result) {
    res.classList.remove('hidden');
    const add = (label, value) => { const d = document.createElement('div'); d.append(label + ' '); if (value) { const c = document.createElement('code'); c.textContent = value; d.append(c); } res.append(d); };
    if (j.result.kind === 'zip') { add('ZIP сохранён:', j.result.filename); add('Дальше:', j.result.hint); if (j.result.cliError) add('CLI был недоступен:', j.result.cliError); }
    else { add(j.result.status === 'done' ? 'Готово, проект:' : 'CLI завершил с замечаниями:', j.result.project || j.result.outDir || ''); if (j.result.blueprint) add('Блюпринт:', j.result.blueprint); if (j.result.error) add('', j.result.error); }
  } else res.classList.add('hidden');
  const warn = $('#warn');
  if (j.warnings && j.warnings.length) { warn.classList.remove('hidden'); warn.textContent = '⚠ ' + j.warnings.slice(-6).join('\n⚠ '); } else warn.classList.add('hidden');
  $('#btn-cancel').classList.toggle('hidden', !running);
}
async function poll() {
  clearTimeout(pollTimer);
  const r = await chrome.runtime.sendMessage({ type: 'sb:status' }).catch(() => null);
  showJob(r && r.job);
  if (r && r.job && r.job.status === 'running') pollTimer = setTimeout(poll, 600);
}
function fail(text) { showJob({ status: 'error', error: text, log: [], warnings: [] }); }

function start(mode) {
  readForm();
  if (!tab || !capturable(tab.url)) return fail('Эту страницу нельзя захватить — открой обычный http/https-сайт.');
  const u = new URL(tab.url);
  // permissions.request must be the first await of the click handler (user gesture)
  const origins = mode === 'site' || settings.cdn ? ['<all_urls>'] : settings.api ? [`${u.protocol}//${u.hostname}/*`] : [];
  const ask = origins.length ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(false);
  ask.then(async (granted) => {
    if (mode === 'site' && !granted) return fail('Для обхода сайта нужен доступ к сайтам: страницы открываются в отдельном окне, и Chrome разрешает их скриншоты только с этим разрешением.');
    const r = await chrome.runtime.sendMessage({ type: 'sb:start', mode, tabId: tab.id, options: { ...settings, reload: !!(settings.api && granted) } });
    if (!r || !r.ok) return fail((r && r.error) || 'не удалось запустить захват');
    showJob(r.job); poll();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const s = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...(s.settings || {}) };
  render();
  tab = await targetTab().catch(() => null);
  if (tab) { try { $('#host').textContent = new URL(tab.url).host || tab.url; } catch (e) { $('#host').textContent = tab.url || '—'; } $('#title').textContent = tab.title || ''; }
  const ok = tab && capturable(tab.url);
  $('#btn-page').disabled = !ok; $('#btn-site').disabled = !ok;
  if ($('#btn-pick')) $('#btn-pick').disabled = !ok;
  if (!ok) $('#title').textContent = 'Открой обычную веб-страницу (http/https)';
  for (const el of document.querySelectorAll('input')) el.addEventListener('change', () => { readForm(); if (el.id === 'set-port' || el.id === 'set-token') checkCli(); });
  $('#btn-page').addEventListener('click', () => start('page'));
  $('#btn-site').addEventListener('click', () => start('site'));
  if ($('#btn-pick')) {
    $('#btn-pick').addEventListener('click', async () => {
      if (!tab || !capturable(tab.url)) return fail('Эту страницу нельзя захватить — открой обычный http/https-сайт.');
      const r = await chrome.runtime.sendMessage({ type: 'sb:pick', tabId: tab.id }).catch((e) => ({ ok: false, error: String(e) }));
      if (!r || !r.ok) return fail((r && r.error) || 'не удалось запустить выбор компонента');
      window.close();
    });
  }
  $('#btn-cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'sb:cancel' }));
  $('#btn-revoke').addEventListener('click', async () => {
    const all = await chrome.permissions.getAll();
    const keep = new Set(chrome.runtime.getManifest().host_permissions || []);
    const origins = (all.origins || []).filter((o) => !keep.has(o));
    if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
    $('#btn-revoke').textContent = origins.length ? 'Доступ отозван' : 'Нечего отзывать';
  });
  checkCli();
  poll();
});
