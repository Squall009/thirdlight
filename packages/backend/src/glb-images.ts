/**
 * The images inside a GLB, read and taken out (the "extract textures" import
 * setting; Godot's glTF importer does the same by default, Unity's model
 * importer on "Extract Textures").
 *
 * - `readGlbImages` lists every image of the file with its bytes and what the
 *   materials sample it as: colour (base colour, emissive, sheen and
 *   specular colour), a normal map, or data (metal/roughness, occlusion and
 *   the other material maps). The role chooses the KTX2 encoding.
 * - `stripGlbImages` writes the file again with the chosen images replaced by
 *   a one-pixel PNG (white, or a flat normal for a normal map: what the
 *   material looks like without the texture) and their textures pointed at
 *   it, so the file stays a valid, self-contained GLB the import profile
 *   accepts; the engine draws those images from the texture assets the model
 *   names instead. Everything else in the binary chunk is kept, byte for
 *   byte, at new offsets.
 *
 * Pure byte work: no decoding of pixels, no file access.
 */
import { encodeRgbaPng } from './image-thumbnail';

export type GlbImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/ktx2';
export type GlbImageRole = 'color' | 'normal' | 'data';

export interface GlbImage {
  readonly index: number;
  /** The image's name in the file (absent: none). */
  readonly name: string | null;
  readonly mime: GlbImageMime;
  /** The image's bytes (a view into the file). */
  readonly bytes: Uint8Array;
  /** What the materials sample it as (empty: no material uses it). */
  readonly roles: ReadonlySet<GlbImageRole>;
}

export interface GlbParts {
  readonly json: Record<string, unknown>;
  readonly bin: Uint8Array | null;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function readGlb(glb: Uint8Array): GlbParts | string {
  if (glb.byteLength < 20) return 'the file is shorter than a GLB header';
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) return 'not a GLB (version 2)';
  const total = Math.min(view.getUint32(8, true), glb.byteLength);
  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > total) return 'a GLB chunk runs past the end of the file';
    if (type === CHUNK_JSON && json === null) {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + length)));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the GLB JSON is not an object';
        json = parsed as Record<string, unknown>;
      } catch {
        return 'the GLB JSON cannot be read';
      }
    } else if (type === CHUNK_BIN && bin === null) bin = glb.subarray(start, start + length);
    offset = start + length;
  }
  if (json === null) return 'the GLB has no JSON chunk';
  return { json, bin };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The image a texture draws (its compressed source first: KTX2, WebP). */
function textureSource(texture: unknown): number | null {
  if (!isObject(texture)) return null;
  const ext = isObject(texture['extensions']) ? texture['extensions'] : {};
  for (const name of ['KHR_texture_basisu', 'EXT_texture_webp']) {
    const e = ext[name];
    if (isObject(e) && Number.isInteger(e['source'])) return e['source'] as number;
  }
  return Number.isInteger(texture['source']) ? (texture['source'] as number) : null;
}

/** The role a material's texture slot samples its texture as. */
function roleOfSlot(key: string): GlbImageRole {
  if (key === 'normalTexture' || key === 'clearcoatNormalTexture') return 'normal';
  if (key === 'baseColorTexture' || key === 'emissiveTexture' || key === 'sheenColorTexture' || key === 'specularColorTexture') return 'color';
  return 'data';
}

/** Every `{index}` texture slot of a material (its extensions included), as [slot name, texture index]. */
function textureSlots(value: unknown, out: [string, number][], depth = 0): void {
  if (!isObject(value) || depth > 8) return;
  for (const [k, v] of Object.entries(value)) {
    if (k.endsWith('Texture') && isObject(v) && Number.isInteger(v['index'])) out.push([k, v['index'] as number]);
    else if (isObject(v)) textureSlots(v, out, depth + 1);
  }
}

