/**
 * Vertex paint: four bytes a vertex painted on placed models, instance
 * copies and generated meshes, stored beside the mesh and read by materials
 * (colour, grime, wetness, blend weights: what each channel means is the
 * material's). It is a stream of its own, never the model's `COLOR_0`; an
 * unpainted vertex reads (0, 0, 0, 0), which changes nothing.
 *
 * Three homes, one byte layout:
 * - a model object's `vertexPaint` component: per mesh (`mesh`: the node's
 *   path and primitive, `modelNodeSegments`) a content-addressed blob of
 *   4 bytes a vertex, tied to the mesh it was painted on by its vertex count
 *   and a hash of its positions. A reimport that changes a mesh leaves the
 *   blob as it was; the mismatch is reported and the paint is not drawn
 *   (`vertexPaintMismatches`), so paint never lands on the wrong vertices.
 * - an instance set's `paint`: a sparse table (copy address → paint slot)
 *   and a slot pool per mesh (the pool's slots one after another). A copy's
 *   address is its place in the set's buffer; when the buffer loses copies
 *   the table follows them (`copyIndexMap`), so painting thousands of
 *   copies costs only the ones painted.
 * - generated meshes (architecture outlines, buildings and sweeps, splines):
 *   `vertexPaint.paths`, a grid per path side in path space (metres along
 *   the path × height up a wall face, or across a top face) every
 *   {@link PATH_PAINT_CELL} m. The mesh is made again whenever its
 *   parameters change; its vertices read the grid wherever they come out
 *   (`vertex-paint-paths.ts`), so the paint stays where it was painted.
 *
 * No cap on painted objects: a blob's size is bounded by its mesh (its
 * vertex count, times the slots for a set) or its path (length × reach).
 *
 * Pure data rules: no three.js, no I/O.
 */
import type { ModelErrorV2 } from './errors';
import { MODEL_READ_LIMITS, type ModelGeometry } from './model-collision';
import { COMPONENT_TYPES as GLTF_COMPONENT_TYPES } from './model-rig';
import type { PaintLayout } from './paint-brush';
import { sha256Hex } from './sha256';
import { MAX_INSTANCES } from './types-v3';
import { ID_RE } from './validate';

/** Bytes one painted vertex (or one path grid point) holds: R, G, B, A. */
export const VERTEX_PAINT_BYTES = 4;
/** The brush's layout over a vertex's bytes: four channels standing alone (painting one leaves the others). */
export const VERTEX_PAINT_LAYOUT: PaintLayout = Object.freeze({ channels: VERTEX_PAINT_BYTES, weights: 0 });
/** Metres between path paint grid points (along the path and up or across it). */
export const PATH_PAINT_CELL = 0.25;
/** Hex characters of a mesh's position hash (64 bits: tells a changed mesh from the one painted). */
export const PAINT_POSITIONS_HASH_LENGTH = 16;
/** Bytes per entry of an instance set's copy table: the copy's address and its slot, each a u32. */
export const PAINT_COPY_ENTRY_BYTES = 8;

/** The sides of a path its paint is kept for: the faces to the left and right of travel, and the faces looking up or down. */
export const PATH_PAINT_SIDES = ['left', 'right', 'top'] as const;
export type PathPaintSide = (typeof PATH_PAINT_SIDES)[number];

/**
 * What one painted mesh and one path's paint grid may hold: a mesh's name, its vertices (as many as a model read
 * decodes, so any mesh the engine draws can be painted), and a path grid's points along and across its path. Bounds of
 * one record, not a cap on painted objects.
 */
export const VERTEX_PAINT_LIMITS = Object.freeze({
  /** Characters of a mesh's name (its node path and primitive). */
  meshKey: 512,
  /** Vertices of one painted mesh: what a model read decodes. */
  vertices: MODEL_READ_LIMITS.positions,
  /** Grid points either way along a path from its start (a path's coordinates are within 100 km). */
  along: 400_000,
  /** Grid points either way up or across a path (the generators' sizes are within 1 km). */
  across: 4_000,
});

