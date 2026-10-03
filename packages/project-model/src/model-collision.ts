/**
 * A model's collision geometry read from its GLB bytes: the mesh parts of
 * its `_COL` nodes (and its render geometry at LOD0, where it has none), in
 * the model's root space — the frame the object holding the model places
 * it in.
 *
 * Why here: a collider `{type: 'model'}` is resolved when the game is built
 * (the runtime never loads models, like a rig for sockets), and the backend's
 * conversion command makes the same shapes the editor's button made from the
 * drawn model. Both read the file with this module, so a model gives one
 * collider wherever it is made.
 *
 * Naming follows the art rule the editor uses (`<piece>_LOD<n>` render
 * levels, `<piece>_COL` the collision mesh, pieces grouped by base name at
 * the top level) with three.js's node-name sanitizing, so a piece named in
 * the editor is found here. Each mesh primitive under a `_COL` node is one
 * convex part (Unreal's `UCX_` and Godot's `-convcolonly` take one object
 * as one hull). EXT_meshopt_compression is decoded; a Draco-compressed or
 * sparse position accessor is not read (the part is reported as skipped).
 *
 * Pure: bytes in, data out; no I/O, no three.js.
 */
import { boxFromBounds, colliderFromTriangles, convexFromPoints, polygonFromPoints, roundMm, type GeometryCollider, type Vec2Tuple, type Vec3Tuple } from './collider-geometry';
import { COLLIDER_3D_LIMITS, MAX_COLLIDER_EXTENT, colliderShapePoints } from './collider-shapes';
import { decodeMeshopt, MeshoptError, type MeshoptFilter, type MeshoptMode } from './meshopt';
import { COMPONENTS as GLTF_COMPONENTS, COMPONENT_TYPES as GLTF_COMPONENT_TYPES, glbChunks, sanitizeRigNodeName } from './model-rig';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const LOD_RE = /^(.*)_LOD(\d+)$/i;
const COL_RE = /^(.*)_COL$/i;

/** A piece's base name (`rock_LOD1` → `rock`, `rock_COL` → `rock`). */
function baseName(name: string): string {
  const lod = LOD_RE.exec(name);
  if (lod !== null && lod[1] !== undefined && lod[1] !== '') return lod[1];
  const col = COL_RE.exec(name);
  if (col !== null && col[1] !== undefined && col[1] !== '') return col[1];
  return name;
}

/** One mesh primitive of the model, in root space. */
export interface ModelGeometryPrimitive {
  /** The base name of the top-level node it is under (its piece). */
  piece: string;
  /** Under a `_COL` node. */
  collision: boolean;
  /** Under a render level above LOD0. */
  higherLod: boolean;
  /** Under the top-level `<piece>_COL` node itself (a piece's collision mesh). */
  pieceCollision: boolean;
  positions: Vec3Tuple[];
  /** Index triples into `positions` (empty for points and lines). */
  triangles: Vec3Tuple[];
}

export interface ModelGeometry {
  primitives: ModelGeometryPrimitive[];
  /** Collision primitives that could not be read, and why. */
  skipped: string[];
}

/** Bounds on what one read decodes (the importer's caps keep stored files far below them). */
const READ_LIMITS = Object.freeze({ depth: 256, positions: 4_000_000 });

