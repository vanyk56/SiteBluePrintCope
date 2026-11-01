// Tiny IndexedDB key-value store shared by the service worker and download.html: the finished capture ZIP is
// handed over as a Blob (service workers cannot create blob: URLs for chrome.downloads themselves).
const DB = 'site-blueprint'; const STORE = 'captures';
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode); const st = t.objectStore(STORE); let out;
      const req = fn(st); if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}
export const idbPut = (key, value) => tx('readwrite', (st) => st.put(value, key));
export const idbGet = (key) => tx('readonly', (st) => st.get(key));
export const idbDel = (key) => tx('readwrite', (st) => st.delete(key));
export const idbKeys = () => tx('readonly', (st) => st.getAllKeys());
