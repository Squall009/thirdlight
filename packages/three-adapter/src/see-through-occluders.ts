/**
 * See-through's occluders: what really stands between the camera and a
 * subject, found on the CPU (`see-through.ts` fades only these).
 *
 * The volume: from the camera to the subject's body (its capsule's axis, from
 * its feet to its top), widened by the capsule's radius and the padding. It
 * ends at the body: what stands behind or beside the subject is not in it.
 *
 * Block layers: rays from the camera to points on the subject's upper half
 * and its sides (the padding out) walk the layer's grid cell by cell, and the
 * cells and edge pieces they cross before they reach the body are occluders.
 * Each hit grows into its whole piece, a box of the grid: a wall run along
 * its longer horizontal run, then up and down, then through its thickness; a
 * pillar up its column; a slab across both. A piece reaches at most
 * {@link PIECE_REACH} cells along an axis: past that the circle round the
 * subject has long ended. A pixel belongs to a piece's box with its point
 * moved a quarter cell against its normal (the cut-away's rule,
 * `block-cutaway-view.ts`), so a face belongs to the cell it bounds: the
 * floor's top under a wall, the next wall's side, stay out of the box.
 *
 * Placed models: a draw whose bounds meet the volume is an occluder as a
 * whole. A draw of many members (a merged static cell, an instanced group)
 * says so ({@link SEE_THROUGH_MEMBERS_KEY}): its members' own bounds that
 * meet the volume are boxes, so only those members fade.
 */
import * as THREE from 'three/webgpu';
import { BLOCK_EDGE_THICKNESS } from '@thirdlight/runtime';

/** `userData[SEE_THROUGH_MEMBERS_KEY]` on a draw of many members: its members' world bounds (only those in front fade). */
export const SEE_THROUGH_MEMBERS_KEY = '__tlSeeThroughMembers';

/** A draw's members (world bounds), for see-through. */
export interface SeeThroughMembers {
  count(): number;
  /** Member `i`'s world bounds into `out` (false: none, an empty member). */
  box(i: number, out: THREE.Box3): boolean;
  /** Member `i`'s world bounding sphere into `out`, cheaper than its box (absent: the box is used); tested first. */
  sphere?(i: number, out: THREE.Sphere): boolean;
}

/** `userData[SEE_THROUGH_PIECES_KEY] = true` on a block layer's chunk draw: it fades only inside its pieces' boxes, never as a whole. */
export const SEE_THROUGH_PIECES_KEY = '__tlSeeThroughPieces';

/** Cells a pixel's point is moved against its face's normal before it is tested against a piece's box (into the cell the face bounds). */
export const PIECE_NUDGE = 0.25;
/** Cells a piece reaches at most along an axis either way from the cell a ray hit (a bound on the work, past any circle). */
export const PIECE_REACH = 16;
/** Pieces a layer's cache keeps before it starts again (the pieces round where the subjects went lately). */
const PIECE_CACHE = 256;

/** What the search reads of a block layer's grid (a `BlockGridReader`). */
export interface OccluderGrid {
  readonly min: readonly number[];
  readonly max: readonly number[];
  /** Edge pieces in the layer (none: rays skip looking for them). */
  readonly edgeCount: number;
  get(x: number, y: number, z: number): { readonly block?: string } | null;
  edgeIndexAt(x: number, y: number, z: number, axis: number): number;
}

/** A block layer as the search reads it. */
export interface OccluderLayer {
  readonly id: string;
  /** World position of cell (0, 0, 0)'s corner. */
  readonly origin: readonly number[];
  readonly cellSize: readonly number[];
  readonly grid: OccluderGrid;
  /** Bumped whenever its cells change (the search runs again). */
  readonly version: number;
}

/** One occluder: a world box, the metres a pixel's point is moved against its normal, and a key that names it across frames. */
export interface OccluderBox {
  readonly key: string;
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  nudge: number;
}

/** What a subject's volume is made from (`SubjectExtent` with the capsule's radius). */
export interface VolumeSubject {
  readonly centre: THREE.Vector3;
  readonly feet: number;
  readonly height: number;
  readonly radius: number;
}

