/**
 * The Basic Kit: the engine's neutral prototype kit, so a new level never
 * draws grey. It holds a trim sheet made to the trim sheet spec
 * (`docs/manual/guides/trim-sheet-spec.md`), presets of the engine's starter
 * styles pointed at it, block types wearing it, and a placeholder door and
 * window. A project gets it as ordinary items (`POST …/packs/basic-kit`,
 * the editor's Create → Basic Kit): `pack.json` lists its asset files and the
 * commands that make the rest.
 *
 * The script (1) encodes the sheet's three maps to KTX2 from the Texture
 * Designer's PNGs, when a folder of them is given (`--sheet <dir>`, holding
 * `basic_kit_trim_{albedo_height,normal,orm}.png` and `layout.json`; the
 * KTX2 files and `source/layout.json` are kept in the repository, the PNGs
 * are not), (2) builds the door and window GLBs (render levels LOD0–2 and a
 * `_COL` collision mesh each, UV'd in strip space against the spec's rows),
 * and (3) writes `pack.json`. Re-running it gives the same bytes.
 *
 * Run (from the repository root):
 *   npx esbuild packs/basic-kit/tools/build-basic-kit.mts --bundle --platform=node \
 *     --format=esm --external:ktx2-encoder --outfile=node_modules/.cache/tl-basic-kit.mjs \
 *     && node node_modules/.cache/tl-basic-kit.mjs [--sheet <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import * as ktx2 from 'ktx2-encoder';
import { ARCHITECTURE_PRESET_KIND, type BlockType, type GraphData, type KitDef, type MaterialDef } from '@thirdlight/project-model';
import { decodePngRgba } from '@thirdlight/project-model/png';
import { trimRowOf, trimRowV, trimSheetFromLayout, type TrimSheet } from '@thirdlight/project-model/trim-sheet';

// Bundled elsewhere, so the pack folder comes from the working directory (the repo root).
const ROOT = resolve('packs', 'basic-kit');
const ASSETS = join(ROOT, 'assets');

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* --------------------------------------------------------------- ids --- */

/** Every item the kit adds; `basic-` keeps them clear of a project's own names. */
export const IDS = {
  kit: 'basic-kit',
  trim: 'basic-trim',
  albedo: 'basic-trim-albedo',
  normal: 'basic-trim-normal',
  orm: 'basic-trim-orm',
  door: 'basic-door',
  window: 'basic-window',
} as const;

/* ---------------------------------------------------------- textures --- */

/** Where the sheet's maps come from: the art-factory Texture Designer's trim sheet document and its packing. */
const SHEET_SOURCE = {
  designer: 'art-factory Texture Designer',
  sheet: 'thirdlight/basic_kit_trim@4',
  packing: 'albedo + height in A, normal, ORM (a shared packing of the designer)',
  note: 'Original content rendered from the shared library graphs (no downloaded or third-party textures).',
};

const MAPS = [
  // Albedo in sRGB with the height in A: ETC1S keeps it small (the engine's colour encoding).
  { assetId: IDS.albedo, png: 'basic_kit_trim_albedo_height.png', file: 'textures/basic-trim-albedo.ktx2', name: 'Basic trim: albedo + height', mode: 'color' },
  // The normal map needs UASTC's precision.
  { assetId: IDS.normal, png: 'basic_kit_trim_normal.png', file: 'textures/basic-trim-normal.ktx2', name: 'Basic trim: normal', mode: 'normal' },
  // Occlusion and roughness are smooth and metalness is 0 everywhere, so ETC1S's shared endpoints cost nothing
  // visible here; it keeps the kit inside its download target (UASTC would be 1.4 MiB more).
  { assetId: IDS.orm, png: 'basic_kit_trim_orm.png', file: 'textures/basic-trim-orm.ktx2', name: 'Basic trim: occlusion, roughness, metalness', mode: 'data-etc1s' },
] as const;

