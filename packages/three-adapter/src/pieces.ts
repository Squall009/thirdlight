/**
 * Multi-piece GLBs: pieces, LOD groups and collision nodes by node name.
 *
 * Game art exported from Blender follows one naming rule (any kit pieces,
 * props or foliage): `<piece>_LOD0..n` are the render levels of one piece
 * and `<piece>_COL` its collision mesh (never drawn). A file's pieces are its
 * top-level nodes grouped by that base name; a group holding only a `_COL`
 * node is not a piece. Editor, Play and export all use these helpers, so a
 * placement names a piece by the same string everywhere.
 *
 * Pure three.js (no loader): safe on the adapter's root subpath.
 */
import { COLLIDER_3D_LIMITS, MAX_COLLIDER_EXTENT, MAX_POLYGON_VERTICES, colliderFromTriangles, convexFromPoints, convexHull2, polygonFromPoints, roundMm } from '@thirdlight/runtime';
import * as THREE from 'three';

const LOD_RE = /^(.*)_LOD(\d+)$/i;
const COL_RE = /^(.*)_COL$/i;

/**
 * LOD switch points as a fraction of screen height covered by the LOD0
 * bounding sphere: below 8 % LOD1, below 3 % LOD2, and so on (never culled).
 */
export const LOD_SCREEN_FRACTIONS: readonly number[] = [0.08, 0.03, 0.012, 0.005];
/** The vertical field of view the LOD distances assume (degrees). */
const LOD_REFERENCE_FOV = 50;

/** The base name of a node (`rock_LOD1` → `rock`, `rock_COL` → `rock`, else the name). */
export function pieceBaseName(name: string): string {
  const lod = LOD_RE.exec(name);
  if (lod !== null && lod[1] !== undefined && lod[1] !== '') return lod[1];
  const col = COL_RE.exec(name);
  if (col !== null && col[1] !== undefined && col[1] !== '') return col[1];
  return name;
}

export function isCollisionNode(o: THREE.Object3D): boolean {
  return COL_RE.test(o.name);
}

function lodLevel(name: string): number | null {
  const m = LOD_RE.exec(name);
  return m === null ? null : Number(m[2]);
}

/** One piece of a file: its render nodes and its collision node (top level only). */
export interface ModelPiece {
  readonly name: string;
  readonly nodes: readonly THREE.Object3D[];
  readonly collider: THREE.Object3D | null;
  /** Render levels (1 when the piece has no `_LOD<n>` nodes). */
  readonly lods: number;
}

/**
 * The pieces of a loaded GLB scene, in node order. A file whose top level is
 * one piece (a character: rig + meshes) yields a single piece.
 */
export function modelPieces(root: THREE.Object3D): ModelPiece[] {
  const groups = new Map<string, { nodes: THREE.Object3D[]; collider: THREE.Object3D | null; lods: number }>();
  for (const child of root.children) {
    const base = pieceBaseName(child.name);
    let g = groups.get(base);
    if (g === undefined) {
      g = { nodes: [], collider: null, lods: 0 };
      groups.set(base, g);
    }
    if (isCollisionNode(child)) g.collider = child;
    else {
      g.nodes.push(child);
      if (lodLevel(child.name) !== null) g.lods += 1;
    }
  }
  const pieces: ModelPiece[] = [];
  for (const [name, g] of groups) {
    if (g.nodes.length === 0) continue;
    pieces.push({ name, nodes: g.nodes, collider: g.collider, lods: Math.max(1, g.lods) });
  }
  return pieces;
}

/**
 * Keep only one piece's top-level nodes under `root` (render nodes and its
 * collision node). Returns false when the file has no such piece.
 */
export function keepOnlyPiece(root: THREE.Object3D, piece: string): boolean {
  const found = modelPieces(root).some((p) => p.name === piece);
  if (!found) return false;
  for (const child of [...root.children]) {
    if (pieceBaseName(child.name) !== piece) root.remove(child);
  }
  return true;
}

/** Remove every `_COL` node from an instance (collision is physics-only). */
export function stripCollisionNodes(root: THREE.Object3D): void {
  const cols: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && isCollisionNode(o)) cols.push(o);
  });
  for (const o of cols) o.parent?.remove(o);
}

/**
 * Turn every set of sibling `<base>_LOD<n>` nodes into one `THREE.LOD` at the
 * same place in the hierarchy (identity transform, so each level keeps its
 * own local transform and skinned levels keep their bind). Switch distances
 * come from the LOD0 bounding sphere and {@link LOD_SCREEN_FRACTIONS}.
 */