/** Column-major 4×4 of a node (its matrix, else T·R·S). */
function nodeMatrix(def: Json): number[] {
  const nums = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null);
  const m = nums(def['matrix'], 16);
  if (m !== null) return [...m];
  const t = nums(def['translation'], 3) ?? [0, 0, 0];
  const [x, y, z, w] = nums(def['rotation'], 4) ?? [0, 0, 0, 1];
  const s = nums(def['scale'], 3) ?? [1, 1, 1];
  const x2 = x! + x!, y2 = y! + y!, z2 = z! + z!;
  const xx = x! * x2, xy = x! * y2, xz = x! * z2, yy = y! * y2, yz = y! * z2, zz = z! * z2, wx = w! * x2, wy = w! * y2, wz = w! * z2;
  return [
    (1 - (yy + zz)) * s[0]!, (xy + wz) * s[0]!, (xz - wy) * s[0]!, 0,
    (xy - wz) * s[1]!, (1 - (xx + zz)) * s[1]!, (yz + wx) * s[1]!, 0,
    (xz + wy) * s[2]!, (yz - wx) * s[2]!, (1 - (xx + yy)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

function mul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) {
    let v = 0;
    for (let k = 0; k < 4; k += 1) v += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = v;
  }
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The bytes of a bufferView (decoded when meshopt-compressed), or why not. */
function viewBytes(json: Json, bin: DataView | null, index: unknown, cache: Map<number, DataView | string>): DataView | string {
  if (typeof index !== 'number' || !Number.isInteger(index)) return 'an accessor names no bufferView';
  const hit = cache.get(index);
  if (hit !== undefined) return hit;
  const views = Array.isArray(json['bufferViews']) ? (json['bufferViews'] as unknown[]) : [];
  const view = views[index];
  let out: DataView | string;
  if (!isObj(view) || bin === null) out = 'a bufferView is missing';
  else {
    const ext = isObj(view['extensions']) ? (view['extensions'] as Json)['EXT_meshopt_compression'] : undefined;
    if (isObj(ext)) {
      const off = typeof ext['byteOffset'] === 'number' ? ext['byteOffset'] : 0;
      const len = ext['byteLength'];
      const count = ext['count'];
      const stride = ext['byteStride'];
      if ((ext['buffer'] ?? 0) !== 0 || typeof len !== 'number' || typeof count !== 'number' || typeof stride !== 'number' || off < 0 || off + len > bin.byteLength) out = 'a meshopt bufferView is malformed';
      else {
        try {
          const src = new Uint8Array(bin.buffer, bin.byteOffset + off, len);
          const decoded = decodeMeshopt(src, count, stride, ext['mode'] as MeshoptMode, (ext['filter'] ?? 'NONE') as MeshoptFilter);
          out = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
        } catch (e) {
          out = e instanceof MeshoptError ? `a meshopt stream does not decode: ${e.message}` : 'a meshopt stream does not decode';
        }
      }
    } else if ((view['buffer'] ?? 0) !== 0) out = 'a bufferView is not in the GLB';
    else {
      const off = typeof view['byteOffset'] === 'number' ? view['byteOffset'] : 0;
      const len = typeof view['byteLength'] === 'number' ? view['byteLength'] : -1;
      out = off < 0 || len < 0 || off + len > bin.byteLength ? 'a bufferView runs past the file' : new DataView(bin.buffer, bin.byteOffset + off, len);
    }
  }
  cache.set(index, out);
  return out;
}

/** An accessor's numbers (normalized integers scaled like three.js), or why not. */
function readNumbers(json: Json, bin: DataView | null, index: unknown, cache: Map<number, DataView | string>): { data: number[]; size: number } | string {
  const accessors = Array.isArray(json['accessors']) ? (json['accessors'] as unknown[]) : [];
  if (typeof index !== 'number' || !Number.isInteger(index)) return 'no accessor';
  const a = accessors[index];
  if (!isObj(a)) return 'an accessor is missing';
  if (a['sparse'] !== undefined) return 'a sparse accessor is not read';
  const size = GLTF_COMPONENTS[String(a['type'])];
  const ct = GLTF_COMPONENT_TYPES[Number(a['componentType'])];
  const count = a['count'];
  if (size === undefined || ct === undefined || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return 'an accessor is malformed';
  const view = viewBytes(json, bin, a['bufferView'], cache);
  if (typeof view === 'string') return view;
  const views = Array.isArray(json['bufferViews']) ? (json['bufferViews'] as unknown[]) : [];
  const vdef = views[a['bufferView'] as number] as Json;
  const base = typeof a['byteOffset'] === 'number' ? a['byteOffset'] : 0;
  const elem = size * ct.bytes;
  const stride = typeof vdef['byteStride'] === 'number' && vdef['byteStride'] > 0 ? vdef['byteStride'] : elem;
  if (count > 0 && base + stride * (count - 1) + elem > view.byteLength) return 'an accessor runs past its bufferView';
  const scale = a['normalized'] === true ? ct.norm : 1;
  const data = new Array<number>(count * size);
  for (let i = 0; i < count; i += 1) for (let k = 0; k < size; k += 1) {
    const v = ct.read(view, base + i * stride + k * ct.bytes);
    data[i * size + k] = scale === 1 ? v : v * scale;
  }
  return { data, size };
}

/** The triangles of a primitive's mode (strips and fans as three.js turns them into triangles). */
function trianglesOf(mode: number, indices: readonly number[]): Vec3Tuple[] {
  const out: Vec3Tuple[] = [];
  if (mode === 4) for (let t = 0; t + 2 < indices.length; t += 3) out.push([indices[t]!, indices[t + 1]!, indices[t + 2]!]);
  else if (mode === 5) for (let t = 0; t + 2 < indices.length; t += 1) out.push(t % 2 === 0 ? [indices[t]!, indices[t + 1]!, indices[t + 2]!] : [indices[t + 2]!, indices[t + 1]!, indices[t]!]);
  else if (mode === 6) for (let t = 1; t + 1 < indices.length; t += 1) out.push([indices[0]!, indices[t]!, indices[t + 1]!]);
  return out.filter((t) => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]);
}

/** Read a model's mesh primitives in root space. Never throws. */
export function readModelGeometry(bytes: Uint8Array): { ok: true; geometry: ModelGeometry } | { ok: false; message: string } {
  const chunks = glbChunks(bytes);
  if (typeof chunks === 'string') return { ok: false, message: chunks };
  const { json, bin } = chunks;
  const nodes = Array.isArray(json['nodes']) ? (json['nodes'] as unknown[]) : [];
  const meshes = Array.isArray(json['meshes']) ? (json['meshes'] as unknown[]) : [];
  const scenes = Array.isArray(json['scenes']) ? (json['scenes'] as unknown[]) : [];
  const scene = scenes[typeof json['scene'] === 'number' ? json['scene'] : 0];
  const cache = new Map<number, DataView | string>();
  const primitives: ModelGeometryPrimitive[] = [];
  const skipped: string[] = [];
  let positionsRead = 0;
  const visit = (index: number, parent: readonly number[], depth: number, ctx: { piece: string; collision: boolean; higherLod: boolean; pieceCollision: boolean }, seen: Set<number>): void => {
    if (depth > READ_LIMITS.depth || seen.has(index)) return;
    const def = nodes[index];
    if (!isObj(def)) return;
    seen.add(index);
    const name = typeof def['name'] === 'string' ? sanitizeRigNodeName(def['name']) : '';
    const lod = LOD_RE.exec(name);
    const here = {
      piece: depth === 0 ? baseName(name) : ctx.piece,
      collision: ctx.collision || COL_RE.test(name),
      higherLod: ctx.higherLod || (lod !== null && Number(lod[2]) > 0),
      pieceCollision: ctx.pieceCollision || (depth === 0 && COL_RE.test(name)),
    };
    const world = mul(parent, nodeMatrix(def));
    const mesh = typeof def['mesh'] === 'number' ? meshes[def['mesh']] : undefined;
    if (isObj(mesh) && Array.isArray(mesh['primitives'])) {
      (mesh['primitives'] as unknown[]).forEach((prim, pi) => {
        if (!isObj(prim) || !isObj(prim['attributes'])) return;
        const label = `${name || `node ${index}`} primitive ${pi}`;
        if (isObj(prim['extensions']) && (prim['extensions'] as Json)['KHR_draco_mesh_compression'] !== undefined) {
          if (here.collision) skipped.push(`${label}: Draco-compressed geometry is not read (export the _COL mesh without Draco)`);
          return;
        }
        const pos = readNumbers(json, bin, (prim['attributes'] as Json)['POSITION'], cache);
        if (typeof pos === 'string' || pos.size !== 3) {
          if (here.collision) skipped.push(`${label}: ${typeof pos === 'string' ? pos : 'POSITION is not a VEC3'}`);
          return;
        }
        const count = pos.data.length / 3;
        positionsRead += count;
        if (positionsRead > READ_LIMITS.positions) return;
        const positions: Vec3Tuple[] = [];
        for (let i = 0; i < count; i += 1) {
          const x = pos.data[i * 3]!, y = pos.data[i * 3 + 1]!, z = pos.data[i * 3 + 2]!;
          positions.push([
            world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
            world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
            world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
          ]);
        }
        const mode = typeof prim['mode'] === 'number' ? prim['mode'] : 4;
        let indices: number[];
        if (prim['indices'] !== undefined) {
          const idx = readNumbers(json, bin, prim['indices'], cache);
          if (typeof idx === 'string') {
            if (here.collision) skipped.push(`${label}: ${idx}`);
            return;
          }
          indices = idx.data.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
        } else indices = Array.from({ length: count }, (_, i) => i);
        primitives.push({ ...here, positions, triangles: trianglesOf(mode, indices) });
      });
    }
    for (const k of Array.isArray(def['children']) ? (def['children'] as unknown[]) : []) if (typeof k === 'number') visit(k, world, depth + 1, here, seen);
  };
  if (isObj(scene)) {
    const seen = new Set<number>();
    for (const n of Array.isArray(scene['nodes']) ? (scene['nodes'] as unknown[]) : []) if (typeof n === 'number') visit(n, IDENTITY, 0, { piece: '', collision: false, higherLod: false, pieceCollision: false }, seen);
  }
  if (positionsRead > READ_LIMITS.positions) return { ok: false, message: `the model holds over ${READ_LIMITS.positions} vertices; its collision geometry is not read` };
  return { ok: true, geometry: { primitives, skipped } };
}

/** The collision primitives of a piece (its `<piece>_COL` node), or of every `_COL` node with `piece` null. */
function collisionPrimitives(g: ModelGeometry, piece: string | null): ModelGeometryPrimitive[] {
  return g.primitives.filter((p) => p.collision && (piece === null || (p.pieceCollision && p.piece === piece)));
}

/** A piece's render geometry at LOD0 (no collision nodes, no higher levels). */
function renderPrimitives(g: ModelGeometry, piece: string | null): ModelGeometryPrimitive[] {
  return g.primitives.filter((p) => !p.collision && !p.higherLod && (piece === null || p.piece === piece));
}

/**
 * A build's `_COL` parts, for colliders `{type: 'model'}`: asset id → piece
 * (`''` for a model shown whole) → each convex part's hull points.
 */
export type ModelColliderTable = Readonly<Record<string, Readonly<Record<string, readonly (readonly (readonly number[])[])[]>>>>;

/** Why a value is not a {@link ModelColliderTable} (null: it is one). Each part is 4–64 finite points within the collider extent. */
export function validateModelColliderTable(value: unknown): string | null {
  if (!isObj(value)) return 'the model collider table is an object of models';
  for (const [assetId, pieces] of Object.entries(value)) {
    if (!isObj(pieces)) return `"${assetId}" is an object of pieces`;
    for (const [piece, parts] of Object.entries(pieces)) {
      if (!Array.isArray(parts)) return `"${assetId}"/"${piece}" is a list of parts`;
      for (let i = 0; i < parts.length; i += 1) {
        const pts = parts[i] as unknown;
        if (!Array.isArray(pts) || pts.length < 4 || pts.length > COLLIDER_3D_LIMITS.convexPoints) return `"${assetId}"/"${piece}" part ${i} has 4-${COLLIDER_3D_LIMITS.convexPoints} points`;
        if (!pts.every((p) => Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_COLLIDER_EXTENT))) return `"${assetId}"/"${piece}" part ${i} holds a point that is not [x, y, z] within ${MAX_COLLIDER_EXTENT} m`;
      }
    }
  }
  return null;
}