function imageMime(bytes: Uint8Array): GlbImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 12 && bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58 && bytes[4] === 0x20 && bytes[5] === 0x32 && bytes[6] === 0x30 && bytes[7] === 0xbb) return 'image/ktx2';
  return null;
}

/** The images of a GLB and how its materials use them. */
export function readGlbImages(glb: Uint8Array): { ok: true; images: GlbImage[] } | { ok: false; message: string } {
  const parts = readGlb(glb);
  if (typeof parts === 'string') return { ok: false, message: parts };
  const { json, bin } = parts;
  const images = listOf(json['images']);
  const views = listOf(json['bufferViews']);
  const textures = listOf(json['textures']);
  const roles = images.map(() => new Set<GlbImageRole>());
  for (const material of listOf(json['materials'])) {
    const slots: [string, number][] = [];
    textureSlots(material, slots);
    for (const [slot, t] of slots) {
      const source = textureSource(textures[t]);
      if (source !== null) roles[source]?.add(roleOfSlot(slot));
    }
  }
  const out: GlbImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!isObject(image)) return { ok: false, message: `image ${i} is not an object` };
    const v = views[image['bufferView'] as number];
    if (!Number.isInteger(image['bufferView']) || !isObject(v) || bin === null || (v['buffer'] ?? 0) !== 0) return { ok: false, message: `image ${i} is not in the file's binary chunk` };
    const offset = (v['byteOffset'] as number | undefined) ?? 0;
    const length = v['byteLength'] as number;
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || offset + length > bin.length) return { ok: false, message: `image ${i} lies outside the binary chunk` };
    const bytes = bin.subarray(offset, offset + length);
    const mime = imageMime(bytes);
    if (mime === null) return { ok: false, message: `image ${i} is not PNG, JPEG, WebP or KTX2` };
    out.push({ index: i, name: typeof image['name'] === 'string' && image['name'].length > 0 ? image['name'] : null, mime, bytes, roles: roles[i]! });
  }
  return { ok: true, images: out };
}