export function applyLodGroups(root: THREE.Object3D): number {
  const sets = new Map<THREE.Object3D, Map<string, { level: number; object: THREE.Object3D }[]>>();
  root.traverse((o) => {
    const level = lodLevel(o.name);
    if (level === null || o.parent === null) return;
    let byBase = sets.get(o.parent);
    if (byBase === undefined) {
      byBase = new Map();
      sets.set(o.parent, byBase);
    }
    const base = pieceBaseName(o.name);
    const list = byBase.get(base) ?? [];
    list.push({ level, object: o });
    byBase.set(base, list);
  });
  let made = 0;
  for (const [parent, byBase] of sets) {
    for (const [base, list] of byBase) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.level - b.level);
      const radius = boundingRadius(list[0]!.object);
      const lod = new THREE.LOD();
      lod.name = `${base}_LOD`;
      for (let i = 0; i < list.length; i += 1) {
        const level = list[i]!.object;
        parent.remove(level);
        lod.addLevel(level, lodSwitchDistance(radius, i));
      }
      parent.add(lod);
      made += 1;
    }
  }
  return made;
}

/**
 * Where level `level` of a model's LOD group takes over: the distance at
 * which LOD0's bounding sphere (`radius`) covers the level's screen fraction
 * of a {@link LOD_REFERENCE_FOV}° view (level 0: from the start).
 */
export function lodSwitchDistance(radius: number, level: number): number {
  if (level === 0) return 0;
  if (radius <= 0) return level * 10;
  const fraction = LOD_SCREEN_FRACTIONS[Math.min(level - 1, LOD_SCREEN_FRACTIONS.length - 1)]!;
  return radius / (Math.tan(THREE.MathUtils.degToRad(LOD_REFERENCE_FOV) / 2) * fraction);
}

function boundingRadius(object: THREE.Object3D): number {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 0;
  return box.getBoundingSphere(new THREE.Sphere()).radius;
}

/**
 * How COLOR_0 is used: `data` (default) never multiplies the albedo — the
 * attribute stays on the geometry for shaders that read it (foliage bend
 * weights etc.); `tint` is the glTF behaviour.
 */
export type VertexColorMode = 'data' | 'tint';

export function applyVertexColorMode(root: THREE.Object3D, mode: VertexColorMode): void {
  const want = mode === 'tint';
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.geometry?.getAttribute('color') === undefined) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (m !== undefined && m.vertexColors !== want) {
        m.vertexColors = want;
        m.needsUpdate = true;
      }
    }
  });
}

// ---- 2D collider from a `_COL` node ---------------------------------------------

/** Most vertices of a physics polygon (the model's collider limit). */
export const COLLIDER_POLYGON_MAX = MAX_POLYGON_VERTICES;

/**
 * The 2D collider for a piece: the convex hull of its `_COL` mesh projected on
 * the XY play plane, in the file's root space (the placement's local space),
 * counter-clockwise, at most {@link COLLIDER_POLYGON_MAX} vertices, rounded to
 * 1 mm. Null when the piece has no collision node or it is degenerate.
 */
export function pieceCollider2D(root: THREE.Object3D, piece: string | null): [number, number][] | null {
  let col: THREE.Object3D | null = null;
  if (piece === null) {
    const all: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (isCollisionNode(o)) all.push(o);
    });
    if (all.length !== 1) return null;
    col = all[0]!;
  } else {
    col = modelPieces(root).find((p) => p.name === piece)?.collider ?? null;
  }
  if (col === null) return null;
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const points: [number, number][] = [];
  const v = new THREE.Vector3();
  col.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const pos = mesh.isMesh ? mesh.geometry?.getAttribute('position') : undefined;
    if (pos === undefined) return;
    const m = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      points.push([v.x, v.y]);
    }
  });
  return polygonFromPoints(points);
}

/** Andrew's monotone chain: counter-clockwise, no collinear points (the project model's). */
export const convexHull = convexHull2;

// ---- 3D colliders from `_COL` nodes or a model's geometry -----------

/** The limits of a 3D collider made from a model (the project model's collider limits). */
export const COLLIDER_3D_FROM_MODEL = Object.freeze({ meshVertices: COLLIDER_3D_LIMITS.meshVertices, meshTriangles: COLLIDER_3D_LIMITS.meshTriangles, convexPoints: COLLIDER_3D_LIMITS.convexPoints, extent: MAX_COLLIDER_EXTENT });

/** A 3D collider shape made from a model (the project model's `convex` / `mesh` shapes, 1 mm grid). */
export type ModelCollider3D =
  | { ok: true; shape: { type: 'mesh'; vertices: [number, number, number][]; triangles: [number, number, number][] } | { type: 'convex'; points: [number, number, number][] }; source: 'collision' | 'geometry' }
  | { ok: false; message: string };

/** Whether `o` or one of its ancestors below `root` is a render level above LOD0. */
function underHigherLod(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n !== null && n !== root; n = n.parent) {
    const lod = lodLevel(n.name);
    if (lod !== null && lod > 0) return true;
  }
  return false;
}

/** Whether `o` or one of its ancestors below `root` is a `_COL` node. */
function underCollision(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n !== null && n !== root; n = n.parent) if (isCollisionNode(n)) return true;
  return false;
}