/**
 * A scene's 3D collider points against `COLLIDER_3D_LIMITS.pointsTotal`:
 * the hull points and mesh vertices its colliders write, and the hull points
 * of each `{type: 'model'}` collider's `_COL` parts as the build resolved
 * them (`table`; every object using a model counts its parts again, as
 * each becomes its own bodies).
 */
export function sceneColliderPoints(entities: readonly unknown[], table: ModelColliderTable | undefined): number {
  let n = 0;
  for (const e of entities) {
    const c = (e as { components?: Record<string, unknown> } | null)?.components;
    const shape = (c?.['collider'] as { shape?: { type?: unknown } } | undefined)?.shape;
    if (shape === undefined) continue;
    if (shape.type !== 'model') {
      n += colliderShapePoints(shape);
      continue;
    }
    const model = c?.['model'] as { asset?: { assetId?: unknown }; piece?: unknown } | undefined;
    if (typeof model?.asset?.assetId !== 'string') continue;
    const parts = table?.[model.asset.assetId]?.[typeof model.piece === 'string' ? model.piece : ''] ?? [];
    for (const part of parts) n += part.length;
  }
  return n;
}

/** One convex part of a model's collision geometry (points in the object's frame, 1 mm grid, at most 64). */
export interface ModelCollisionPart {
  points: Vec3Tuple[];
}

