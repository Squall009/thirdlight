/**
 * One-cell-thick house shells at every level: closed houses (walls,
 * floor and roof one cell thick, no openings) floating in air, derived at
 * level 0 and as mip nodes, their base surfaces welded per level and
 * measured:
 * - watertight: every edge two triangles wound opposite ways;
 * - closed: every ray from the inside meets the shell (a roofless frame
 *   lets the sky in);
 * - silhouette: the view from above and from two sides, sampled on a grid
 *   of half a level-0 cell, against level 0's: what level 0 covers is kept,
 *   and what a level adds lies within one of its cells of the house.
 * The houses sit at odd and even cells, so a shell meets the coarse cells'
 * boundaries both ways.
 */
import { chunkGrid, createWorldStore, deriveMipNode, MipTree, POSITION_STEPS_PER_CELL, TERRAIN_RULES, VOXEL_ROLE, type AssemblyRuleSet, type PaletteStore, type PieceTable } from '@thirdlight/voxel';
import { weldBase, type BaseMesh } from './base-cases';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const E = grid.edge;
const STEPS = POSITION_STEPS_PER_CELL;

/** A shell house: footprint w × d cells from (x0, z0), walls from y0 up `walls` cells, then its roof. */
export interface ShellHouse {
  readonly name: string;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly w: number;
  readonly d: number;
  readonly walls: number;
  readonly roof: 'gable' | 'hip' | 'flat';
}

/** Gable and hip roofs at 45° (one cell up a cell in), a flat roof; at odd and even cells. */
export const SHELL_HOUSES: readonly ShellHouse[] = [
  { name: 'gable-odd', x0: 3, y0: 5, z0: 5, w: 24, d: 19, walls: 12, roof: 'gable' },
  { name: 'gable-even', x0: 50, y0: 6, z0: 6, w: 22, d: 20, walls: 11, roof: 'gable' },
  { name: 'hip-odd', x0: 3, y0: 5, z0: 41, w: 21, d: 24, walls: 12, roof: 'hip' },
  { name: 'flat-even', x0: 50, y0: 6, z0: 42, w: 20, d: 18, walls: 12, roof: 'flat' },
];

/** Height above the walls' top of the roof over house-local column (x, z), or null outside the roof (one-cell overhang). */
function roofRise(h: ShellHouse, x: number, z: number): number | null {
  if (x < -1 || x > h.w || z < -1 || z > h.d) return null;
  if (h.roof === 'flat') return 0;
  const across = Math.min(z + 1, h.d - z);
  return h.roof === 'gable' ? across : Math.min(across, x + 1, h.w - x);
}

/** Whether house-local cell (x, y, z) is the shell (y 0 the floor slab); `roof` set to whether it is a roof cell. */
export function shellCell(h: ShellHouse, x: number, y: number, z: number): 'wall' | 'roof' | null {
  const inFoot = x >= 0 && x < h.w && z >= 0 && z < h.d;
  if (y === 0) return inFoot ? 'wall' : null;
  const edge = inFoot && (x === 0 || x === h.w - 1 || z === 0 || z === h.d - 1);
  if (y <= h.walls) return edge ? 'wall' : null;
  const r = roofRise(h, x, z);
  if (r === null) return null;
  const top = h.walls + 1 + r;
  if (y === top) return 'roof';
  // A gable's end walls rise to the roof; under a hip or flat roof the attic is open to the walls' top.
  return y < top && inFoot && h.roof === 'gable' && (x === 0 || x === h.w - 1) ? 'wall' : null;
}