/** One painted mesh: its name, what it was painted on, and its paint's blob. */
export interface VertexPaintMesh {
  /** The node's path from the model's scene root and the primitive (`Body/Hull#0`). */
  mesh: string;
  /** The mesh's vertex count when painted. */
  vertices: number;
  /** The first {@link PAINT_POSITIONS_HASH_LENGTH} hex of the SHA-256 of its positions as float32 (`paintPositionsHash`). */
  positions: string;
  /** SHA-256 of the paint: 4 bytes a vertex (an instance set's: the slots' runs one after another). */
  paint: string;
}

/** One side of one path's paint: a grid of points {@link PATH_PAINT_CELL} m apart. */
export interface PathPaintGrid {
  /** The path: `outline:<id>`, `building:<id>`, `element:<id>` (architecture) or `spline`. */
  path: string;
  side: PathPaintSide;
  /** The grid's first point, in cells: along the path, and up (left/right) or across (top). */
  origin: [number, number];
  /** Points along and up/across. */
  size: [number, number];
  /** SHA-256 of the grid: 4 bytes a point, rows (up/across) of points along. */
  paint: string;
}

/** `vertexPaint` on a model object (meshes) or a generated one (paths). */
export interface VertexPaintComponent {
  meshes?: VertexPaintMesh[];
  paths?: PathPaintGrid[];
}

/** An instance set's paint (`instances.paint`). */
export interface InstancePaint {
  /** SHA-256 of the copy table: `painted` entries (copy address, slot), u32 little-endian, in address order. */
  copies: string;
  painted: number;
  /** Slots in each mesh's pool (some may be free). */
  slots: number;
  /** Per mesh, its pool: `slots` runs of 4 bytes a vertex. */
  meshes: VertexPaintMesh[];
}

/** The component's fields in canonical order. */
export const VERTEX_PAINT_FIELDS: readonly string[] = Object.freeze(['meshes', 'paths']);
const MESH_FIELDS = ['mesh', 'vertices', 'positions', 'paint'];
const PATH_FIELDS = ['path', 'side', 'origin', 'size', 'paint'];
const INSTANCE_PAINT_FIELDS = ['copies', 'painted', 'slots', 'meshes'];

const DIGEST_RE = /^[0-9a-f]{64}$/;
const POSITIONS_RE = new RegExp(`^[0-9a-f]{${PAINT_POSITIONS_HASH_LENGTH}}$`);
/** A path key: an outline, building or sweep element of the architecture on the object, or the object's spline. */
const PATH_KEY_RE = /^(?:(?:outline|building|element):(.+)|spline)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Whether `key` names a path vertex paint can be kept for. */
export function isPathPaintKey(key: string): boolean {
  const m = PATH_KEY_RE.exec(key);
  return m !== null && (m[1] === undefined || ID_RE.test(m[1]));
}

function validateMeshes(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value) || value.length === 0) return err(errors, 'field_value', path, 'meshes is a non-empty list of {mesh, vertices, positions, paint}', value);
  const seen = new Set<string>();
  value.forEach((m, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(m)) return err(errors, 'field_type', p, 'a painted mesh is {mesh, vertices, positions, paint}', m);
    for (const k of Object.keys(m)) if (!MESH_FIELDS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown painted mesh field "${k}" (${MESH_FIELDS.join(', ')})`, k);
    const key = m['mesh'];
    if (typeof key !== 'string' || key.length === 0 || key.length > VERTEX_PAINT_LIMITS.meshKey || !/#\d+$/.test(key)) err(errors, 'field_value', `${p}/mesh`, `mesh is the node path and primitive ("Body/Hull#0"), up to ${VERTEX_PAINT_LIMITS.meshKey} characters`, key);
    else if (seen.has(key)) err(errors, 'field_value', `${p}/mesh`, `mesh "${key}" is painted twice`, key);
    else seen.add(key);
    if (!int(m['vertices'], 1, VERTEX_PAINT_LIMITS.vertices)) err(errors, 'field_value', `${p}/vertices`, `vertices is the mesh's vertex count, 1-${VERTEX_PAINT_LIMITS.vertices}`, m['vertices']);
    if (typeof m['positions'] !== 'string' || !POSITIONS_RE.test(m['positions'])) err(errors, 'field_value', `${p}/positions`, `positions is the mesh's position hash (${PAINT_POSITIONS_HASH_LENGTH} lowercase hex)`, m['positions']);
    if (typeof m['paint'] !== 'string' || !DIGEST_RE.test(m['paint'])) err(errors, 'field_value', `${p}/paint`, 'paint is the SHA-256 of the paint bytes (64 lowercase hex)', m['paint']);
  });
}

