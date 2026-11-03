/**
 * The terrain mesher's hard-case world: one 32 m pad a case in a row along
 * +x, each case a solid given by an analytic signed distance, so a mesh can
 * be measured against the true surface: gentle and steep slopes, a bank, a
 * cliff, terraces, an overhang, an arch, a cave with a roof and a mouth,
 * one-cell walls, spikes, pits and holes, and bumps. Never flat-only.
 *
 * Engine-owned test data, not world generation: every cell is a pure
 * function of its position. A cell's fill level is the fraction of the
 * cell inside the case's solid (measured down to 1/8 cell where the surface
 * passes through it, rounded to the format's 16 levels), so the fill is
 * what an author's brush or an import would store for that solid.
 *
 * Distances are in cells (0.5 m), positive inside. Parts compose with
 * max (union), min (intersection) and min(a, −b) (subtraction): exact
 * outside the solid and near any one part's face, a lower bound of the true
 * distance near the joins of two parts.
 */
import { type ChunkGrid, chunkGrid, createWorldStore, type DenseChunk, localIndex, type PaletteStore, SHAPE_FULL, VOXEL_ROLE } from '@thirdlight/voxel';
import { loadArea } from './regions';
import { MAT, shapeByte, type TestGrid, type TestWorld } from './world-kit';

/** Signed distance in cells, positive inside the solid. */
export type Sdf = (x: number, y: number, z: number) => number;

type V3 = readonly [number, number, number];

/** A ray along which the mesh must hit (or miss) the solid where the analytic solid does. */
export interface FeatureProbe {
  readonly name: string;
  readonly from: V3;
  /** Unit direction. */
  readonly dir: V3;
  /** Cells. */
  readonly length: number;
}

export interface FeatureCase {
  readonly name: string;
  readonly description: string;
  /** The pad's first cell on x (pads are {@link FEATURE_PAD} cells on x and z, z from 0). */
  readonly x0: number;
  /** The solid in world cells (the world's box included). */
  readonly sdf: Sdf;
  readonly probes: readonly FeatureProbe[];
}

/** Cells a side of a case's pad (32 m). */
export const FEATURE_PAD = 64;
/** The ground surface around the cases (cells): not a whole cell, so its top cells are partly full. */
export const FEATURE_GROUND = 8.3;
/** The world's lowest solid cell. */
export const FEATURE_BASE = -8;
/** Cells above which nothing stands. */
export const FEATURE_TOP = 64;

const G = FEATURE_GROUND;
const FAR = 1e4;

const groundBelow = (h: number): Sdf => (_x, y) => h - y;

function box(min: V3, max: V3, round = 0): Sdf {
  return (x, y, z) => {
    const qx = Math.max(min[0] + round - x, x - max[0] + round);
    const qy = Math.max(min[1] + round - y, y - max[1] + round);
    const qz = Math.max(min[2] + round - z, z - max[2] + round);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    const oz = Math.max(qz, 0);
    const out = Math.sqrt(ox * ox + oy * oy + oz * oz);
    return round - out - Math.min(Math.max(qx, qy, qz), 0);
  };
}

const sphere = (c: V3, r: number): Sdf => (x, y, z) => r - Math.hypot(x - c[0], y - c[1], z - c[2]);
function union(...parts: Sdf[]): Sdf {
  return (x, y, z) => {
    let d = -Infinity;
    for (const p of parts) d = Math.max(d, p(x, y, z));
    return d;
  };
}
const subtract = (a: Sdf, b: Sdf): Sdf => (x, y, z) => Math.min(a(x, y, z), -b(x, y, z));

/** Distance from (px, py) to the segment a–b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const ex = px - ax - t * dx;
  const ey = py - ay - t * dy;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Ground under a height profile extruded across the pad: `points` are
 * (t, height) with t rising (a repeated t is a vertical face), t measured
 * from (x0, 0) along the horizontal direction `deg` from +x towards +z.
 * Flat beyond both ends. Exact (a 2D distance in the profile's plane).
 */
function profile(x0: number, deg: number, points: ReadonlyArray<readonly [number, number]>): Sdf {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const pts = [[-FAR, first[1]], ...points, [FAR, last[1]]] as const;
  return (x, y, z) => {
    const t = (x - x0) * c + z * s;
    let d = Infinity;
    let h = first[1];
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k]!;
      const [bx, by] = pts[k + 1]!;
      d = Math.min(d, segmentDistance(t, y, ax, ay, bx, by));
      if (t >= ax && t < bx) h = ay + ((by - ay) * (t - ax)) / (bx - ax);
    }
    return y < h ? d : -d;
  };
}

