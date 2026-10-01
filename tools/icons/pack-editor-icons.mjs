/**
 * Packs the editor's kind and toolbar icons for shipping: each generated
 * 256 px PNG (tools/icons/editor-icons.tsv says which prompt and seed made
 * it) is cropped to what it draws, squared, scaled down to the size the
 * editor shows it at (twice the CSS size, for high-density screens) and
 * written as a WebP with alpha into packages/editor/public/icons/{kinds,actions}.
 * The browser does the scaling and the encoding (Chromium's canvas), so the
 * repo needs no image library. Prints each file's size and the total.
 *
 *   node tools/icons/pack-editor-icons.mjs <raw dir>
 *
 * `<raw dir>/<name>.png` per row of the table; a row whose `source` column
 * names a file under packages/editor/public/icons/ packs that file instead
 * (the object icons reused for their kinds).
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICONS = join(REPO, 'packages', 'editor', 'public', 'icons');
/** Shipped pixel size per group: kinds show at up to ~50 CSS px (project tiles; 16–32 in tabs and headers), actions at 16. */
const SIZE = { kind: 96, action: 32 };
/** Alpha at or below this is background haze the generator leaves; it is cleared before cropping. */
const HAZE = 8;

const raw = process.argv[2];
if (raw === undefined) throw new Error('usage: node tools/icons/pack-editor-icons.mjs <raw dir>');

const rows = readFileSync(join(REPO, 'tools', 'icons', 'editor-icons.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith('#'))
  .map((l) => {
    const [name, group, source] = l.split('\t');
    return { name, group, source: source !== undefined && source !== '' && source !== '-' ? source : null };
  });

const browser = await chromium.launch({ env: browserLaunchEnv() });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
let total = 0;
for (const r of rows) {
  const file = r.source !== null ? join(ICONS, r.source) : join(raw, `${r.name}.png`);
  const png = readFileSync(file).toString('base64');
  const size = SIZE[r.group];
  if (size === undefined) throw new Error(`${r.name}: unknown group ${r.group}`);
  const dataUrl = await page.evaluate(
    async ({ png, size, haze }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height);
      const px = data.data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4 + 3;
          if (px[i] <= haze) px[i] = 0;
          else {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      g.putImageData(data, 0, 0);
      if (x1 < 0) throw new Error('empty image');
      // A square around what it draws, with a small margin so strokes are not cut at the edge.
      const side = Math.max(x1 - x0 + 1, y1 - y0 + 1) * 1.06;
      const cx = (x0 + x1 + 1) / 2;
      const cy = (y0 + y1 + 1) / 2;
      // Halve step by step (a single big downscale aliases thin strokes).
      let src = c, sx = cx - side / 2, sy = cy - side / 2, sw = side;
      while (sw / 2 >= size) {
        const half = document.createElement('canvas');
        half.width = half.height = Math.round(sw / 2);
        const h = half.getContext('2d');
        h.imageSmoothingQuality = 'high';
        h.drawImage(src, sx, sy, sw, sw, 0, 0, half.width, half.height);
        src = half;
        sx = 0;
        sy = 0;
        sw = half.width;
      }
      const out = document.createElement('canvas');
      out.width = out.height = size;
      const o = out.getContext('2d');
      o.imageSmoothingQuality = 'high';
      o.drawImage(src, sx, sy, sw, sw, 0, 0, size, size);
      return out.toDataURL('image/webp', 0.9);
    },
    { png, size, haze: HAZE },
  );
  if (!dataUrl.startsWith('data:image/webp')) throw new Error('this Chromium cannot encode WebP');
  const dir = join(ICONS, r.group === 'kind' ? 'kinds' : 'actions');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${r.name}.webp`);
  writeFileSync(out, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  const bytes = statSync(out).size;
  total += bytes;
  console.log(`${r.group === 'kind' ? 'kinds' : 'actions'}/${r.name}.webp\t${size}x${size}\t${bytes} B`);
}
await browser.close();
console.log(`total\t${rows.length} files\t${total} B (${(total / 1024).toFixed(1)} KiB)`);
