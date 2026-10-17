/**
 * Texture arrays assembled from per-layer texture slots (a graph material's
 * texture parameter naming one single-layer texture per layer).
 *
 * Play, the export and the editor's views draw a slot list as one KTX2
 * array made here: UASTC layers alike are joined as stored (milliseconds),
 * the rest transcoded (or their lossless PNG read) and encoded once
 * (seconds; at the faster efforts a view waiting on it wants,
 * `ASSEMBLED_UASTC_LEVEL`, `ASSEMBLED_ETC1S_LEVEL`) — the pack route's
 * `packKtx2`, each layer the whole RGBA of its texture; a UASTC array's
 * layers are encoded side by side on the encoder's threads and joined
 * (`packLayerByLayer`). The result goes to the project's import cache keyed
 * by the layers' digests, the digest of each lossless PNG read in a layer's place
 * (or none) and the encoding — everything the bytes are made from, so a PNG
 * appearing beside a KTX2 later makes the array again, and two hosts with
 * the same files make the same key. It is made once: the next Play, the
 * export, a backend restart and every material naming the same list find it
 * there; a trial changing one slot assembles only that array. Two requests
 * for the same array while it is made share the one assembly.
 *
 * A height array (`TextureSlotSet.height`: a layered surface's albedo) gives
 * each layer whose texture has no height in A (`height-alpha.ts`) a height
 * from its brightness in A; which layers did is part of the key, so the
 * array is made again once a texture with a real height takes the slot, and
 * an array whose layers all carry height is the plain array, joined as stored.
 *
 * While an array is made (seconds for large textures), a view draws a
 * stand-in: first each layer's mean colour (`base`), then a small encode of
 * the array (`preview`, ahead of the other encodes); neither is ever stored
 * as the array.
 */
import { createHash } from 'node:crypto';

import { imageDimensions } from '@thirdlight/asset-pipeline';
import { parseFillLayer } from '@thirdlight/project-model/texture-slots';

import type { BlobFile, ImportKey, WorkspaceService } from '@thirdlight/workspace';

import type { DecalPageRequest, DecalPageResult } from './decal-page-assembly';
import type { HeightAlphaChecks } from './height-alpha';
import { sourceFormat } from './image-decode';
import { readKtx2 } from './ktx2-container';
import { KTX2_ENCODER, KTX2_SOURCE_PIXELS_MAX, wholeKtx2Layers, type Ktx2Mode, type Ktx2PackResult, type PackLayer, type TextureEncoder } from './texture-encode';
import { MEAN_UNKNOWN } from './texture-mean';
import { losslessOriginal, textureVersionsOf } from './texture-originals';

/** One layer: a texture asset's version and its file's digest; a constant layer (`fillLayerId`) is its id in all three. */
export interface SlotLayer {
  readonly assetId: string;
  readonly version: number;
  readonly sourceDigest: string;
}

export type SlotArrayResult =
  | {
      ok: true;
      file: BlobFile;
      /** Found in the cache (nothing assembled). */
      cached: boolean;
      /** Assembled now: the layers were joined as stored. */
      joined?: boolean;
      /** Assembled now: which layers were encoded again from a lossy KTX2. */
      reencoded?: boolean[];
      /** Assembly time (0 when cached). */
      ms: number;
      /** A height array: which layers' A is a height made from brightness (their textures have none). */
      derivedHeight?: boolean[];
    }
  | { ok: false; code: string; message: string };

/** A preview of an array (`TextureSlotAssembler.preview`): its bytes, or that the array itself is made already. */
export type SlotPreviewResult = { ok: true; final: true } | { ok: true; final: false; ktx2: Uint8Array; ms: number } | { ok: false; code: string; message: string };

/** Each layer's mean colour (RGBA 0–255; `TextureSlotAssembler.base`), and whether the array itself is made already. */
export type SlotBaseResult = { ok: true; base: [number, number, number, number][]; final: boolean } | { ok: false; code: string; message: string };

