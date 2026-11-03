/**
 * Seams between chunk-tree levels, measured on two-level patches (bench
 * only). A patch is one layer of nodes of the finer level on one side of a
 * plane and the coarser level's nodes on the other (L0 | L1, L1 | L2), every
 * node derived by the derive itself (the same rules and mesher at every
 * level, mip-derive.ts), ground and base surfaces welded per side in level-0
 * cells. Seam candidates, all working on the two sides' meshes after their
 * derive:
 * - **none**: the two sides as derived;
 * - **stitch** (finer side): every vertex on the finer side's open boundary
 *   at the plane moves to the nearest point of the coarser side's boundary
 *   there, and the finer side fills the strip between them with a fan over
 *   the coarser boundary's vertices it passes (the coarser node unchanged);
 * - **transition** (coarser side, Transvoxel's placement in dual form): the
 *   same with the sides swapped, so the coarser node meets the finer one at
 *   full resolution on its face;
 * - **skirts**: every boundary edge at the plane, on both sides, hangs a
 *   flap one coarse cell deep, inward along its vertices' normals
 *   (`skirts`) or straight down (`skirts-down`).
 * A **control** patch puts the finer level on both sides (no level change):
 * what the measures report there is the harness's own noise and must be 0.
 *
 * Measures, inside a band along the seam (away from the patch's ends):
 * - crack rays: rays from a point outside every surface (at level 0 and
 *   both patch levels, with a margin) to a point inside every surface,
 *   that meet no front-facing triangle first (a culled renderer sees
 *   through them). Rays come down from above on a dense grid over the seam,
 *   and through a dense grid of points on the seam plane near both sides'
 *   boundaries in 50 directions (vertical, and 8 azimuths at ±5°, ±20°,
 *   ±60°: grazing to steep, from above and from below for roofs);
 * - open length: open edges in the band not lying along another open edge
 *   (within a millimetre: T-junctions count as closed), in metres; skirts
 *   are open by design;
 * - triangles added, µs, the largest vertex move, folds (fill or moved
 *   triangles facing the wrong way), the share of rays whose first hit is a
 *   skirt (the flap is what the eye sees there).
 */
import {
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createWorldStore,
  deriveFromStore,
  deriveMipNode,
  MipTree,
  POSITION_STEPS_PER_CELL,
  SHAPE_FULL,
  SURFACE_VERTEX_BYTES,
  TERRAIN_RULES,
  voxel,
  VOXEL_ROLE,
  type MipLevelView,
  type PaletteStore,
  type SurfaceBuffer,
  type VoxelRecord,
} from '@thirdlight/voxel';
import { featureCases, featuresStore } from './features';

const grid = chunkGrid(32);
const E = grid.edge;
const M_PER_CELL = 0.5;

export const SEAM_CANDIDATES = ['none', 'stitch', 'transition', 'skirts', 'skirts-down', 'stitch+flaps', 'transition+flaps', 'transition+skirts'] as const;
export type SeamCandidate = (typeof SEAM_CANDIDATES)[number];

export interface SeamPatchSpec {
  readonly name: string;
  readonly store: PaletteStore;
  /** The finer side's level; the coarser side is one level up. */
  readonly fine: number;
  /** The seam plane's normal axis (0 x, 2 z). */
  readonly axis: 0 | 2;
  /** The plane (level-0 cells), on the coarser level's node lattice. */
  readonly face: number;
  /** Whether the finer side lies at smaller coordinates along the axis. */
  readonly fineBelow: boolean;
  /** The band measured along the other horizontal axis (level-0 cells). */
  readonly along: readonly [number, number];
  /** Ray density: 1 the full grid, 2 every second point, … (tests run sparser). */
  readonly sparse?: number;
}

/** A welded triangle mesh in level-0 cells, with a unit normal a vertex. */
class Soup {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly tris: number[] = [];
  private readonly ids = new Map<string, number>();