/** The one-pixel stand-ins (computed once). */
let standIns: { white: Uint8Array; normal: Uint8Array } | null = null;
function standIn(normal: boolean): Uint8Array {
  standIns ??= { white: encodeRgbaPng(new Uint8Array([255, 255, 255, 255]), 1, 1), normal: encodeRgbaPng(new Uint8Array([128, 128, 255, 255]), 1, 1) };
  return normal ? standIns.normal : standIns.white;
}

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * The GLB with the images in `extracted` replaced by one-pixel PNGs: their
 * buffer views hold the stand-in, the textures that drew them name it
 * directly (their KTX2/WebP extension is dropped, and the extension leaves
 * the file's lists when nothing uses it any more). Null when the file's
 * binary layout is not one this can rewrite (views overlapping an image).
 */
export function stripGlbImages(glb: Uint8Array, images: readonly GlbImage[], extracted: ReadonlySet<number>): Uint8Array | null {
  const parts = readGlb(glb);
  if (typeof parts === 'string' || parts.bin === null) return null;
  const json = structuredClone(parts.json);
  const bin = parts.bin;
  const views = listOf(json['bufferViews']) as Record<string, unknown>[];
  const jsonImages = listOf(json['images']) as Record<string, unknown>[];
  const imageView = new Map<number, number>();
  for (const i of extracted) imageView.set(jsonImages[i]!['bufferView'] as number, i);
  // Every region of the binary chunk something points at: buffer views of buffer 0, and meshopt's compressed data.
  interface Region {
    start: number;
    end: number;
    set: (offset: number) => void;
    replace?: Uint8Array;
  }
  const regions: Region[] = [];
  views.forEach((v, vi) => {
    if (!isObject(v)) return;
    if ((v['buffer'] ?? 0) === 0) {
      const start = (v['byteOffset'] as number | undefined) ?? 0;
      const image = imageView.get(vi);
      const roles = image === undefined ? undefined : images.find((x) => x.index === image)?.roles;
      // A normal map's stand-in is a flat normal; anything else white (the material's own factors then).
      const replace = image === undefined ? undefined : standIn(roles !== undefined && roles.size > 0 && [...roles].every((r) => r === 'normal'));
      regions.push({
        start,
        end: start + (v['byteLength'] as number),
        set: (o) => {
          v['byteOffset'] = o;
          if (replace !== undefined) v['byteLength'] = replace.length;
        },
        ...(replace !== undefined ? { replace } : {}),
      });
    }
    const ext = isObject(v['extensions']) ? v['extensions'] : null;
    const mo = ext !== null && isObject(ext['EXT_meshopt_compression']) ? (ext['EXT_meshopt_compression'] as Record<string, unknown>) : null;
    if (mo !== null && (mo['buffer'] ?? 0) === 0) {
      const start = (mo['byteOffset'] as number | undefined) ?? 0;
      regions.push({ start, end: start + (mo['byteLength'] as number), set: (o) => void (mo['byteOffset'] = o) });
    }
  });
  regions.sort((a, b) => a.start - b.start || a.end - b.end);
  // Another region sharing bytes with an image cannot keep them once the image is replaced.
  for (const img of regions) {
    if (img.replace === undefined) continue;
    if (regions.some((r) => r !== img && r.start < img.end && img.start < r.end)) return null;
  }
  // The new chunk: each region at a 4-byte aligned offset (accessors need their component's alignment, meshopt 4).
  const chunks: { at: number; bytes: Uint8Array }[] = [];
  let size = 0;
  let last: Region | null = null;
  let lastAt = 0;
  for (const r of regions) {
    if (last !== null && r.replace === undefined && last.replace === undefined && r.start >= last.start && r.end <= last.end) {
      // Inside the previous region (shared bytes): the same relative place.
      r.set(lastAt + (r.start - last.start));
      continue;
    }
    const bytes = r.replace ?? bin.subarray(r.start, r.end);
    const at = align4(size);
    chunks.push({ at, bytes });
    r.set(at);
    size = at + bytes.length;
    last = r;
    lastAt = at;
  }
  const newBin = new Uint8Array(align4(size));
  for (const c of chunks) newBin.set(c.bytes, c.at);
  const buffers = listOf(json['buffers']) as Record<string, unknown>[];
  if (isObject(buffers[0])) buffers[0]['byteLength'] = newBin.length;
  // The stand-ins are PNGs; the textures that drew an extracted image draw it plainly.
  for (const i of extracted) {
    const img = jsonImages[i]!;
    img['mimeType'] = 'image/png';
  }
  for (const t of listOf(json['textures']) as Record<string, unknown>[]) {
    const source = textureSource(t);
    if (source === null || !extracted.has(source)) continue;
    t['source'] = source;
    if (isObject(t['extensions'])) {
      delete (t['extensions'] as Record<string, unknown>)['KHR_texture_basisu'];
      delete (t['extensions'] as Record<string, unknown>)['EXT_texture_webp'];
      if (Object.keys(t['extensions'] as object).length === 0) delete t['extensions'];
    }
  }
  for (const name of ['KHR_texture_basisu', 'EXT_texture_webp']) {
    const used = (listOf(json['textures']) as Record<string, unknown>[]).some((t) => isObject(t['extensions']) && (t['extensions'] as Record<string, unknown>)[name] !== undefined);
    if (used) continue;
    for (const key of ['extensionsUsed', 'extensionsRequired']) {
      const list = json[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => e !== name);
      if (kept.length > 0) json[key] = kept;
      else delete json[key];
    }
  }
  return writeGlb(json, newBin);
}

export function writeGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(text.length);
  const total = 12 + 8 + jsonLength + (bin.length > 0 ? 8 + bin.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  if (bin.length > 0) {
    const at = 20 + jsonLength;
    view.setUint32(at, bin.length, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}
