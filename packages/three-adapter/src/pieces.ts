/**
 * Multi-piece GLBs: pieces, LOD groups and collision nodes by node name.
 *
 * Game art exported from Blender follows one naming rule (any kit pieces,
 * props or foliage): `<piece>_LOD0..n` are the render levels of one piece,
 * `<piece>_COL` its collision mesh (never drawn) and `<piece>_OCC` its
 * occluder stand-in (depth only, occluders.ts). A file's pieces are its
 * top-level nodes grouped by that base name; a group holding only a `_COL`
 * node is not a piece. Editor, Play and export all use these helpers, so a
 * placement names a piece by the same string everywhere.
 *
 * Pure three.js (no loader): safe on the adapter's root subpath.
 */
import { COLLIDER_3D_LIMITS, LOD_REFERENCE_FOV_DEG, LOD_SCREEN_SIZES_DEFAULT, MAX_COLLIDER_EXTENT, MODEL_OCC_RE, colliderFromTriangles, convexFromPoints, convexHull2, lodCullSizeOf, lodScreenSizesFor, roundMm, TRIM_DATA_OCCLUSION, TRIM_DATA_WETNESS, type ModelLodSettings } from '@thirdlight/project-model';
import * as THREE from 'three';

import { LOD_CULL_LEVEL_KEY, LOD_MODEL_SCALE_KEY } from './lod-switch';
import { TRIM_DATA_ATTRIBUTE } from './trim-data-attribute';
import { maxScaleOf } from './view-cull';

const LOD_RE = /^(.*)_LOD(\d+)$/i;
const COL_RE = /^(.*)_COL$/i;
const OCC_RE = MODEL_OCC_RE;

/**
 * The default LOD switch points as a fraction of screen height covered by the
 * LOD0 bounding sphere (project-model's `LOD_SCREEN_SIZES_DEFAULT`): below 8 %
 * LOD1, below 3 % LOD2, and so on. A model's import settings may set its own
 * and a cull size.
 */
export const LOD_SCREEN_FRACTIONS: readonly number[] = LOD_SCREEN_SIZES_DEFAULT;

