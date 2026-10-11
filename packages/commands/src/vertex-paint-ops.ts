/**
 * `paintVertices`: one vertex paint stroke, one command and one undo.
 *
 * The stroke paints a model object's meshes, one copy of an instance set
 * (`copy`), or one side of a path of generated architecture or a spline
 * (`path`, `side`). The host reads what the stroke paints over (the model's
 * file, the set's buffer and paint, the stored blobs), the pure planner here
 * turns the dabs into bytes with the shared brush, and the host publishes
 * the new blobs (content-addressed: the old ones stay, so undo points back
 * to them) and hands the result to the command as a `PreparedVertexPaint`,
 * stored as a `setComponent` change. The editor's brush and MCP send the
 * same op; the backend that owns the project decides the bytes.
 *
 * A mesh whose model was reimported with other vertices keeps its old paint
 * (reported as `paint_mismatch`); a stroke over it is refused until that
 * paint is removed, so stale bytes are never mixed with new ones.
 */
import {
  INSTANCE_FLOATS,
  PAINT_COPY_ENTRY_BYTES,
  VERTEX_PAINT_BYTES,
  compose,
  copySlot,
  decodeCopyTable,
  encodeCopyTable,
  multiply,
  paintIsEmpty,
  paintPathDabs,
  pathPaintFrame,
  pathPaintPoint,
  paintVertexDabs,
  transformPoints,
  vertexPaintStrokeError,
  worldMatrix,
  type CopyTable,
  type HierarchyNode,
  type InstancePaint,
  type PaintVec3,
  type PaintableMesh,
  type PathGrid,
  type PathPaintGrid,
  type VertexPaintComponent,
  type VertexPaintMesh,
  type VertexPaintStroke,
} from '@thirdlight/project-model';

import { applySetComponent, type OpInput } from './content-ops';
import { componentMissing, entityNotFound, fieldValue, noChangeContent, type CommandError } from './errors';
import type { OpOutcome } from './ops';
import type { ContentDocument, SceneDocument } from './types';
import { assetsOf } from './v3';

/** `paintVertices` args: the object and one stroke. */
export interface PaintVerticesArgs extends VertexPaintStroke {
  entityId: string;
}

/** The host's result: the component value the stroke leaves (null: none left). */
export interface PreparedVertexPaint {
  entityId: string;
  component: 'vertexPaint' | 'instances';
  value: Record<string, unknown> | null;
}

/** A new blob the stroke made (published by the host once the command passed). */
export interface VertexPaintBlob {
  digest: string;
  bytes: Uint8Array;
}

/** What the planner reads through the host. */
export interface VertexPaintReads {
  /** A stored blob's bytes by digest. */
  blob(digest: string): { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError };
  /** The meshes of a model asset's version (`paintableMeshes`). */
  model(assetId: string, version: number): { ok: true; meshes: readonly PaintableMesh[] } | { ok: false; error: CommandError };
  /** SHA-256, lowercase hex. */
  hash(bytes: Uint8Array): string;
}

export function validatePaintVerticesArgs(args: Record<string, unknown>): { ok: true; args: PaintVerticesArgs } | { ok: false; error: CommandError } {
  if (typeof args['entityId'] !== 'string') return { ok: false, error: fieldValue('/args/entityId', args['entityId'], 'an entity id', 'entityId names the object painted (a model, an instance set, generated architecture or a spline)') };
  const bad = vertexPaintStrokeError(args, ['entityId']);
  if (bad !== null) return { ok: false, error: fieldValue(`/args${bad.path}`, undefined, 'a stroke (see the paintVertices op)', bad.message) };
  return { ok: true, args: args as unknown as PaintVerticesArgs };
}

type SceneEntity = { id: string; parentId?: string; components: Record<string, unknown> };
type Planned = { ok: true; prepared: PreparedVertexPaint; blobs: VertexPaintBlob[]; changed: number } | { ok: false; error: CommandError };

const refuse = (path: string, found: unknown, message: string): { ok: false; error: CommandError } => ({ ok: false, error: fieldValue(path, found, 'a stroke the object can take', message) });

