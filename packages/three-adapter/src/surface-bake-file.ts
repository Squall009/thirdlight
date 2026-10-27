/**
 * The saved result of the live lighting ("Bake lighting") as files.
 *
 * One saved file per scene, little-endian:
 *
 * - "TLSL", u32 version (`SURFACE_BAKE_VERSION`), u32 the file's length,
 *   u32 the header's length, the header (JSON, UTF-8), zero padding to 8;
 * - the cache's pages: `pages` × `SURFACE_PAGE_TEXELS`² RGBA half floats
 *   (the atlas as the light pass wrote it: irradiance in rgb, the lit mark
 *   and the sun's share in alpha);
 * - per probe tile in header order: its probes' validity (f32 each), then
 *   its packed GPU layout (`probe-pack.ts`: RGBA half floats), each padded
 *   to 8 bytes.
 *
 * The header names the cache level, the page count, each tile's key, chart
 * digest, level and atlas blocks (page, x, y, side), and each probe tile's
 * key, box, resolution and whether it is a brick.
 *
 * The bytes travel as 16-bit RGBA PNGs (texture assets, like probe files):
 * `SURFACE_BAKE_FILE_WIDTH` texels a row (8 bytes a texel, two bytes a
 * sample), at most `MAX_TEXTURE_EDGE` rows a file; the files' samples,
 * concatenated, are the saved file (its own length says where it ends).
 */
import { MAX_TEXTURE_EDGE } from '@thirdlight/runtime';

import { SURFACE_PAGE_TEXELS, type AtlasBlock } from './surface-cache-atlas';
import { decodePng16, encodePng16 } from './probe-artifact';
import { emptyPackedProbeTile } from './probe-pack';

export const SURFACE_BAKE_VERSION = 1;
/** Texels a row of a saved lighting PNG. */
export const SURFACE_BAKE_FILE_WIDTH = 1024;
const MAGIC = [0x54, 0x4c, 0x53, 0x4c];
const ROW_BYTES = SURFACE_BAKE_FILE_WIDTH * 8;
/** Halves of one saved page. */
const PAGE_HALVES = SURFACE_PAGE_TEXELS * SURFACE_PAGE_TEXELS * 4;

/** A cache tile as saved: its key, its charts' digest, its level and its blocks. */
export interface SavedTileRecord {
  readonly key: string;
  readonly digest: string;
  readonly level: number;
  readonly blocks: readonly AtlasBlock[];
}

/** A probe tile as saved: a room's grid or a brick, in the probe lighting's GPU layout. */
export interface SavedProbeTile {
  readonly key: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly resolution: readonly [number, number, number];
  readonly brick: boolean;
  readonly validity: Float32Array;
  /** `PackedProbeTile.data`. */
  readonly data: Uint16Array;
}

export interface SavedSurfaceLight {
  /** The cache level the tiles were lit at. */
  readonly level: number;
  readonly pages: number;
  /** `pages` pages of RGBA half floats. */
  readonly texels: Uint16Array;
  readonly tiles: readonly SavedTileRecord[];
  readonly probes: readonly SavedProbeTile[];
}

interface Header {
  level: number;
  pages: number;
  tiles: [string, string, number, number[]][];
  probes: [string, number[], number[], number[], number][];
}

const pad8 = (n: number): number => (n + 7) & ~7;

/** The saved file's bytes. */
export function encodeSavedSurface(s: SavedSurfaceLight): Uint8Array {
  const header: Header = {
    level: s.level,
    pages: s.pages,
    tiles: s.tiles.map((t) => [t.key, t.digest, t.level, t.blocks.flatMap((b) => [b.page, b.x, b.y, b.side])]),
    probes: s.probes.map((p) => [p.key, [...p.min], [...p.max], [...p.resolution], p.brick ? 1 : 0]),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const headAt = 16;
  let size = pad8(headAt + json.length);
  const texelsAt = size;
  size += s.pages * PAGE_HALVES * 2;
  const probeAt: [number, number][] = [];
  for (const p of s.probes) {
    const v = size;
    size = pad8(size + p.validity.length * 4);
    probeAt.push([v, size]);
    size = pad8(size + p.data.length * 2);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, SURFACE_BAKE_VERSION, true);
  view.setUint32(8, size, true);
  view.setUint32(12, json.length, true);
  out.set(json, headAt);
  out.set(new Uint8Array(s.texels.buffer, s.texels.byteOffset, s.pages * PAGE_HALVES * 2), texelsAt);
  s.probes.forEach((p, i) => {
    const [v, d] = probeAt[i]!;
    out.set(new Uint8Array(p.validity.buffer, p.validity.byteOffset, p.validity.byteLength), v);
    out.set(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), d);
  });
  return out;
}

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message: `the saved lighting file ${message} (bake the scene again)` });

