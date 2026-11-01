// Minimal ZIP reader for captures made by the browser extension (and any ordinary ZIP: store + deflate).
// Reads the central directory (works with data descriptors), validates names (no zip-slip), enforces limits.
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50, SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

export class ZipError extends Error {}

/** Safe relative entry name or null (absolute paths, drive letters, "..", NUL bytes are rejected). */
export function safeEntryName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[a-z]:/i.test(n)) return null;
  const parts = n.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} entry name → contents (directories are skipped)
 */
export function readZip(buf, { maxEntries = 50000, maxTotalBytes = 4 * 1024 ** 3, maxEntryBytes = 1024 ** 3, filter = null } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  // end of central directory: last 22..(22+65535) bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('не ZIP-архив (нет End of Central Directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenOff === 0xffffffff) throw new ZipError('ZIP64 не поддерживается');
  if (count > maxEntries) throw new ZipError(`слишком много файлов в архиве (${count} > ${maxEntries})`);
  if (cenOff + cenSize > buf.length) throw new ZipError('повреждённый ZIP (central directory за пределами файла)');
  const out = new Map();
  let p = cenOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new ZipError('повреждённый ZIP (central directory)');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (rawName.endsWith('/')) continue;
    const name = safeEntryName(rawName);
    if (!name) throw new ZipError('небезопасное имя файла в архиве: ' + rawName.slice(0, 120));
    if (filter && !filter(name)) continue;
    if (flags & 1) throw new ZipError('зашифрованные ZIP не поддерживаются');
    if (usize > maxEntryBytes) throw new ZipError(`файл ${name} слишком большой (${usize} байт)`);
    total += usize;
    if (total > maxTotalBytes) throw new ZipError('распакованный архив превышает лимит');
    if (loc + 30 > buf.length || buf.readUInt32LE(loc) !== SIG_LOC) throw new ZipError('повреждённый ZIP (local header ' + name + ')');
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    if (start + csize > buf.length) throw new ZipError('повреждённый ZIP (данные ' + name + ')');
    const data = buf.subarray(start, start + csize);
    let body;
    if (method === 0) body = Buffer.from(data);
    else if (method === 8) {
      // maxOutputLength = declared size: a "zip bomb" that lies about its size fails here instead of filling memory
      try { body = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, usize) }); }
      catch (e) { throw new ZipError(`повреждённый ZIP (${/larger than|ERR_BUFFER_TOO_LARGE/i.test(String(e && (e.code || e.message))) ? 'данные больше заявленного размера' : 'deflate'}: ${name})`); }
    }
    else throw new ZipError(`метод сжатия ${method} не поддерживается (${name})`);
    if (body.length !== usize) throw new ZipError('повреждённый ZIP (размер ' + name + ')');
    if (typeof zlib.crc32 === 'function' && zlib.crc32(body) >>> 0 !== crc) throw new ZipError('повреждённый ZIP (CRC ' + name + ')');
    out.set(name, body);
  }
  return out;
}