export interface TextureSlotAssembler {
  /** `options.height`: a height array (a layer without a height in A gets one from its brightness). */
  assemble(projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode, options?: { readonly height?: boolean }): Promise<SlotArrayResult>;
  /**
   * The array at a preview size (`SLOT_PREVIEW_SIDE`, the fastest efforts),
   * ahead of every encode not urgent: what a view draws for the seconds the
   * array takes. Never stored: the cache only ever holds the array itself.
   */
  preview?(projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode, options?: { readonly height?: boolean }): Promise<SlotPreviewResult>;
  /**
   * Each layer's mean colour (a constant layer's own; a colour array's sRGB
   * mean, another's plain one; a layer given a brightness height has A 128,
   * that height's middle): what a view draws before even a preview arrives.
   * One decode a texture, shared with the height check and kept.
   */
  base?(projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode, options?: { readonly height?: boolean }): Promise<SlotBaseResult>;
  /** Arrays assembled and found cached since start (the diagnostics and tests read them). */
  readonly stats: { assembled: number; cached: number };
  /** A build's decal pages as texture arrays (`decal-page-assembly.ts`). */
  readonly decalPages?: (projectId: string, request: DecalPageRequest, options?: { readonly preview?: boolean }) => Promise<DecalPageResult>;
}

/** The import cache's importer name and version for an assembled array (a change to the assembly changes the version). */
export const SLOT_ARRAY_IMPORTER = 'texture-slots';
export const SLOT_ARRAY_VERSION = '2';
/** The brightness height's version in a key (a change to `brightnessHeight` changes it). */
const DERIVED_HEIGHT_VERSION = 1;

/**
 * The cache key of one array: its layers' file digests in order, the digest
 * of the lossless original each layer's texture is read from instead
 * (`originals`, one per layer, null where none is), the encoding and the
 * encoder; and the layers whose A is a brightness height (`derived`, only
 * when any is: an array without one keeps its plain key).
 */
export function slotArrayKey(layers: readonly SlotLayer[], mode: Ktx2Mode, originals: readonly (string | null)[], derived: readonly boolean[] = []): ImportKey {
  const digests = layers.map((l) => l.sourceDigest);
  const heights = derived.some(Boolean) ? { derivedHeight: layers.map((_, i) => derived[i] === true), derivedHeightVersion: DERIVED_HEIGHT_VERSION } : {};
  const settings = { mode, layers: digests, originals: layers.map((_, i) => originals[i] ?? 'none'), encoder: `${KTX2_ENCODER.name}@${KTX2_ENCODER.version}`, ...heights };
  return { sourceDigest: createHash('sha256').update(JSON.stringify(settings)).digest('hex'), importer: SLOT_ARRAY_IMPORTER, importerVersion: SLOT_ARRAY_VERSION, settings };
}

/** The layers' distinct textures as read for an assembly: bytes, lossless originals, and each layer's index into them. */
interface ResolvedLayers {
  sources: Uint8Array[];
  lossless: (Uint8Array | null)[];
  /** Per layer: its texture's index in `sources` (-1: a constant layer). */
  index: number[];
  /** Per layer: a constant layer's RGBA bytes, null for a texture's. */
  fills: ([number, number, number, number] | null)[];
  /** Per layer: the digest of the original read in its place, null where none is. */
  originals: (string | null)[];
}

/** The layers' size: the first texture's, read from its header (null when unreadable: the encode reports it). */
function layerSize(resolved: ResolvedLayers): { width: number; height: number } | null {
  const bytes = resolved.lossless[0] ?? resolved.sources[0];
  const format = bytes === undefined ? null : sourceFormat(bytes);
  return format === null ? null : imageDimensions(bytes!, `image/${format}`);
}

/** Whether an array is more than one encode job takes (`KTX2_SOURCE_PIXELS_MAX` across its layers). */
export function overEncodeLimit(width: number, height: number, layers: number): boolean {
  return width * height * layers > KTX2_SOURCE_PIXELS_MAX;
}

/**
 * A UASTC array's layers encoded side by side, one job per layer on the
 * encoder's threads, then joined without touching a texel (UASTC blocks are
 * encoded each on its own, so the array is the one a single encode makes;
 * the join runs on an encoder thread too, as a pack of whole KTX2 layers).
 * A layer that is a UASTC KTX2 as stored stays as it is; a constant layer is
 * encoded at the textures' size. An array past the encoder's source limit
 * (four 2048² layers) is always made this way, a colour one too, in UASTC:
 * ETC1S layers share one codebook, so they cannot be encoded apart, and the
 * limit bounds one job's memory, so it is not raised. Null where it does not
 * apply — an ETC1S colour array within the limit, one layer, or one thread
 * and within the limit (one job is as fast) — or the layers do not join and
 * fit one job: the caller packs them in one.
 */