/** The base name of a node (`rock_LOD1`, `rock_COL`, `rock_OCC` → `rock`, else the name). */
export function pieceBaseName(name: string): string {
  const lod = LOD_RE.exec(name);
  if (lod !== null && lod[1] !== undefined && lod[1] !== '') return lod[1];
  for (const re of [COL_RE, OCC_RE]) {
    const m = re.exec(name);
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  return name;
}

export function isCollisionNode(o: THREE.Object3D): boolean {
  return COL_RE.test(o.name);
}

/** Whether `o` is an `_OCC` node (an occluder stand-in: never one of the piece's drawn surfaces). */
export function isOccluderNode(o: THREE.Object3D): boolean {
  return OCC_RE.test(o.name);
}

/** The level of a `<base>_LOD<n>` node (null: not a level). */
export function lodLevel(name: string): number | null {
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
    // A stand-in belongs to its piece (kept with it) but is none of its render nodes.
    else if (isOccluderNode(child)) continue;
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

/** `mesh.userData[MODEL_PIECE_KEY]`: the piece of the file a mesh draws, as the model's distance-field file names it. */
export const MODEL_PIECE_KEY = '__tlModelPiece';

/**
 * Names every mesh of a freshly loaded file with its piece as the
 * distance-field file names it (`buildDistanceBricks`: a top-level piece's
 * base name, `''` when the file has one piece with drawn triangles), so a
 * mesh reads its own piece's light from the surface cache. Run on the whole
 * file, before one piece is kept: a kept piece keeps the file's naming.
 */
export function tagModelPieces(root: THREE.Object3D): void {
  const drawn = new Set<string>();
  for (const child of root.children) {
    if (isCollisionNode(child) || isOccluderNode(child)) continue;
    child.traverse((o) => {
      const g = (o as THREE.Mesh).isMesh === true ? (o as THREE.Mesh).geometry : undefined;
      if (g === undefined || underHigherLod(o, root) || underHelperNode(o, root)) return;
      if ((g.index?.count ?? g.getAttribute('position')?.count ?? 0) >= 3) drawn.add(pieceBaseName(child.name));
    });
  }
  const single = drawn.size === 1;
  for (const child of root.children) {
    const name = single ? '' : pieceBaseName(child.name);
    child.traverse((o) => {
      if ((o as THREE.Mesh).isMesh === true) o.userData[MODEL_PIECE_KEY] = name;
    });
  }
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
 * come from the LOD0 bounding sphere and the model's screen sizes (`lod`,
 * else {@link LOD_SCREEN_FRACTIONS}). With a cull size, an empty last level
 * takes over below it (levels that would only show past it are left out),
 * and a model without levels gets one LOD around all of it for that.
 */
export function applyLodGroups(root: THREE.Object3D, lod?: ModelLodSettings): number {
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
  const cullSize = lodCullSizeOf(lod);
  // Radii and node scales below are measured in the model's own frame.
  root.updateMatrixWorld(true);
  let made = 0;
  const groups = new Set<THREE.Object3D>();
  /** The nearest distance a group of the model is culled at (its meshes outside the groups go with it). */
  let firstCull = Number.POSITIVE_INFINITY;
  for (const [parent, byBase] of sets) {
    for (const [base, list] of byBase) {
      if (list.length < 2 && cullSize <= 0) continue;
      list.sort((a, b) => a.level - b.level);
      const radius = boundingRadius(list[0]!.object);
      const sizes = lodScreenSizesFor(lod, list.length);
      const group = new THREE.LOD();
      group.name = `${base}_LOD`;
      for (const l of list) parent.remove(l.object);
      addLevels(group, list.map((l) => l.object), radius, sizes, cullSize);
      group.userData[LOD_MODEL_SCALE_KEY] = maxScaleOf(parent.matrixWorld.elements);
      parent.add(group);
      groups.add(group);
      if (cullSize > 0) firstCull = Math.min(firstCull, lodDistanceForSize(radius, cullSize));
      made += 1;
    }
  }
  // The model's meshes outside its LOD groups are culled with it, as an instance set's copies are: past the
  // distance its first group is culled at (else a model of levels and plain parts left the plain parts drawn).
  if (made > 0 && Number.isFinite(firstCull)) cullOutsideGroups(root, groups, firstCull);
  if (made === 0 && cullSize > 0 && root.children.length > 0) {
    // No levels of its own: the whole model is level 0, culled below its cull size.
    const all = new THREE.Group();
    all.name = 'LOD0';
    const radius = boundingRadius(root);
    for (const c of [...root.children]) all.add(c);
    const group = new THREE.LOD();
    group.name = 'model_LOD';
    addLevels(group, [all], radius, [], cullSize);
    group.userData[LOD_MODEL_SCALE_KEY] = maxScaleOf(root.matrixWorld.elements);
    root.add(group);
    made = 1;
  }
  return made;
}

/**
 * Put each largest subtree under `root` that holds drawables but no LOD group
 * (nor a bone: a skeleton stays where its skinned meshes find it) in a LOD of
 * its own, culled past `cullAt`.
 */
function cullOutsideGroups(root: THREE.Object3D, groups: ReadonlySet<THREE.Object3D>, cullAt: number): void {
  const holds = (o: THREE.Object3D, test: (x: THREE.Object3D) => boolean): boolean => {
    let found = false;
    o.traverse((x) => {
      if (!found && test(x)) found = true;
    });
    return found;
  };
  const visit = (parent: THREE.Object3D): void => {
    for (const child of [...parent.children]) {
      if (groups.has(child)) continue;
      const inner = holds(child, (x) => groups.has(x) || (x as THREE.Bone).isBone === true);
      if (inner) {
        visit(child);
        continue;
      }
      if (!holds(child, (x) => (x as THREE.Mesh).isMesh === true || (x as THREE.Points).isPoints === true || (x as THREE.Line).isLine === true)) continue;
      const lod = new THREE.LOD();
      lod.name = `${child.name}_cullLOD`;
      const at = parent.children.indexOf(child);
      parent.remove(child);
      lod.addLevel(child, 0);
      const none = new THREE.Group();
      none.name = 'LOD_cull';
      none.userData[LOD_CULL_LEVEL_KEY] = true;
      lod.addLevel(none, cullAt);
      lod.userData[LOD_MODEL_SCALE_KEY] = maxScaleOf(parent.matrixWorld.elements);
      parent.add(lod);
      // Keep the child order (a renderer's tie-break, and what a file's reader expects).
      parent.children.splice(parent.children.indexOf(lod), 1);
      parent.children.splice(at, 0, lod);
    }
  };
  visit(root);
}

/** The levels of one LOD group, then its empty cull level (when its cull size leaves room for one). */
function addLevels(group: THREE.LOD, levels: readonly THREE.Object3D[], radius: number, sizes: readonly number[], cullSize: number): void {
  const cullAt = cullSize > 0 ? lodDistanceForSize(radius, cullSize) : Number.POSITIVE_INFINITY;
  levels.forEach((level, i) => {
    const at = i === 0 ? 0 : lodDistanceForSize(radius, sizes[i - 1]!);
    // A coarser level that would take over only past the cull distance is never drawn.
    if (i === 0 || at < cullAt) group.addLevel(level, at);
  });
  if (Number.isFinite(cullAt)) {
    const none = new THREE.Group();
    none.name = 'LOD_cull';
    none.userData[LOD_CULL_LEVEL_KEY] = true;
    group.addLevel(none, cullAt);
  }
}

/**
 * Where level `level` of a model's LOD group takes over with the default
 * screen sizes: the distance at which LOD0's bounding sphere (`radius`)
 * covers the level's screen fraction of a {@link LOD_REFERENCE_FOV_DEG}° view
 * (level 0: from the start).
 */
export function lodSwitchDistance(radius: number, level: number): number {
  if (level === 0) return 0;
  return lodDistanceForSize(radius, LOD_SCREEN_FRACTIONS[Math.min(level - 1, LOD_SCREEN_FRACTIONS.length - 1)]!, level);
}

/** The distance at which a sphere of `radius` covers `size` of the screen height (a {@link LOD_REFERENCE_FOV_DEG}° view). */
export function lodDistanceForSize(radius: number, size: number, level = 1): number {
  if (radius <= 0) return level * 10;
  return radius / (Math.tan(THREE.MathUtils.degToRad(LOD_REFERENCE_FOV_DEG) / 2) * size);
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
 * weights, layer weights and wetness); `tint` is the glTF behaviour; `trim`
 * says the file was authored with trim data in COLOR_0 (R occlusion,
 * B wetness), which moves into the trim data attribute (R occlusion,
 * A wetness) so COLOR_0 keeps one meaning on every mesh.
 */
export type VertexColorMode = 'data' | 'tint' | 'trim';

/** COLOR_0 authored as trim data, moved into the trim data attribute (once: a shared geometry has no COLOR_0 after). */
function colourToTrimData(geometry: THREE.BufferGeometry): void {
  const colour = geometry.getAttribute('color');
  if (colour === undefined) return;
  const n = colour.count;
  const data = new Uint8Array(n * 4);
  const byte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);
  for (let i = 0; i < n; i++) {
    data[i * 4 + TRIM_DATA_OCCLUSION] = byte(colour.getX(i));
    data[i * 4 + TRIM_DATA_WETNESS] = byte(colour.getZ(i));
  }
  geometry.setAttribute(TRIM_DATA_ATTRIBUTE, new THREE.BufferAttribute(data, 4, true));
  geometry.deleteAttribute('color');
}

export function applyVertexColorMode(root: THREE.Object3D, mode: VertexColorMode): void {
  const want = mode === 'tint';
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.geometry?.getAttribute('color') === undefined) return;
    if (mode === 'trim') {
      colourToTrimData(mesh.geometry);
      return;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (m !== undefined && m.vertexColors !== want) {
        m.vertexColors = want;
        m.needsUpdate = true;
      }
    }
  });
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

/** Whether `o` or one of its ancestors below `root` is a `_COL` or `_OCC` node (no render geometry of the piece). */
function underHelperNode(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n !== null && n !== root; n = n.parent) if (isCollisionNode(n) || isOccluderNode(n)) return true;
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
    if (mesh.isMesh === true && mesh.geometry !== undefined && !underHelperNode(o, root) && !underHigherLod(o, root)) meshes.push(mesh);
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
  const tmp = new THREE.Box3();
  for (const mesh of pieceLod0Meshes(root, piece)) {
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld));
    box.union(tmp);
  }
  return box;
}

/** The meshes a piece draws at LOD0 (`piece` null: the whole file's), without its collision and occluder nodes or helper nodes' meshes. */
export function pieceLod0Meshes(root: THREE.Object3D, piece: string | null): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const nodes = piece === null ? root.children : (modelPieces(root).find((p) => p.name === piece)?.nodes ?? []);
  for (const n of nodes) {
    if (isCollisionNode(n) || isOccluderNode(n)) continue;
    n.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.geometry === undefined || underHelperNode(o, root)) return;
      const lod = lodLevel(o.name);
      if (lod !== null && lod > 0) return;
      out.push(mesh);
    });
  }
  return out;
}
