/**
 * The debug texture set of a trim layout (project-model voxel-trim-layout.ts,
 * the engine's example layout `detail-trim`, or a kit's own `sheetLayout`): what a kit whose pieces follow a
 * layout draws with until the material model gives it real texture sets.
 * Each region its own hue with its id written in it, a 1/16-cell checker
 * (3.125 cm) to show stretching, a tick every 0.125 m along U and a number
 * every half metre (the cell along the 4 m period), gutters and reserved
 * space magenta. A face in the wrong region shows the wrong colour, a
 * squashed one a stretched checker, a section join a jump in the numbers.
 *
 * Generated, not painted, at the layout's low tier (a quarter of the
 * authored side: 1024² for the draft's 4096² sheet). Rows follow glTF's v
 * from the top (a DataTexture is not flipped, so row 0 is v 0).
 */
import * as THREE from 'three';
import type { TrimLayout } from '@thirdlight/project-model';

/** The debug set's side as a share of the authored sheet's: the low tier (256 of 1024 px a metre). */
export const TRIM_DEBUG_TEXTURE_SCALE = 1 / 4;

/** 3 × 5 glyphs (rows top first, 3 bits each, high bit left) for debug textures' labels. */
export const DEBUG_GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [7, 4, 4, 4, 7],
  D: [6, 5, 5, 5, 6],
  F: [7, 4, 6, 4, 4],
  P: [7, 5, 7, 4, 4],
  S: [7, 4, 7, 1, 7],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
};

/** Every glyph of `text` (upper case; unknown characters as a gap) into `set`, top row first, `scale` texels a dot. */
export function drawGlyphs(set: (x: number, y: number) => void, text: string, x0: number, y0: number, scale: number, rowsUp = false): void {
  [...text.toUpperCase()].forEach((ch, i) => {
    const rows = DEBUG_GLYPHS[ch];
    if (rows === undefined) return;
    rows.forEach((bits, row) => {
      const r = rowsUp ? 4 - row : row;
      for (let col = 0; col < 3; col++) if (((bits >> (2 - col)) & 1) !== 0) for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) set(x0 + i * 4 * scale + col * scale + a, y0 + r * scale + b);
    });
  });
}

/** An RGB hue (s = 0.55, l = 0.62) for region `i` of `n`. */
function hue(i: number, n: number): [number, number, number] {
  const h = (i / n) * 6;
  const c = 0.42;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = 0.62 - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** The labelled debug texture of `layout` (see the file comment). */
export function trimDebugTexture(layout: TrimLayout): THREE.DataTexture {
  const s = TRIM_DEBUG_TEXTURE_SCALE;
  const n = Math.round(layout.size * s);
  const px = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) px.set([255, 0, 255, 255], i * 4);
  const pxPerM = layout.pxPerMetre * s;
  const check = pxPerM / 32;
  const put = (x: number, y: number, c: readonly number[]): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    px.set([c[0]!, c[1]!, c[2]!, 255], (y * n + x) * 4);
  };
  layout.regions.forEach((r, i) => {
    const [y0, y1] = [Math.round(r.y[0] * s), Math.round(r.y[1] * s)];
    const [x0, x1] = r.x === undefined ? [0, n] : [Math.round(r.x[0] * s), Math.round(r.x[1] * s)];
    const base = hue(i, layout.regions.length);
    const ink = base.map((c) => Math.round(c * 0.25));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dark = ((Math.floor((x - x0) / check) + Math.floor((y - y0) / check)) & 1) === 0;
        put(x, y, dark ? base.map((c) => Math.round(c * 0.82)) : base);
      }
    }
    const set = (x: number, y: number): void => put(x, y, ink);
    const scale = Math.max(1, Math.min(3, Math.floor((y1 - y0) / 12)));
    if (r.x === undefined) {
      // Along U: a tick every 0.125 m, a stronger line and the cell's number (0 … period / 0.5 m) every half metre.
      for (let k = 0; k * pxPerM * 0.125 < n; k++) {
        const x = Math.round(k * pxPerM * 0.125);
        const len = k % 4 === 0 ? y1 - y0 : Math.max(2, Math.round((y1 - y0) / 4));
        for (let y = y0; y < y0 + len; y++) set(x, y);
        if (k % 4 === 0) drawGlyphs(set, `${r.id} ${k / 4}`, x + 2 * scale, y0 + Math.round((y1 - y0) / 2) - 2 * scale, scale);
      }
    } else {
      for (let x = x0; x < x1; x++) (set(x, y0), set(x, y1 - 1));
      for (let y = y0; y < y1; y++) (set(x0, y), set(x1 - 1, y));
      drawGlyphs(set, r.id, x0 + 2 * scale, y0 + 2 * scale, scale);
    }
  });
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