  vertex(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0): number {
    const key = `${x},${y},${z}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.pos.length / 3;
      this.ids.set(key, id);
      this.pos.push(x, y, z);
      this.nrm.push(nx, ny, nz);
    } else {
      // Split crease copies weld into one position: sum their normals.
      this.nrm[3 * id] = this.nrm[3 * id]! + nx;
      this.nrm[3 * id + 1] = this.nrm[3 * id + 1]! + ny;
      this.nrm[3 * id + 2] = this.nrm[3 * id + 2]! + nz;
    }
    return id;
  }

  /** A node's surface, positions from its level's steps to level-0 cells. */
  addNode(buf: SurfaceBuffer, level: number, nx: number, ny: number, nz: number): void {
    if (buf.indices.length === 0) return;
    const view = new DataView(buf.vertices.buffer, buf.vertices.byteOffset, buf.vertices.byteLength);
    const s = POSITION_STEPS_PER_CELL;
    const scale = 1 << level;
    const local = new Uint32Array(buf.vertexCount);
    for (let v = 0; v < buf.vertexCount; v++) {
      const o = v * SURFACE_VERTEX_BYTES;
      const wx = (nx * E - 1) * s + view.getUint16(o, true);
      const wy = (ny * E - 1) * s + view.getUint16(o + 2, true);
      const wz = (nz * E - 1) * s + view.getUint16(o + 4, true);
      local[v] = this.vertex((wx * scale) / s, (wy * scale) / s, (wz * scale) / s, view.getInt8(o + 8), view.getInt8(o + 9), view.getInt8(o + 10));
    }
    for (const i of buf.indices) this.tris.push(local[i]!);
  }

  normal(v: number): [number, number, number] {
    const x = this.nrm[3 * v]!, y = this.nrm[3 * v + 1]!, z = this.nrm[3 * v + 2]!;
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }
}

/** One side of a patch: its level and its ground and base meshes. */
interface Side {
  readonly level: number;
  readonly ground: Soup;
  readonly base: Soup;
  /** Nodes on the seam with a surface. */
  readonly seamNodes: number;
  readonly triangles: number;
}

/** A triangle soup tagged per triangle: 0 a node's surface, 1 a seam fill, 2 a skirt. */
interface Assembled {
  readonly tri: number[];
  readonly tag: number[];
}

export interface SeamResult {
  readonly candidate: SeamCandidate;
  readonly crackRays: number;
  readonly rays: number;
  /** Of the rays whose first hit is front-facing: those hitting a skirt first. */
  readonly skirtFirst: number;
  readonly openM: number;
  readonly openEdges: number;
  readonly addedTriangles: number;
  /** Triangles of both sides' seam nodes (what the added count compares with). */
  readonly seamTriangles: number;
  /** Fine node faces on the seam (with a surface). */
  readonly seamFaces: number;
  readonly us: number;
  readonly maxMoveM: number;
  readonly folds: number;
  /** Boundary edges whose ends land on different boundary chains of the other side (no fill). */
  readonly unmatched: number;
  /** Some of the crack rays (every seventh, up to 40), for looking at where they pass. */
  readonly crackSamples: readonly Ray[];
}

export interface PatchReport {
  readonly name: string;
  readonly levels: string;
  readonly results: SeamResult[];
  /** Rays the truth calls outside → inside, and those of them each one-level control (finer, coarser) let through. */
  readonly truthRays: number;
  readonly controlMisses: readonly [number, number];
  /** Angle between the finer and the coarser side's normals at the seam (degrees), p50 / p95. */
  readonly normalJumpDeg: readonly [number, number];
  /** The two sides' boundary gap before any seam: largest distance from a fine boundary vertex to the coarse boundary (m). */
  readonly gapM: number;
}

/** Rays and level views of one patch (the same for every candidate). */
interface Ray {
  readonly o: [number, number, number];
  readonly d: [number, number, number];
  readonly len: number;
}

function nodeYRange(store: PaletteStore): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    lo = Math.min(lo, c.cy);
    hi = Math.max(hi, c.cy);
  }
  return [lo, hi];
}

/**
 * Derives one side: a layer of nodes of `level` next to the plane (on the
 * finer side) or the coarser level's nodes there, across the patch's
 * length, every height of the store.
 */
function buildSide(spec: SeamPatchSpec, tree: MipTree, level: number, below: boolean, along: readonly [number, number], cy: readonly [number, number]): Side {
  const span = E << level;
  const ground = new Soup();
  const base = new Soup();
  const a = below ? spec.face / span - 1 : spec.face / span;
  let seamNodes = 0;
  let triangles = 0;
  for (let b = Math.floor(along[0] / span); b < Math.ceil(along[1] / span); b++) {
    for (let ny = (cy[0] >> level) - 1; ny <= cy[1] >> level; ny++) {
      const nx = spec.axis === 0 ? a : b;
      const nz = spec.axis === 0 ? b : a;
      const d = level === 0 ? deriveFromStore(spec.store, nx, ny, nz, TERRAIN_RULES) : deriveMipNode(tree, { level, nx, ny, nz }, TERRAIN_RULES);
      const t = (d.ground.indices.length + d.base.indices.length) / 3;
      if (t === 0) continue;
      seamNodes++;
      triangles += t;
      ground.addNode(d.ground, level, nx, ny, nz);
      base.addNode(d.base, level, nx, ny, nz);
    }
  }
  return { level, ground, base, seamNodes, triangles };
}

/** Open edges (directed as their triangle has them) with both ends within `tol` of the plane. */
function seamEdges(s: Soup, axis: number, face: number, tol: number): Array<[number, number]> {
  const n = s.pos.length / 3;
  const directed = new Set<number>();
  const T = s.tris;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t]!, b = T[t + 1]!, c = T[t + 2]!;
    if (a === b || b === c || c === a) continue;
    directed.add(a * n + b).add(b * n + c).add(c * n + a);
  }
  const out: Array<[number, number]> = [];
  for (const k of directed) {
    const p = Math.floor(k / n);
    const q = k % n;
    if (directed.has(q * n + p)) continue;
    if (Math.abs(s.pos[3 * p + axis]! - face) <= tol && Math.abs(s.pos[3 * q + axis]! - face) <= tol) out.push([p, q]);
  }
  return out;
}

function closestOnSegment(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number, number] {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, ay + t * dy, az + t * dz, t];
}

interface ZipOut {
  /** Moved positions of the moved side's boundary vertices. */
  readonly moved: Map<number, [number, number, number]>;
  /** Fill triangles, 9 coordinates each. */
  readonly fills: number[];
  readonly folds: number;
  readonly unmatched: number;
  readonly maxMove: number;
  /** Per moved vertex: the angle (degrees) between its normal and the target side's at the point it moved to. */
  readonly normalJump: number[];
  /** Mover edges left without a strip (folded or unmatched), and target edges no strip or moved vertex reached. */
  readonly loose: Array<[number, number]>;
  readonly bare: Array<[number, number]>;
}

/** Longest walk along the target boundary between the targets of one moved edge's two ends. */
const WALK = 64;

/**
 * Moves the boundary of `A` at the plane onto the boundary of `B` there and
 * fills the strip (see the file comment). `along` is the along-seam axis,
 * used to bucket B's boundary edges (`bucket` level-0 cells a bucket).
 */
function zip(A: Soup, aEdges: Array<[number, number]>, B: Soup, bEdges: Array<[number, number]>, alongAxis: number, bucket: number): ZipOut {
  const moved = new Map<number, [number, number, number]>();
  const fills: number[] = [];
  const normalJump: number[] = [];
  let folds = 0;
  let unmatched = 0;
  let maxMove = 0;
  if (bEdges.length === 0) return { moved, fills, folds, unmatched: aEdges.length, maxMove, normalJump, loose: aEdges, bare: [] };
  const loose: Array<[number, number]> = [];
  const reached = new Uint8Array(bEdges.length);
  const BP = B.pos;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < bEdges.length; i++) {
    const [u, v] = bEdges[i]!;
    const lo = Math.floor(Math.min(BP[3 * u + alongAxis]!, BP[3 * v + alongAxis]!) / bucket);
    const hi = Math.floor(Math.max(BP[3 * u + alongAxis]!, BP[3 * v + alongAxis]!) / bucket);
    for (let k = lo; k <= hi; k++) {
      let list = buckets.get(k);
      if (list === undefined) buckets.set(k, (list = []));
      list.push(i);
    }
  }
  const incoming = new Map<number, number>();
  const outgoing = new Map<number, number>();
  for (let i = 0; i < bEdges.length; i++) {
    outgoing.set(bEdges[i]![0], i);
    incoming.set(bEdges[i]![1], i);
  }
  const proj = new Map<number, { e: number; t: number; p: [number, number, number] }>();
  const AP = A.pos;
  for (const [p, q] of aEdges) for (const v of [p, q]) {
    if (proj.has(v)) continue;
    const x = AP[3 * v]!, y = AP[3 * v + 1]!, z = AP[3 * v + 2]!;
    const home = Math.floor(AP[3 * v + alongAxis]! / bucket);
    let best = Infinity;
    let hit = { e: -1, t: 0, p: [0, 0, 0] as [number, number, number] };
    for (let r = 0; r < 256; r++) {
      for (const k of r === 0 ? [home] : [home - r, home + r]) {
        for (const i of buckets.get(k) ?? []) {
          const [u, w] = bEdges[i]!;
          const [cx, cy, cz, t] = closestOnSegment(x, y, z, BP[3 * u]!, BP[3 * u + 1]!, BP[3 * u + 2]!, BP[3 * w]!, BP[3 * w + 1]!, BP[3 * w + 2]!);
          const d = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
          if (d < best) {
            best = d;
            hit = { e: i, t, p: [cx, cy, cz] };
          }
        }
      }
      // Buckets further out lie at least r buckets away along the seam.
      if (best <= (r * bucket) ** 2) break;
    }
    proj.set(v, hit);
    moved.set(v, hit.p);
    maxMove = Math.max(maxMove, Math.sqrt(best));
    const [u, w] = bEdges[hit.e]!;
    const [ax, ay, az] = A.normal(v);
    const nu = B.normal(u), nw = B.normal(w);
    const bx = nu[0] * (1 - hit.t) + nw[0] * hit.t, by = nu[1] * (1 - hit.t) + nw[1] * hit.t, bz = nu[2] * (1 - hit.t) + nw[2] * hit.t;
    const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    normalJump.push((Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / bl))) * 180) / Math.PI);
  }
  const pt = (v: number): number[] => [BP[3 * v]!, BP[3 * v + 1]!, BP[3 * v + 2]!];
  for (const [p, q] of aEdges) {
    const P = proj.get(p)!;
    const Q = proj.get(q)!;
    reached[P.e] = 1;
    reached[Q.e] = 1;
    if (P.e === Q.e) {
      // On one target edge: A runs against B's direction, so q lands nearer the edge's start.
      if (Q.t > P.t + 1e-9) {
        folds++;
        loose.push([p, q]);
      }
      continue;
    }
    // Against B's direction from p's edge: its start, then the start of the edge coming into it, … until q's edge.
    const path: number[] = [];
    let e = P.e;
    let found = false;
    for (let k = 0; k < WALK; k++) {
      const u = bEdges[e]![0];
      path.push(u);
      const prev = incoming.get(u);
      if (prev === undefined) break;
      if (prev === Q.e) {
        found = true;
        break;
      }
      e = prev;
      reached[e] = 1;
    }
    if (!found) {
      loose.push([p, q]);
      let f = P.e;
      let ahead = false;
      for (let k = 0; k < WALK && !ahead; k++) {
        const next = outgoing.get(bEdges[f]![1]);
        if (next === undefined) break;
        if (next === Q.e) ahead = true;
        f = next;
      }
      if (ahead) folds++;
      else unmatched++;
      continue;
    }
    // Fan from p' over the target boundary's vertices to q': wound against A's edge, so the strip faces as A does.
    const poly = [P.p, ...path.map(pt), Q.p];
    for (let i = 1; i + 1 < poly.length; i++) fills.push(...poly[0]!, ...poly[i]!, ...poly[i + 1]!);
  }
  const bare = bEdges.filter((_, i) => reached[i] === 0);
  return { moved, fills, folds, unmatched, maxMove, normalJump, loose, bare };
}

function pushSoup(out: Assembled, s: Soup, tag: number, moved?: Map<number, [number, number, number]>): number {
  let folds = 0;
  const T = s.tris;
  const P = s.pos;
  for (let t = 0; t < T.length; t += 3) {
    const before: number[] = [];
    const after: number[] = [];
    let touched = false;
    for (let j = 0; j < 3; j++) {
      const v = T[t + j]!;
      const p = [P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!];
      before.push(...p);
      const m = moved?.get(v);
      if (m !== undefined) touched = true;
      after.push(...(m ?? p));
    }
    if (touched && faceDot(before, after) < 0) folds++;
    out.tri.push(...after);
    out.tag.push(tag);
  }
  return folds;
}

function faceNormal(t: readonly number[], o = 0): [number, number, number] {
  const ax = t[o + 3]! - t[o]!, ay = t[o + 4]! - t[o + 1]!, az = t[o + 5]! - t[o + 2]!;
  const bx = t[o + 6]! - t[o]!, by = t[o + 7]! - t[o + 1]!, bz = t[o + 8]! - t[o + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function faceDot(a: readonly number[], b: readonly number[]): number {
  const n = faceNormal(a);
  const m = faceNormal(b);
  return n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
}

/** Flaps under every boundary edge at the plane: inward along the vertices' normals, or straight down. */
function skirts(out: Assembled, s: Soup, edges: Array<[number, number]>, depth: number, down: boolean): number {
  const P = s.pos;
  let n = 0;
  for (const [p, q] of edges) {
    const np = down ? [0, 1, 0] : s.normal(p);
    const nq = down ? [0, 1, 0] : s.normal(q);
    const a = [P[3 * p]!, P[3 * p + 1]!, P[3 * p + 2]!];
    const b = [P[3 * q]!, P[3 * q + 1]!, P[3 * q + 2]!];
    const ad = [a[0]! - depth * np[0]!, a[1]! - depth * np[1]!, a[2]! - depth * np[2]!];
    const bd = [b[0]! - depth * nq[0]!, b[1]! - depth * nq[1]!, b[2]! - depth * nq[2]!];
    // The edge runs p → q in its triangle: the flap takes q → p, continuing the surface over the edge.
    out.tri.push(...b, ...a, ...ad, ...b, ...ad, ...bd);
    out.tag.push(2, 2);
    n += 2;
  }
  return n;
}

/** Flaps (inward along the normals, `depth` cells) under edges of `s` at positions `at` gives (moved or not). */
function flaps(out: Assembled, s: Soup, edges: Array<[number, number]>, depth: number, at: (v: number) => readonly number[]): number {
  for (const [p, q] of edges) {
    const np = s.normal(p);
    const nq = s.normal(q);
    const a = at(p);
    const b = at(q);
    const ad = [a[0]! - depth * np[0], a[1]! - depth * np[1], a[2]! - depth * np[2]];
    const bd = [b[0]! - depth * nq[0], b[1]! - depth * nq[1], b[2]! - depth * nq[2]];
    out.tri.push(...b, ...a, ...ad, ...b, ...ad, ...bd);
    out.tag.push(2, 2);
  }
  return 2 * edges.length;
}

/** Inside / outside of every surface at a level: the cells a box of `half` cells round the point touches, all full or all empty. */
function boxIs(view: (x: number, y: number, z: number, out: VoxelRecord) => VoxelRecord, scale: number, half: number, x: number, y: number, z: number, want: 'full' | 'empty', v: VoxelRecord): boolean {
  const lo = (c: number): number => Math.floor(c / scale - half);
  const hi = (c: number): number => Math.floor(c / scale + half);
  for (let i = lo(x); i <= hi(x); i++) for (let j = lo(y); j <= hi(y); j++) for (let k = lo(z); k <= hi(z); k++) {
    view(i, j, k, v);
    const solidRole = v.role === VOXEL_ROLE.terrain || (v.role >= VOXEL_ROLE.wall && v.role <= VOXEL_ROLE.pillar);
    if (want === 'full' ? !(solidRole && v.shape === SHAPE_FULL) : solidRole && v.shape > 0) return false;
  }
  return true;
}

/**
 * Margins (cells of each level): a surface lies within a third of a cell of
 * its voxels' boundary (rounded corners), so 0.4 keeps a point clear of it.
 * Inside at level 0 asks for 0.9: one-cell bodies (posts, rails, thin
 * walls) may be drawn as detail pieces, not surfaces.
 */
const MARGIN = 0.4;
const INSIDE_L0 = 0.9;

class Truth {
  private readonly views: Array<{ scale: number; at: (x: number, y: number, z: number, out: VoxelRecord) => VoxelRecord }>;
  private readonly v = voxel();

  constructor(store: PaletteStore, tree: MipTree, levels: readonly number[]) {
    this.views = [{ scale: 1, at: (x, y, z, out) => store.voxelAt(x, y, z, out) }];
    for (const l of levels) if (l > 0) {
      const view: MipLevelView = tree.level(l);
      this.views.push({ scale: 1 << l, at: (x, y, z, out) => view.voxelAt(x, y, z, out) });
    }
  }

  inside(x: number, y: number, z: number): boolean {
    return this.views.every((w, k) => boxIs(w.at, w.scale, k === 0 ? INSIDE_L0 : MARGIN, x, y, z, 'full', this.v));
  }

  outside(x: number, y: number, z: number): boolean {
    return this.views.every((w) => boxIs(w.at, w.scale, MARGIN, x, y, z, 'empty', this.v));
  }
}

/** Triangles bucketed in a uniform grid for ray segments (Amanatides–Woo walk). */
class TriGrid {
  private readonly cells = new Map<string, number[]>();
  private stamp: Int32Array;
  private now = 0;

  constructor(readonly soup: Assembled, readonly size: number, keep: (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => boolean) {
    const T = soup.tri;
    const n = T.length / 9;
    this.stamp = new Int32Array(n);
    for (let t = 0; t < n; t++) {
      const o = 9 * t;
      const x0 = Math.min(T[o]!, T[o + 3]!, T[o + 6]!), x1 = Math.max(T[o]!, T[o + 3]!, T[o + 6]!);
      const y0 = Math.min(T[o + 1]!, T[o + 4]!, T[o + 7]!), y1 = Math.max(T[o + 1]!, T[o + 4]!, T[o + 7]!);
      const z0 = Math.min(T[o + 2]!, T[o + 5]!, T[o + 8]!), z1 = Math.max(T[o + 2]!, T[o + 5]!, T[o + 8]!);
      if (!keep(x0, x1, y0, y1, z0, z1)) continue;
      const s = size;
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) for (let k = Math.floor(z0 / s); k <= Math.floor(z1 / s); k++) {
        const key = `${i},${j},${k}`;
        let list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, (list = []));
        list.push(t);
      }
    }
  }

  /**
   * The first front-facing hit along the segment (its tag), or null: what a
   * renderer culling back faces shows there (null: it sees through).
   */
  firstFront(r: Ray): { tag: number } | null {
    const s = this.size;
    const [ox, oy, oz] = r.o;
    const [dx, dy, dz] = r.d;
    let i = Math.floor(ox / s), j = Math.floor(oy / s), k = Math.floor(oz / s);
    const si = Math.sign(dx), sj = Math.sign(dy), sk = Math.sign(dz);
    const next = (c: number, o: number, d: number, sg: number): number => (d === 0 ? Infinity : ((c + (sg > 0 ? 1 : 0)) * s - o) / d);
    let tx = next(i, ox, dx, si), ty = next(j, oy, dy, sj), tz = next(k, oz, dz, sk);
    const ddx = dx === 0 ? Infinity : s / Math.abs(dx), ddy = dy === 0 ? Infinity : s / Math.abs(dy), ddz = dz === 0 ? Infinity : s / Math.abs(dz);
    this.now++;
    let best = Infinity;
    let hit: { tag: number } | null = null;
    let t0 = 0;
    const T = this.soup.tri;
    while (t0 <= r.len && t0 <= best) {
      for (const t of this.cells.get(`${i},${j},${k}`) ?? []) {
        if (this.stamp[t] === this.now) continue;
        this.stamp[t] = this.now;
        const o = 9 * t;
        const e1x = T[o + 3]! - T[o]!, e1y = T[o + 4]! - T[o + 1]!, e1z = T[o + 5]! - T[o + 2]!;
        const e2x = T[o + 6]! - T[o]!, e2y = T[o + 7]! - T[o + 1]!, e2z = T[o + 8]! - T[o + 2]!;
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        // Counter-clockwise from outside: the ray meets the front when it runs against the normal (det > 0).
        if (det < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - T[o]!, sy = oy - T[o + 1]!, sz = oz - T[o + 2]!;
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d < 0 || d > r.len || d >= best) continue;
        best = d;
        hit = { tag: this.soup.tag[t]! };
      }
      if (tx <= ty && tx <= tz) {
        t0 = tx;
        tx += ddx;
        i += si;
      } else if (ty <= tz) {
        t0 = ty;
        ty += ddy;
        j += sj;
      } else {
        t0 = tz;
        tz += ddz;
        k += sk;
      }
    }
    return hit;
  }
}

/** The 50 directions: straight down and up, and 8 azimuths at ±5°, ±20°, ±60° (negative: going down). */
function directions(): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [[0, -1, 0], [0, 1, 0]];
  for (let a = 0; a < 8; a++) for (const el of [-60, -20, -5, 5, 20, 60]) {
    const az = (a * Math.PI) / 4;
    const e = (el * Math.PI) / 180;
    out.push([Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)]);
  }
  return out;
}

/** The patch's rays (valid ones only: from outside every surface to inside every surface). */
function patchRays(spec: SeamPatchSpec, truth: Truth, sides: readonly Side[], yTop: number, yBottom: number): Ray[] {
  const c = spec.fine + 1;
  const coarse = 1 << c;
  const step = spec.sparse ?? 1;
  const alongAxis = spec.axis === 0 ? 2 : 0;
  const rays: Ray[] = [];
  const at = (u: number, s: number, y: number): [number, number, number] => (spec.axis === 0 ? [u, y, s] : [s, y, u]);
  // From above: a grid 1/4 cell apart over two coarse cells either side of the plane.
  for (let s = spec.along[0]; s < spec.along[1]; s += 0.25 * step) {
    for (let u = spec.face - 2 * coarse + 0.125; u < spec.face + 2 * coarse; u += 0.25 * step) {
      // The first point inside every surface going down the column.
      let target: number | null = null;
      for (let y = yTop; y > yBottom; y -= 0.5) {
        const [x, , z] = at(u, s, y);
        if (truth.inside(x, y, z)) {
          target = y;
          break;
        }
      }
      if (target === null) continue;
      const [x, , z] = at(u, s, 0);
      rays.push({ o: [x, yTop, z], d: [0, -1, 0], len: yTop - target });
    }
  }
  // Through points on the plane near either side's boundary, in every direction.
  const dirs = directions();
  const heights = new Map<number, Set<number>>();
  for (const side of sides) for (const soup of [side.ground, side.base]) {
    for (const [p, q] of seamEdges(soup, spec.axis, spec.face, 0.5 * (1 << side.level) + 1e-6)) {
      const P = soup.pos;
      const s0 = P[3 * p + alongAxis]!, s1 = P[3 * q + alongAxis]!;
      const y0 = P[3 * p + 1]!, y1 = P[3 * q + 1]!;
      const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
      for (let s = Math.ceil(lo / (0.5 * step)) * 0.5 * step; s <= hi; s += 0.5 * step) {
        if (s < spec.along[0] || s >= spec.along[1]) continue;
        const y = hi === lo ? y0 : y0 + ((s - s0) / (s1 - s0)) * (y1 - y0);
        let set = heights.get(s);
        if (set === undefined) heights.set(s, (set = new Set()));
        for (let k = -8; k <= 8; k += step) set.add(Math.round((y + (k / 8) * coarse) * 64) / 64);
      }
    }
  }
  const reach = [2 * coarse, 4 * coarse];
  for (const [s, ys] of heights) for (const y of ys) {
    const [px, , pz] = at(spec.face, s, y);
    for (const d of dirs) {
      let origin: [number, number, number] | null = null;
      for (const a of reach) {
        const o: [number, number, number] = [px - d[0] * a, y - d[1] * a, pz - d[2] * a];
        if (truth.outside(...o)) {
          origin = o;
          break;
        }
      }
      if (origin === null) continue;
      const a = Math.hypot(px - origin[0], y - origin[1], pz - origin[2]);
      for (const b of reach) {
        if (truth.inside(px + d[0] * b, y + d[1] * b, pz + d[2] * b)) {
          rays.push({ o: origin, d, len: a + b });
          break;
        }
      }
    }
  }
  return rays;
}

/** Open edges in the band not lying along another open edge (within `tol` cells): their count and length in metres. */
function openLength(soup: Assembled, inBand: (x: number, y: number, z: number) => boolean, tol: number): { edges: number; m: number } {
  const T = soup.tri;
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const id = (o: number): number => {
    const key = `${T[o]!.toFixed(6)},${T[o + 1]!.toFixed(6)},${T[o + 2]!.toFixed(6)}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      ids.set(key, v);
      pos.push(T[o]!, T[o + 1]!, T[o + 2]!);
    }
    return v;
  };
  const directed = new Set<string>();
  const list: Array<[number, number]> = [];
  for (let t = 0; t < T.length; t += 9) {
    const a = id(t), b = id(t + 3), c = id(t + 6);
    if (a === b || b === c || c === a) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      directed.add(`${p},${q}`);
      list.push([p, q]);
    }
  }
  const open = list.filter(([p, q]) => !directed.has(`${q},${p}`) && inBand(pos[3 * p]!, pos[3 * p + 1]!, pos[3 * p + 2]!) && inBand(pos[3 * q]!, pos[3 * q + 1]!, pos[3 * q + 2]!));
  // Buckets of a cell for the covering test.
  const buckets = new Map<string, number[]>();
  open.forEach(([p, q], i) => {
    const keys = new Set<string>();
    for (let f = 0; f <= 1; f += 0.25) keys.add([0, 1, 2].map((a) => Math.floor(pos[3 * p + a]! + f * (pos[3 * q + a]! - pos[3 * p + a]!))).join(','));
    for (const k of keys) {
      let l = buckets.get(k);
      if (l === undefined) buckets.set(k, (l = []));
      l.push(i);
    }
  });
  let m = 0;
  let edges = 0;
  open.forEach(([p, q], i) => {
    const len = Math.hypot(pos[3 * q]! - pos[3 * p]!, pos[3 * q + 1]! - pos[3 * p + 1]!, pos[3 * q + 2]! - pos[3 * p + 2]!);
    let bare = 0;
    const N = 8;
    for (let k = 0; k < N; k++) {
      const f = (k + 0.5) / N;
      const x = pos[3 * p]! + f * (pos[3 * q]! - pos[3 * p]!), y = pos[3 * p + 1]! + f * (pos[3 * q + 1]! - pos[3 * p + 1]!), z = pos[3 * p + 2]! + f * (pos[3 * q + 2]! - pos[3 * p + 2]!);
      let covered = false;
      for (const j of buckets.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) ?? []) {
        if (j === i) continue;
        const [u, w] = open[j]!;
        const [cx, cy, cz] = closestOnSegment(x, y, z, pos[3 * u]!, pos[3 * u + 1]!, pos[3 * u + 2]!, pos[3 * w]!, pos[3 * w + 1]!, pos[3 * w + 2]!);
        if ((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2 <= tol * tol) {
          covered = true;
          break;
        }
      }
      if (!covered) bare++;
    }
    if (bare > 0) edges++;
    m += (bare / N) * len * M_PER_CELL;
  });
  return { edges, m };
}

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/** Builds a patch, runs every candidate and measures them against the two one-level controls. */
export function measurePatch(spec: SeamPatchSpec, candidates: readonly SeamCandidate[] = SEAM_CANDIDATES): PatchReport {
  const f = spec.fine;
  const c = f + 1;
  const coarse = 1 << c;
  const spanC = E << c;
  const ext = 4 * coarse + 2;
  const along: [number, number] = [Math.floor((spec.along[0] - ext) / spanC) * spanC, Math.ceil((spec.along[1] + ext) / spanC) * spanC];
  const cy = nodeYRange(spec.store);
  const tree = new MipTree(spec.store);
  const fineSide = buildSide(spec, tree, f, spec.fineBelow, along, cy);
  const coarseSide = buildSide(spec, tree, c, !spec.fineBelow, along, cy);
  const truth = new Truth(spec.store, tree, [f, c]);
  const yTop = (cy[1] + 1) * E + 2;
  const yBottom = (cy[0] - 1) * E;
  const alongAxis = spec.axis === 0 ? 2 : 0;
  const tolOf = (level: number): number => 0.5 * (1 << level) + 1e-6;
  const inBand = (x: number, y: number, z: number): boolean => {
    const p = [x, y, z];
    return Math.abs(p[spec.axis]! - spec.face) <= coarse && p[alongAxis]! >= spec.along[0] && p[alongAxis]! < spec.along[1];
  };
  const keep = (x0: number, x1: number, _y0: number, _y1: number, z0: number, z1: number): boolean => {
    const lo = spec.axis === 0 ? x0 : z0, hi = spec.axis === 0 ? x1 : z1;
    const alo = spec.axis === 0 ? z0 : x0, ahi = spec.axis === 0 ? z1 : x1;
    return hi >= spec.face - ext && lo <= spec.face + ext && ahi >= spec.along[0] - ext && alo <= spec.along[1] + ext;
  };
  const stops = (soup: Assembled): ((r: Ray) => { tag: number } | null) => {
    const tg = new TriGrid(soup, Math.max(1, 1 << f), keep);
    return (r) => tg.firstFront(r);
  };
  // Rays the truth calls outside → inside that both levels alone (each level on both sides, no seam) stop: a ray
  // either control lets through is the truth's margin, not a seam, and is left out (counted).
  const truthRays = patchRays(spec, truth, [fineSide, coarseSide], yTop, yBottom);
  const fineSame = buildSide(spec, tree, f, !spec.fineBelow, along, cy);
  const coarseSame = buildSide(spec, tree, c, spec.fineBelow, along, cy);
  const controls = [[fineSide, fineSame], [coarseSame, coarseSide]].map(([a, b]) => {
    const soup: Assembled = { tri: [], tag: [] };
    for (const s of [a!.ground, a!.base, b!.ground, b!.base]) pushSoup(soup, s, 0);
    return stops(soup);
  });
  const controlMisses: [number, number] = [0, 0];
  const rays = truthRays.filter((r) => {
    const a = controls[0]!(r) !== null;
    const b = controls[1]!(r) !== null;
    if (!a) controlMisses[0]++;
    if (!b) controlMisses[1]++;
    return a && b;
  });
  const seamTriangles = fineSide.triangles + coarseSide.triangles;
  const results: SeamResult[] = [];
  const fineEdges = { ground: seamEdges(fineSide.ground, spec.axis, spec.face, tolOf(f)), base: seamEdges(fineSide.base, spec.axis, spec.face, tolOf(f)) };
  const coarseEdges = { ground: seamEdges(coarseSide.ground, spec.axis, spec.face, tolOf(c)), base: seamEdges(coarseSide.base, spec.axis, spec.face, tolOf(c)) };
  let normalJump: number[] = [];
  let gap = 0;
  for (const candidate of candidates) {
    const soup: Assembled = { tri: [], tag: [] };
    let added = 0;
    let folds = 0;
    let unmatched = 0;
    let maxMove = 0;
    // Only the seam's own work is timed (the move and the strip, or the flaps), not copying the meshes.
    let us = 0;
    if (candidate === 'none') {
      for (const s of [fineSide.ground, fineSide.base, coarseSide.ground, coarseSide.base]) pushSoup(soup, s, 0);
    } else if (candidate.startsWith('stitch') || candidate.startsWith('transition')) {
      const [mover, moverEdges, target, targetEdges] = candidate.startsWith('stitch') ? [fineSide, fineEdges, coarseSide, coarseEdges] : [coarseSide, coarseEdges, fineSide, fineEdges];
      for (const kind of ['ground', 'base'] as const) {
        const t0 = performance.now();
        const z = zip(mover[kind], moverEdges[kind], target[kind], targetEdges[kind], alongAxis, coarse);
        if (candidate.endsWith('+skirts')) {
          // A skirt under both sides' whole boundary behind the strip: where the boundaries differ in shape it shows.
          const M = mover[kind].pos;
          const T = target[kind].pos;
          added += flaps(soup, mover[kind], moverEdges[kind], coarse, (v) => z.moved.get(v) ?? [M[3 * v]!, M[3 * v + 1]!, M[3 * v + 2]!]);
          added += flaps(soup, target[kind], targetEdges[kind], coarse, (v) => [T[3 * v]!, T[3 * v + 1]!, T[3 * v + 2]!]);
        }
        if (candidate.endsWith('+flaps')) {
          // Where the two boundaries differ in shape (a tunnel one level has and the other not), a flap from each side.
          const M = mover[kind].pos;
          const T = target[kind].pos;
          added += flaps(soup, mover[kind], z.loose, coarse, (v) => z.moved.get(v) ?? [M[3 * v]!, M[3 * v + 1]!, M[3 * v + 2]!]);
          added += flaps(soup, target[kind], z.bare, coarse, (v) => [T[3 * v]!, T[3 * v + 1]!, T[3 * v + 2]!]);
        }
        us += (performance.now() - t0) * 1000;
        folds += z.folds + pushSoup(soup, mover[kind], 0, z.moved);
        pushSoup(soup, target[kind], 0);
        unmatched += z.unmatched;
        maxMove = Math.max(maxMove, z.maxMove);
        for (let k = 0; k < z.fills.length; k += 9) {
          soup.tri.push(...z.fills.slice(k, k + 9));
          soup.tag.push(1);
          added++;
        }
        if (candidate === 'stitch' && kind === 'ground') {
          normalJump = z.normalJump;
          gap = z.maxMove;
        }
      }
    } else {
      const down = candidate === 'skirts-down';
      for (const [side, edges] of [[fineSide, fineEdges], [coarseSide, coarseEdges]] as const) {
        for (const kind of ['ground', 'base'] as const) {
          pushSoup(soup, side[kind], 0);
          const t0 = performance.now();
          added += skirts(soup, side[kind], edges[kind], coarse, down);
          us += (performance.now() - t0) * 1000;
        }
      }
    }
    const first = stops(soup);
    let cracks = 0;
    let skirtFirst = 0;
    const crackSamples: Ray[] = [];
    for (const r of rays) {
      const h = first(r);
      if (h === null && crackSamples.length < 40 && cracks % 7 === 0) crackSamples.push(r);
      if (h === null) cracks++;
      else if (h.tag === 2) skirtFirst++;
    }
    const open = openLength(soup, inBand, 0.002);
    results.push({ candidate, crackRays: cracks, rays: rays.length, skirtFirst, openM: open.m, openEdges: open.edges, seamTriangles, addedTriangles: added, seamFaces: fineSide.seamNodes, us: us / Math.max(1, fineSide.seamNodes), maxMoveM: maxMove * M_PER_CELL, folds, unmatched, crackSamples });
  }
  return { name: spec.name, levels: `L${f}|L${c}`, results, truthRays: truthRays.length, controlMisses, normalJumpDeg: [quantile(normalJump, 0.5), quantile(normalJump, 0.95)], gapM: gap * M_PER_CELL };
}

