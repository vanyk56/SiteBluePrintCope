// PNG helpers for captures that arrive without a browser on this side (extension → import/listen):
// section crops and downscaled "sheets" for vision LLMs, produced with pngjs (pure JS, optional dependency).
import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir } from '../util.mjs';

let PNGlib;
export async function loadPng() {
  if (PNGlib !== undefined) return PNGlib;
  try { const m = await import('pngjs'); PNGlib = m.PNG || (m.default && m.default.PNG) || null; } catch { PNGlib = null; }
  return PNGlib;
}
export async function decodePng(buf) { const PNG = await loadPng(); if (!PNG) return null; try { return PNG.sync.read(buf); } catch { return null; } }

/** rows [y, y+h) of a decoded PNG → PNG buffer (full width) */
export async function cropRows(img, y, h) {
  const PNG = await loadPng(); if (!PNG || !img) return null;
  const y0 = Math.max(0, Math.round(y)); const y1 = Math.min(img.height, Math.round(y + h));
  if (y1 - y0 < 2) return null;
  const out = new PNG({ width: img.width, height: y1 - y0 });
  img.data.copy(out.data, 0, y0 * img.width * 4, y1 * img.width * 4);
  return PNG.sync.write(out);
}

/** box-filter downscale of rows [sy, sy+sh) to width dw → PNG buffer (white background under transparency) */
async function downscale(img, sy, sh, dw) {
  const PNG = await loadPng();
  const scale = dw / img.width; const dh = Math.max(1, Math.round(sh * scale));
  const out = new PNG({ width: dw, height: dh });
  const src = img.data; const dst = out.data; const W = img.width;
  for (let y = 0; y < dh; y++) {
    const ya = sy + Math.floor(y / scale); const yb = Math.min(sy + sh, Math.max(ya + 1, sy + Math.floor((y + 1) / scale)));
    for (let x = 0; x < dw; x++) {
      const xa = Math.floor(x / scale); const xb = Math.min(W, Math.max(xa + 1, Math.floor((x + 1) / scale)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) {
        const i = (yy * W + xx) * 4; const a = src[i + 3] / 255;
        r += src[i] * a + 255 * (1 - a); g += src[i + 1] * a + 255 * (1 - a); b += src[i + 2] * a + 255 * (1 - a); n++;
      }
      const o = (y * dw + x) * 4; dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = 255;
    }
  }
  return PNG.sync.write(out, { colorType: 2 });
}

/**
 * Same contract as createSheetMaker().make() in crawl/pageops.mjs: ≤ max parts of ≤ maxH px (after scaling),
 * evenly picked when the page is longer. → [{ file, y0, y1, part, of }] (y in CSS px of the screenshot)
 */
export async function makeSheets(img, outPrefix, { width = 1000, maxH = 1800, max = 4, dpr = 1 } = {}) {
  if (!img || max <= 0) return [];
  const W0 = img.width, H0 = img.height;
  let scale = Math.min(1, width / W0);
  let n = Math.ceil((H0 * scale) / maxH);
  if (n > max) { scale = Math.max(Math.min(scale, (max * maxH) / H0), Math.min(scale, 640 / W0)); n = Math.ceil((H0 * scale) / maxH); }
  const step = Math.ceil(maxH / scale);
  let pick = [...Array(n).keys()];
  if (n > max) { const p = new Set(); for (let i = 0; i < max; i++) p.add(Math.round((i * (n - 1)) / Math.max(1, max - 1))); pick = [...p]; }
  await ensureDir(path.dirname(outPrefix));
  const out = [];
  for (const i of pick) {
    const sy = i * step; const sh = Math.min(step, H0 - sy); if (sh <= 0) continue;
    const buf = await downscale(img, sy, sh, Math.max(1, Math.round(W0 * scale)));
    const file = `${outPrefix}-${i + 1}.png`;
    await fsp.writeFile(file, buf);
    out.push({ file, y0: Math.round(sy / dpr), y1: Math.round((sy + sh) / dpr), part: i + 1, of: n });
  }
  return out;
}