const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** The squared distance from `p` to the triangle (a, b, c) (Ericson's closest point, region by region). */
function distanceToTriangleSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _ap.subVectors(p, a);
  const d1 = _ab.dot(_ap);
  const d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) return _ap.lengthSq();
  _d.subVectors(p, b);
  const d3 = _ab.dot(_d);
  const d4 = _ac.dot(_d);
  if (d3 >= 0 && d4 <= d3) return _d.lengthSq();
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return _c.copy(a).addScaledVector(_ab, d1 / (d1 - d3)).distanceToSquared(p);
  _d.subVectors(p, c);
  const d5 = _ab.dot(_d);
  const d6 = _ac.dot(_d);
  if (d6 >= 0 && d5 <= d6) return _d.lengthSq();
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return _c.copy(a).addScaledVector(_ac, d2 / (d2 - d6)).distanceToSquared(p);
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return _c.subVectors(c, b).multiplyScalar(w).add(b).distanceToSquared(p);
  }
  const denom = 1 / (va + vb + vc);
  return _c.copy(a).addScaledVector(_ab, vb * denom).addScaledVector(_ac, vc * denom).distanceToSquared(p);
}

/**
 * The volume from the camera to a subject's body, widened by the body's
 * radius and the padding: the triangle from the eye to the body's axis,
 * swept by a sphere of that width, cut off behind the body.
 */
export class SubjectVolume {
  readonly eye = new THREE.Vector3();
  /** The body's axis: its feet and its top. */
  readonly foot = new THREE.Vector3();
  readonly top = new THREE.Vector3();
  readonly centre = new THREE.Vector3();
  /** The capsule's radius and that plus the padding. */
  radius = 0;
  reach = 0;
  padding = 0;
  /** Height of the half-height plane (nothing below it fades). */
  half = 0;
  height = 0;
  feet = 0;
  /** Across the view, level (the side the rays are spread to), and along it, level, away from the eye (null length: a camera straight above). */
  readonly right = new THREE.Vector3();
  readonly away = new THREE.Vector3();
  /** The volume's bounding box. */
  readonly box = new THREE.Box3();

  set(eye: THREE.Vector3, s: VolumeSubject, padding: number): this {
    this.eye.copy(eye);
    this.centre.copy(s.centre);
    this.radius = s.radius;
    this.padding = padding;
    this.reach = s.radius + padding;
    this.feet = s.feet;
    this.height = s.height;
    this.half = s.feet + s.height / 2;
    this.foot.set(s.centre.x, s.feet, s.centre.z);
    this.top.set(s.centre.x, s.feet + s.height, s.centre.z);
    this.away.set(s.centre.x - eye.x, 0, s.centre.z - eye.z);
    const len = this.away.length();
    if (len > 1e-3) {
      this.away.divideScalar(len);
      this.right.set(-this.away.z, 0, this.away.x);
    } else {
      this.away.set(0, 0, 0);
      this.right.set(1, 0, 0);
    }
    this.box.makeEmpty().expandByPoint(eye).expandByPoint(this.foot).expandByPoint(this.top).expandByScalar(this.reach);
    return this;
  }

  /**
   * Whether a sphere (world centre, radius) meets the volume: within reach of the triangle from the eye to the
   * axis, not wholly below the half-height plane, and not wholly behind the body (farther from the eye across the
   * ground than the body's far side).
   */
  meetsSphere(c: THREE.Vector3, r: number): boolean {
    if (c.y + r < this.half) return false;
    const b = this.box;
    if (c.x + r < b.min.x || c.x - r > b.max.x || c.y + r < b.min.y || c.y - r > b.max.y || c.z + r < b.min.z || c.z - r > b.max.z) return false;
    const behind = (c.x - this.centre.x) * this.away.x + (c.z - this.centre.z) * this.away.z;
    if (behind - r > this.reach) return false;
    const w = r + this.reach;
    return distanceToTriangleSq(c, this.eye, this.foot, this.top) < w * w;
  }