/** A saved file read back (the arrays are views into `bytes`, which must start 8-aligned). */
export function decodeSavedSurface(bytes: Uint8Array): { ok: true; saved: SavedSurfaceLight } | { ok: false; message: string } {
  if (bytes.length < 16 || MAGIC.some((m, i) => bytes[i] !== m)) return fail('is not one');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== SURFACE_BAKE_VERSION) return fail('is of another version');
  const size = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  if (size > bytes.length || 16 + jsonLength > size) return fail('is cut short');
  let header: Header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + jsonLength))) as Header;
  } catch {
    return fail('has no readable header');
  }
  if (!Number.isInteger(header.pages) || header.pages < 0 || !Array.isArray(header.tiles) || !Array.isArray(header.probes)) return fail('has a malformed header');
  let at = pad8(16 + jsonLength);
  const halves = (n: number): Uint16Array | null => {
    if (at + n * 2 > size || (bytes.byteOffset + at) % 2 !== 0) return null;
    const a = new Uint16Array(bytes.buffer, bytes.byteOffset + at, n);
    at = pad8(at + n * 2);
    return a;
  };
  const texels = halves(header.pages * PAGE_HALVES);
  if (texels === null) return fail('is cut short');
  const probes: SavedProbeTile[] = [];
  for (const [key, min, max, resolution, brick] of header.probes) {
    const n = resolution[0]! * resolution[1]! * resolution[2]!;
    if (at + n * 4 > size) return fail('is cut short');
    const validity = new Float32Array(bytes.slice(at, at + n * 4).buffer);
    at = pad8(at + n * 4);
    const data = halves(emptyPackedProbeTile(resolution).data.length);
    if (data === null) return fail('is cut short');
    probes.push({ key, min: min as [number, number, number], max: max as [number, number, number], resolution: resolution as [number, number, number], brick: brick === 1, validity, data });
  }
  const tiles = header.tiles.map(([key, digest, level, b]) => {
    const blocks: AtlasBlock[] = [];
    for (let i = 0; i + 3 < b.length; i += 4) blocks.push({ page: b[i]!, x: b[i + 1]!, y: b[i + 2]!, side: b[i + 3]! });
    return { key, digest, level, blocks };
  });
  return { ok: true, saved: { level: header.level, pages: header.pages, texels, tiles, probes } };
}

/** The saved file as 16-bit RGBA PNGs (each at most `MAX_TEXTURE_EDGE` rows). */
export async function savedSurfaceFiles(bytes: Uint8Array): Promise<Uint8Array[]> {
  const rows = Math.max(1, Math.ceil(bytes.length / ROW_BYTES));
  const out: Uint8Array[] = [];
  for (let r0 = 0; r0 < rows; r0 += MAX_TEXTURE_EDGE) {
    const h = Math.min(MAX_TEXTURE_EDGE, rows - r0);
    const part = new Uint8Array(h * ROW_BYTES);
    part.set(bytes.subarray(r0 * ROW_BYTES, Math.min(bytes.length, (r0 + h) * ROW_BYTES)));
    const samples = new Uint16Array(part.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = part[i * 2]! | (part[i * 2 + 1]! << 8);
    out.push(await encodePng16(SURFACE_BAKE_FILE_WIDTH, h, samples));
  }
  return out;
}

/** The saved file from its PNGs, in order. */
export async function savedSurfaceFromFiles(files: readonly Uint8Array[]): Promise<{ ok: true; saved: SavedSurfaceLight; bytes: number } | { ok: false; message: string }> {
  const parts: Uint16Array[] = [];
  for (const f of files) {
    const d = await decodePng16(f);
    if (!d.ok) return fail(`could not be read: ${d.message}`);
    if (d.width !== SURFACE_BAKE_FILE_WIDTH) return fail('has rows of another width');
    parts.push(d.samples);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length * 2, 0));
  let o = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += 1) {
      all[o + i * 2] = p[i]! & 0xff;
      all[o + i * 2 + 1] = p[i]! >>> 8;
    }
    o += p.length * 2;
  }
  const r = decodeSavedSurface(all);
  return r.ok ? { ...r, bytes: files.reduce((n, f) => n + f.length, 0) } : r;
}
