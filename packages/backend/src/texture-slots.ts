/**
 * Texture arrays assembled from per-layer texture slots (a graph material's
 * texture parameter naming one single-layer texture per layer).
 *
 * Play, the export and the editor's views draw a slot list as one KTX2
 * array made here: UASTC layers alike are joined as stored (milliseconds),
 * the rest transcoded (or their lossless PNG read) and encoded once
 * (seconds) — the pack route's `packKtx2`, each layer the whole RGBA of its
 * texture. The result goes to the project's import cache keyed by the
 * layers' digests, the digest of each lossless PNG read in a layer's place
 * (or none) and the encoding — everything the bytes are made from, so a PNG
 * appearing beside a KTX2 later makes the array again, and two hosts with
 * the same files make the same key. It is made once: the next Play, the
 * export, a backend restart and every material naming the same list find it
 * there; a trial changing one slot assembles only that array. Two requests
 * for the same array while it is made share the one assembly.
 */
import { createHash } from 'node:crypto';

import type { BlobFile, ImportKey, WorkspaceService } from '@thirdlight/workspace';

import type { DecalPageRequest, DecalPageResult } from './decal-page-assembly';
import { readKtx2 } from './ktx2-container';
import { KTX2_ENCODER, type Ktx2Mode, type PackLayer, type TextureEncoder } from './texture-encode';
import { losslessOriginal, textureVersionsOf } from './texture-originals';

/** One layer: a texture asset's version and its file's digest. */
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
    }
  | { ok: false; code: string; message: string };

export interface TextureSlotAssembler {
  assemble(projectId: string, layers: readonly SlotLayer[], mode: Ktx2Mode): Promise<SlotArrayResult>;
  /** Arrays assembled and found cached since start (the diagnostics and tests read them). */
  readonly stats: { assembled: number; cached: number };
  /** A build's decal pages as texture arrays (`decal-page-assembly.ts`). */
  readonly decalPages?: (projectId: string, request: DecalPageRequest) => Promise<DecalPageResult>;
}

/** The import cache's importer name and version for an assembled array (a change to the assembly changes the version). */
export const SLOT_ARRAY_IMPORTER = 'texture-slots';
export const SLOT_ARRAY_VERSION = '1';

/**
 * The cache key of one array: its layers' file digests in order, the digest
 * of the lossless original each layer's texture is read from instead
 * (`originals`, one per layer, null where none is), the encoding and the
 * encoder.
 */
export function slotArrayKey(layers: readonly SlotLayer[], mode: Ktx2Mode, originals: readonly (string | null)[]): ImportKey {
  const digests = layers.map((l) => l.sourceDigest);
  const settings = { mode, layers: digests, originals: layers.map((_, i) => originals[i] ?? 'none'), encoder: `${KTX2_ENCODER.name}@${KTX2_ENCODER.version}` };
  return { sourceDigest: createHash('sha256').update(JSON.stringify(settings)).digest('hex'), importer: SLOT_ARRAY_IMPORTER, importerVersion: SLOT_ARRAY_VERSION, settings };
}

/** The layers' distinct textures as read for an assembly: bytes, lossless originals, and each layer's index into them. */
interface ResolvedLayers {
  sources: Uint8Array[];
  lossless: (Uint8Array | null)[];
  /** Per layer: its texture's index in `sources`. */
  index: number[];
  /** Per layer: the digest of the original read in its place, null where none is. */
  originals: (string | null)[];
}

export function createTextureSlotAssembler(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined; now: () => number }): TextureSlotAssembler {
  const stats = { assembled: 0, cached: 0 };
  /** The assemblies running now, by project and key: a second request waits for the first. */
  const running = new Map<string, Promise<SlotArrayResult>>();

  /** Read each distinct texture once, verify it and find its lossless original. */
  const resolve = (projectId: string, layers: readonly SlotLayer[]): ResolvedLayers | { ok: false; code: string; message: string } => {
    const at = new Map<string, number>();
    const out: ResolvedLayers = { sources: [], lossless: [], index: [], originals: [] };
    const originalDigests: (string | null)[] = [];
    let versions: ReturnType<typeof textureVersionsOf> | null = null;
    for (const l of layers) {
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

  const make = async (projectId: string, resolved: ResolvedLayers, mode: Ktx2Mode, key: ImportKey, t0: number): Promise<SlotArrayResult> => {
    const encoder = deps.encoder;
    if (encoder === undefined) return { ok: false, code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server' };
    // Each layer is the whole RGBA of its texture.
    const packLayers: PackLayer[] = resolved.index.map((source) => [0, 1, 2, 3].map((channel) => ({ source, channel })) as unknown as PackLayer);
    const packed = await encoder.pack(resolved.sources, packLayers, mode, resolved.lossless);
    if (!packed.ok) return { ok: false, code: 'conversion_failed', message: packed.message };
    const stored = deps.service.writeImportedArtifact(projectId, key, packed.ktx2);
    if (!stored.ok) return { ok: false, code: stored.error.code, message: stored.error.message };
    const file = deps.service.locateImportedArtifact(projectId, key);
    if (file === null || file.digest !== stored.digest) return { ok: false, code: 'internal', message: 'the assembled array is not in the import cache after it was written' };
    stats.assembled += 1;
    return { ok: true, file, cached: false, joined: packed.joined, reencoded: packed.reencoded, ms: Math.round(deps.now() - t0) };
  };

  return {
    stats,
    assemble(projectId, layers, mode) {
      if (layers.length < 1) return Promise.resolve({ ok: false, code: 'field_value', message: 'an array needs at least one layer' });
      const t0 = deps.now();
      // The originals are part of the key, so they are looked for before the cache.
      const resolved = resolve(projectId, layers);
      if ('ok' in resolved) return Promise.resolve(resolved);
      const key = slotArrayKey(layers, mode, resolved.originals);
      const found = deps.service.locateImportedArtifact(projectId, key);
      if (found !== null) {
        stats.cached += 1;
        return Promise.resolve({ ok: true, file: found, cached: true, ms: 0 });
      }
      const id = `${projectId}\u0000${key.sourceDigest}`;
      const busy = running.get(id);
      if (busy !== undefined) return busy;
      const run = make(projectId, resolved, mode, key, t0).finally(() => running.delete(id));
      running.set(id, run);
      return run;
    },
  };
}