/** The latest version of a model asset (0: none imported). */
function latestVersion(content: ContentDocument | undefined, assetId: string): number {
  const record = content === undefined ? undefined : assetsOf(content).find((a) => a.assetId === assetId);
  return record?.versions.reduce((m, v) => Math.max(m, v.version), 0) ?? 0;
}

/** The model's meshes the stroke may reach (its piece's, the one named). */
function meshesFor(content: ContentDocument | undefined, asset: { assetId?: unknown; piece?: unknown } | undefined, args: PaintVerticesArgs, reads: VertexPaintReads): { ok: true; meshes: readonly PaintableMesh[] } | { ok: false; error: CommandError } {
  const assetId = asset?.assetId;
  if (typeof assetId !== 'string') return refuse('/args/entityId', args.entityId, 'the object shows no model');
  const version = latestVersion(content, assetId);
  if (version < 1) return refuse('/args/entityId', assetId, `the model ${assetId} has no imported version to paint`);
  const read = reads.model(assetId, version);
  if (!read.ok) return read;
  const piece = typeof asset?.piece === 'string' ? asset.piece : null;
  const meshes = read.meshes.filter((m) => (piece === null || m.piece === piece) && (args.mesh === undefined || m.mesh === args.mesh));
  if (meshes.length === 0) return refuse(args.mesh !== undefined ? '/args/mesh' : '/args/entityId', args.mesh ?? assetId, args.mesh !== undefined ? `the model has no mesh "${args.mesh}"` : 'the model has no mesh to paint');
  return { ok: true, meshes };
}

/** Refuse painting over a mesh whose paint was made for other vertices (a reimport changed them). */
function staleError(r: VertexPaintMesh, m: PaintableMesh): { ok: false; error: CommandError } | null {
  if (r.vertices === m.vertices && r.positions === m.positions) return null;
  // A code of its own: the editor offers to remove that paint by it (and the mesh, `found`).
  const refused = refuse('/args/entityId', r.mesh, `mesh ${r.mesh}'s paint was made for other vertices (the model was reimported); remove that paint first (setComponent vertexPaint without it), or undo the reimport`);
  return { ok: false, error: { ...refused.error, code: 'vertex_paint_stale' } };
}

const blobOf = (bytes: Uint8Array, reads: VertexPaintReads, out: VertexPaintBlob[]): string => {
  const digest = reads.hash(bytes);
  out.push({ digest, bytes });
  return digest;
};

/**
 * The stroke's result (the host's half; pure apart from `reads`): the
 * object's new component value and the blobs it names that are new. An
 * error is a refusal; `no_change` when the dabs reach nothing.
 */
export function planVertexPaint(scene: SceneDocument, content: ContentDocument | undefined, args: PaintVerticesArgs, reads: VertexPaintReads): Planned {
  const entities = scene.entities as unknown as SceneEntity[];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const entity = byId.get(args.entityId);
  if (entity === undefined) return { ok: false, error: entityNotFound(args.entityId) };
  const toWorld = worldMatrix(byId as unknown as ReadonlyMap<string, HierarchyNode>, args.entityId);
  const c = entity.components;
  if (args.path !== undefined) return planPathPaint(entity, args, reads);
  if (c['instances'] !== undefined) return planCopyPaint(entity, content, toWorld, args, reads);
  if (c['model'] !== undefined) {
    if (args.copy !== undefined) return refuse('/args/copy', args.copy, 'copy paints an instance set; this object is a model');
    return planModelPaint(entity, content, toWorld, args, reads);
  }
  if (c['architecture'] !== undefined || c['spline'] !== undefined) return refuse('/args/path', undefined, 'generated architecture and splines are painted along a path: name path and side');
  return { ok: false, error: componentMissing(args.entityId, 'model') };
}