/** Horizontal rays along +x at height y across z = z0, z0 + step, … < z1, from x to x + length. */
function raysAlongX(name: string, x: number, y: number, z0: number, z1: number, step: number, length: number): FeatureProbe[] {
  const out: FeatureProbe[] = [];
  for (let z = z0; z < z1; z += step) out.push({ name: `${name} z ${z}`, from: [x, y, z], dir: [1, 0, 0], length });
  return out;
}

const down = (name: string, x: number, z: number, from = FEATURE_TOP): FeatureProbe => ({ name, from: [x, from, z], dir: [0, -1, 0], length: from - FEATURE_BASE });
const up = (name: string, x: number, y: number, z: number, length: number): FeatureProbe => ({ name, from: [x, y, z], dir: [0, 1, 0], length });
const alongX = (name: string, x: number, y: number, z: number, length: number): FeatureProbe => ({ name, from: [x, y, z], dir: [1, 0, 0], length });
const alongZ = (name: string, x: number, y: number, z: number, length: number): FeatureProbe => ({ name, from: [x, y, z], dir: [0, 0, 1], length });

type CaseSpec = Omit<FeatureCase, 'x0' | 'sdf' | 'probes'> & { sdf: (x0: number) => Sdf; probes: (x0: number) => FeatureProbe[] };

/** Bump caps on the ground: centre (u, w) in the pad, sphere radius, cap height. */
const BUMPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [16, 16, 6, 3],
  [40, 20, 8, 5],
  [24, 44, 4, 2],
  [47, 45, 10, 2.5],
  [33, 33, 3, 1.5],
];