  /** Whether a box meets the volume (by the sphere round it). */
  meetsBox(box: THREE.Box3): boolean {
    box.getCenter(_v);
    return this.meetsSphere(_v, box.min.distanceTo(box.max) / 2);
  }

  /**
   * The points the rays aim at: across the body (the reach either side, and half of it) at half its height, three
   * quarters and its top, and one the padding over its head. `visit` gets each and the ray's length to it, up to
   * where it meets the body.
   */
  targets(visit: (x: number, y: number, z: number) => void): void {
    const r = this.reach;
    for (const h of RAY_HEIGHTS) {
      const y = this.feet + this.height * h;
      for (const s of RAY_SIDES) visit(this.centre.x + this.right.x * r * s, y, this.centre.z + this.right.z * r * s);
    }
    visit(this.centre.x, this.feet + this.height + this.padding, this.centre.z);
  }
}

/** The heights (shares of the body's) and sides (shares of the reach) the rays aim at: 16 rays a subject. */
const RAY_HEIGHTS = [0.5, 0.75, 1] as const;
const RAY_SIDES = [-1, -0.5, 0, 0.5, 1] as const;
const _v = new THREE.Vector3();

/** A cell or edge piece a ray crossed (layer cells; `axis` −1: a cell, 0 / 1: the edge on that line). */
interface Hit {
  x: number;
  y: number;
  z: number;
  axis: number;
}

/**
 * What the search asks of a layer's cells, remembered while its cells stay as they are (a grid lookup builds a
 * chunk key; the rays of every subject and frame cross the same cells). Cells and edges by a numeric key.
 */
class CellMemo {
  private readonly cells = new Map<number, boolean>();
  private readonly edges = new Map<number, boolean>();
  constructor(private readonly g: OccluderGrid) {}

  private static key(x: number, y: number, z: number, axis: number): number {
    // Layers span at most a few thousand cells a side: 2^13 per axis (offset to stay positive) and the edge axis.
    return (((x + 4096) * 8192 + (z + 4096)) * 2048 + (y + 1024)) * 2 + axis;
  }

  solid(x: number, y: number, z: number): boolean {
    if (this.cells.size > MEMO_CELLS) this.cells.clear();
    const k = CellMemo.key(x, y, z, 0);
    let v = this.cells.get(k);
    if (v === undefined) this.cells.set(k, (v = this.g.get(x, y, z)?.block !== undefined));
    return v;
  }

  edge(x: number, y: number, z: number, axis: number): boolean {
    if (this.g.edgeCount === 0) return false;
    if (this.edges.size > MEMO_CELLS) this.edges.clear();
    const k = CellMemo.key(x, y, z, axis);
    let v = this.edges.get(k);
    if (v === undefined) this.edges.set(k, (v = this.g.edgeIndexAt(x, y, z, axis) >= 0));
    return v;
  }
}

/** Cells a layer's memo holds before it starts again. */
const MEMO_CELLS = 1 << 16;

/**
 * Walk one ray (world, from `eye` toward `to`, `length` metres) through a layer's cells, calling `hit` for every
 * filled cell and every edge piece it crosses, in order (an Amanatides–Woo walk; no allocation).
 */