/** A store holding the shell houses (walls and floor stone, roof tiles), nothing else. */
export function shellStore(houses: readonly ShellHouse[] = SHELL_HOUSES): PaletteStore {
  const s = createWorldStore(grid);
  const v = { material: 0, role: 0, shape: 15, wetness: 0 };
  for (const h of houses) for (let x = -1; x <= h.w; x++) for (let z = -1; z <= h.d; z++) for (let y = 0; y <= h.walls + 2 + Math.max(h.w, h.d); y++) {
    const c = shellCell(h, x, y, z);
    if (c === null) continue;
    v.material = c === 'roof' ? MAT.roofTile : MAT.stone;
    v.role = c === 'roof' ? VOXEL_ROLE.roof : VOXEL_ROLE.wall;
    s.setVoxel(h.x0 + x, h.y0 + y, h.z0 + z, v);
  }
  return s;
}

/** Edges not wound both ways as often (an edge four faces meet, as at a 45° roof's step, counts closed when balanced). */
export function unbalancedEdges(m: BaseMesh): number {
  const directed = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3) for (let k = 0; k < 3; k++) {
    const key = `${m.triangles[t + k]}|${m.triangles[t + ((k + 1) % 3)]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  let n = 0;
  for (const [key, c] of directed) {
    const [a, b] = key.split('|');
    if (directed.get(`${b}|${a}`) !== c) n++;
  }
  return n;
}

/** The house's cell box in level-0 cells (inclusive-exclusive), the roof's overhang included. */
export function shellBox(h: ShellHouse): { min: [number, number, number]; max: [number, number, number] } {
  return { min: [h.x0 - 1, h.y0, h.z0 - 1], max: [h.x0 + h.w + 1, h.y0 + h.walls + 3 + Math.max(h.w, h.d), h.z0 + h.d + 1] };
}

/** The base surfaces of every level-`level` node over the houses (under `rules`, kits from `table`), welded; positions in level-0 cells. */
export function shellMesh(store: PaletteStore, level: number, houses: readonly ShellHouse[] = SHELL_HOUSES, rules: AssemblyRuleSet = TERRAIN_RULES, table: PieceTable | null = null): { mesh: BaseMesh; points: Float64Array } {
  const tree = new MipTree(store);
  const span = E << level;
  const lo = [0, 1, 2].map((a) => Math.min(...houses.map((h) => shellBox(h).min[a]!)));
  const hi = [0, 1, 2].map((a) => Math.max(...houses.map((h) => shellBox(h).max[a]!)));
  const parts = [];
  for (let nx = Math.floor(lo[0]! / span); nx <= Math.floor(hi[0]! / span); nx++) for (let ny = Math.floor(lo[1]! / span); ny <= Math.floor(hi[1]! / span); ny++) for (let nz = Math.floor(lo[2]! / span); nz <= Math.floor(hi[2]! / span); nz++) {
    parts.push({ buf: deriveMipNode(tree, { level, nx, ny, nz }, rules, undefined, table).base, cx: nx, cy: ny, cz: nz });
  }
  const mesh = weldBase(parts);
  // weldBase's positions are in the level's steps from the level's origin: level-0 cells × 2^level.
  const points = Float64Array.from(mesh.positions, (p) => (p / STEPS) * 2 ** level);
  return { mesh, points };
}

/** Unit directions spread over the sphere (a Fibonacci lattice). */
function sphere(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let k = 0; k < n; k++) {
    const y = 1 - (2 * (k + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = k * Math.PI * (3 - Math.sqrt(5));
    out.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return out;
}

/** Whether a ray from p along d (unit) meets a triangle of the mesh within `length` cells. */
function rayMeets(points: Float64Array, tris: readonly number[], p: readonly number[], d: readonly number[], length: number): boolean {
  for (let t = 0; t < tris.length; t += 3) {
    const a = 3 * tris[t]!, b = 3 * tris[t + 1]!, c = 3 * tris[t + 2]!;
    const e1 = [points[b]! - points[a]!, points[b + 1]! - points[a + 1]!, points[b + 2]! - points[a + 2]!];
    const e2 = [points[c]! - points[a]!, points[c + 1]! - points[a + 1]!, points[c + 2]! - points[a + 2]!];
    const h = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const s = [p[0]! - points[a]!, p[1]! - points[a + 1]!, p[2]! - points[a + 2]!];
    const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
    if (dist >= 0 && dist <= length) return true;
  }
  return false;
}

/** Rays (of `n` spread over the sphere) from the house's inside, mid-way up its walls, that meet no triangle of its shell. */
export function raysOut(h: ShellHouse, points: Float64Array, mesh: BaseMesh, n = 96): number {
  const p = [h.x0 + h.w / 2 + 0.137, h.y0 + 1 + h.walls / 2 + 0.071, h.z0 + h.d / 2 + 0.093];
  const reach = h.w + h.d + h.walls;
  return sphere(n).filter((d) => !rayMeets(points, mesh.triangles, p, d, reach)).length;
}

/** Views a silhouette is sampled in: looking down y (from above), along z and along x (from two sides). */
export const SHELL_VIEWS = [1, 2, 0] as const;

/**
 * The house's silhouette seen along `axis` (orthographic): sample points on
 * a grid of half a level-0 cell over the view plane, offset off every
 * lattice line, each kept when a triangle of the mesh within the house's
 * box grown by `margin` cells covers it.
 */
export function silhouette(h: ShellHouse, points: Float64Array, mesh: BaseMesh, axis: number, margin: number): Set<string> {
  const box = shellBox(h);
  const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
  const lo = box.min.map((c) => c - margin);
  const hi = box.max.map((c) => c + margin);
  const out = new Set<string>();
  const T = mesh.triangles;
  const step = 0.5;
  const off = 0.2718;
  for (let t = 0; t < T.length; t += 3) {
    const c = [0, 1, 2].map((k) => 3 * T[t + k]!);
    const inBox = [0, 1, 2].every((a) => c.every((i) => points[i + a]! >= lo[a]! && points[i + a]! <= hi[a]!));
    if (!inBox) continue;
    const pu = c.map((i) => points[i + u]!);
    const pv = c.map((i) => points[i + v]!);
    const area = (pu[1]! - pu[0]!) * (pv[2]! - pv[0]!) - (pu[2]! - pu[0]!) * (pv[1]! - pv[0]!);
    if (Math.abs(area) < 1e-9) continue;
    const a0 = Math.ceil((Math.min(...pu) - off) / step), a1 = Math.floor((Math.max(...pu) - off) / step);
    const b0 = Math.ceil((Math.min(...pv) - off) / step), b1 = Math.floor((Math.max(...pv) - off) / step);
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) {
      const x = a * step + off, y = b * step + off;
      const s1 = (pu[1]! - pu[0]!) * (y - pv[0]!) - (pv[1]! - pv[0]!) * (x - pu[0]!);
      const s2 = (pu[2]! - pu[1]!) * (y - pv[1]!) - (pv[2]! - pv[1]!) * (x - pu[1]!);
      const s3 = (pu[0]! - pu[2]!) * (y - pv[2]!) - (pv[0]! - pv[2]!) * (x - pu[2]!);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) out.add(`${a},${b}`);
    }
  }
  return out;
}

/** Level-0 silhouette points a level keeps, and the points it adds farther than `reach` cells from the house's box (view plane). */
export function compareSilhouettes(h: ShellHouse, axis: number, l0: Set<string>, lv: Set<string>, reach: number): { kept: number; outside: number } {
  const box = shellBox(h);
  const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [number, number];
  let kept = 0;
  for (const k of l0) if (lv.has(k)) kept++;
  let outside = 0;
  for (const k of lv) {
    const [a, b] = k.split(',').map(Number) as [number, number];
    const x = a * 0.5 + 0.2718, y = b * 0.5 + 0.2718;
    if (x < box.min[u]! - reach || x > box.max[u]! + reach || y < box.min[v]! - reach || y > box.max[v]! + reach) outside++;
  }
  return { kept: kept / l0.size, outside };
}