const SPECS: readonly CaseSpec[] = [
  {
    name: 'slope-1:20',
    description: 'a 1:20 plane slope running 30° off the x axis',
    sdf: (x0) => profile(x0, 30, [[-FAR, G - FAR / 20], [FAR, G + FAR / 20]]),
    probes: (x0) => [down('ground at the middle', x0 + 32.5, 32.5)],
  },
  {
    name: 'slope-1:5',
    description: 'a 1:5 plane slope running 30° off the x axis',
    sdf: (x0) => profile(x0, 30, [[-FAR, G - FAR / 5], [FAR, G + FAR / 5]]),
    probes: (x0) => [down('ground at the middle', x0 + 32.5, 32.5)],
  },
  {
    name: 'bank-1:1',
    description: 'flat ground, a 1:1 bank 8 m high at 45°, a plateau',
    sdf: (x0) => profile(x0, 45, [[30, G], [46, G + 16]]),
    probes: (x0) => [down('bank foot', x0 + 22.5, 22.5), down('bank middle', x0 + 27.5, 27.5), down('plateau', x0 + 40.5, 40.5)],
  },
  {
    name: 'cliff-20m',
    description: 'a vertical cliff 20 m high facing −x',
    sdf: (x0) => profile(x0, 0, [[28, G], [28, G + 40]]),
    probes: (x0) => [...raysAlongX('cliff face', x0 + 16.5, G + 20.5, 12.5, 52, 8, 24), down('cliff top edge', x0 + 28.5, 32.5), down('cliff foot', x0 + 27.5, 32.5)],
  },
  {
    name: 'terraces-1',
    description: 'terraces with 1-cell risers every 3 m',
    sdf: (x0) => profile(x0, 0, Array.from({ length: 9 }, (_, k) => [[8 + 6 * k, G + k], [8 + 6 * k, G + k + 1]] as const).flat()),
    probes: (x0) => Array.from({ length: 8 }, (_, k) => down(`tread ${k + 1}`, x0 + 11.5 + 6 * k, 32.5)),
  },
  {
    name: 'terraces-2',
    description: 'terraces with 2-cell risers every 4 m',
    sdf: (x0) => profile(x0, 0, Array.from({ length: 7 }, (_, k) => [[8 + 8 * k, G + 2 * k], [8 + 8 * k, G + 2 * k + 2]] as const).flat()),
    probes: (x0) => Array.from({ length: 6 }, (_, k) => down(`tread ${k + 1}`, x0 + 12.5 + 8 * k, 32.5)),
  },
  {
    name: 'overhang',
    description: 'a cliff 8 m high facing −x with a ledge 6 m out over the low ground, 2.5 m thick',
    sdf: (x0) => union(groundBelow(G), box([x0 + 34, -FAR, -FAR], [FAR, G + 16, FAR]), box([x0 + 22, G + 11, -FAR], [x0 + 34, G + 16, FAR])),
    probes: (x0) => [up('ledge underside', x0 + 28.5, G + 1, 32.5, 20), alongX('face under the ledge', x0 + 16.5, G + 5.5, 32.5, 24), alongX('ledge front', x0 + 16.5, G + 13.5, 32.5, 24), down('ledge top', x0 + 28.5, 32.5)],
  },
  {
    name: 'arch',
    description: 'a 4 m thick arch 12 m wide, its round opening 3.5 m high, standing on the ground',
    sdf: (x0) => union(groundBelow(G), subtract(box([x0 + 20, -FAR, 28], [x0 + 44, G + 14, 36]), (x, y) => 7 - Math.hypot(x - x0 - 32, y - G))),
    probes: (x0) => [alongZ('through the opening', x0 + 32.5, G + 3.5, 20.5, 24), alongZ('lintel', x0 + 32.5, G + 10.5, 20.5, 24), up('opening top', x0 + 32.5, G + 1, 32.5, 20), alongX('inner side', x0 + 16.5, G + 2.5, 32.5, 32)],
  },
  {
    name: 'cave',
    description: 'a hill 7 m high with a cave 3.5 m high into it: a mouth on −x, a roof 3 m thick, a back wall',
    sdf: (x0) => subtract(union(groundBelow(G), box([x0 + 12, -FAR, 12], [x0 + 52, G + 14, 52])), box([x0 + 4, G + 1, 26], [x0 + 44, G + 8, 38], 1.5)),
    probes: (x0) => [alongX('through the mouth to the back wall', x0 + 2.5, G + 4.5, 32.5, 56), down('roof top', x0 + 30.5, 32.5), up('cave ceiling', x0 + 30.5, G + 4.5, 32.5, 20), down('cave floor', x0 + 30.5, 32.5, G + 4.5)],
  },
  {
    name: 'wall-1',
    description: 'a wall one cell thick, 16 m long and ~3.3 m high, on the ground',
    sdf: (x0) => union(groundBelow(G), box([x0 + 32, -FAR, 16], [x0 + 33, 15, 48])),
    probes: (x0) => [...raysAlongX('wall', x0 + 24.5, 12.5, 16.5, 48, 1, 16), down('wall top', x0 + 32.5, 32.5)],
  },
  {
    name: 'spike-1',
    description: 'a column one cell square, ~4.9 m high, on the ground',
    sdf: (x0) => union(groundBelow(G), box([x0 + 32, -FAR, 32], [x0 + 33, 18, 33])),
    probes: (x0) => [down('spike top', x0 + 32.5, 32.5), alongX('spike side', x0 + 24.5, 14.5, 32.5, 16)],
  },
  {
    name: 'pit-1',
    description: 'a pit one cell square, 1.65 m deep, in the ground',
    sdf: (x0) => subtract(groundBelow(G), box([x0 + 32, 5, 32], [x0 + 33, FAR, 33])),
    probes: (x0) => [down('pit bottom', x0 + 32.5, 32.5), down('beside the pit', x0 + 34.5, 32.5)],
  },
  {
    name: 'hole-1',
    description: 'a slab 2 cells thick, 16 m long, ~6 m high, with a hole one cell square through it',
    sdf: (x0) => union(groundBelow(G), subtract(box([x0 + 31, -FAR, 16], [x0 + 33, 20, 48]), box([x0 + 30, 14, 32], [x0 + 34, 15, 33]))),
    probes: (x0) => [alongX('through the hole', x0 + 24.5, 14.5, 32.5, 16), alongX('above the hole', x0 + 24.5, 16.5, 32.5, 16), alongX('beside the hole', x0 + 24.5, 14.5, 30.5, 16)],
  },
  {
    name: 'bumps',
    description: 'round bumps 0.75–2.5 m high and 3–14 m across on the ground',
    sdf: (x0) => union(groundBelow(G), ...BUMPS.map(([u, w, r, h]) => sphere([x0 + u, G + h - r, w], r))),
    probes: (x0) => BUMPS.map(([u, w], k) => down(`bump ${k + 1} top`, x0 + u + 0.5, w + 0.5)),
  },
];

/** Cells on x of the whole row. */
export const FEATURE_WIDTH = SPECS.length * FEATURE_PAD;

