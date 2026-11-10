/**
 * The realistic far world's drainage: a coarse height grid over the whole
 * world (a node every 32 m), carved by stream-power erosion so the mountains
 * get ridgelines, branching valleys and the river network that drains them,
 * with basins filled into flat alluvial floors. It is small (an 8 km world is
 * 261² nodes, ~1 MB), a pure function of the seed and the world's size, and
 * every worker computes the same one, so the cells written from it match
 * across region columns without any column seeing another.
 *
 * Engine-owned test data (see far-world.ts), not a product feature.
 */
import { fractalNoise01, latticeHash, valueNoise01 } from '@thirdlight/shared';
import { smoothstep } from './world-kit';

/** Cells between drainage nodes (32 m). */
export const DRAINAGE_STEP = 64;
/** Nodes past the world's edge on every side, so a cubic read at the edge has its neighbours. */
const PAD = 2;
/** Radius (cells) of the flat ground round the town, and where the mountains have fully risen. */
export const FLAT_RADIUS = 420;
export const RISEN_RADIUS = 2600;
/** Height (cells) of the tallest peak once the eroded relief is scaled: ~1.5 km. */
export const PEAK = 3000;
/**
 * Stream-power erosion toward its steady state under uplift: steps, the
 * erodibility (node units; soft and hard rock vary it by half each way),
 * the area exponent, hillslope diffusion (its rate and substeps a step), the uplift a step of a massif's
 * core and the share the lowland gets of it, the lowland's start height.
 */
const STEPS = 90;
const ERODE_K = 0.3;
const AREA_M = 0.5;
const DIFFUSE = 0.2;
const CREEP_STEPS = 4;
const UPLIFT_STEP = 40;
const LOWLAND_UPLIFT = 0.07;
const LOWLAND = 40;
/** Drainage area (nodes, ~1,000 m² each) from which a node carries a river channel. */
export const RIVER_AREA = 90;

/** The coarse drainage of one world: heights, flow and the channel network. */
export interface FarDrainage {
  /** Nodes a side. */
  readonly n: number;
  /** World cell (x and z) of node 0. */
  readonly origin: number;
  /** Eroded surface heights (cells), node (i, j) at index i * n + j (i along x). */
  readonly height: Float32Array;
  /** Drainage area (nodes, the node's own included). */
  readonly area: Float32Array;
  /** Each node's downstream node (itself at an outlet). */
  readonly receiver: Int32Array;
  /** The channel's point in each node (world cells), jittered off the node so rivers do not run on the lattice. */
  readonly pointX: Float32Array;
  readonly pointZ: Float32Array;
  /** How much a node is massif (0 … 1): the uplift share that raised it. */
  readonly massif: Float32Array;
}

/** How far from the town the ground has risen (0 inside the flat ring, 1 past it). */
export function risenAt(x: number, z: number): number {
  return smoothstep(FLAT_RADIUS, RISEN_RADIUS, Math.hypot(x, z));
}

/** Ridged multifractal (0 … ~1): sharp crests where the noise crosses its middle, each octave weighted by the last. */
function ridged(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let f = 1;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let s = 1 - Math.abs(2 * valueNoise01(x * f, z * f, seed + o) - 1);
    s *= s * weight;
    weight = Math.min(1, s * 2);
    sum += s * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** The uplift share of a point (0 … 1): massifs from domain-warped low-frequency noise, ridged so they have crests. */
function massifAt(x: number, z: number, seed: number): number {
  const wx = x + 1800 * (fractalNoise01(x / 5200, z / 5200, 3, seed + 11) - 0.5);
  const wz = z + 1800 * (fractalNoise01(x / 5200, z / 5200, 3, seed + 12) - 0.5);
  const mass = smoothstep(0.3, 0.72, fractalNoise01(wx / 7400, wz / 7400, 3, seed));
  const crest = ridged(wx / 3100, wz / 3100, 5, seed + 1);
  return risenAt(x, z) * mass * (0.25 + 0.75 * crest);
}

/** A binary min-heap of node indices by a key array. */
class NodeHeap {
  private readonly items: Int32Array;
  private size = 0;
  constructor(
    capacity: number,
    private readonly key: Float64Array,
  ) {
    this.items = new Int32Array(capacity);
  }
  get length(): number {
    return this.size;
  }
  /** Lower key first; equal keys by index, so the order never depends on the heap's history. */
  private less(a: number, b: number): boolean {
    const ka = this.key[a]!;
    const kb = this.key[b]!;
    return ka < kb || (ka === kb && a < b);
  }
  push(v: number): void {
    let i = this.size++;
    this.items[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.items[i]!, this.items[p]!)) break;
      const t = this.items[p]!;
      this.items[p] = this.items[i]!;
      this.items[i] = t;
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0]!;
    const last = this.items[--this.size]!;
    if (this.size > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(this.items[l]!, this.items[m]!)) m = l;
        if (r < this.size && this.less(this.items[r]!, this.items[m]!)) m = r;
        if (m === i) break;
        const t = this.items[m]!;
        this.items[m] = this.items[i]!;
        this.items[i] = t;
        i = m;
      }
    }
    return top;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2],
];

