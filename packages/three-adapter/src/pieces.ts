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
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(LOD_REFERENCE_FOV) / 2);
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
        const fraction = i === 0 ? null : LOD_SCREEN_FRACTIONS[Math.min(i - 1, LOD_SCREEN_FRACTIONS.length - 1)]!;
        const distance = fraction === null || radius <= 0 ? (i === 0 ? 0 : i * 10) : radius / (tanHalf * fraction);
        lod.addLevel(level, distance);
      }
      parent.add(lod);
      made += 1;
    }
  }
  return made;
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

/** Most vertices of a physics polygon (physics-rapier MAX_POLYGON_VERTICES). */
export const COLLIDER_POLYGON_MAX = 8;

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
  let hull = convexHull(points);
  while (hull.length > COLLIDER_POLYGON_MAX) hull = dropLeastArea(hull);
  hull = hull.map(([x, y]) => [round3(x), round3(y)]);
  hull = dedupe(hull);
  if (hull.length < 3 || Math.abs(signedArea(hull)) < 1e-4) return null;
  return hull;
}

function round3(x: number): number {
  const r = Math.round(x * 1000) / 1000;
  return r === 0 ? 0 : r;
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain: counter-clockwise, no collinear points. */
export function convexHull(input: readonly [number, number][]): [number, number][] {
  const pts = [...input].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts;
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function signedArea(poly: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Remove the vertex whose removal loses the least area (the hull stays convex). */
function dropLeastArea(poly: [number, number][]): [number, number][] {
  let best = 0;
  let bestLoss = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const prev = poly[(i + poly.length - 1) % poly.length]!;
    const next = poly[(i + 1) % poly.length]!;
    const loss = Math.abs(cross(prev, poly[i]!, next));
    if (loss < bestLoss) {
      bestLoss = loss;
      best = i;
    }
  }
  return poly.filter((_, i) => i !== best);
}

function dedupe(poly: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]) out.pop();
  return convexHull(out);
}

// ---- phase 23.1: 3D colliders from `_COL` nodes or a model's geometry -----------

/** Phase 23.1: the limits of a 3D collider made from a model (the project model's collider limits). */
export const COLLIDER_3D_FROM_MODEL = Object.freeze({ meshVertices: 1024, meshTriangles: 2048, convexPoints: 64, extent: 64 });

/** Phase 23.1: a 3D collider shape made from a model (the project model's `convex` / `mesh` shapes, 1 mm grid). */
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

/**
 * Phase 23.1: the triangles of a piece's collision geometry in the file's
 * root space (the placement's local space) — its `_COL` node(s) when it has
 * any (the whole file's with `piece` null), else its render geometry at
 * LOD0 (the `_COL` and higher levels skipped). Vertices are rounded to 1 mm
 * and merged; degenerate triangles are dropped.
 */