/**
 * The convex parts of a model's `_COL` geometry (its piece's, or every
 * `_COL` node's with `piece` null): one hull per mesh primitive. Flat or
 * unreadable parts are left out and reported.
 */
export function modelCollisionParts(g: ModelGeometry, piece: string | null): { parts: ModelCollisionPart[]; skipped: string[] } {
  const parts: ModelCollisionPart[] = [];
  const skipped = [...g.skipped];
  collisionPrimitives(g, piece).forEach((p, i) => {
    const made = convexFromPoints(p.positions, 'collision node');
    if (made.ok && made.shape.type === 'convex') parts.push({ points: made.shape.points });
    else if (!made.ok) skipped.push(`part ${i}: ${made.message}`);
  });
  return { parts, skipped };
}

/** The 2D plane's polygon of each convex part (its points' XY hull, at most 8 corners), parts without area left out. */
export function collisionPartPolygons(parts: readonly ModelCollisionPart[]): Vec2Tuple[][] {
  const out: Vec2Tuple[][] = [];
  for (const p of parts) {
    const poly = polygonFromPoints(p.points);
    if (poly !== null) out.push(poly);
  }
  return out;
}

/**
 * What a conversion makes: a box around the render geometry; in 3D a hull
 * or mesh of the collision node (else the geometry), on a 2D plane its
 * polygon; or a compound of the collision node's convex parts.
 */