function validatePaths(value: unknown, path: string, errors: ModelErrorV2[]): void {
  const L = VERTEX_PAINT_LIMITS;
  if (!Array.isArray(value) || value.length === 0) return err(errors, 'field_value', path, 'paths is a non-empty list of {path, side, origin, size, paint}', value);
  const seen = new Set<string>();
  value.forEach((g, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(g)) return err(errors, 'field_type', p, 'a path paint grid is {path, side, origin, size, paint}', g);
    for (const k of Object.keys(g)) if (!PATH_FIELDS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown path paint field "${k}" (${PATH_FIELDS.join(', ')})`, k);
    const key = g['path'];
    if (typeof key !== 'string' || !isPathPaintKey(key)) err(errors, 'field_value', `${p}/path`, 'path is "outline:<id>", "building:<id>", "element:<id>" or "spline"', key);
    if (!(PATH_PAINT_SIDES as readonly unknown[]).includes(g['side'])) err(errors, 'field_value', `${p}/side`, `side is ${PATH_PAINT_SIDES.join(', ')}`, g['side']);
    const id = `${String(key)}|${String(g['side'])}`;
    if (seen.has(id)) err(errors, 'field_value', p, `the ${String(g['side'])} side of ${String(key)} is painted twice`, key);
    seen.add(id);
    const o = g['origin'];
    const s = g['size'];
    const okO = Array.isArray(o) && o.length === 2 && int(o[0], -L.along, L.along) && int(o[1], -L.across, L.across);
    const okS = Array.isArray(s) && s.length === 2 && int(s[0], 1, 2 * L.along) && int(s[1], 1, 2 * L.across);
    if (!okO) err(errors, 'field_value', `${p}/origin`, `origin is the first grid point in cells [along ${-L.along}..${L.along}, up/across ${-L.across}..${L.across}]`, o);
    if (!okS) err(errors, 'field_value', `${p}/size`, 'size is the grid points [along, up/across], each at least 1', s);
    if (okO && okS && ((o[0] as number) + (s[0] as number) - 1 > L.along || (o[1] as number) + (s[1] as number) - 1 > L.across)) err(errors, 'field_value', `${p}/size`, 'the grid reaches past the path paint bounds', s);
    if (typeof g['paint'] !== 'string' || !DIGEST_RE.test(g['paint'])) err(errors, 'field_value', `${p}/paint`, 'paint is the SHA-256 of the grid bytes (64 lowercase hex)', g['paint']);
  });
}

export function validateVertexPaintComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'vertexPaint is an object { meshes?, paths? }', value);
  for (const k of Object.keys(value)) if (!VERTEX_PAINT_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown vertexPaint field "${k}" (${VERTEX_PAINT_FIELDS.join(', ')})`, k);
  if (value['meshes'] === undefined && value['paths'] === undefined) err(errors, 'field_missing', path, 'vertexPaint holds meshes (a model) or paths (generated architecture, a spline)');
  if (value['meshes'] !== undefined) validateMeshes(value['meshes'], `${path}/meshes`, errors);
  if (value['paths'] !== undefined) validatePaths(value['paths'], `${path}/paths`, errors);
}

/** An instance set's `paint` (absent: no copy is painted). */
export function validateInstancePaint(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'paint is {copies, painted, slots, meshes}', value);
  for (const k of Object.keys(value)) if (!INSTANCE_PAINT_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown instance paint field "${k}" (${INSTANCE_PAINT_FIELDS.join(', ')})`, k);
  if (typeof value['copies'] !== 'string' || !DIGEST_RE.test(value['copies'])) err(errors, 'field_value', `${path}/copies`, 'copies is the SHA-256 of the copy table (64 lowercase hex)', value['copies']);
  if (!int(value['painted'], 1, MAX_INSTANCES)) err(errors, 'field_value', `${path}/painted`, `painted is how many copies the table lists, 1-${MAX_INSTANCES}`, value['painted']);
  if (!int(value['slots'], 1, MAX_INSTANCES)) err(errors, 'field_value', `${path}/slots`, `slots is the pool's size, 1-${MAX_INSTANCES}`, value['slots']);
  else if (typeof value['painted'] === 'number' && value['painted'] > value['slots']) err(errors, 'field_value', `${path}/slots`, 'the pool holds at least one slot per painted copy', value['slots']);
  validateMeshes(value['meshes'], `${path}/meshes`, errors);
}

const canonicalMesh = (m: VertexPaintMesh): VertexPaintMesh => ({ mesh: m.mesh, vertices: m.vertices, positions: m.positions, paint: m.paint });
const canonicalPath = (g: PathPaintGrid): PathPaintGrid => ({ path: g.path, side: g.side, origin: [g.origin[0], g.origin[1]], size: [g.size[0], g.size[1]], paint: g.paint });

/** The component in canonical form: fields in order, meshes by name, paths by key and side. */
export function canonicalVertexPaint(c: VertexPaintComponent): VertexPaintComponent {
  const out: VertexPaintComponent = {};
  if (c.meshes !== undefined) out.meshes = [...c.meshes].map(canonicalMesh).sort((a, b) => (a.mesh < b.mesh ? -1 : a.mesh > b.mesh ? 1 : 0));
  if (c.paths !== undefined) out.paths = [...c.paths].map(canonicalPath).sort((a, b) => (a.path !== b.path ? (a.path < b.path ? -1 : 1) : PATH_PAINT_SIDES.indexOf(a.side) - PATH_PAINT_SIDES.indexOf(b.side)));
  return out;
}

export function canonicalInstancePaint(p: InstancePaint): InstancePaint {
  return { copies: p.copies, painted: p.painted, slots: p.slots, meshes: [...p.meshes].map(canonicalMesh).sort((a, b) => (a.mesh < b.mesh ? -1 : a.mesh > b.mesh ? 1 : 0)) };
}

/** Every blob the paint names, with the bytes it must hold. */
export function vertexPaintBlobs(c: VertexPaintComponent | undefined): { digest: string; byteLength: number }[] {
  if (c === undefined) return [];
  return [
    ...(c.meshes ?? []).map((m) => ({ digest: m.paint, byteLength: m.vertices * VERTEX_PAINT_BYTES })),
    ...(c.paths ?? []).map((g) => ({ digest: g.paint, byteLength: g.size[0] * g.size[1] * VERTEX_PAINT_BYTES })),
  ];
}

export function instancePaintBlobs(p: InstancePaint | undefined): { digest: string; byteLength: number }[] {
  if (p === undefined) return [];
  return [{ digest: p.copies, byteLength: p.painted * PAINT_COPY_ENTRY_BYTES }, ...p.meshes.map((m) => ({ digest: m.paint, byteLength: p.slots * m.vertices * VERTEX_PAINT_BYTES }))];
}

// ---- meshes --------------------------------------------------------------------

/** A mesh's name: its node's path and the primitive's index. */
export const paintMeshKey = (node: string, primitive: number): string => `${node}#${primitive}`;

/**
 * A mesh's position hash: the first {@link PAINT_POSITIONS_HASH_LENGTH} hex
 * of the SHA-256 of its POSITION values as stored (float32, little-endian),
 * so a page that loaded the same file computes the same from its geometry.
 */
export function paintPositionsHash(local: ArrayLike<number>, hash: (bytes: Uint8Array) => string = sha256Hex): string {
  const f = Float32Array.from(local as ArrayLike<number>);
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    // A big-endian host hashes the file's little-endian bytes.
    const le = new Uint8Array(bytes.length);
    const v = new DataView(le.buffer);
    for (let i = 0; i < f.length; i++) v.setFloat32(i * 4, f[i]!, true);
    return hash(le).slice(0, PAINT_POSITIONS_HASH_LENGTH);
  }
  return hash(bytes).slice(0, PAINT_POSITIONS_HASH_LENGTH);
}