async function encodeMaps(dir: string): Promise<void> {
  mkdirSync(join(ASSETS, 'textures'), { recursive: true });
  for (const m of MAPS) {
    const r = decodePngRgba(new Uint8Array(readFileSync(join(dir, m.png))), { maxPixels: 4096 * 4096, inflate: (d, max) => new Uint8Array(inflateSync(d, { maxOutputLength: max })) });
    if (!r.ok) throw new Error(`${m.png}: ${r.message}`);
    const { width, height, rgba } = r.png;
    const colour = m.mode === 'color';
    const uastc = m.mode === 'normal';
    const out = await ktx2.encodeToKTX2(new Uint8Array(0), {
      imageDecoder: async () => ({ width, height, data: rgba }),
      isUASTC: uastc,
      generateMipmap: true,
      isKTX2File: true,
      isNormalMap: m.mode === 'normal',
      isPerceptual: colour,
      isSetKTX2SRGBTransferFunc: colour,
      ...(uastc ? { needSupercompression: true, enableRDO: true, rdoQualityLevel: 4 } : { qualityLevel: colour ? 128 : 255 }),
      enableDebug: false,
    });
    writeFileSync(join(ASSETS, m.file), out);
    console.log(`  ${m.file}: ${width}×${height}, ${out.byteLength} B`);
  }
  mkdirSync(join(ROOT, 'source'), { recursive: true });
  // The layout as the engine imports it; the packing's library name is the designer's own bookkeeping
  // (it names the library entry it was saved under), which engine content does not carry.
  const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as { source?: { packing?: { name?: unknown } } };
  delete layout.source?.packing?.name;
  writeFileSync(join(ROOT, 'source', 'layout.json'), `${JSON.stringify(layout, null, 1)}\n`);
}

/* --------------------------------------------------------------- GLB --- */

class BinWriter {
  bytes: number[] = [];
  push(data: Uint8Array): { offset: number; length: number } {
    const offset = Math.ceil(this.bytes.length / 4) * 4;
    while (this.bytes.length < offset) this.bytes.push(0);
    for (const b of data) this.bytes.push(b);
    return { offset, length: data.length };
  }
  padded(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bytes.length / 4) * 4);
    out.set(this.bytes, 0);
    return out;
  }
}

function packGlb(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4);
  jsonPadded.set(jsonBytes, 0);
  jsonPadded.fill(0x20, jsonBytes.length);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonPadded.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  v.setUint32(binHeader, bin.length, true);
  v.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The sheet's row table, imported from the Texture Designer's layout as the editor imports one: pieces are UV'd against it. */
function readSheet(): TrimSheet {
  const layout = JSON.parse(readFileSync(join(ROOT, 'source', 'layout.json'), 'utf8')) as unknown;
  const r = trimSheetFromLayout(layout);
  if (!r.ok) throw new Error(`layout.json: ${r.message}`);
  return r.sheet;
}
/** Set in main (after the layout may have been written). */
let SPEC: TrimSheet;

