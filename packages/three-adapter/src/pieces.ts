/**
 * Multi-piece GLBs: pieces, LOD groups and collision nodes by node name.
 *
 * Game art exported from Blender follows one naming rule (e.g. Sprout's
 * kits and foliage): `<piece>_LOD0..n` are the render levels of one piece
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