function walkRay(layer: OccluderLayer, memo: CellMemo, eye: THREE.Vector3, to: THREE.Vector3, length: number, hit: (h: Hit) => void): void {
  const cs = layer.cellSize;
  const g = layer.grid;
  const dx = to.x - eye.x;
  const dy = to.y - eye.y;
  const dz = to.z - eye.z;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0) || !(length > 0)) return;
  // In cells, per metre along the ray.
  const o = [(eye.x - layer.origin[0]!) / cs[0]!, (eye.y - layer.origin[1]!) / cs[1]!, (eye.z - layer.origin[2]!) / cs[2]!];
  const dc = [dx / len / cs[0]!, dy / len / cs[1]!, dz / len / cs[2]!];
  // The layer's box (its edges reach one past it across x and z).
  const lo = [g.min[0]! - 1, g.min[1]!, g.min[2]! - 1];
  const hi = [g.max[0]! + 1, g.max[1]!, g.max[2]! + 1];
  let t0 = 0;
  let t1 = length;
  for (let a = 0; a < 3; a++) {
    if (dc[a] === 0) {
      if (o[a]! < lo[a]! || o[a]! >= hi[a]!) return;
      continue;
    }
    let ta = (lo[a]! - o[a]!) / dc[a]!;
    let tb = (hi[a]! - o[a]!) / dc[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  if (t0 > t1) return;
  // A hair past the entry, so the first cell is the one entered.
  const ts = t0 + 1e-6;
  const cell = [Math.floor(o[0]! + dc[0]! * ts), Math.floor(o[1]! + dc[1]! * ts), Math.floor(o[2]! + dc[2]! * ts)];
  const step = [Math.sign(dc[0]!), Math.sign(dc[1]!), Math.sign(dc[2]!)];
  const tMax = [0, 0, 0];
  const tDelta = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    if (dc[a] === 0) {
      tMax[a] = Infinity;
      tDelta[a] = Infinity;
      continue;
    }
    const boundary = dc[a]! > 0 ? cell[a]! + 1 : cell[a]!;
    tMax[a] = (boundary - o[a]!) / dc[a]!;
    tDelta[a] = Math.abs(1 / dc[a]!);
  }
  const h: Hit = { x: 0, y: 0, z: 0, axis: -1 };
  for (;;) {
    if (cell[1]! >= g.min[1]! && cell[1]! < g.max[1]! && memo.solid(cell[0]!, cell[1]!, cell[2]!)) {
      h.x = cell[0]!;
      h.y = cell[1]!;
      h.z = cell[2]!;
      h.axis = -1;
      hit(h);
    }
    let a = 0;
    if (tMax[1]! < tMax[a]!) a = 1;
    if (tMax[2]! < tMax[a]!) a = 2;
    if (tMax[a]! > t1) return;
    if (a !== 1 && cell[1]! >= g.min[1]! && cell[1]! < g.max[1]!) {
      // Crossing a vertical cell side: the edge on it is stored with the cell on its + side.
      const plane = step[a]! > 0 ? cell[a]! + 1 : cell[a]!;
      const ex = a === 0 ? plane : cell[0]!;
      const ez = a === 2 ? plane : cell[2]!;
      const axis = a === 0 ? 0 : 1;
      if (memo.edge(ex, cell[1]!, ez, axis)) {
        h.x = ex;
        h.y = cell[1]!;
        h.z = ez;
        h.axis = axis;
        hit(h);
      }
    }
    cell[a] = cell[a]! + step[a]!;
    tMax[a] = tMax[a]! + tDelta[a]!;
    if (cell[a]! < lo[a]! || cell[a]! >= hi[a]!) return;
  }
}

/** A box of layer cells (min inclusive, max exclusive), as a piece grows. */
type CellBox = [number, number, number, number, number, number];

/** Whether every cell of the box is filled (`axis` −1) or carries an edge piece on the given line. */
function allFilled(g: CellMemo, b: CellBox, axis: number): boolean {
  for (let x = b[0]; x < b[3]; x++)
    for (let y = b[1]; y < b[4]; y++)
      for (let z = b[2]; z < b[5]; z++) {
        if (axis < 0 ? !g.solid(x, y, z) : !g.edge(x, y, z, axis)) return false;
      }
  return true;
}

/** Grow box `b` along axis `a` (0 x, 1 y, 2 z) both ways while the next layer of cells is all filled, up to the reach from `from`. */
function grow(g: CellMemo, b: CellBox, a: number, from: number, axis: number): void {
  const next: CellBox = [0, 0, 0, 0, 0, 0];
  for (const dir of [1, -1]) {
    for (;;) {
      const at = dir > 0 ? b[a + 3]! : b[a]! - 1;
      if (Math.abs(at - from) >= PIECE_REACH) break;
      for (let k = 0; k < 6; k++) next[k] = b[k]!;
      next[a] = at;
      next[a + 3] = at + 1;
      if (!allFilled(g, next, axis)) break;
      if (dir > 0) b[a + 3] = at + 1;
      else b[a] = at;
    }
  }
}