/**
 * Fills every pit so water reaches an outlet (priority flood from the
 * outlets, each node a hair above the one it was reached from), then gives
 * each node its steepest downhill neighbour and returns the nodes lowest
 * first, so a receiver always comes before the nodes draining into it.
 */
function route(n: number, h: Float64Array, outlet: Uint8Array, receiver: Int32Array, dist: Float64Array): Int32Array {
  const heap = new NodeHeap(n * n, h);
  const done = new Uint8Array(n * n);
  // A node raised out of a pit drains to the node the flood reached it from: water crosses a filled basin as a tree to
  // its spill point, not in parallel lines.
  const parent = new Int32Array(n * n).fill(-1);
  const order = new Int32Array(n * n);
  let k = 0;
  for (let i = 0; i < n * n; i++) if (outlet[i]) {
    done[i] = 1;
    heap.push(i);
  }
  while (heap.length > 0) {
    const c = heap.pop();
    order[k++] = c;
    const ci = (c / n) | 0;
    const cj = c - ci * n;
    for (const [di, dj] of NEIGHBOURS) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const m = i * n + j;
      if (done[m]) continue;
      done[m] = 1;
      if (h[m]! <= h[c]!) {
        h[m] = h[c]! + 1e-3;
        parent[m] = c;
      }
      heap.push(m);
    }
  }
  for (let c = 0; c < n * n; c++) {
    receiver[c] = c;
    dist[c] = 1;
    if (outlet[c]) continue;
    const ci = (c / n) | 0;
    const cj = c - ci * n;
    const p = parent[c]!;
    if (p >= 0) {
      receiver[c] = p;
      const pi = (p / n) | 0;
      dist[c] = pi !== ci && p - pi * n !== cj ? Math.SQRT2 : 1;
      continue;
    }
    let best = 0;
    for (const [di, dj, d] of NEIGHBOURS) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const m = i * n + j;
      const s = (h[c]! - h[m]!) / d;
      if (s > best) {
        best = s;
        receiver[c] = m;
        dist[c] = d;
      }
    }
  }
  return order;
}

const memo = new Map<string, FarDrainage>();

/** The drainage of the world of side `2 * half` cells for `seed` (computed once a thread). */
export function farDrainage(half: number, seed: number): FarDrainage {
  const key = `${half}:${seed}`;
  let hit = memo.get(key);
  if (hit === undefined) memo.set(key, (hit = computeFarDrainage(half, seed)));
  return hit;
}