export type ModelColliderKind = 'box' | 'convex' | 'mesh' | 'polygon' | 'compound';
export const MODEL_COLLIDER_KINDS: readonly ModelColliderKind[] = ['box', 'convex', 'mesh', 'polygon', 'compound'];

/** Triangles of primitives merged on the 1 mm grid. */
function mergedTriangles(prims: readonly ModelGeometryPrimitive[]): { vertices: Vec3Tuple[]; triangles: Vec3Tuple[] } {
  const vertices: Vec3Tuple[] = [];
  const triangles: Vec3Tuple[] = [];
  const index = new Map<string, number>();
  for (const p of prims) {
    const ids = p.positions.map((q) => {
      const r: Vec3Tuple = [roundMm(q[0]), roundMm(q[1]), roundMm(q[2])];
      const key = `${r[0]},${r[1]},${r[2]}`;
      let i = index.get(key);
      if (i === undefined) {
        i = vertices.length;
        vertices.push(r);
        index.set(key, i);
      }
      return i;
    });
    for (const t of p.triangles) {
      const a = ids[t[0]]!, b = ids[t[1]]!, c = ids[t[2]]!;
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c]);
    }
  }
  return { vertices, triangles };
}

/**
 * A collider shape made from a model — what the editor's "collider from the
 * model" makes and the `colliderFromModel` command stores. `box` around its
 * LOD0 render geometry, centred where it is; in 3D `convex` or `mesh` from
 * its `_COL` node(s), else from its LOD0 render geometry; on a 2D plane
 * (`dimension` 2) `polygon`, the XY hull of the same geometry; `compound`:
 * one hull (2D: one polygon) per convex part of its `_COL` node. `source`
 * says which geometry it was made from.
 */