/** The world's box: solid only from the base up and inside the row. */
const worldBox = box([0, FEATURE_BASE, 0], [FEATURE_WIDTH, FAR, FEATURE_PAD]);

/** Every case, in row order (case k on x [k·64, k·64 + 64)). */
export function featureCases(): FeatureCase[] {
  return SPECS.map((s, k) => {
    const x0 = k * FEATURE_PAD;
    const own = s.sdf(x0);
    return { name: s.name, description: s.description, x0, sdf: (x, y, z) => Math.min(own(x, y, z), worldBox(x, y, z)), probes: s.probes(x0) };
  });
}

/** The case whose pad holds cell column x (clamped to the row). */
export function caseIndexAt(x: number): number {
  return Math.max(0, Math.min(SPECS.length - 1, Math.floor(x / FEATURE_PAD)));
}

/** Half a cube's diagonal over its side: a cube whose centre is this many sides from the surface is wholly inside or outside. */
const HALF_DIAGONAL = Math.sqrt(3) / 2;
/** Octree levels below a cell where the fill is measured (leaves of 1/8 cell). */
const FILL_LEVELS = 3;

/**
 * The fraction of the cube at (x, y, z) of side `size` inside the solid:
 * whole cubes are 1 or 0, cubes the surface passes through split in eight,
 * and a leaf takes 0.5 + d / size (exact where the surface is a plane
 * along a cube face).
 */
function cubeFill(sdf: Sdf, x: number, y: number, z: number, size: number, level: number): number {
  const h = size / 2;
  const d = sdf(x + h, y + h, z + h);
  if (d >= HALF_DIAGONAL * size) return 1;
  if (d <= -HALF_DIAGONAL * size) return 0;
  if (level === FILL_LEVELS) return Math.max(0, Math.min(1, 0.5 + d / size));
  let sum = 0;
  for (let k = 0; k < 8; k++) sum += cubeFill(sdf, x + (k & 1) * h, y + ((k >> 1) & 1) * h, z + ((k >> 2) & 1) * h, h, level + 1);
  return sum / 8;
}

/** The hard-case row: {@link featureCases} side by side on ground 8 m deep. */
export function featuresWorld(): TestWorld {
  const cases = featureCases();
  const grid: TestGrid = {
    name: 'world',
    yawDeg: 0,
    originM: [0, 0, 0],
    bounds: { min: [0, FEATURE_BASE, 0], max: [FEATURE_WIDTH, FEATURE_TOP, FEATURE_PAD] },
    fill(g: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
      const e = g.edge;
      let any = false;
      for (let lx = 0; lx < e; lx++) for (let lz = 0; lz < e; lz++) for (let ly = 0; ly < e; ly++) {
        const x = (cx << g.shift) + lx;
        const y = (cy << g.shift) + ly;
        const z = (cz << g.shift) + lz;
        const i = localIndex(g, lx, ly, lz);
        const inRow = x >= 0 && x < FEATURE_WIDTH && z >= 0 && z < FEATURE_PAD && y >= FEATURE_BASE && y < FEATURE_TOP;
        const c = inRow ? cases[caseIndexAt(x)]! : null;
        const fill = c === null ? 0 : cubeFill(c.sdf, x, y, z, 1, 0);
        if (fill > 0) {
          const depth = c!.sdf(x + 0.5, y + 0.5, z + 0.5);
          out.material[i] = depth < 1.5 ? MAT.grass : depth < 4 ? MAT.soil : MAT.rock;
          out.role[i] = VOXEL_ROLE.terrain;
          out.shape[i] = fill >= 1 ? SHAPE_FULL : shapeByte(fill);
          any = true;
        } else {
          out.material[i] = 0;
          out.role[i] = 0;
          out.shape[i] = 0;
        }
        out.wetness[i] = 0;
      }
      return any;
    },
  };
  return {
    name: 'features',
    description: `the terrain mesher's hard cases: ${cases.map((c) => c.name).join(', ')}, each on a 32 m pad in a row ${FEATURE_WIDTH / 2} m long`,
    seed: 0,
    areaM2: FEATURE_WIDTH * FEATURE_PAD * 0.25,
    benchFootprint: FEATURE_PAD,
    grids: [grid],
  };
}

/** The hard-case row in a store of 32³ chunks. */
export function featuresStore(): PaletteStore {
  const store = createWorldStore(chunkGrid(32));
  loadArea(featuresWorld().grids[0]!, store, 0, 0, FEATURE_WIDTH, FEATURE_PAD);
  return store;
}