/** Computes the drainage (a few seconds for 8 km; {@link farDrainage} keeps it). */
export function computeFarDrainage(half: number, seed: number): FarDrainage {
  const n = Math.ceil((2 * half) / DRAINAGE_STEP) + 1 + 2 * PAD;
  const origin = -half - PAD * DRAINAGE_STEP;
  const N = n * n;
  const h = new Float64Array(N);
  const uplift = new Float64Array(N);
  const massif = new Float32Array(N);
  const outlet = new Uint8Array(N);
  const erodibility = new Float64Array(N);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = origin + i * DRAINAGE_STEP;
    const z = origin + j * DRAINAGE_STEP;
    const c = i * n + j;
    const m = massifAt(x, z, seed);
    const risen = risenAt(x, z);
    massif[c] = m;
    uplift[c] = UPLIFT_STEP * (m + LOWLAND_UPLIFT * risen * fractalNoise01(x / 1500, z / 1500, 2, seed + 3));
    // A rough start; the steady state the uplift and the rivers reach is what stays.
    h[c] = 4 * UPLIFT_STEP * m + LOWLAND * risen * fractalNoise01(x / 900, z / 900, 3, seed + 2);
    // Hard and soft rock: soft ground wears into broad valleys, hard holds steep ones.
    erodibility[c] = ERODE_K * (0.55 + 0.9 * fractalNoise01(x / 2400, z / 2400, 2, seed + 4));
    // Water leaves the world at its edge (the town's flat is levelled where the cells are written, rivers cross it).
    if (i === 0 || j === 0 || i === n - 1 || j === n - 1) {
      // At lowland height: a massif the edge cuts slopes down to it instead of damming a basin behind it.
      outlet[c] = 1;
      h[c] = Math.min(h[c]!, LOWLAND);
    }
  }
  const receiver = new Int32Array(N);
  const dist = new Float64Array(N);
  const area = new Float64Array(N);
  const next = new Float64Array(N);
  let order = route(n, h, outlet, receiver, dist);
  for (let step = 0; step < STEPS; step++) {
    for (let c = 0; c < N; c++) if (!outlet[c]) h[c] = h[c]! + uplift[c]!;
    order = route(n, h, outlet, receiver, dist);
    area.fill(1);
    for (let k = N - 1; k >= 0; k--) {
      const c = order[k]!;
      const r = receiver[c]!;
      if (r !== c) area[r] = area[r]! + area[c]!;
    }
    // Implicit stream power (slope exponent 1), receivers first: stable at any rate, never below the receiver.
    for (let k = 0; k < N; k++) {
      const c = order[k]!;
      const r = receiver[c]!;
      if (r === c) continue;
      const f = (erodibility[c]! * area[c]! ** AREA_M) / dist[c]!;
      h[c] = (h[c]! + f * h[r]!) / (1 + f);
    }
    // Hillslope creep: rounds what the rivers leave between them.
    for (let sub = 0; sub < CREEP_STEPS; sub++) {
      next.set(h);
      for (let i = 1; i < n - 1; i++) for (let j = 1; j < n - 1; j++) {
        const c = i * n + j;
        if (outlet[c]) continue;
        next[c] = h[c]! + DIFFUSE * (h[c - n]! + h[c + n]! + h[c - 1]! + h[c + 1]! - 4 * h[c]!);
      }
      h.set(next);
    }
  }
  // Scaled so the tallest peak is PEAK: the relief's shape is the erosion's, its size a choice.
  let top = 0;
  for (let c = 0; c < N; c++) top = Math.max(top, h[c]!);
  for (let c = 0; c < N; c++) h[c] = (h[c]! * PEAK) / top;
  // The routing of the final surface (its pits filled: lakes become flat alluvial floors).
  order = route(n, h, outlet, receiver, dist);
  area.fill(1);
  for (let k = N - 1; k >= 0; k--) {
    const c = order[k]!;
    const r = receiver[c]!;
    if (r !== c) area[r] = area[r]! + area[c]!;
  }
  const pointX = new Float32Array(N);
  const pointZ = new Float32Array(N);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const c = i * n + j;
    const hx = latticeHash(i, j, seed + 31) / 4294967296 - 0.5;
    const hz = latticeHash(i, j, seed + 32) / 4294967296 - 0.5;
    pointX[c] = origin + i * DRAINAGE_STEP + 0.55 * DRAINAGE_STEP * hx;
    pointZ[c] = origin + j * DRAINAGE_STEP + 0.55 * DRAINAGE_STEP * hz;
  }
  return { n, origin, height: Float32Array.from(h), area: Float32Array.from(area), receiver, pointX, pointZ, massif };
}