/** glTF's component type of each integer typed array a decoded accessor may be kept in. */
const ARRAY_COMPONENT_TYPES: Readonly<Record<string, number>> = { Int8Array: 5120, Uint8Array: 5121, Int16Array: 5122, Uint16Array: 5123, Uint32Array: 5125 };

/**
 * What one stored number of a normalized POSITION is multiplied by when the
 * model is read (glTF's scale, as {@link readModelGeometry} applies it), by
 * the typed array a loader kept the integers in; 1 for floats. A page that
 * hashes its loaded positions then hashes the numbers the backend hashed.
 */
export function normalizedPositionScale(array: ArrayLike<number>): number {
  const type = ARRAY_COMPONENT_TYPES[(array as { constructor?: { name?: string } }).constructor?.name ?? ''];
  return type === undefined ? 1 : (GLTF_COMPONENT_TYPES[type]?.norm ?? 1);
}

/** A mesh a model draws, as paint sees it:its name, vertex count, position hash, and its vertices in the model's root space. */
export interface PaintableMesh {
  mesh: string;
  /** The top-level piece it belongs to. */
  piece: string;
  vertices: number;
  positions: string;
  /** xyz per vertex, model root space. */
  points: Float32Array;
}

/** The meshes of a model vertex paint may cover: every render primitive (every level of detail), no `_COL` part. */
export function paintableMeshes(g: ModelGeometry, hash: (bytes: Uint8Array) => string = sha256Hex): PaintableMesh[] {
  const out: PaintableMesh[] = [];
  for (const p of g.primitives) {
    if (p.collision || p.positions.length === 0) continue;
    const points = new Float32Array(p.positions.length * 3);
    p.positions.forEach((q, i) => points.set(q, i * 3));
    out.push({ mesh: paintMeshKey(p.node, p.primitive), piece: p.piece, vertices: p.positions.length, positions: paintPositionsHash(p.local, hash), points });
  }
  return out;
}