async function packLayerByLayer(encoder: TextureEncoder, resolved: ResolvedLayers, layers: readonly PackLayer[], mode: Ktx2Mode): Promise<Ktx2PackResult | null> {
  if (layers.length < 2) return null;
  const size = layerSize(resolved);
  const over = size !== null && overEncodeLimit(size.width, size.height, layers.length);
  if (!over && (mode === 'color' || (encoder.parallelism ?? 1) < 2)) return null;
  const sizeSource = resolved.index.find((i) => i >= 0)!;
  const one = await Promise.all(
    layers.map((l, at) => {
      // The layer's own texture only, as source 0 (a constant layer: the size's texture, read for its size).
      const source = resolved.index[at]! >= 0 ? resolved.index[at]! : sizeSource;
      const own = l.map((c) => ('source' in c ? { ...c, source: 0 } : c)) as unknown as PackLayer;
      return encoder.pack([resolved.sources[source]!], [own], mode, [resolved.lossless[source] ?? null], 'assembled', over);
    }),
  );
  const failed = one.find((r) => !r.ok);
  if (failed !== undefined) return failed;
  const done = one as Extract<Ktx2PackResult, { ok: true }>[];
  const whole = done.map((_, i) => [0, 1, 2, 3].map((channel) => ({ source: i, channel })) as unknown as PackLayer);
  const joined = await encoder.pack(done.map((r) => r.ktx2), whole, mode);
  if (!joined.ok || !joined.joined) {
    if (!over) return null;
    return { ok: false, code: 'texture_encode_failed', message: `the ${layers.length} layers, encoded one at a time, could not be joined into one array${joined.ok ? '' : `: ${joined.message}`}` };
  }
  return { ...joined, reencoded: done.map((r, at) => resolved.index[at]! >= 0 && r.reencoded[0] === true), joined: done.every((r) => r.joined) };
}

/** Each layer as packed: the whole RGBA of its texture (A a brightness height where `derived`), or its constant (the size is the textures'). */
function packLayersOf(resolved: ResolvedLayers, derived: readonly boolean[]): PackLayer[] {
  return resolved.index.map((source, l) => {
    const fill = resolved.fills[l];
    if (fill !== null && fill !== undefined) return fill.map((value) => ({ value })) as unknown as PackLayer;
    return (derived[l] === true ? [{ source, channel: 0 }, { source, channel: 1 }, { source, channel: 2 }, { source, height: true }] : [0, 1, 2, 3].map((channel) => ({ source, channel }))) as unknown as PackLayer;
  });
}

/** A brightness height's middle (`brightnessHeight` stretches every texture over 0–255). */
const DERIVED_HEIGHT_MIDDLE = 128;

/** A refused array in plain words, for the project's Problems: why first (the line is cut to its length), then which layers. */
export function slotArrayRefusalLine(layers: readonly SlotLayer[], mode: Ktx2Mode, reason: string): string {
  const names = layers.map((l) => (parseFillLayer(l.assetId) !== null ? 'a constant' : `"${l.assetId}"`));
  const kind = mode === 'color' ? 'colour' : mode;
  return `A ${kind} texture array could not be made, so the surface draws a stand-in: ${reason.replace(/\.?$/, '.')} Its layers: ${names.join(', ')}`;
}