function planModelPaint(entity: SceneEntity, content: ContentDocument | undefined, toWorld: number[], args: PaintVerticesArgs, reads: VertexPaintReads): Planned {
  const model = entity.components['model'] as { asset?: { assetId?: unknown }; piece?: unknown };
  const found = meshesFor(content, { assetId: model.asset?.assetId, piece: model.piece }, args, reads);
  if (!found.ok) return found;
  const current = entity.components['vertexPaint'] as VertexPaintComponent | undefined;
  const records = new Map((current?.meshes ?? []).map((r) => [r.mesh, r]));
  const blobs: VertexPaintBlob[] = [];
  let changed = 0;
  for (const m of found.meshes) {
    const record = records.get(m.mesh);
    let values: Uint8Array;
    if (record !== undefined) {
      const stale = staleError(record, m);
      // A stale mesh is only refused when the stroke would reach it.
      const probe = stale === null ? null : new Uint8Array(m.vertices * VERTEX_PAINT_BYTES).fill(args.brush.erase === true ? 255 : 0);
      if (probe !== null && paintVertexDabs(transformPoints(m.points, toWorld), probe, args.dabs, args.brush) > 0) return stale!;
      if (stale !== null) continue;
      const read = reads.blob(record.paint);
      if (!read.ok) return read;
      if (read.bytes.byteLength !== m.vertices * VERTEX_PAINT_BYTES) return refuse('/args/entityId', record.paint, `mesh ${m.mesh}'s paint holds ${read.bytes.byteLength} bytes, not ${m.vertices * VERTEX_PAINT_BYTES}`);
      values = read.bytes.slice();
    } else values = new Uint8Array(m.vertices * VERTEX_PAINT_BYTES);
    const n = paintVertexDabs(transformPoints(m.points, toWorld), values, args.dabs, args.brush);
    if (n === 0) continue;
    changed += n;
    if (paintIsEmpty(values)) records.delete(m.mesh);
    else records.set(m.mesh, { mesh: m.mesh, vertices: m.vertices, positions: m.positions, paint: blobOf(values, reads, blobs) });
  }
  if (changed === 0) return { ok: false, error: { ...noChangeContent(), message: 'the stroke reaches no vertex of the model (or changes none of them)' } };
  const meshes = [...records.values()];
  const value: Record<string, unknown> | null = meshes.length === 0 && current?.paths === undefined ? null : { meshes: meshes.length > 0 ? meshes : null };
  return { ok: true, prepared: { entityId: args.entityId, component: 'vertexPaint', value }, blobs, changed };
}

/** A copy's matrix in its set (position, rotation, scale from its 10 floats). */
function copyMatrix(floats: Float32Array, copy: number): number[] {
  const o = copy * INSTANCE_FLOATS;
  const f = (k: number): number => floats[o + k]!;
  return compose({ position: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5), f(6)], scale: [f(7), f(8), f(9)] });
}

