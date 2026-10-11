/**
 * The host's parts of vertex paint.
 *
 * `paintVertices`: the stroke is planned here against what it paints over
 * (the model's file, an instance set's buffer and paint, the stored blobs)
 * by the command package's pure planner; its new blobs are published only
 * once the command passed its checks (nothing collects an unused blob).
 *
 * An instance set's paint addresses copies by their place in the set's
 * buffer, so a change of the buffer (the instance brush's erase, a copy
 * deleted in the editor, MCP's `setComponent instances`) carries the paint
 * table along in the same change (`copyIndexMap`): each copy keeps its
 * paint wherever it now sits as long as it is the same copy, bit for bit;
 * copies taken out or changed lose theirs (a changed copy cannot be told
 * from another put in its place: a new scatter of the same count keeps no
 * paint). A change that carries `paint` itself (the editor moving one copy
 * in place) is taken as it says. Undo brings dropped paint back.
 *
 * A model's painted meshes are read from its version's file once and kept by
 * the file's digest (a brush sends many strokes over one model).
 */
import { readModelGeometry, paintableMeshes, INSTANCE_FLOATS, decodeCopyTable, encodeCopyTable, copyIndexMap, remapCopyTable, instancePaintBlobs, vertexPaintBlobs, PAINT_COPY_ENTRY_BYTES, type InstancePaint, type PaintableMesh, type VertexPaintComponent } from '@thirdlight/project-model';
import { planVertexPaint, validatePaintVerticesArgs, type CommandError, type ContentDocument, type PreparedVertexPaint, type SceneDocument, type VertexPaintBlob } from '@thirdlight/commands';

import { publishBlob, readBlob, readSourceBlob, verifyReferencedBlob } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';

/** Models' paintable meshes kept by file digest: a cache's bound (the models one brush session paints), not a project's. */
const MODELS_KEPT = 8;
const models = new Map<string, readonly PaintableMesh[]>();

function modelMeshes(core: Core, s: ProjectSession, assetId: string, version: number): { ok: true; meshes: readonly PaintableMesh[] } | { ok: false; error: CommandError } {
  const r = readBlob(core, contentCtx(s), { assetId, version });
  if (!r.ok) return { ok: false, error: r.error };
  const kept = models.get(r.digest);
  if (kept !== undefined) {
    models.delete(r.digest);
    models.set(r.digest, kept);
    return { ok: true, meshes: kept };
  }
  const g = readModelGeometry(r.bytes);
  if (!g.ok) return { ok: false, error: { code: 'field_value', cls: 'validation', path: '/args/entityId', message: `the model ${assetId} cannot be read: ${g.message}`.slice(0, 256) } as CommandError };
  const meshes = paintableMeshes(g.geometry, sha256Hex);
  if (models.size >= MODELS_KEPT) models.delete(models.keys().next().value!);
  models.set(r.digest, meshes);
  return { ok: true, meshes };
}

const readStored = (core: Core, s: ProjectSession) => (digest: string): { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError } => {
  const r = readSourceBlob(core, contentCtx(s), { digest });
  return r.ok ? { ok: true, bytes: r.bytes } : { ok: false, error: r.error };
};

/** A stroke planned: the command's prepared value and the blobs to publish once it passes. */
export function prepareVertexPaint(core: Core, s: ProjectSession, scene: SceneDocument, content: ContentDocument | undefined, args: Record<string, unknown>): { ok: true; prepared: PreparedVertexPaint; blobs: VertexPaintBlob[] } | { ok: false; error: CommandError } {
  const v = validatePaintVerticesArgs(args);
  if (!v.ok) return v;
  const plan = planVertexPaint(scene, content, v.args, { blob: readStored(core, s), model: (assetId, version) => modelMeshes(core, s, assetId, version), hash: sha256Hex });
  return plan.ok ? { ok: true, prepared: plan.prepared, blobs: plan.blobs } : plan;
}