/** Why a painted mesh's paint is not drawn on the model as it is now. */
export interface PaintMismatch {
  mesh: string;
  reason: 'missing' | 'vertices' | 'positions';
  message: string;
}

/**
 * The painted meshes that no longer match the model (a reimport changed or
 * removed them). Their blobs stay; the paint is not drawn until it is
 * painted again or removed.
 */
export function vertexPaintMismatches(records: readonly VertexPaintMesh[], meshes: readonly Pick<PaintableMesh, 'mesh' | 'vertices' | 'positions'>[]): PaintMismatch[] {
  const by = new Map(meshes.map((m) => [m.mesh, m]));
  const out: PaintMismatch[] = [];
  for (const r of records) {
    const m = by.get(r.mesh);
    if (m === undefined) out.push({ mesh: r.mesh, reason: 'missing', message: `mesh ${r.mesh} is no longer in the model` });
    else if (m.vertices !== r.vertices) out.push({ mesh: r.mesh, reason: 'vertices', message: `mesh ${r.mesh} has ${m.vertices} vertices, the paint was made for ${r.vertices}` });
    else if (m.positions !== r.positions) out.push({ mesh: r.mesh, reason: 'positions', message: `mesh ${r.mesh}'s vertices moved since it was painted` });
  }
  return out;
}