/** The run of filled cells (or edge pieces) through a hit along axis `a`: its length. */
function runLength(g: CellMemo, h: Hit, a: number, axis: number): number {
  const b: CellBox = [h.x, h.y, h.z, h.x + 1, h.y + 1, h.z + 1];
  grow(g, b, a, a === 0 ? h.x : a === 1 ? h.y : h.z, axis);
  return b[a + 3]! - b[a]!;
}

/** The whole piece a hit belongs to, in cells (a cell box; an edge piece's box spans its line, thickness added later). */
function pieceOf(g: CellMemo, h: Hit): CellBox {
  const b: CellBox = [h.x, h.y, h.z, h.x + 1, h.y + 1, h.z + 1];
  const from = [h.x, h.y, h.z];
  if (h.axis >= 0) {
    // An edge piece: along its line (z for an x line, x for a z line), then up and down.
    const along = h.axis === 0 ? 2 : 0;
    grow(g, b, along, from[along]!, h.axis);
    grow(g, b, 1, h.y, h.axis);
    return b;
  }
  // A cell: along its longer level run, then up and down, then across.
  const first = runLength(g, h, 0, -1) >= runLength(g, h, 2, -1) ? 0 : 2;
  grow(g, b, first, from[first]!, -1);
  grow(g, b, 1, h.y, -1);
  const other = first === 0 ? 2 : 0;
  grow(g, b, other, from[other]!, -1);
  return b;
}

const _to = new THREE.Vector3();

/** A piece found in a layer: its cells (an edge piece's on its line, `axis` 0 or 1; a cell piece's, −1) and its box. */
interface Piece {
  readonly b: CellBox;
  readonly axis: number;
  readonly box: OccluderBox;
}

/** A layer's pieces and its cells as the search asked for them, for one version of the layer. */
export interface LayerPieces {
  readonly key: string;
  readonly grid: OccluderGrid;
  readonly pieces: Piece[];
  readonly memo: CellMemo;
}

/**
 * A layer's pieces, kept while its cells and place stay as they are: pieces depend on the grid alone, so the
 * subjects and frames that hit the same wall share it, and a moving camera only walks its rays.
 */
export class PieceCache {
  private readonly layers = new Map<string, LayerPieces>();

  /** The pieces of a layer as it is now (none kept from an older version). */
  of(layer: OccluderLayer): LayerPieces {
    const key = `${layer.version}|${layer.origin.join(',')}|${layer.cellSize.join(',')}`;
    let c = this.layers.get(layer.id);
    if (c === undefined || c.key !== key || c.grid !== layer.grid || c.pieces.length > PIECE_CACHE) this.layers.set(layer.id, (c = { key, grid: layer.grid, pieces: [], memo: new CellMemo(layer.grid) }));
    return c;
  }

  /** Forget the layers not among `ids`. */
  keep(ids: ReadonlySet<string>): void {
    for (const id of this.layers.keys()) if (!ids.has(id)) this.layers.delete(id);
  }
}

/**
 * A subject's occluders in a block layer, appended to `out` (a piece already in `out` is not added again): every
 * piece a ray from the eye to the body crosses before it meets the body. `pieces` is the layer's cache
 * ({@link PieceCache}): a hit inside a piece found before is that piece.
 */
