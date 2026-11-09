/**
 * The placeholder kit sheets (kit-sheets.ts) and what reads them: a sheet
 * on the example layout and on a kit's own, the GLB of a committed
 * placeholder kit with the sheet as its one material (read back by the
 * engine's GLB reader), and a kit's 4 m crack map at the base tile's
 * 1024 px/m read into the crack layer without losing its thin cracks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGlb } from '@thirdlight/shared';
import { DRAFT_TRIM_LAYOUT, kitTrimLayout } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import { CRACK_TEXELS, crackTexelsFromPixels } from '../../packages/three-adapter/src/voxel-crack-texture';
import { glbWithKitMaterial, kitSheetMaps, kitSheetPngs } from './kit-sheets';

const KITS = join(__dirname, 'kits');

describe('placeholder kit sheets', () => {
  it('lays a placeholder material into the layout\'s regions and leaves gutters neutral (height 0.5, flat normal); the height is the albedo\'s A, the normal\'s A opaque', () => {
    const size = 512;
    const m = kitSheetMaps(DRAFT_TRIM_LAYOUT, size, 'stone');
    const at = (map: Uint8Array, u: number, v: number): number[] => [...map.subarray((Math.floor(v * size) * size + Math.floor(u * size)) * 4, (Math.floor(v * size) * size + Math.floor(u * size)) * 4 + 4)];
    // The gutter between the field (rows 32–1056 of 4096) and the 0.5 m strip.
    const gutter = 1088 / 4096;
    expect(at(m.normal, 0.5, gutter)).toEqual([128, 128, 255, 255]);
    expect(at(m.albedo, 0.5, gutter)[3]).toBe(128);
    // Inside the field: the stone's relief in the albedo's A, not neutral; the normal map carries no height.
    const field: number[] = [];
    for (let u = 0.1; u < 0.9; u += 0.05) for (const y of [300, 520, 740, 960]) field.push(at(m.albedo, u, y / 4096)[3]!);
    expect(Math.max(...field) - Math.min(...field)).toBeGreaterThan(20);
    for (let i = 3; i < m.normal.length; i += 4 * 97) expect(m.normal[i]).toBe(255);
    // A kit's own layout: its strip filled, everything else neutral.
    const own = kitTrimLayout({ voxelKitId: 'k', sheetLayout: { size: 1024, pxPerMetre: 1024, regions: [{ id: 'S25', kind: 'strip', metres: 0.25, y: [32, 288] }] } })!;
    const o = kitSheetMaps(own, 256, 'timber');
    const row = (y: number): number => o.albedo[(y * 256 + 128) * 4 + 3]!;
    expect(row(200)).toBe(128);
    expect([row(30), row(40), row(50), row(60)].every((h) => h !== 128)).toBe(true);
  });

  it("puts the sheet into a kit's GLB as its one material on every primitive, images inside the file", () => {
    const glb = new Uint8Array(readFileSync(join(KITS, 'voxel-kit-sample.glb')));
    const pngs = kitSheetPngs(DRAFT_TRIM_LAYOUT, 64, 'stone');
    const out = glbWithKitMaterial(glb, 'sample-sheet', pngs);
    const parts = readGlb(out);
    if (typeof parts === 'string') throw new Error(parts);
    const json = parts.json as { materials: { name: string; normalTexture?: unknown; occlusionTexture?: unknown }[]; images: { bufferView: number; mimeType: string }[]; bufferViews: { byteOffset: number; byteLength: number }[]; meshes: { primitives: { material: number }[] }[] };
    expect(json.materials.map((x) => x.name)).toEqual(['sample-sheet']);
    expect(json.materials[0]!.normalTexture).toEqual({ index: 1 });
    expect(json.materials[0]!.occlusionTexture).toEqual({ index: 2 });
    expect(json.meshes.flatMap((x) => x.primitives.map((p) => p.material))).toEqual(json.meshes.flatMap((x) => x.primitives.map(() => 0)));
    // Each image's bytes are the PNG given (the original geometry's bytes before them unchanged).
    const views = json.images.map((im) => json.bufferViews[im.bufferView]!);
    const bytes = views.map((v) => parts.bin!.subarray(v.byteOffset, v.byteOffset + v.byteLength));
    expect(Buffer.from(bytes[0]!).equals(Buffer.from(pngs.albedo))).toBe(true);
    expect(Buffer.from(bytes[2]!).equals(Buffer.from(pngs.orm))).toBe(true);
    const was = readGlb(glb);
    if (typeof was === 'string') throw new Error(was);
    expect(Buffer.from(parts.bin!.subarray(0, was.bin!.length)).equals(Buffer.from(was.bin!))).toBe(true);
    // The material stays opaque: the albedo's A is a height, not a coverage a glTF reader should cut or blend by.
    expect(json.materials[0]).not.toHaveProperty('alphaMode');
    expect(pngs.albedo.length).toBeGreaterThan(100);
  });

  it("reads a kit's crack map authored at 1024 px/m (4096², cracks a pixel wide) into the crack layer without losing them", () => {
    const n = 4096;
    const rgba = new Uint8Array(n * n * 4);
    // A one-pixel crack every 37 pixels across, at strengths 255 and 110 alternately.
    for (let x = 5; x < n; x += 37) for (let y = 0; y < n; y++) rgba[(y * n + x) * 4] = (x / 37) % 2 < 1 ? 255 : 110;
    const layer = crackTexelsFromPixels(rgba, n, n);
    expect(layer.length).toBe(CRACK_TEXELS * CRACK_TEXELS);
    // Every crack column keeps a texel column at its own strength; nothing appears between them.
    const k = n / CRACK_TEXELS;
    for (let x = 5; x < n; x += 37) {
      const col = Math.floor(x / k);
      expect(layer[100 * CRACK_TEXELS + col], `crack at ${x}`).toBe(rgba[x * 4]);
    }
    const lit = new Set<number>();
    for (let x = 5; x < n; x += 37) lit.add(Math.floor(x / k));
    for (let c = 0; c < CRACK_TEXELS; c++) if (!lit.has(c)) expect(layer[100 * CRACK_TEXELS + c]).toBe(0);
  });
});