// ---- instance copies -------------------------------------------------------------

/** A copy table's entries: per entry the copy's address and its slot, in address order. */
export interface CopyTable {
  copies: Uint32Array;
  slots: Uint32Array;
}

export function encodeCopyTable(t: CopyTable): Uint8Array {
  const out = new Uint8Array(t.copies.length * PAINT_COPY_ENTRY_BYTES);
  const v = new DataView(out.buffer);
  for (let i = 0; i < t.copies.length; i++) {
    v.setUint32(i * 8, t.copies[i]!, true);
    v.setUint32(i * 8 + 4, t.slots[i]!, true);
  }
  return out;
}

/** The table in `bytes` (null: not a table of whole entries in address order). */
export function decodeCopyTable(bytes: Uint8Array): CopyTable | null {
  if (bytes.byteLength % PAINT_COPY_ENTRY_BYTES !== 0) return null;
  const n = bytes.byteLength / PAINT_COPY_ENTRY_BYTES;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copies = new Uint32Array(n);
  const slots = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    copies[i] = v.getUint32(i * 8, true);
    slots[i] = v.getUint32(i * 8 + 4, true);
    if (i > 0 && copies[i]! <= copies[i - 1]!) return null;
  }
  return { copies, slots };
}

/** The slot a copy's paint is in (−1: unpainted). */
export function copySlot(t: CopyTable, copy: number): number {
  let lo = 0;
  let hi = t.copies.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = t.copies[mid]!;
    if (c === copy) return t.slots[mid]!;
    if (c < copy) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Where each copy of an instance set went when its buffer changed (old
 * address → new, −1: gone), or null when the new buffer is not the old one
 * edited (its paint would land on unrelated copies).
 * - The same count: every copy kept its place (copies moved, turned or scaled keep their paint).
 * - Fewer: the new copies are the old ones with some taken out (the brush's erase, a deleted copy).
 * - More: the old copies come first, the new ones after (the brush's paint, an added copy).
 */
export function copyIndexMap(before: Float32Array, after: Float32Array, floatsPerCopy: number): Int32Array | null {
  const n = Math.floor(before.length / floatsPerCopy);
  const m = Math.floor(after.length / floatsPerCopy);
  const map = new Int32Array(n).fill(-1);
  const same = (i: number, j: number): boolean => {
    for (let k = 0; k < floatsPerCopy; k++) if (!Object.is(before[i * floatsPerCopy + k], after[j * floatsPerCopy + k])) return false;
    return true;
  };
  if (m === n) {
    for (let i = 0; i < n; i++) map[i] = i;
    return map;
  }
  if (m > n) {
    for (let i = 0; i < n; i++) {
      if (!same(i, i)) return null;
      map[i] = i;
    }
    return map;
  }
  // Fewer: walk both in order; an old copy that is not the next new one was taken out.
  let j = 0;
  for (let i = 0; i < n && j < m; i++) {
    if (same(i, j)) map[i] = j++;
  }
  return j === m ? map : null;
}

/** The table after the copies moved (`map` from {@link copyIndexMap}): gone copies leave it, their slots free. */
export function remapCopyTable(t: CopyTable, map: Int32Array): CopyTable {
  const copies: number[] = [];
  const slots: number[] = [];
  for (let i = 0; i < t.copies.length; i++) {
    const to = map[t.copies[i]!];
    if (to === undefined || to < 0) continue;
    copies.push(to);
    slots.push(t.slots[i]!);
  }
  return { copies: Uint32Array.from(copies), slots: Uint32Array.from(slots) };
}