export function layerOccluders(layer: OccluderLayer, vol: SubjectVolume, out: OccluderBox[], cache: LayerPieces = new PieceCache().of(layer)): void {
  const { pieces, memo } = cache;
  const cs = layer.cellSize;
  const og = layer.origin;
  const nudge = PIECE_NUDGE * Math.min(cs[0]!, cs[1]!, cs[2]!);
  // Edge pieces are a slab across their line: the thickness either side, and the nudge.
  const half = BLOCK_EDGE_THICKNESS / 2 + PIECE_NUDGE;
  const keys = new Set(out.map((b) => b.key));
  const add = (box: OccluderBox): void => {
    if (keys.has(box.key)) return;
    keys.add(box.key);
    out.push(box);
  };
  vol.targets((x, y, z) => {
    _to.set(x, y, z);
    const length = vol.eye.distanceTo(_to) - vol.radius;
    walkRay(layer, memo, vol.eye, _to, length, (h) => {
      for (const { b, axis, box } of pieces) {
        if (axis === h.axis && h.x >= b[0] && h.x < b[3] && h.y >= b[1] && h.y < b[4] && h.z >= b[2] && h.z < b[5]) return add(box);
      }
      const p = pieceOf(memo, h);
      const key = `${layer.id}|${h.axis < 0 ? 'c' : `e${h.axis}`}|${p.join(',')}`;
      const min = new THREE.Vector3(p[0], p[1], p[2]);
      const max = new THREE.Vector3(p[3], p[4], p[5]);
      if (h.axis === 0) {
        min.x = p[0] - half;
        max.x = p[0] + half;
      } else if (h.axis === 1) {
        min.z = p[2] - half;
        max.z = p[2] + half;
      }
      min.set(og[0]! + min.x * cs[0]!, og[1]! + min.y * cs[1]!, og[2]! + min.z * cs[2]!);
      max.set(og[0]! + max.x * cs[0]!, og[1]! + max.y * cs[1]!, og[2]! + max.z * cs[2]!);
      const box = { key, min, max, nudge };
      pieces.push({ b: p, axis: h.axis, box });
      add(box);
    });
  });
}

const _box = new THREE.Box3();
const _memberSphere = new THREE.Sphere();

/** A draw's members that meet the volume, appended to `out` as boxes (no nudge: a member's bounds hold it whole). */
export function memberOccluders(draw: THREE.Object3D, members: SeeThroughMembers, vol: SubjectVolume, out: OccluderBox[]): void {
  const n = members.count();
  for (let i = 0; i < n; i++) {
    if (members.sphere !== undefined && (!members.sphere(i, _memberSphere) || !vol.meetsSphere(_memberSphere.center, _memberSphere.radius))) continue;
    if (!members.box(i, _box) || _box.isEmpty() || !vol.meetsBox(_box)) continue;
    out.push({ key: `${draw.id}|m|${i}`, min: _box.min.clone(), max: _box.max.clone(), nudge: 0 });
  }
}

/** The volume two boxes' union adds over their own (what merging them costs). */
function mergeCost(a: { min: THREE.Vector3; max: THREE.Vector3 }, b: { min: THREE.Vector3; max: THREE.Vector3 }): number {
  const vol = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => Math.max(0, x1 - x0) * Math.max(0, y1 - y0) * Math.max(0, z1 - z0);
  const u = vol(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z), Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z));
  return u - vol(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z) - vol(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
}

/** A box as packed: world bounds, its nudge (metres) and its fade. */
export interface PackedBox {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
  nudge: number;
  fade: number;
}

/**
 * Fit `boxes` into `size`: while there are more, the two whose union adds the least volume become their union
 * (the smaller nudge, the larger fade), so no occluder is ever left out. Changes `boxes` in place.
 */
export function mergeToFit(boxes: PackedBox[], size: number): void {
  while (boxes.length > size) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const c = mergeCost(boxes[i]!, boxes[j]!);
        if (c < best) {
          best = c;
          bi = i;
          bj = j;
        }
      }
    const a = boxes[bi]!;
    const b = boxes[bj]!;
    a.min.min(b.min);
    a.max.max(b.max);
    a.nudge = Math.min(a.nudge, b.nudge);
    a.fade = Math.max(a.fade, b.fade);
    boxes.splice(bj, 1);
  }
}

/** Whether a sphere (world) comes within `r` of a box. */
export function sphereMeetsBox(c: THREE.Vector3, r: number, min: THREE.Vector3, max: THREE.Vector3): boolean {
  const dx = Math.max(min.x - c.x, 0, c.x - max.x);
  const dy = Math.max(min.y - c.y, 0, c.y - max.y);
  const dz = Math.max(min.z - c.z, 0, c.z - max.z);
  return dx * dx + dy * dy + dz * dz < r * r;
}