function planCopyPaint(entity: SceneEntity, content: ContentDocument | undefined, toWorld: number[], args: PaintVerticesArgs, reads: VertexPaintReads): Planned {
  const inst = entity.components['instances'] as { asset?: { assetId?: unknown; piece?: unknown }; buffer: string; count: number; paint?: InstancePaint };
  if (args.copy === undefined) return refuse('/args/copy', undefined, 'an instance set is painted one copy at a time: name the copy (its place in the set\'s buffer)');
  if (args.copy >= inst.count) return refuse('/args/copy', args.copy, `the set holds ${inst.count} copies (addresses 0-${inst.count - 1})`);
  const buffer = reads.blob(inst.buffer);
  if (!buffer.ok) return buffer;
  const floats = new Float32Array(INSTANCE_FLOATS * inst.count);
  new Uint8Array(floats.buffer).set(buffer.bytes.subarray(0, floats.byteLength));
  const found = meshesFor(content, inst.asset, args, reads);
  if (!found.ok) return found;
  const m4 = multiply(toWorld, copyMatrix(floats, args.copy));

  // The set's table and pools as they are.
  const old = inst.paint;
  let table: CopyTable = { copies: new Uint32Array(0), slots: new Uint32Array(0) };
  if (old !== undefined) {
    const t = reads.blob(old.copies);
    if (!t.ok) return t;
    const decoded = t.bytes.byteLength === old.painted * PAINT_COPY_ENTRY_BYTES ? decodeCopyTable(t.bytes) : null;
    if (decoded === null) return refuse('/args/entityId', old.copies, 'the set\'s copy table does not read back');
    table = decoded;
  }
  let slots = old?.slots ?? 0;
  const pools = new Map<string, { record: VertexPaintMesh | null; vertices: number; positions: string; bytes: Uint8Array }>();
  for (const r of old?.meshes ?? []) {
    const read = reads.blob(r.paint);
    if (!read.ok) return read;
    pools.set(r.mesh, { record: r, vertices: r.vertices, positions: r.positions, bytes: read.bytes });
  }
  const slot = copySlot(table, args.copy);
  const run = (vertices: number): number => vertices * VERTEX_PAINT_BYTES;

  // Paint the copy's run of each mesh (a copy not painted yet starts from zero).
  const runs = new Map<string, Uint8Array>();
  let changed = 0;
  for (const m of found.meshes) {
    const pool = pools.get(m.mesh);
    if (pool?.record !== undefined && pool.record !== null) {
      const stale = staleError(pool.record, m);
      const probe = stale === null ? null : new Uint8Array(run(m.vertices)).fill(args.brush.erase === true ? 255 : 0);
      if (probe !== null && paintVertexDabs(transformPoints(m.points, m4), probe, args.dabs, args.brush) > 0) return stale!;
      if (stale !== null) continue;
    }
    const values = slot >= 0 && pool !== undefined ? pool.bytes.slice(slot * run(m.vertices), (slot + 1) * run(m.vertices)) : new Uint8Array(run(m.vertices));
    const n = paintVertexDabs(transformPoints(m.points, m4), values, args.dabs, args.brush);
    if (n === 0) continue;
    changed += n;
    runs.set(m.mesh, values);
    if (pool === undefined) pools.set(m.mesh, { record: null, vertices: m.vertices, positions: m.positions, bytes: new Uint8Array(0) });
  }
  if (changed === 0) return { ok: false, error: { ...noChangeContent(), message: 'the stroke reaches no vertex of the copy (or changes none of them)' } };

  // The copy's slot: its own, else the lowest free one (cleared in every pool), else a new one at the end.
  let at = slot;
  if (at < 0) {
    const used = new Set(table.slots);
    at = 0;
    while (used.has(at)) at++;
    const copies = [...table.copies, args.copy];
    const order = copies.map((_, i) => i).sort((a, b) => copies[a]! - copies[b]!);
    const slotsList = [...table.slots, at];
    table = { copies: Uint32Array.from(order.map((i) => copies[i]!)), slots: Uint32Array.from(order.map((i) => slotsList[i]!)) };
  }
  const want = Math.max(slots, at + 1);
  for (const [key, pool] of pools) {
    let bytes = pool.bytes;
    if (bytes.byteLength < want * run(pool.vertices)) {
      const grownPool = new Uint8Array(want * run(pool.vertices));
      grownPool.set(bytes);
      bytes = grownPool;
    } else bytes = bytes.slice();
    const own = runs.get(key);
    if (own !== undefined) bytes.set(own, at * run(pool.vertices));
    else if (slot < 0) bytes.fill(0, at * run(pool.vertices), (at + 1) * run(pool.vertices));
    pools.set(key, { ...pool, bytes });
  }
  slots = want;

  // A copy whose paint is all gone leaves the table; trailing free slots leave the pools; empty pools are dropped.
  const copyEmpty = [...pools.values()].every((p) => paintIsEmpty(p.bytes.subarray(at * run(p.vertices), (at + 1) * run(p.vertices))));
  if (copyEmpty) {
    const keep = [...table.copies].map((c, i) => [c, table.slots[i]!] as const).filter(([c]) => c !== args.copy);
    table = { copies: Uint32Array.from(keep.map(([c]) => c)), slots: Uint32Array.from(keep.map(([, s]) => s)) };
  }
  const top = table.slots.reduce((m, s) => Math.max(m, s + 1), 0);
  slots = Math.min(slots, top);
  const blobs: VertexPaintBlob[] = [];
  if (table.copies.length === 0) return { ok: true, prepared: { entityId: args.entityId, component: 'instances', value: { paint: null } }, blobs, changed };
  const meshes: VertexPaintMesh[] = [];
  for (const [key, pool] of pools) {
    const bytes = pool.bytes.subarray(0, slots * run(pool.vertices));
    if (paintIsEmpty(bytes)) continue;
    const unchanged = pool.record !== null && pool.bytes.byteLength === bytes.byteLength && !runs.has(key) && slot >= 0 && slots === old?.slots;
    meshes.push({ mesh: key, vertices: pool.vertices, positions: pool.positions, paint: unchanged ? pool.record!.paint : blobOf(bytes.slice(), reads, blobs) });
  }
  const paint: InstancePaint = { copies: blobOf(encodeCopyTable(table), reads, blobs), painted: table.copies.length, slots, meshes };
  return { ok: true, prepared: { entityId: args.entityId, component: 'instances', value: { paint } }, blobs, changed };
}