/** A copy of `store` moved by whole chunks (dx, dz chunk steps), so a case's middle lands on a node face. */
export function shiftedStore(store: PaletteStore, dcx: number, dcz: number): PaletteStore {
  const out = createWorldStore(grid);
  const cells = createDenseChunk(grid);
  const c = { cx: 0, cy: 0, cz: 0 };
  for (const key of store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    if (store.exportChunk(c.cx, c.cy, c.cz, cells)) out.importChunk(c.cx + dcx, c.cy, c.cz + dcz, cells);
  }
  return out;
}

/** The hard cases a seam is cut through. */
export const SEAM_CASES = ['slope-1:5', 'bank-1:1', 'cliff-20m', 'terraces-1', 'terraces-2', 'overhang', 'arch', 'cave', 'wall-1', 'hole-1', 'bumps'];

/**
 * A seam across the row's cases at z = their middle: the row moved by one
 * chunk (L0 | L1: the face at z 64) or three (L1 | L2: z 128), the finer side
 * below.
 */
export function featureSpecs(fine: number, names: readonly string[] = SEAM_CASES, sparse = 1): SeamPatchSpec[] {
  const store = shiftedStore(featuresStore(), 0, fine === 0 ? 1 : 3);
  return featureCases()
    .filter((c) => names.includes(c.name))
    .map((c) => ({ name: c.name, store, fine, axis: 2, face: fine === 0 ? 64 : 128, fineBelow: true, along: [c.x0 + 8, c.x0 + 56], sparse }) as const);
}