/** Publish blobs a passed command names (a stroke's paint, a moved copy table). */
export function publishPaintBlobs(core: Core, s: ProjectSession, blobs: readonly VertexPaintBlob[]): CommandError | null {
  for (const b of blobs) {
    const put = publishBlob(core, contentCtx(s), { digest: b.digest, byteLength: b.bytes.byteLength, source: { kind: 'bytes', bytes: b.bytes } });
    if (!put.ok) return put.error;
  }
  return null;
}

/**
 * An instance set's paint after its buffer changes from `before` to the
 * buffer `after` names: undefined when it has none or keeps its table, null
 * when none is left, else the new paint (and its new table's blob).
 */
export function followCopyPaint(core: Core, s: ProjectSession, paint: InstancePaint | undefined, before: { buffer: string; count: number }, after: { buffer: string; count: number; bytes?: Uint8Array }): { ok: true; paint?: InstancePaint | null; blobs: VertexPaintBlob[] } | { ok: false; error: CommandError } {
  if (paint === undefined || before.buffer === after.buffer) return { ok: true, blobs: [] };
  const read = readStored(core, s);
  const floatsOf = (bytes: Uint8Array, count: number): Float32Array => {
    const f = new Float32Array(count * INSTANCE_FLOATS);
    new Uint8Array(f.buffer).set(bytes.subarray(0, Math.min(bytes.byteLength, f.byteLength)));
    return f;
  };
  const old = read(before.buffer);
  if (!old.ok) return old;
  let nextBytes = after.bytes;
  if (nextBytes === undefined) {
    const r = read(after.buffer);
    // A buffer that is not stored yet is refused by the commit's own check; the paint is left to it.
    if (!r.ok) return { ok: true, blobs: [] };
    nextBytes = r.bytes;
  }
  const map = copyIndexMap(floatsOf(old.bytes, before.count), floatsOf(nextBytes, after.count), INSTANCE_FLOATS);
  const t = read(paint.copies);
  if (!t.ok) return t;
  const table = t.bytes.byteLength === paint.painted * PAINT_COPY_ENTRY_BYTES ? decodeCopyTable(t.bytes) : null;
  if (table === null) return { ok: true, paint: null, blobs: [] };
  const moved = remapCopyTable(table, map);
  if (moved.copies.length === 0) return { ok: true, paint: null, blobs: [] };
  if (moved.copies.length === table.copies.length && moved.copies.every((c, i) => c === table.copies[i])) return { ok: true, blobs: [] };
  const bytes = encodeCopyTable(moved);
  const digest = sha256Hex(bytes);
  return { ok: true, paint: { ...paint, copies: digest, painted: moved.copies.length }, blobs: [{ digest, bytes }] };
}

type EntityLike = { id: string; components: { vertexPaint?: VertexPaintComponent; instances?: { paint?: InstancePaint } } & Record<string, unknown> };

/**
 * Every paint blob a change names that is new to the scene is stored with
 * its size (blobs in `inHand` are about to be published by this command).
 */
export function verifyPaintBlobs(s: ProjectSession, before: readonly EntityLike[], after: readonly EntityLike[], inHand: ReadonlySet<string>): CommandError | null {
  const was = new Map(before.map((e) => [e.id, e]));
  const known = new Set<string>();
  for (const e of after) {
    const b0 = was.get(e.id);
    // An object whose paint the change did not touch names only blobs checked when they were set.
    if (b0 !== undefined && b0.components.vertexPaint === e.components.vertexPaint && b0.components.instances?.paint === e.components.instances?.paint) continue;
    if (b0 !== undefined) for (const b of [...vertexPaintBlobs(b0.components.vertexPaint), ...instancePaintBlobs(b0.components.instances?.paint)]) known.add(`${b.digest}:${b.byteLength}`);
    for (const b of [...vertexPaintBlobs(e.components.vertexPaint), ...instancePaintBlobs(e.components.instances?.paint)]) {
      if (inHand.has(b.digest) || known.has(`${b.digest}:${b.byteLength}`)) continue;
      const v = verifyReferencedBlob(contentCtx(s), b.digest, b.byteLength);
      if (!v.ok) return v.error;
      known.add(`${b.digest}:${b.byteLength}`);
    }
  }
  return null;
}
