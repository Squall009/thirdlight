/**
 * A neutral trim sheet and a model of trim strips, made in the test (no game
 * art): the sheet is four solid rows of unequal height — red, green, blue,
 * magenta — each filling its padding with its own colour, so any read of a
 * neighbour shows as a colour that does not belong. The model lays one patch
 * per entry of `patches` on the ground, side by side along X: each patch is
 * strips 0.25 m deep running along X (u along the strip in metres at the
 * row's density), stacked along −Z for `length` metres, every strip spanning
 * its row once across (v inset by the row table's rules). Far away a strip
 * is much less than a pixel deep, so v changes by many rows per pixel: the
 * deepest mips are asked for, the grazing-angle case of a floor.
 *
 * COLOR_0 per patch carries the trim channels (occlusion, grime, wetness).
 * Shared by the layered-material spec (pixels) and the perf harness's trim
 * cost run (tools/perf/trim-run.ts).
 */
import { makePng } from './png-make';
import { trimRowOf, writeTrimStripUvs, type TrimSheet } from '../../packages/project-model/src/trim-sheet';

/** The test sheet's rows: unequal heights, 4 px of padding filled with the row's own colour. */
export const TEST_TRIM_SHEET: TrimSheet = {
  size: [256, 256],
  texelDensity: 128,
  padding: 4,
  rows: [
    { slot: 'floor', top: 4, bottom: 60 },
    { slot: 'baseboard', top: 68, bottom: 92 },
    { slot: 'crown', top: 100, bottom: 124 },
    { slot: 'lower_wall', top: 132, bottom: 252 },
  ],
};

/** Each row's colour (the bands its padding fills: [0, 64), [64, 96), [96, 128), [128, 256)). */
export const TEST_TRIM_COLOURS: Readonly<Record<string, readonly [number, number, number]>> = {
  floor: [220, 24, 24],
  baseboard: [24, 200, 24],
  crown: [24, 24, 220],
  lower_wall: [210, 24, 210],
};

/** The test sheet as a PNG: every pixel row the colour of the band it lies in. */
export function testTrimSheetPng(): Buffer {
  const bandOf = (y: number): string => (y < 64 ? 'floor' : y < 96 ? 'baseboard' : y < 128 ? 'crown' : 'lower_wall');
  return makePng(256, 256, (_x, y) => [...TEST_TRIM_COLOURS[bandOf(y)]!, 255]);
}

/** A Texture Designer layout.json (trim/1) of the test sheet, with a decal layer the import leaves out. */
export function testTrimLayoutJson(): string {
  const layers = TEST_TRIM_SHEET.rows.map((r) => ({ name: r.slot, kind: 'tile_u', px: [r.top, r.bottom], height_px: r.bottom - r.top, gutter_px: TEST_TRIM_SHEET.padding }));
  return JSON.stringify({ format: 'trim/1', name: 'e2e_rows', size: TEST_TRIM_SHEET.size, texel_density_px_per_m: TEST_TRIM_SHEET.texelDensity, gutter_px: TEST_TRIM_SHEET.padding, uv_origin: 'top-left', layers: [...layers, { name: 'signs', kind: 'decals', px: [0, 4], cells: [] }] });
}

export interface StripPatch {
  /** The row (slot) the patch shows. */
  slot: string;
  /** COLOR_0 of its vertices: occlusion, grime, wetness (absent: 0, 0, 0). */
  colour?: readonly [number, number, number];
}

/** Patch width and the gap between patches (metres, along X); strip depth (along −Z). */
export const STRIP_PATCH_WIDTH = 0.6;
export const STRIP_PATCH_GAP = 0.15;
export const STRIP_DEPTH = 0.25;

/** The middle of patch `i` along X (model metres). */
export function stripPatchCentre(i: number): number {
  return i * (STRIP_PATCH_WIDTH + STRIP_PATCH_GAP) + STRIP_PATCH_WIDTH / 2;
}

/** The strips as a GLB: one mesh (POSITION, NORMAL, TEXCOORD_0, COLOR_0), its material named "trim". */
export function trimStripsGlb(sheet: TrimSheet, patches: readonly StripPatch[], length: number): Buffer {
  const strips = Math.round(length / STRIP_DEPTH);
  const quads = patches.length * strips;
  const pos = new Float32Array(quads * 12);
  const nrm = new Float32Array(quads * 12);
  const uv = new Float32Array(quads * 8);
  const col = new Float32Array(quads * 16);
  const idx = new Uint32Array(quads * 6);
  let q = 0;
  patches.forEach((p, i) => {
    const row = trimRowOf(sheet, p.slot);
    if (row === null) throw new Error(`the sheet has no row "${p.slot}"`);
    const x0 = i * (STRIP_PATCH_WIDTH + STRIP_PATCH_GAP);
    const x1 = x0 + STRIP_PATCH_WIDTH;
    for (let s = 0; s < strips; s++, q++) {
      const z0 = -s * STRIP_DEPTH;
      const z1 = z0 - STRIP_DEPTH;
      // Corners: near-left, near-right, far-right, far-left; the strip's top edge (v of the row's top) is the near one.
      pos.set([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1], q * 12);
      nrm.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], q * 12);
      writeTrimStripUvs(sheet, row, [x0, x1, x1, x0], [0, 0, 1, 1], uv, q * 8);
      const [o, g, w] = p.colour ?? [0, 0, 0];
      for (let k = 0; k < 4; k++) col.set([o, g, w, 1], q * 16 + k * 4);
      const b = q * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    }
  });
  const width = patches.length * (STRIP_PATCH_WIDTH + STRIP_PATCH_GAP);
  const parts = [pos, nrm, uv, col, idx].map((a) => Buffer.from(a.buffer));
  const offsets: number[] = [];
  let at = 0;
  for (const b of parts) {
    offsets.push(at);
    at += b.length;
  }
  const bin = Buffer.concat(parts);
  const view = (i: number, target: number): Record<string, number> => ({ buffer: 0, byteOffset: offsets[i]!, byteLength: parts[i]!.length, target });
  const json = {
    asset: { version: '2.0', generator: 'thirdlight e2e trim strips' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'strips', mesh: 0 }],
    meshes: [{ name: 'strips', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 3 }, indices: 4, material: 0 }] }],
    materials: [{ name: 'trim', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: quads * 4, type: 'VEC3', min: [0, 0, -strips * STRIP_DEPTH], max: [width, 0, 0] },
      { bufferView: 1, componentType: 5126, count: quads * 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: quads * 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5126, count: quads * 4, type: 'VEC4' },
      { bufferView: 4, componentType: 5125, count: quads * 6, type: 'SCALAR' },
    ],
    bufferViews: [view(0, 34962), view(1, 34962), view(2, 34962), view(3, 34962), view(4, 34963)],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