/** One primitive's triangles, built a quad at a time. */
class Prim {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  get triangles(): number {
    return this.idx.length / 3;
  }
  /**
   * A rectangle from `corner` spanning `a` (u: along) and `b` (v: across) metres, facing `normal`. On the trim
   * material it wears `slot`'s row: u = metres along ÷ 4 from `u0`, v down from the row's top edge, a part
   * `|b|` metres across taking `|b|` ÷ the row's metres of it (a part as tall as the row spans it exactly;
   * a taller one is stretched within the row). Upright: `b` runs from the top edge (corner) downwards.
   */
  quad(corner: V3, a: V3, b: V3, normal: V3, slot: string | null, u0 = 0): void {
    const base = this.pos.length / 3;
    const la = Math.hypot(...a);
    const lb = Math.hypot(...b);
    let v0 = 0;
    let v1 = 1;
    if (slot !== null) {
      const row = trimRowOf(SPEC, slot);
      if (row === null) throw new Error(`no row ${slot}`);
      const [vt, vb] = trimRowV(SPEC, row);
      const metres = (row.bottom - row.top) / SPEC.texelDensity;
      v0 = vt;
      v1 = vt + (vb - vt) * Math.min(1, lb / metres);
    }
    const uOf = (m: number): number => (u0 + m) / (SPEC.size[0] / SPEC.texelDensity);
    const corners: [V3, number, number][] = [
      [corner, uOf(0), v0],
      [add(corner, a), uOf(la), v0],
      [add(add(corner, a), b), uOf(la), v1],
      [add(corner, b), uOf(0), v1],
    ];
    for (const [p, u, v] of corners) {
      this.pos.push(...p);
      this.nor.push(...normal);
      // Without a row (the glass): 0–1 across the quad.
      this.uv.push(slot === null ? (u * (SPEC.size[0] / SPEC.texelDensity)) / la : u, v);
    }
    // Counter-clockwise seen from the side the normal points to.
    const ccw = dot(cross(a, b), normal) > 0;
    if (ccw) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/** A box's faces: which ones are drawn (hidden ones left out) and the row each wears. */
interface BoxFaces {
  px?: string | null;
  nx?: string | null;
  py?: string | null;
  ny?: string | null;
  pz?: string | null;
  nz?: string | null;
}

/**
 * The visible faces of the box `min`–`max` as quads, u along each face's longer side (a frame member's strip
 * runs along the member), v across it from the top (vertical faces) or the outer edge.
 */
function box(prim: Prim, min: V3, max: V3, faces: BoxFaces): void {
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const sides: [keyof BoxFaces, number, 1 | -1][] = [['px', 0, 1], ['nx', 0, -1], ['py', 1, 1], ['ny', 1, -1], ['pz', 2, 1], ['nz', 2, -1]];
  for (const [key, axis, sign] of sides) {
    if (!(key in faces)) continue;
    const slot = faces[key] ?? null;
    const normal = mul(axes[axis]!, sign);
    const others = [0, 1, 2].filter((k) => k !== axis);
    // u along the longer side; on a vertical face whose longer side is horizontal, v runs down from the top.
    const [ua, va] = size[others[0]!]! >= size[others[1]!]! ? [others[0]!, others[1]!] : [others[1]!, others[0]!];
    const at = (k: number, high: boolean): number => (high ? max[k]! : min[k]!);
    const corner: V3 = [0, 0, 0];
    corner[axis] = at(axis, sign > 0);
    corner[ua] = min[ua]!;
    // v starts at the top (y) or at the high side, so a row's top pixels sit at the top of a vertical part.
    corner[va] = max[va]!;
    const a = mul(axes[ua]!, size[ua]!);
    const b = mul(axes[va]!, -size[va]!);
    prim.quad(corner, a, b, normal, slot);
  }
}

interface Level {
  trim: Prim;
  glass?: Prim;
}
interface PieceModel {
  name: string;
  levels: Level[];
  /** Collision boxes (each its own primitive: one convex part). */
  collision: [V3, V3][];
}

/** The GLB of one piece: `<name>_LOD0..2` and `<name>_COL` top-level nodes at the origin; materials `trim` and `glass`. */
function pieceGlb(piece: PieceModel): Uint8Array {
  const bin = new BinWriter();
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const view = (bytes: Uint8Array, target: number): number => {
    const r = bin.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: r.offset, byteLength: r.length, target });
    return bufferViews.length - 1;
  };
  const f32 = (v: number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer);
  const u16 = (v: number[]): Uint8Array => new Uint8Array(new Uint16Array(v).buffer);
  const primitive = (p: Prim, material: number | null, uv: boolean): Record<string, unknown> => {
    const n = p.pos.length / 3;
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p.pos[i * 3 + k]!);
      max[k] = Math.max(max[k]!, p.pos[i * 3 + k]!);
    }
    const round = (v: V3): number[] => v.map((x) => Math.fround(x));
    const attributes: Record<string, number> = {};
    accessors.push({ bufferView: view(f32(p.pos), 34962), componentType: 5126, count: n, type: 'VEC3', min: round(min), max: round(max) });
    attributes['POSITION'] = accessors.length - 1;
    accessors.push({ bufferView: view(f32(p.nor), 34962), componentType: 5126, count: n, type: 'VEC3' });
    attributes['NORMAL'] = accessors.length - 1;
    if (uv) {
      accessors.push({ bufferView: view(f32(p.uv), 34962), componentType: 5126, count: n, type: 'VEC2' });
      attributes['TEXCOORD_0'] = accessors.length - 1;
    }
    accessors.push({ bufferView: view(u16(p.idx), 34963), componentType: 5123, count: p.idx.length, type: 'SCALAR' });
    return { attributes, indices: accessors.length - 1, mode: 4, ...(material !== null ? { material } : {}) };
  };
  piece.levels.forEach((level, i) => {
    const prims = [primitive(level.trim, 0, true)];
    if (level.glass !== undefined) prims.push(primitive(level.glass, 1, true));
    meshes.push({ name: `${piece.name}_LOD${i}`, primitives: prims });
    nodes.push({ name: `${piece.name}_LOD${i}`, mesh: meshes.length - 1 });
  });
  // Collision: one primitive per box, so each is a convex part.
  const colPrims = piece.collision.map(([min, max]) => {
    const p = new Prim();
    box(p, min, max, { px: null, nx: null, py: null, ny: null, pz: null, nz: null });
    return primitive(p, null, false);
  });
  meshes.push({ name: `${piece.name}_COL`, primitives: colPrims });
  nodes.push({ name: `${piece.name}_COL`, mesh: meshes.length - 1 });
  const json = {
    asset: { version: '2.0', generator: 'thirdlight-basic-kit' },
    scene: 0,
    scenes: [{ name: piece.name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    // `trim` is mapped to the kit's trim sheet material (the asset's material mapping); `glass` keeps its own look.
    materials: [
      { name: 'trim', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
      { name: 'glass', pbrMetallicRoughness: { baseColorFactor: [0.32, 0.38, 0.43, 1], metallicFactor: 0, roughnessFactor: 0.12 } },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.padded().length }],
  };
  return packGlb(JSON.stringify(json), bin.padded());
}

/*
 * Both pieces follow the spec's placement: origin at the bottom centre, +X along the wall, +Z facing out, +Y up,
 * metres, one block cell (1 m) wide. Frame members are 0.125 m wide on their faces, the `frame` row's height, so
 * the row's chamfered edges outline them at the painted scale; the reveal faces (0.2 m deep, a wall's thickness)
 * wear the `column` field row; a door leaf is fifteen 0.125 m slats of the `crown` row on each side.
 */
const W = 0.5; // half the cell
const F = 0.125; // frame member width (the frame row)
const D = 0.1; // half the frame's depth (a 0.2 m wall)

function door(): PieceModel {
  const H = 2;
  const leafT = 0.02;
  const lod0 = new Prim();
  const lod1 = new Prim();
  const lod2 = new Prim();
  for (const s of [-1, 1] as const) {
    const x0 = s < 0 ? -W : W - F;
    const x1 = s < 0 ? -W + F : W;
    // Jambs: the outer side shows where the door stands free on a cell edge; the inner side up to the head.
    const outer = s < 0 ? 'nx' : 'px';
    const inner = s < 0 ? 'px' : 'nx';
    box(lod0, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame', py: 'column', [outer]: 'column' });
    box(lod0, [x0, 0, -D], [x1, H - F, D], { [inner]: 'column' });
    box(lod1, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame', py: 'column', [outer]: 'column', [inner]: 'column' });
    box(lod2, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame' });
  }
  // The head between the jambs.
  for (const p of [lod0, lod1]) box(p, [-W + F, H - F, -D], [W - F, H, D], { pz: 'frame', nz: 'frame', py: 'column', ny: 'column' });
  box(lod2, [-W + F, H - F, -D], [W - F, H, D], { pz: 'frame', nz: 'frame' });
  // The leaf: slats of the crown row on both faces (LOD0), one stretched strip each (LOD1, LOD2), its edges in the frame row.
  const lw = 2 * (W - F);
  const lh = H - F;
  const slats = Math.round(lh / F);
  for (const z of [leafT, -leafT]) {
    const normal: V3 = [0, 0, Math.sign(z)];
    for (let i = 0; i < slats; i++) lod0.quad([-W + F, lh - i * F, z], [lw, 0, 0], [0, -F, 0], normal, 'crown');
    for (const p of [lod1, lod2]) p.quad([-W + F, lh, z], [lw, 0, 0], [0, -lh, 0], normal, 'crown');
  }
  box(lod0, [-W + F, 0, -leafT], [W - F, lh, leafT], { px: 'frame', nx: 'frame' });
  // Handles, one each side (LOD0 only).
  for (const s of [1, -1] as const) {
    const z0 = s > 0 ? leafT : -leafT - 0.04;
    const z1 = s > 0 ? leafT + 0.04 : -leafT;
    box(lod0, [0.18, 0.98, z0], [0.3, 1.02, z1], { py: 'frame', ny: 'frame', px: 'frame', nx: 'frame', [s > 0 ? 'pz' : 'nz']: 'frame' });
  }
  // Collision: the frame only — a placeholder door does not block the way (a game opens and closes its own doors).
  return {
    name: 'door',
    levels: [{ trim: lod0 }, { trim: lod1 }, { trim: lod2 }],
    collision: [
      [[-W, 0, -D], [-W + F, H, D]],
      [[W - F, 0, -D], [W, H, D]],
      [[-W + F, H - F, -D], [W - F, H, D]],
    ],
  };
}

function windowPiece(): PieceModel {
  const H = 1;
  const M = 0.025; // half a glazing bar
  const lod0: Level = { trim: new Prim(), glass: new Prim() };
  const lod1: Level = { trim: new Prim(), glass: new Prim() };
  const lod2: Level = { trim: new Prim(), glass: new Prim() };
  for (const s of [-1, 1] as const) {
    const x0 = s < 0 ? -W : W - F;
    const x1 = s < 0 ? -W + F : W;
    const inner = s < 0 ? 'px' : 'nx';
    // The jambs' outer sides, tops and bottoms are inside the wall round the opening: left out.
    box(lod0.trim, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame' });
    box(lod0.trim, [x0, F, -D], [x1, H - F, D], { [inner]: 'column' });
    box(lod1.trim, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame' });
    box(lod1.trim, [x0, F, -D], [x1, H - F, D], { [inner]: 'column' });
    box(lod2.trim, [x0, 0, -D], [x1, H, D], { pz: 'frame', nz: 'frame' });
  }
  // Head and sill between the jambs.
  for (const l of [lod0, lod1, lod2]) {
    box(l.trim, [-W + F, H - F, -D], [W - F, H, D], l === lod2 ? { pz: 'frame', nz: 'frame' } : { pz: 'frame', nz: 'frame', ny: 'column' });
    box(l.trim, [-W + F, 0, -D], [W - F, F, D], l === lod2 ? { pz: 'frame', nz: 'frame' } : { pz: 'frame', nz: 'frame', py: 'column' });
  }
  // The pane, one quad each way (its own material).
  const pw = 2 * (W - F);
  for (const l of [lod0, lod1, lod2]) for (const z of [0.004, -0.004]) l.glass!.quad([-W + F, H - F, z], [pw, 0, 0], [0, -pw, 0], [0, 0, Math.sign(z)], null);
  // Glazing bars (LOD0): a cross, 5 cm wide, 6 cm deep.
  const mid = H / 2;
  box(lod0.trim, [-M, F, -0.03], [M, H - F, 0.03], { pz: 'frame', nz: 'frame', px: 'frame', nx: 'frame' });
  for (const [x0, x1] of [[-W + F, -M], [M, W - F]] as const) box(lod0.trim, [x0, mid - M, -0.03], [x1, mid + M, 0.03], { pz: 'frame', nz: 'frame', py: 'frame', ny: 'frame' });
  return { name: 'window', levels: [lod0, lod1, lod2], collision: [[[-W, 0, -D], [W, H, D]]] };
}

/* -------------------------------------------------------------- pack --- */

/** The starter presets the kit derives, each pointed at its sheet; band sliders tied to a row are set to the row's height. */
const PRESETS: { graphId: string; name: string; base: string; values?: Record<string, number> }[] = [
  { graphId: 'basic-room', name: 'Room (Basic Kit)', base: 'starter-room', values: { baseboard_height: 0.15625 } },
  { graphId: 'basic-room-tall', name: 'Tall room (Basic Kit)', base: 'starter-room-tall', values: { baseboard_height: 0.15625 } },
  { graphId: 'basic-hall', name: 'Vaulted hall (Basic Kit)', base: 'starter-hall', values: { baseboard_height: 0.15625 } },
  { graphId: 'basic-rail', name: 'Rail (Basic Kit)', base: 'starter-rail' },
  { graphId: 'basic-fence', name: 'Fence (Basic Kit)', base: 'starter-fence' },
  { graphId: 'basic-pipe', name: 'Pipe (Basic Kit)', base: 'starter-pipe' },
];

function presetGraph(base: string, values: Record<string, number> = {}): GraphData {
  const nodes: GraphData['nodes'] = [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base, sheet: IDS.trim } }];
  Object.entries(values).forEach(([parameter, value], i) => nodes.push({ id: `v-${parameter}`, type: 'value', position: [0, 150 * (i + 1)], data: { parameter, value } }));
  return { nodes, edges: [] };
}

/** Stand-ins wearing the sheet: tops the floor row, the first storey of cells the lower wall, higher storeys the upper wall. */
const BLOCKS: BlockType[] = [
  { blockId: 'basic-ground', name: 'Ground', variants: [{ color: '#ffffff' }], shape: 'full' },
  { blockId: 'basic-wall', name: 'Wall', variants: [{ color: '#ffffff' }], shape: 'full' },
  { blockId: 'basic-half', name: 'Half block', variants: [{ color: '#ffffff' }], shape: 'half' },
  { blockId: 'basic-ramp', name: 'Ramp', variants: [{ color: '#ffffff' }], shape: 'ramp' },
  { blockId: 'basic-stairs', name: 'Stairs', variants: [{ color: '#ffffff' }], shape: 'stairs' },
  { blockId: 'basic-slab', name: 'Floor slab', variants: [{ color: '#ffffff' }], shape: 'custom', boxes: [[0, 0, 0, 1, 0.25, 1]] },
  { blockId: 'basic-edge-wall', name: 'Edge wall', variants: [{ color: '#ffffff' }], shape: 'full', placement: 'edge' },
].map((b) => ({ ...b, materials: { '*': IDS.trim } }) as BlockType);

async function main(): Promise<void> {
  const sheetAt = process.argv.indexOf('--sheet');
  if (sheetAt >= 0) await encodeMaps(resolve(process.argv[sheetAt + 1] ?? '.'));
  SPEC = readSheet();
  for (const m of MAPS) if (!existsSync(join(ASSETS, m.file))) throw new Error(`${m.file} is missing: run with --sheet <dir of the Texture Designer's PNGs>`);
  mkdirSync(join(ASSETS, 'models'), { recursive: true });
  const pieces = [
    { assetId: IDS.door, model: door(), file: 'models/basic-door.glb', name: 'Door (Basic Kit)' },
    { assetId: IDS.window, model: windowPiece(), file: 'models/basic-window.glb', name: 'Window (Basic Kit)' },
  ];
  for (const p of pieces) writeFileSync(join(ASSETS, p.file), pieceGlb(p.model));

  const material: MaterialDef = { materialId: IDS.trim, name: 'Basic trim sheet', shader: 'trim', params: { color: '#ffffff' }, textures: { map: IDS.albedo, normalMap: IDS.normal, ormMap: IDS.orm }, trim: SPEC };
  const kit: KitDef = {
    kitId: IDS.kit,
    name: 'Basic Kit',
    description: 'The engine’s neutral prototype kit: a trim sheet made to the trim sheet spec, room and rail presets on it, block types wearing it, a placeholder door and window. Change the copies freely; swap the trim material for a sheet of your own made to the same spec.',
    trimMaterial: IDS.trim,
    presets: PRESETS.map((p) => p.graphId),
    blockTypes: BLOCKS.map((b) => b.blockId),
    pieces: { door: [{ assetId: IDS.door, piece: 'door' }], window: [{ assetId: IDS.window, piece: 'window' }] },
  };
  const file = (f: string): { file: string; sha256: string; bytes: number } => {
    const b = new Uint8Array(readFileSync(join(ASSETS, f)));
    return { file: f, sha256: sha256Hex(b), bytes: b.byteLength };
  };
  const pack = {
    format: 1,
    packId: IDS.kit,
    name: 'Basic Kit',
    description: kit.description,
    source: SHEET_SOURCE,
    folder: 'assets/basic-kit',
    assets: [
      ...MAPS.map((m) => ({ assetId: m.assetId, kind: 'texture', displayName: m.name, ...file(m.file) })),
      ...pieces.map((p) => ({ assetId: p.assetId, kind: 'model', displayName: p.name, ...file(p.file), materials: { trim: IDS.trim } })),
    ],
    commands: [
      { op: 'setMaterial', args: { material } },
      ...PRESETS.map((p) => ({ op: 'setGraph', args: { graph: { graphId: p.graphId, kind: ARCHITECTURE_PRESET_KIND, name: p.name, graph: presetGraph(p.base, p.values) } } })),
      ...BLOCKS.map((b) => ({ op: 'setBlockType', args: { block: b } })),
      { op: 'setKit', args: { kit } },
    ],
  };
  writeFileSync(join(ROOT, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
  let total = 0;
  for (const a of pack.assets) {
    total += a.bytes;
    console.log(`  ${a.file}: ${a.bytes} B`);
  }
  for (const p of pieces) console.log(`  ${p.file}: tris per level ${p.model.levels.map((l) => l.trim.triangles + (l.glass?.triangles ?? 0)).join(' / ')}, collision boxes ${p.model.collision.length}`);
  console.log(`basic-kit: ${pack.assets.length} files, ${total} B; ${pack.commands.length} commands`);
}

await main();