function modelTriangles(root: THREE.Object3D, piece: string | null): { vertices: [number, number, number][]; triangles: [number, number, number][]; source: 'collision' | 'geometry' } {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const found = piece === null ? null : modelPieces(root).find((p) => p.name === piece);
  const cols: THREE.Object3D[] = [];
  if (piece === null) root.traverse((o) => void (isCollisionNode(o) && cols.push(o)));
  else if (found?.collider) cols.push(found.collider);
  const source: 'collision' | 'geometry' = cols.length > 0 ? 'collision' : 'geometry';
  const roots = source === 'collision' ? cols : piece === null ? [root] : (found?.nodes ?? []);
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];
  const index = new Map<string, number>();
  const v = new THREE.Vector3();
  const idOf = (x: number, y: number, z: number): number => {
    const p: [number, number, number] = [round3(x), round3(y), round3(z)];
    const key = `${p[0]},${p[1]},${p[2]}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push(p);
      index.set(key, i);
    }
    return i;
  };
  for (const r of roots) {
    r.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.geometry === undefined) return;
      if (source === 'geometry' && (isCollisionNode(o) || underHigherLod(o, root) || (() => { for (let n: THREE.Object3D | null = o; n !== null && n !== root; n = n.parent) if (isCollisionNode(n)) return true; return false; })())) return;
      const pos = mesh.geometry.getAttribute('position');
      if (pos === undefined) return;
      const m = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
      const ids: number[] = [];
      for (let i = 0; i < pos.count; i += 1) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        ids.push(idOf(v.x, v.y, v.z));
      }
      const idx = mesh.geometry.getIndex();
      const count = idx !== null ? idx.count : pos.count;
      for (let t = 0; t + 2 < count; t += 3) {
        const a = ids[idx !== null ? idx.getX(t) : t]!;
        const b = ids[idx !== null ? idx.getX(t + 1) : t + 1]!;
        const c = ids[idx !== null ? idx.getX(t + 2) : t + 2]!;
        if (a !== b && b !== c && a !== c) triangles.push([a, b, c]);
      }
    });
  }
  return { vertices, triangles, source };
}

/**
 * Phase 23.1: a 3D collider for a piece (or the whole file) — a triangle
 * mesh (static level geometry, exact) or a convex hull — from its `_COL`
 * node(s), else from its LOD0 render geometry, in the placement's local
 * space on a 1 mm grid. A mesh keeps every triangle up to the limits (a
 * collision proxy is small; a detailed render mesh is refused with a hint);
 * a hull keeps up to 64 extreme points (the six axis extremes and the
 * furthest point toward each of 58 evenly spread directions). Refused, with
 * a reason, when there is no geometry, it reaches beyond 64 m, it is too big
 * for a mesh, or a hull would be flat.
 */
export function pieceCollider3D(root: THREE.Object3D, piece: string | null, kind: 'mesh' | 'convex'): ModelCollider3D {
  const L = COLLIDER_3D_FROM_MODEL;
  const { vertices, triangles, source } = modelTriangles(root, piece);
  const what = source === 'collision' ? 'collision node' : 'geometry';
  if (vertices.length === 0) return { ok: false, message: 'the model has no geometry to make a collider from' };
  if (vertices.some((p) => p.some((c) => Math.abs(c) > L.extent))) return { ok: false, message: `the model's ${what} reaches beyond ${L.extent} m of its origin (a collider stays within ${L.extent} m)` };
  if (kind === 'mesh') {
    // Only the vertices triangles use.
    const used = new Map<number, number>();
    const verts: [number, number, number][] = [];
    const tris = triangles.map((t) => t.map((i) => {
      let j = used.get(i);
      if (j === undefined) {
        j = verts.length;
        verts.push(vertices[i]!);
        used.set(i, j);
      }
      return j;
    }) as [number, number, number]);
    if (tris.length === 0) return { ok: false, message: `the model's ${what} has no triangles` };
    if (verts.length > L.meshVertices || tris.length > L.meshTriangles) {
      return { ok: false, message: `the model's ${what} has ${tris.length} triangles and ${verts.length} vertices; a mesh collider takes at most ${L.meshTriangles} and ${L.meshVertices} — add a simpler _COL node, or use a convex hull` };
    }
    return { ok: true, shape: { type: 'mesh', vertices: verts, triangles: tris }, source };
  }
  let points = vertices;
  if (points.length > L.convexPoints) {
    const dirs: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const n = L.convexPoints - dirs.length;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      dirs.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
    }
    const pick = new Set<number>();
    for (const d of dirs) {
      let best = 0;
      let bestDot = -Infinity;
      points.forEach((p, i) => {
        const dot = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
        if (dot > bestDot) [bestDot, best] = [dot, i];
      });
      pick.add(best);
    }
    points = [...pick].sort((a, b) => a - b).map((i) => vertices[i]!);
  }
  if (points.length < 4 || !spansVolume(points)) return { ok: false, message: `the model's ${what} is flat: a convex hull needs volume (use a mesh collider, or a box)` };
  return { ok: true, shape: { type: 'convex', points }, source };
}

/** Whether points span a volume (not all on one plane; the project model's rule). */
function spansVolume(pts: readonly (readonly [number, number, number])[]): boolean {
  const a = pts[0]!;
  let b = a;
  let best = 0;
  for (const p of pts) {
    const d = Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    if (d > best) [best, b] = [d, p];
  }
  if (best < 1e-6) return false;
  const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  let c = a;
  let area = 0;
  for (const p of pts) {
    const m = new THREE.Vector3(p[0] - a[0], p[1] - a[1], p[2] - a[2]).cross(ab).length();
    if (m > area) [area, c] = [m, p];
  }
  if (area < 1e-9) return false;
  const n = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]).cross(ab);
  let vol = 0;
  for (const p of pts) vol = Math.max(vol, Math.abs(n.x * (p[0] - a[0]) + n.y * (p[1] - a[1]) + n.z * (p[2] - a[2])));
  return vol > 1e-9;
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
