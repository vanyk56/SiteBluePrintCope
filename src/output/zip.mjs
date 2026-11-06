// Stage 5: bundles `<outDir>` into `<outDir>.zip` for handing off to an AI coder in one archive.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ZipWriter } from '../../extension/lib/zip.js';

const SKIP_DIRS = new Set(['node_modules', '.next', 'data', 'verify']);

export async function bundle(outDir) {
  const zip = new ZipWriter();
  let files = 0;

  async function walk(dir, relPrefix = '') {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs, rel);
      } else if (e.isFile()) {
        const buf = await fsp.readFile(abs);
        await zip.add(rel, buf);
        files++;
      }
    }
  }

  await walk(outDir);
  const bytes = zip.finishBytes();
  const file = path.resolve(outDir + '.zip');
  await fsp.writeFile(file, bytes);
  return { file, bytes: bytes.byteLength, files };
}