function planPathPaint(entity: SceneEntity, args: PaintVerticesArgs, reads: VertexPaintReads): Planned {
  const c = entity.components;
  if (c['architecture'] === undefined && c['spline'] === undefined) return refuse('/args/path', args.path, 'path paints generated architecture or a spline; this object has neither');
  const frame = pathPaintFrame(c, args.path!);
  if (frame === null) return refuse('/args/path', args.path, `the object has no path "${args.path}"`);
  // Drawn at its own position alone (the page's frame), so a dab is offset by that, whatever its parent, rotation or scale.
  const origin = (c['transform'] as { position?: readonly number[] } | undefined)?.position;
  const dabs: PaintVec3[] = args.dabs.map((d) => pathPaintPoint(origin, d));
  const current = c['vertexPaint'] as VertexPaintComponent | undefined;
  const grids = [...(current?.paths ?? [])];
  const at = grids.findIndex((g) => g.path === args.path && g.side === args.side);
  let grid: PathGrid | null = null;
  if (at >= 0) {
    const g = grids[at]!;
    const read = reads.blob(g.paint);
    if (!read.ok) return read;
    if (read.bytes.byteLength !== g.size[0] * g.size[1] * VERTEX_PAINT_BYTES) return refuse('/args/path', g.paint, `the ${g.side} side of ${g.path}'s paint does not hold its grid`);
    grid = { origin: [g.origin[0], g.origin[1]], size: [g.size[0], g.size[1]], values: read.bytes.slice() };
  }
  const r = paintPathDabs(grid, frame, args.side!, dabs, args.brush);
  if (r.changed === 0 || r.grid === null) return { ok: false, error: { ...noChangeContent(), message: `the stroke reaches no point of the ${args.side} side of ${args.path} (or changes none)` } };
  const blobs: VertexPaintBlob[] = [];
  const next: PathPaintGrid | null = paintIsEmpty(r.grid.values) ? null : { path: args.path!, side: args.side!, origin: r.grid.origin, size: r.grid.size, paint: blobOf(r.grid.values, reads, blobs) };
  if (at >= 0) grids.splice(at, 1);
  if (next !== null) grids.push(next);
  const value: Record<string, unknown> | null = grids.length === 0 && current?.meshes === undefined ? null : { paths: grids.length > 0 ? grids : null };
  return { ok: true, prepared: { entityId: args.entityId, component: 'vertexPaint', value }, blobs, changed: r.changed };
}

/** Store the host's result (a `setComponent` change: one undo restores the paint before the stroke). */
export function applyPaintVertices(input: OpInput, args: PaintVerticesArgs, prepared: PreparedVertexPaint | undefined): OpOutcome {
  if (prepared === undefined || prepared.entityId !== args.entityId) {
    return { ok: false, error: fieldValue('/args', undefined, 'a stroke the host prepared', 'paintVertices runs through the project host, which reads the object\'s model and paint') };
  }
  return applySetComponent(input, { entityId: args.entityId, component: prepared.component, value: prepared.value });
}