/** One mesh's positions in the file's root space. */
function meshPoints(mesh: THREE.Mesh, inverseRoot: THREE.Matrix4): [number, number, number][] {
  const pos = mesh.geometry.getAttribute('position');
  if (pos === undefined) return [];
  const m = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
  const v = new THREE.Vector3();
  const out: [number, number, number][] = [];
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    out.push([v.x, v.y, v.z]);
  }
  return out;
}

/** The meshes of a piece's `_COL` node(s) (every `_COL` node's with `piece` null). */
function collisionMeshes(root: THREE.Object3D, piece: string | null): THREE.Mesh[] {
  const found = piece === null ? null : modelPieces(root).find((p) => p.name === piece);
  const cols: THREE.Object3D[] = [];
  if (piece === null) root.traverse((o) => void (isCollisionNode(o) && cols.push(o)));
  else if (found?.collider) cols.push(found.collider);
  const meshes: THREE.Mesh[] = [];
  for (const c of cols) c.traverse((o) => void ((o as THREE.Mesh).isMesh === true && (o as THREE.Mesh).geometry !== undefined && meshes.push(o as THREE.Mesh)));
  return meshes;
}

/**
 * The triangles of a piece's collision geometry in the file's
 * root space (the placement's local space) — its `_COL` node(s) when it has
 * any (the whole file's with `piece` null), else its render geometry at
 * LOD0 (the `_COL` and higher levels skipped). Vertices are rounded to 1 mm
 * and merged; degenerate triangles are dropped.
 */
function modelTriangles(root: THREE.Object3D, piece: string | null): { vertices: [number, number, number][]; triangles: [number, number, number][]; source: 'collision' | 'geometry' } {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const found = piece === null ? null : modelPieces(root).find((p) => p.name === piece);
  const cols = collisionMeshes(root, piece);
  const source: 'collision' | 'geometry' = cols.length > 0 ? 'collision' : 'geometry';
  const meshes: THREE.Mesh[] = [];
  if (source === 'collision') meshes.push(...cols);
  else for (const r of piece === null ? [root] : (found?.nodes ?? [])) r.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh === true && mesh.geometry !== undefined && !underCollision(o, root) && !underHigherLod(o, root)) meshes.push(mesh);
  });
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const index = new Map<string, number>();
  const idOf = (x: number, y: number, z: number): number => {
    const p: [number, number, number] = [roundMm(x), roundMm(y), roundMm(z)];
    const key = `${p[0]},${p[1]},${p[2]}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push(p);
      index.set(key, i);
    }
    return i;
  };
  for (const mesh of meshes) {
    const ids = meshPoints(mesh, inverseRoot).map((p) => idOf(p[0], p[1], p[2]));
    const idx = mesh.geometry.getIndex();
    const count = idx !== null ? idx.count : ids.length;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = ids[idx !== null ? idx.getX(t) : t]!;
      const b = ids[idx !== null ? idx.getX(t + 1) : t + 1]!;
      const c = ids[idx !== null ? idx.getX(t + 2) : t + 2]!;
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c]);
    }
  }
  return { vertices, triangles, source };
}

/**
 * A 3D collider for a piece (or the whole file) — a triangle
 * mesh (static level geometry, exact) or a convex hull — from its `_COL`
 * node(s), else from its LOD0 render geometry, in the placement's local
 * space on a 1 mm grid (the project model's `colliderFromTriangles`, which
 * the backend's conversion runs on the file too).
 */
export function pieceCollider3D(root: THREE.Object3D, piece: string | null, kind: 'mesh' | 'convex'): ModelCollider3D {
  const { vertices, triangles, source } = modelTriangles(root, piece);
  const made = colliderFromTriangles(vertices, triangles, kind, source === 'collision' ? 'collision node' : 'geometry');
  return made.ok ? { ok: true, shape: made.shape, source } : made;
}

/**
 * The convex parts of a piece's `_COL` node(s) (every `_COL` node's with
 * `piece` null) in the file's root space: one hull per mesh, as a build
 * resolves a `{type: 'model'}` collider from the file. Flat parts are left out.
 */
export function pieceCollisionParts(root: THREE.Object3D, piece: string | null): [number, number, number][][] {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out: [number, number, number][][] = [];
  for (const mesh of collisionMeshes(root, piece)) {
    const made = convexFromPoints(meshPoints(mesh, inverseRoot), 'collision node');
    if (made.ok && made.shape.type === 'convex') out.push(made.shape.points);
  }
  return out;
}

/** Bounds of a piece (or the whole file) in the file's root space. */
export function pieceBounds(root: THREE.Object3D, piece: string | null): THREE.Box3 {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  const nodes = piece === null ? root.children : (modelPieces(root).find((p) => p.name === piece)?.nodes ?? []);
  const tmp = new THREE.Box3();
  for (const n of nodes) {
    if (isCollisionNode(n)) continue;
    n.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || isCollisionNode(o) || mesh.geometry === undefined) return;
      const lod = lodLevel(o.name);
      if (lod !== null && lod > 0) return;
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld));
      box.union(tmp);
    });
  }
  return box;
}