export function createTextureSlotAssembler(deps: {
  service: WorkspaceService;
  encoder: TextureEncoder | undefined;
  now: () => number;
  heights?: HeightAlphaChecks;
  /** An array that could not be made (once per array and reason): the project's Problems get it in plain words, not only a route's 400. */
  refused?: (projectId: string, code: string, message: string) => void;
}): TextureSlotAssembler {
  const stats = { assembled: 0, cached: 0 };
  /** The refusals told, by project, array key and reason (an editor asks again on every view load); forgotten once the array is made. */
  const told = new Set<string>();
  /** The assemblies running now, by project and key: a second request waits for the first. */
  const running = new Map<string, Promise<SlotArrayResult>>();

  /** Per layer: whether its texture has no height in A (a height array; constant layers never). */
  const flatLayers = async (projectId: string, layers: readonly SlotLayer[], resolved: ResolvedLayers): Promise<boolean[]> => {
    const checks = deps.heights;
    if (checks === undefined) return layers.map(() => false);
    const flat = await Promise.all(
      resolved.sources.map(async (bytes, i) => {
        const l = layers[resolved.index.indexOf(i)]!;
        return (await checks.ofFile(projectId, l.sourceDigest, bytes, resolved.lossless[i] ?? null)) === 'flat';
      }),
    );
    return resolved.index.map((i) => i >= 0 && flat[i] === true);
  };

  /** Read each distinct texture once, verify it and find its lossless original. */
  const resolve = (projectId: string, layers: readonly SlotLayer[]): ResolvedLayers | { ok: false; code: string; message: string } => {
    const at = new Map<string, number>();
    const out: ResolvedLayers = { sources: [], lossless: [], index: [], fills: [], originals: [] };
    const originalDigests: (string | null)[] = [];
    let versions: ReturnType<typeof textureVersionsOf> | null = null;
    for (const l of layers) {
      const fill = parseFillLayer(l.assetId);
      out.fills.push(fill);
      if (fill !== null) {
        out.index.push(-1);
        out.originals.push(null);
        continue;
      }
      let i = at.get(l.assetId);
      if (i === undefined) {
        const read = deps.service.readBlob(projectId, { assetId: l.assetId, version: l.version });
        if (!read.ok) return { ok: false, code: read.error.code, message: `texture slot "${l.assetId}": ${read.error.message}` };
        if (read.digest !== l.sourceDigest) return { ok: false, code: 'asset_digest_mismatch', message: `texture slot "${l.assetId}" changed while the array was assembled` };
        const head = readKtx2(read.bytes);
        if (head !== null && head.layerCount >= 2) return { ok: false, code: 'field_value', message: `texture slot "${l.assetId}" is a texture array: a slot holds one layer` };
        // A KTX2's lossless PNG, read in its place should the layers need encoding.
        let original: { bytes: Uint8Array; digest: string } | null = null;
        if (head !== null) {
          versions ??= textureVersionsOf(deps.service, projectId);
          const v = versions.get(l.assetId);
          if (v !== undefined && v.version === l.version) original = losslessOriginal(deps.service, projectId, v, read.bytes, head.width, head.height);
        }
        i = out.sources.length;
        at.set(l.assetId, i);
        out.sources.push(read.bytes);
        out.lossless.push(original?.bytes ?? null);
        originalDigests.push(original?.digest ?? null);
      }
      out.index.push(i);
      out.originals.push(originalDigests[i]!);
    }
    return out;
  };

  const make = async (projectId: string, layers: readonly SlotLayer[], resolved: ResolvedLayers, mode: Ktx2Mode, key: ImportKey, t0: number, derived: readonly boolean[]): Promise<SlotArrayResult> => {
    const encoder = deps.encoder;
    if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server' };
    const packLayers = packLayersOf(resolved, derived);
    const packed = (await packLayerByLayer(encoder, resolved, packLayers, mode)) ?? (await encoder.pack(resolved.sources, packLayers, mode, resolved.lossless, 'assembled'));
    if (!packed.ok) {
      const once = `${projectId}\u0000${key.sourceDigest}\u0000${packed.message}`;
      if (deps.refused !== undefined && !told.has(once)) {
        told.add(once);
        deps.refused(projectId, 'texture_array_refused', slotArrayRefusalLine(layers, mode, packed.message));
      }
      return { ok: false, code: 'conversion_failed', message: packed.message };
    }
    const made = `${projectId}\u0000${key.sourceDigest}\u0000`;
    for (const t of told) if (t.startsWith(made)) told.delete(t);
    const stored = deps.service.writeImportedArtifact(projectId, key, packed.ktx2);
    if (!stored.ok) return { ok: false, code: stored.error.code, message: stored.error.message };
    const file = deps.service.locateImportedArtifact(projectId, key);
    if (file === null || file.digest !== stored.digest) return { ok: false, code: 'internal', message: 'the assembled array is not in the import cache after it was written' };
    stats.assembled += 1;
    return { ok: true, file, cached: false, joined: packed.joined, reencoded: packed.reencoded, ms: Math.round(deps.now() - t0), ...(derived.some(Boolean) ? { derivedHeight: [...derived] } : {}) };
  };

  /** What every request reads first: the layers' files, which have no height, and the array's cache key. */
  const prepare = async (projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode, options: { readonly height?: boolean } | undefined): Promise<{ resolved: ResolvedLayers; derived: boolean[]; key: ImportKey; found: BlobFile | null } | { ok: false; code: string; message: string }> => {
    if (layers.length < 1) return { ok: false, code: 'field_value', message: 'an array needs at least one layer' };
    if (layers.every((l) => parseFillLayer(l.assetId) !== null)) return { ok: false, code: 'field_value', message: 'an array needs at least one texture layer (its size)' };
    // The originals and the layers without height are part of the key, so they are looked for before the cache.
    const resolved = resolve(projectId, layers);
    if ('ok' in resolved) return resolved;
    const derived = options?.height === true ? await flatLayers(projectId, layers, resolved) : layers.map(() => false);
    const key = slotArrayKey(layers, mode, resolved.originals, derived);
    return { resolved, derived, key, found: deps.service.locateImportedArtifact(projectId, key) };
  };
  /** The previews being made, by project and array key (two views asking share one). */
  const previews = new Map<string, Promise<SlotPreviewResult>>();

  return {
    stats,
    async assemble(projectId, layers, mode, options) {
      const t0 = deps.now();
      const p = await prepare(projectId, layers, mode, options);
      if ('ok' in p) return p;
      const { resolved, derived, key, found } = p;
      const heights = derived.some(Boolean) ? { derivedHeight: derived } : {};
      if (found !== null) {
        stats.cached += 1;
        return { ok: true, file: found, cached: true, ms: 0, ...heights };
      }
      const id = `${projectId}\u0000${key.sourceDigest}`;
      const busy = running.get(id);
      if (busy !== undefined) return busy;
      const run = make(projectId, layers, resolved, mode, key, t0, derived).finally(() => running.delete(id));
      running.set(id, run);
      return run;
    },
    async preview(projectId, layers, mode, options) {
      const t0 = deps.now();
      const p = await prepare(projectId, layers, mode, options);
      if ('ok' in p) return p;
      // Made already, or layers joined as stored (no encode to wait for): the array itself, not a preview of it.
      if (p.found !== null || wholeKtx2Layers(p.resolved.sources, packLayersOf(p.resolved, p.derived)) !== null) return { ok: true, final: true };
      const encoder = deps.encoder;
      if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server' };
      const id = `${projectId}\u0000${p.key.sourceDigest}`;
      const busy = previews.get(id);
      if (busy !== undefined) return busy;
      const run = (async (): Promise<SlotPreviewResult> => {
        const packed = await encoder.pack(p.resolved.sources, packLayersOf(p.resolved, p.derived), mode, p.resolved.lossless, 'preview');
        if (!packed.ok) return { ok: false, code: 'conversion_failed', message: packed.message };
        return { ok: true, final: false, ktx2: packed.ktx2, ms: Math.round(deps.now() - t0) };
      })().finally(() => previews.delete(id));
      previews.set(id, run);
      return run;
    },
    async base(projectId, layers, mode, options) {
      const p = await prepare(projectId, layers, mode, options);
      if ('ok' in p) return p;
      const checks = deps.heights;
      const { resolved, derived } = p;
      const means = await Promise.all(resolved.sources.map((bytes, i) => (checks === undefined ? Promise.resolve(null) : checks.meanOfFile(projectId, layers[resolved.index.indexOf(i)]!.sourceDigest, bytes, resolved.lossless[i] ?? null))));
      const base = resolved.index.map((i, l): [number, number, number, number] => {
        const fill = resolved.fills[l];
        if (fill !== null && fill !== undefined) return [...fill];
        const m = means[i];
        const rgba = m === null || m === undefined ? MEAN_UNKNOWN : mode === 'color' ? m.srgb : m.plain;
        return [rgba[0], rgba[1], rgba[2], derived[l] === true ? DERIVED_HEIGHT_MIDDLE : rgba[3]];
      });
      return { ok: true, base, final: p.found !== null };
    },
  };
}
