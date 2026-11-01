// Minimal streaming-friendly ZIP writer (store + deflate) for the extension service worker and Node (tests).
// Deflate uses the platform CompressionStream('deflate-raw') — Chrome 103+, Node 21+. No dependencies.
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const enc = new TextEncoder();
// already-compressed formats are stored as is
const STORE_RE = /\.(png|jpe?g|gif|webp|avif|woff2?|mp4|webm|mov|mp3|ogg|zip|gz|br|ico)$/i;

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(u8).catch(() => {}); writer.close().catch(() => {});
  const reader = cs.readable.getReader(); const chunks = []; let total = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
export function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('zip: unsupported data type');
}

export class ZipWriter {
  constructor({ maxBytes = 3.9 * 1024 ** 3 } = {}) { this.parts = []; this.central = []; this.offset = 0; this.names = new Set(); this.maxBytes = maxBytes; this.raw = 0; }
  get count() { return this.central.length; }
  get size() { return this.offset; }
  has(name) { return this.names.has(name); }
  /** @param {string} name  relative path inside the archive ("pages/home.json") */
  async add(name, data, { compress } = {}) {
    name = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.split('/').some((p) => p === '..' || p === '')) throw new Error('zip: bad entry name ' + name);
    if (this.names.has(name)) throw new Error('zip: duplicate entry ' + name);
    const raw = toBytes(data);
    const crc = crc32(raw);
    let method = 0; let body = raw;
    if ((compress ?? !STORE_RE.test(name)) && raw.length > 128) { const d = await deflateRaw(raw); if (d.length < raw.length * 0.97) { method = 8; body = d; } }
    if (this.offset + body.length + 1e6 > this.maxBytes) throw new Error('zip: archive size limit reached');
    this.names.add(name);
    const nb = enc.encode(name);
    const { time, date } = dosTime(new Date());
    const loc = new Uint8Array(30 + nb.length); const v = new DataView(loc.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, method, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true); v.setUint32(18, body.length, true);
    v.setUint32(22, raw.length, true); v.setUint16(26, nb.length, true); v.setUint16(28, 0, true);
    loc.set(nb, 30);
    this.parts.push(loc, body);
    this.central.push({ nb, method, time, date, crc, csize: body.length, usize: raw.length, offset: this.offset });
    this.offset += loc.length + body.length; this.raw += raw.length;
    return { name, bytes: raw.length, stored: body.length, method };
  }
  _tail() {
    const chunks = []; let size = 0;
    for (const e of this.central) {
      const c = new Uint8Array(46 + e.nb.length); const v = new DataView(c.buffer);
      v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0800, true); v.setUint16(10, e.method, true);
      v.setUint16(12, e.time, true); v.setUint16(14, e.date, true); v.setUint32(16, e.crc, true); v.setUint32(20, e.csize, true); v.setUint32(24, e.usize, true);
      v.setUint16(28, e.nb.length, true); v.setUint32(42, e.offset, true);
      c.set(e.nb, 46); chunks.push(c); size += c.length;
    }
    const end = new Uint8Array(22); const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, this.central.length, true); v.setUint16(10, this.central.length, true);
    v.setUint32(12, size, true); v.setUint32(16, this.offset, true);
    chunks.push(end);
    if (this.central.length > 0xfffe) throw new Error('zip: too many entries');
    return chunks;
  }
  /** Blob (service worker: POST body / IndexedDB); parts are not copied */
  finish(type = 'application/zip') { return new Blob([...this.parts, ...this._tail()], { type }); }
  /** one Uint8Array (Node tests) */
  finishBytes() {
    const all = [...this.parts, ...this._tail()]; const n = all.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(n); let o = 0; for (const c of all) { out.set(c, o); o += c.length; }
    return out;
  }
}
