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
 */
import { createHash } from 'node:crypto';

import { parseFillLayer } from '@thirdlight/project-model/texture-slots';

import type { BlobFile, ImportKey, WorkspaceService } from '@thirdlight/workspace';

import type { DecalPageRequest, DecalPageResult } from './decal-page-assembly';
import type { HeightAlphaChecks } from './height-alpha';
import { readKtx2 } from './ktx2-container';
import { KTX2_ENCODER, type Ktx2Mode, type Ktx2PackResult, type PackLayer, type TextureEncoder } from './texture-encode';
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

export interface TextureSlotAssembler {
  /** `options.height`: a height array (a layer without a height in A gets one from its brightness). */
  assemble(projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode, options?: { readonly height?: boolean }): Promise<SlotArrayResult>;
  /** Arrays assembled and found cached since start (the diagnostics and tests read them). */
  readonly stats: { assembled: number; cached: number };
  /** A build's decal pages as texture arrays (`decal-page-assembly.ts`). */
  readonly decalPages?: (projectId: string, request: DecalPageRequest) => Promise<DecalPageResult>;
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

/**
 * A UASTC array's layers encoded side by side, one job per layer on the
 * encoder's threads, then joined without touching a texel (UASTC blocks are
 * encoded each on its own, so the array is the one a single encode makes;
 * the join runs on an encoder thread too, as a pack of whole KTX2 layers).
 * A layer that is a UASTC KTX2 as stored stays as it is. Null where that
 * does not apply — one thread or one layer, ETC1S (colour: its layers share
 * one codebook), a constant layer (no size of its own) — or the layers do
 * not join: the caller packs them in one job.
 */
async function packLayerByLayer(encoder: TextureEncoder, resolved: ResolvedLayers, layers: readonly PackLayer[], mode: Ktx2Mode): Promise<Ktx2PackResult | null> {
  if ((encoder.parallelism ?? 1) < 2 || layers.length < 2 || mode === 'color' || resolved.index.some((i) => i < 0)) return null;
  const one = await Promise.all(
    layers.map((l, at) => {
      const source = resolved.index[at]!;
      // The layer's own texture only, as source 0.
      const own = l.map((c) => ('source' in c ? { ...c, source: 0 } : c)) as unknown as PackLayer;
      return encoder.pack([resolved.sources[source]!], [own], mode, [resolved.lossless[source] ?? null], 'assembled');
    }),
  );
  const failed = one.find((r) => !r.ok);
  if (failed !== undefined) return failed;
  const done = one as Extract<Ktx2PackResult, { ok: true }>[];
  const whole = done.map((_, i) => [0, 1, 2, 3].map((channel) => ({ source: i, channel })) as unknown as PackLayer);
  const joined = await encoder.pack(done.map((r) => r.ktx2), whole, mode);
  if (!joined.ok || !joined.joined) return null;
  return { ...joined, reencoded: done.map((r) => r.reencoded[0] === true), joined: done.every((r) => r.joined) };
}

export function createTextureSlotAssembler(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined; now: () => number; heights?: HeightAlphaChecks }): TextureSlotAssembler {
  const stats = { assembled: 0, cached: 0 };
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

  const make = async (projectId: string, resolved: ResolvedLayers, mode: Ktx2Mode, key: ImportKey, t0: number, derived: readonly boolean[]): Promise<SlotArrayResult> => {
    const encoder = deps.encoder;
    if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server' };
    // Each layer is the whole RGBA of its texture, or its constant (the size is the textures').
    const packLayers: PackLayer[] = resolved.index.map((source, l) => {
      const fill = resolved.fills[l];
      if (fill !== null && fill !== undefined) return fill.map((value) => ({ value })) as unknown as PackLayer;
      return (derived[l] === true ? [{ source, channel: 0 }, { source, channel: 1 }, { source, channel: 2 }, { source, height: true }] : [0, 1, 2, 3].map((channel) => ({ source, channel }))) as unknown as PackLayer;
    });
    const packed = (await packLayerByLayer(encoder, resolved, packLayers, mode)) ?? (await encoder.pack(resolved.sources, packLayers, mode, resolved.lossless, 'assembled'));
    if (!packed.ok) return { ok: false, code: 'conversion_failed', message: packed.message };
    const stored = deps.service.writeImportedArtifact(projectId, key, packed.ktx2);
    if (!stored.ok) return { ok: false, code: stored.error.code, message: stored.error.message };
    const file = deps.service.locateImportedArtifact(projectId, key);
    if (file === null || file.digest !== stored.digest) return { ok: false, code: 'internal', message: 'the assembled array is not in the import cache after it was written' };
    stats.assembled += 1;
    return { ok: true, file, cached: false, joined: packed.joined, reencoded: packed.reencoded, ms: Math.round(deps.now() - t0), ...(derived.some(Boolean) ? { derivedHeight: [...derived] } : {}) };
  };

  return {
    stats,
    async assemble(projectId, layers, mode, options) {
      if (layers.length < 1) return { ok: false, code: 'field_value', message: 'an array needs at least one layer' };
      if (layers.every((l) => parseFillLayer(l.assetId) !== null)) return { ok: false, code: 'field_value', message: 'an array needs at least one texture layer (its size)' };
      const t0 = deps.now();
      // The originals and the layers without height are part of the key, so they are looked for before the cache.
      const resolved = resolve(projectId, layers);
      if ('ok' in resolved) return resolved;
      const derived = options?.height === true ? await flatLayers(projectId, layers, resolved) : layers.map(() => false);
      const heights = derived.some(Boolean) ? { derivedHeight: derived } : {};
      const key = slotArrayKey(layers, mode, resolved.originals, derived);
      const found = deps.service.locateImportedArtifact(projectId, key);
      if (found !== null) {
        stats.cached += 1;
        return { ok: true, file: found, cached: true, ms: 0, ...heights };
      }
      const id = `${projectId}\u0000${key.sourceDigest}`;
      const busy = running.get(id);
      if (busy !== undefined) return busy;
      const run = make(projectId, resolved, mode, key, t0, derived).finally(() => running.delete(id));
      running.set(id, run);
      return run;
    },
  };
}