/** Catmull-Rom weights and their derivatives at t. */
function cubicWeights(t: number, w: Float64Array, d: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = 0.5 * (-t3 + 2 * t2 - t);
  w[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  w[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  w[3] = 0.5 * (t3 - t2);
  d[0] = 0.5 * (-3 * t2 + 4 * t - 1);
  d[1] = 0.5 * (9 * t2 - 10 * t);
  d[2] = 0.5 * (-9 * t2 + 8 * t + 1);
  d[3] = 0.5 * (3 * t2 - 2 * t);
}

const wx = new Float64Array(4);
const wz = new Float64Array(4);
const dx = new Float64Array(4);
const dz = new Float64Array(4);

/** A node field read with a cubic at world cell (x, z): the value and its gradient (per cell), written to `out`. */
export function sampleCubic(d: FarDrainage, field: Float32Array, x: number, z: number, out: Float64Array): void {
  const fx = (x - d.origin) / DRAINAGE_STEP;
  const fz = (z - d.origin) / DRAINAGE_STEP;
  const i0 = Math.min(d.n - 3, Math.max(1, Math.floor(fx)));
  const j0 = Math.min(d.n - 3, Math.max(1, Math.floor(fz)));
  cubicWeights(fx - i0, wx, dx);
  cubicWeights(fz - j0, wz, dz);
  let v = 0;
  let gx = 0;
  let gz = 0;
  for (let a = 0; a < 4; a++) {
    const row = (i0 - 1 + a) * d.n + j0 - 1;
    for (let b = 0; b < 4; b++) {
      const f = field[row + b]!;
      v += wx[a]! * wz[b]! * f;
      gx += dx[a]! * wz[b]! * f;
      gz += wx[a]! * dz[b]! * f;
    }
  }
  out[0] = v;
  out[1] = gx / DRAINAGE_STEP;
  out[2] = gz / DRAINAGE_STEP;
}

/** A node field read bilinearly at world cell (x, z). */
export function sampleLinear(d: FarDrainage, field: Float32Array, x: number, z: number): number {
  const fx = Math.min(d.n - 1.001, Math.max(0, (x - d.origin) / DRAINAGE_STEP));
  const fz = Math.min(d.n - 1.001, Math.max(0, (z - d.origin) / DRAINAGE_STEP));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const c = i * d.n + j;
  const a = field[c]! + (field[c + d.n]! - field[c]!) * tx;
  const b = field[c + 1]! + (field[c + d.n + 1]! - field[c + 1]!) * tx;
  return a + (b - a) * tz;
}

/** One river reach: from a node's channel point to its receiver's, with the bed heights and the channel's size. */
export interface RiverReach {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly ha: number;
  readonly hb: number;
  /** Channel half width (cells), depth under the floodplain (cells) and the floodplain's half width (cells). */
  readonly half: number;
  readonly depth: number;
  readonly plain: number;
}

/** Channel half width, depth and floodplain half width (cells) at their largest; what a reach can change round it. */
const CHANNEL_MAX = 26;
const DEPTH_MAX = 9;
const PLAIN_MAX = 110;
/** How far (cells) the channels wander off the straight reaches (the landscape's meander). */
export const MEANDER = 44;
/** Nodes round a box whose reaches can touch it: the widest channel and floodplain, its blend, the meander and the jitter. */
const REACH_NODES = Math.ceil((CHANNEL_MAX + PLAIN_MAX + 24 + MEANDER / 2 + 2 + 0.3 * DRAINAGE_STEP) / DRAINAGE_STEP) + 1;

/**
 * Every river reach that can change a cell of the box [x0, x1) × [z0, z1)
 * (a superset: a reach farther off is skipped by distance where it is read,
 * so two boxes see the same ground where they meet).
 */
export function riverReaches(d: FarDrainage, x0: number, z0: number, x1: number, z1: number, out: RiverReach[]): void {
  out.length = 0;
  const lo = (v: number): number => Math.max(0, Math.floor((v - d.origin) / DRAINAGE_STEP) - REACH_NODES);
  const hi = (v: number): number => Math.min(d.n - 1, Math.ceil((v - d.origin) / DRAINAGE_STEP) + REACH_NODES);
  for (let i = lo(x0); i <= hi(x1); i++) for (let j = lo(z0); j <= hi(z1); j++) {
    const c = i * d.n + j;
    const a = d.area[c]!;
    const r = d.receiver[c]!;
    if (a < RIVER_AREA || r === c) continue;
    const ha = d.height[c]!;
    const hb = d.height[r]!;
    // A gentle reach spreads a wide floodplain; a steep one stays a narrow cut.
    const slope = (ha - hb) / DRAINAGE_STEP;
    const half = Math.min(CHANNEL_MAX, 2.5 + 0.55 * Math.sqrt(a));
    const depth = Math.min(DEPTH_MAX, 1.5 + 1.1 * Math.log2(a / RIVER_AREA));
    const plain = half * (1.5 + 5 * (1 - smoothstep(0.01, 0.12, slope)));
    out.push({ ax: d.pointX[c]!, az: d.pointZ[c]!, bx: d.pointX[r]!, bz: d.pointZ[r]!, ha, hb, half, depth, plain: Math.min(plain, PLAIN_MAX) });
  }
}
