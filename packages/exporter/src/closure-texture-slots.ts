/**
 * Per-layer texture slots in a build (Play and the export alike).
 *
 * A graph material's texture parameter may name one single-layer texture
 * per array layer (project-model `texture-slots.ts`). The runtime samples
 * arrays only and the exported game runs without the backend, so the build
 * ships each distinct slot list the used materials draw with as one
 * assembled KTX2 array, and the materials as the runtime gets them name that
 * array instead of the list. The assembly is the backend's (injected:
 * `ClosureTextureSlots`), cached by the layers' digests, so a build after a
 * one-slot change assembles only the array that changed, and two materials
 * (an A/B instance and its parent) sharing a list share one array.
 *
 * An assembled array ships under an id of its own made from its file's
 * digest (`slots-…`): the same layers give the same file and the same id
 * build after build; the slots' own textures ship only when something else
 * names them.
 */
import type { WorkspaceService, BlobFile } from '@thirdlight/workspace';
import { materialTextureSlotSets, textureSlotSetKey, type Ktx2Encoding, type ManifestAssetInputV2, type TextureSlotSet } from '@thirdlight/project-model';

import type { ClosureArtifact, ClosureFileArtifact, ContentClosureError } from './content-closure';

/** One layer of a slot list: the texture version the captured content holds. */
export interface ClosureSlotLayer {
  readonly assetId: string;
  readonly version: number;
  readonly sourceDigest: string;
}

/** The backend's texture-array assembly from single-layer textures (cached by their digests). */
export interface ClosureTextureSlots {
  assemble(projectId: string, layers: readonly ClosureSlotLayer[], mode: Ktx2Encoding): Promise<{ ok: true; file: BlobFile } | { ok: false; code: string; message: string }>;
}

/** The id prefix of an assembled array (then its file digest's first 57 hex digits: 63 characters, within the id syntax). */
export const SLOT_ARRAY_ID_PREFIX = 'slots-';

/** What the build ships for the slot lists, and the id each list's array ships under (by `textureSlotSetKey`). */
export interface ClosureSlotArrays {
  readonly ids: ReadonlyMap<string, string>;
  readonly rows: readonly ManifestAssetInputV2[];
  readonly files: readonly ClosureFileArtifact[];
  readonly artifacts: readonly ClosureArtifact[];
}

interface AssetRecordLike {
  readonly assetId: string;
  readonly kind?: string;
  readonly currentVersion?: number;
  readonly versions?: readonly { readonly version: number; readonly sourceDigest: string }[];
}

const refused = (message: string, reason = 'texture_slots'): { ok: false; error: ContentClosureError } => ({ ok: false, error: { code: 'export_scene_invalid', cls: 'validation', reason, message: message.slice(0, 256) } });

/** Assemble (or find cached) the array of every distinct slot list of `materials` (resolved, the used ones). */
export async function closureSlotArrays(o: {
  readonly port: ClosureTextureSlots | undefined;
  readonly service: WorkspaceService;
  readonly projectId: string;
  readonly assets: readonly AssetRecordLike[];
  readonly materials: Parameters<typeof materialTextureSlotSets>[0];
  readonly locate: boolean;
  readonly hash: (bytes: Uint8Array) => string;
}): Promise<{ ok: true; arrays: ClosureSlotArrays } | { ok: false; error: ContentClosureError }> {
  const sets = materialTextureSlotSets(o.materials);
  const ids = new Map<string, string>();
  const rows: ManifestAssetInputV2[] = [];
  const files: ClosureFileArtifact[] = [];
  const artifacts: ClosureArtifact[] = [];
  if (sets.length === 0) return { ok: true, arrays: { ids, rows, files, artifacts } };
  if (o.port === undefined) return refused('a material names per-layer texture slots, and this build has no texture assembly');
  const byId = new Map(o.assets.map((a) => [a.assetId, a]));
  const shipped = new Set<string>();
  for (const set of sets) {
    const layers = slotLayers(set, byId);
    if (typeof layers === 'string') return refused(layers);
    const made = await o.port.assemble(o.projectId, layers, set.mode);
    if (!made.ok) return refused(`the ${set.mode} array of slots ${set.layers.join(', ')}: ${made.message}`, made.code);
    const f = made.file;
    const id = `${SLOT_ARRAY_ID_PREFIX}${f.digest.slice(0, 57)}`;
    if (byId.has(id)) return refused(`the assembled array's id ${id} is an asset of the project`);
    ids.set(textureSlotSetKey(set), id);
    if (shipped.has(id)) continue;
    shipped.add(id);
    const path = `content/sha256/${f.digest}`;
    if (o.locate) files.push({ path, digest: f.digest, byteLength: f.byteLength, contentType: 'image/x-texture', file: f });
    else {
      const bytes = await readWhole(o.service, o.projectId, f);
      if (typeof bytes === 'string') return { ok: false, error: { code: 'asset_digest_mismatch', cls: 'unavailable', reason: 'asset_digest_mismatch', message: bytes } };
      artifacts.push({ path, bytes, digest: f.digest, contentType: 'image/x-texture' });
    }
    // The metrics digest stands for what the array is made of (its layers' files and encoding).
    const metricsDigest = o.hash(new TextEncoder().encode(JSON.stringify({ slots: layers.map((l) => l.sourceDigest), mode: set.mode })));
    rows.push({ assetId: id, kind: 'texture', version: 1, sourceDigest: f.digest, sourceByteLength: f.byteLength, metricsDigest });
  }
  return { ok: true, arrays: { ids, rows, files, artifacts } };
}

/** Each layer's texture version in the captured content, or why there is none. */
function slotLayers(set: TextureSlotSet, byId: ReadonlyMap<string, AssetRecordLike>): ClosureSlotLayer[] | string {
  const out: ClosureSlotLayer[] = [];
  for (const assetId of set.layers) {
    const a = byId.get(assetId);
    if (a === undefined || a.kind !== 'texture') return `texture slot "${assetId}" names no texture asset of the project`;
    const v = a.versions?.find((x) => x.version === a.currentVersion);
    if (v === undefined) return `texture slot "${assetId}" has no current version`;
    out.push({ assetId, version: v.version, sourceDigest: v.sourceDigest });
  }
  return out;
}

/** A located file's bytes, checked against its digest while read (a message when it changed). */
async function readWhole(service: WorkspaceService, projectId: string, f: BlobFile): Promise<Uint8Array | string> {
  const opened = service.openBlobFile(projectId, f);
  if (!opened.ok) return `the assembled array ${f.digest.slice(0, 12)}… cannot be read: ${opened.error.message}`;
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of opened.blob.chunks()) {
      parts.push(c);
      n += c.length;
    }
  } catch (e) {
    return `the assembled array ${f.digest.slice(0, 12)}… changed while it was read (${e instanceof Error ? e.message : String(e)})`;
  } finally {
    opened.blob.close();
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of parts) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