export function modelColliderShape(g: ModelGeometry, piece: string | null, kind: ModelColliderKind, dimension: 2 | 3 = 3):
  | { ok: true; shape: Record<string, unknown>; source: 'collision' | 'geometry'; skipped: string[] }
  | { ok: false; message: string } {
  if (dimension === 2 && (kind === 'convex' || kind === 'mesh')) return { ok: false, message: `a ${kind} collider is a 3D shape; a 2D-plane project makes a box, a polygon or a compound` };
  if (dimension === 3 && kind === 'polygon') return { ok: false, message: 'a polygon collider is a 2D-plane shape; a 3D project makes a box, a convex hull, a mesh or a compound' };
  if (kind === 'compound') {
    const { parts, skipped } = modelCollisionParts(g, piece);
    if (parts.length === 0) return { ok: false, message: skipped.length > 0 ? `the model's _COL parts could not be made into hulls: ${skipped.slice(0, 3).join('; ')}` : 'the model has no _COL node to make a compound from' };
    if (dimension === 2) {
      const polys = collisionPartPolygons(parts);
      if (polys.length === 0) return { ok: false, message: "the model's _COL parts have no area on the 2D plane" };
      return { ok: true, shape: { type: 'compound', shapes: polys.map((vertices) => ({ type: 'polygon', vertices })) }, source: 'collision', skipped };
    }
    return { ok: true, shape: { type: 'compound', shapes: parts.map((p) => ({ type: 'convex', points: p.points })) }, source: 'collision', skipped };
  }
  if (kind === 'box') {
    const prims = renderPrimitives(g, piece);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of prims) for (const q of p.positions) for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k]!, q[k]!);
      hi[k] = Math.max(hi[k]!, q[k]!);
    }
    if (dimension === 2) {
      // The plane's box needs no depth: only its x and y have to have a size.
      lo[2] = -0.5;
      hi[2] = 0.5;
    }
    const made = boxFromBounds(prims.length === 0 || !Number.isFinite(lo[0]!) ? null : { min: lo, max: hi });
    if (!made.ok) return made;
    if (dimension === 2) {
      const { hz: _hz, center, ...flat } = made.shape;
      return { ok: true, shape: { ...flat, ...(center !== undefined && (center[0] !== 0 || center[1] !== 0) ? { center: [center[0], center[1], 0] } : {}) }, source: 'geometry', skipped: [] };
    }
    return { ok: true, shape: made.shape, source: 'geometry', skipped: [] };
  }
  const cols = collisionPrimitives(g, piece);
  const source: 'collision' | 'geometry' = cols.length > 0 ? 'collision' : 'geometry';
  const what = source === 'collision' ? 'collision node' : 'geometry';
  if (kind === 'polygon') {
    const poly = polygonFromPoints((source === 'collision' ? cols : renderPrimitives(g, piece)).flatMap((p) => p.positions));
    return poly === null ? { ok: false, message: `the model's ${what} has no area on the 2D plane` } : { ok: true, shape: { type: 'polygon', vertices: poly }, source, skipped: source === 'collision' ? [...g.skipped] : [] };
  }
  const { vertices, triangles } = mergedTriangles(source === 'collision' ? cols : renderPrimitives(g, piece));
  const made: GeometryCollider = colliderFromTriangles(vertices, triangles, kind, what);
  return made.ok ? { ok: true, shape: made.shape, source, skipped: source === 'collision' ? [...g.skipped] : [] } : made;
}
