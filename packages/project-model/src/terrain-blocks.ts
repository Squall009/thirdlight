/**
 * Block layers on a terrain: the edit layer (`terrain-layers.ts` kind
 * `blocks`) that makes the ground meet a block area without a step, a crack
 * or a change of material.
 *
 * A block layer's footprint is its columns holding a block with a surface
 * (any shape but `none`; a larger block covers the columns of its
 * footprint). Its ground in a column is the top of the column's lowest run
 * of blocks — the corner heights of a sloped top, a ramp's rise, a half
 * block's half — so layered ground (rock under grass) meets the terrain at
 * its grass, a cliff at its top, and a wall stacked on the ground cells at
 * the wall's top (walls made of edge pieces stand on the ground and leave it
 * alone). On an edge or corner several columns share, the lowest of their
 * tops there counts: the terrain never stands above a column's top edge,
 * where its side face would end and a crack would open.
 *
 * What the layer does to a terrain sample, by where it lies:
 * - on the footprint's border: the ground there exactly, so the terrain's
 *   edge is the blocks' top edge (no step, no crack);
 * - outside it, within `blend` metres: pulled toward the ground at the
 *   nearest border point, fully at the border and fading out (smoothstep):
 *   the terrain round a block area follows its border corner heights;
 * - under it: `cut` (the default) leaves the ground there (for coarser
 *   levels of detail and the normals at the border) and makes holes of the
 *   terrain cells the footprint covers whole a cell in from its border, so
 *   nothing is drawn or collides under the blocks but a ring one cell wide
 *   just under their tops: a hole's edge on the border itself would let the
 *   ground's last pixels there (cut to the hole per pixel) show the sky where
 *   the blocks' side faces face away; `flatten` keeps the cells and lowers the ground
 *   {@link TERRAIN_BLOCKS_SINK} under the blocks' (out of sight under their
 *   tops) — whole ground for scenery-only terrain, a
 *   streamed block area's stand-in past its ring, and no collider patches.
 *   A sample under the footprint whose cell is kept (a terrain grid not
 *   aligned with the cells) is lowered the same way in either mode.
 * - paint: the layer weights the blocks show at the same point (the chunk's
 *   hand paint over the block layer's material rules, `chunkMeshPaint`) are
 *   mixed in by the same measure, so the ground's material carries across the
 *   border; the terrain's own hand paint stays over it.
 *
 * Everything is a function of a sample's world place and the block data, so
 * combining a rectangle again gives the bytes combining everything gives.
 *
 * Pure and deterministic.
 */
import { BlockGrid } from './block-grid';
import { CHUNK_SIZE, blockTypeSlopes, rotatedFootprint, type BlockCell, type BlockLayerComponent, type BlockLayerData, type BlockType } from './block-layers';
import { chunkMeshPaint } from './block-paint-mesh';
import { anchoredTopAt, cellCorners, subdividedGradientAt, subdividedHeightAt, type CellCorners } from './block-surface';
import type { ScatterRect } from './scatter';
import { SurfaceRuleSet } from './surface-rules';
import { TERRAIN_HEIGHT_STEPS, terrainHeightOf, terrainStepOf, type TerrainComponent } from './terrain';
import type { TerrainSplinePaint } from './terrain-splines';
import { TERRAIN_SAMPLE_LAYERS } from './terrain-tile';

export type TerrainBlocksMode = 'cut' | 'flatten';
export const TERRAIN_BLOCKS_MODES: readonly TerrainBlocksMode[] = ['cut', 'flatten'];
/** Metres over which the ground outside a footprint fades from the border's height and paint to its own, when absent. */
export const TERRAIN_BLOCKS_BLEND_DEFAULT = 8;
export const TERRAIN_BLOCKS_BLEND_LIMITS = Object.freeze({ min: 0, max: 256 });
/**
 * Metres a sample under a footprint whose cell stays drawn lies below the
 * blocks' ground (at least one height step): enough for the blocks' tops to
 * win the depth test near the camera, little enough that the ground's normal
 * at the border — read across it, from the sample inside — stays the
 * blocks' within a degree, so no lit line marks the border. Where depth
 * precision gives way far off, the ground under the tops wears their paint
 * and normal, so what shows through looks the same.
 */
export const TERRAIN_BLOCKS_SINK = 0.02;

/** A block layer as the terrain meets it. */
export interface TerrainBlocksSource {
  readonly id: string;
  readonly component: BlockLayerComponent;
  readonly data: BlockLayerData | null;
  readonly types: ReadonlyMap<string, BlockType>;
  /** The layer object's world position (the min corner of cell [0, 0, 0]). */
  readonly origin: readonly number[];
}

/** The settings of one blocks layer of a terrain (its edit layer's). */
export interface TerrainBlocksSettings {
  readonly mode: TerrainBlocksMode;
  readonly blend: number;
  readonly paint: boolean;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Places closer than this (in cells) to a column line are on it. */
const ON_LINE = 1e-6;

/** A column's ground: the block whose top it is. */
interface Ground {
  readonly anchor: readonly [number, number, number];
  readonly cell: BlockCell;
  /** A single-cell sloped top's corners (null: the block's own shape). */
  readonly corners: CellCorners | null;
}

const columnKey = (x: number, z: number): number => (x + 0x100000) * 0x200000 + (z + 0x100000);

/** A layer's columns that may hold ground, by bin of CHUNK_SIZE columns (bin (x0, z0) first), with scratch for a search. */
interface ColumnBins {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  readonly has: Uint8Array;
  /** Scratch: the bins a search may visit, their nearest distance and index. */
  readonly md: Float64Array;
  readonly at: Int32Array;
}

/**
 * A search box's cell count from which the nearest border column is found
 * bin by bin (below it, the box is scanned whole: as fast for a few metres of
 * blend, and the blend's area grows with its square).
 */
const BIN_SEARCH_FROM_CELLS = 1024;

/** The nearest border column found: its column, the border point on it (layer cells), and its distance (m). */
interface Nearest {
  x: number;
  z: number;
  px: number;
  pz: number;
  d: number;
}

/** One block layer's footprint and ground, read on demand. */
class BlockGround {
  readonly cw: number;
  readonly ch: number;
  readonly cd: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** The world box of the chunks holding columns (a bound of the footprint). */
  readonly rect: ScatterRect | null;
  private gridMade: BlockGrid | null = null;
  private covers: Map<number, Map<number, readonly [number, number, number]>> | null = null;
  private readonly grounds = new Map<number, Ground | null>();
  private binsMade: ColumnBins | null = null;
  /** The block layer's material rules (the paint its tops show is read through them). */
  readonly rules: SurfaceRuleSet | undefined;
  private readonly subdivision: number;

  constructor(readonly src: TerrainBlocksSource) {
    const [cw, ch, cd] = src.component.cellSize;
    this.cw = cw;
    this.ch = ch;
    this.cd = cd;
    this.ox = src.origin[0] ?? 0;
    this.oy = src.origin[1] ?? 0;
    this.oz = src.origin[2] ?? 0;
    this.subdivision = src.component.topSubdivision ?? 1;
    const rules = src.component.rules;
    this.rules = rules !== undefined && rules.length > 0 ? new SurfaceRuleSet(rules) : undefined;
    let r: ScatterRect | null = null;
    if (src.component.metadataOnly !== true) {
      for (const c of src.data?.chunks ?? []) {
        if (c.columns.length === 0) continue;
        // A larger block anchored near a chunk's edge reaches into the next chunk (a footprint is at most 8 cells).
        const x0 = this.ox + (c.cx * CHUNK_SIZE - 8) * cw;
        const z0 = this.oz + (c.cz * CHUNK_SIZE - 8) * cd;
        const x1 = this.ox + ((c.cx + 1) * CHUNK_SIZE + 8) * cw;
        const z1 = this.oz + ((c.cz + 1) * CHUNK_SIZE + 8) * cd;
        r = r === null ? [x0, z0, x1, z1] : [Math.min(r[0], x0), Math.min(r[1], z0), Math.max(r[2], x1), Math.max(r[3], z1)];
      }
    }
    this.rect = r;
  }

  get grid(): BlockGrid {
    return (this.gridMade ??= BlockGrid.from(this.src.component, this.src.data));
  }

  /** Larger blocks' covered cells by column, then row → anchor. */
  private coversOf(): Map<number, Map<number, readonly [number, number, number]>> {
    if (this.covers !== null) return this.covers;
    const out = new Map<number, Map<number, readonly [number, number, number]>>();
    const types = this.src.types;
    if ([...types.values()].some((t) => t.footprint !== undefined)) {
      const g = this.grid;
      g.forEach((x, y, z, idx) => {
        const cell = g.valueOf(idx);
        const t = cell.block !== undefined ? types.get(cell.block) : undefined;
        if (t?.footprint === undefined) return;
        const f = rotatedFootprint(t, cell.rot);
        const anchor = [x, y, z] as const;
        for (let dx = 0; dx < f[0]; dx++)
          for (let dz = 0; dz < f[2]; dz++) {
            const k = columnKey(x + dx, z + dz);
            let rows = out.get(k);
            if (rows === undefined) out.set(k, (rows = new Map()));
            for (let dy = 0; dy < f[1]; dy++) if (dx !== 0 || dy !== 0 || dz !== 0) rows.set(y + dy, anchor);
          }
      });
    }
    return (this.covers = out);
  }

  /** Whether a cell holds a block with a surface (an unknown type counts as a full block, as the sculpt tools read it). */
  private solid(cell: BlockCell | null): boolean {
    if (cell?.block === undefined) return false;
    const t = this.src.types.get(cell.block);
    return t === undefined || t.shape !== 'none';
  }

  /** The ground of column (x, z): the top block of its lowest run (null: no block there). */
  ground(x: number, z: number): Ground | null {
    const key = columnKey(x, z);
    const known = this.grounds.get(key);
    if (known !== undefined) return known;
    let found: Ground | null = null;
    if (this.rect !== null && this.src.component.metadataOnly !== true) {
      const g = this.grid;
      const covered = this.coversOf().get(key);
      // The rows holding a block (stored here, or a larger block's covered cells), each with its anchor.
      const rows = new Map<number, readonly [number, number, number]>();
      g.forEachInColumn(x, z, (y, idx) => {
        if (this.solid(g.valueOf(idx))) rows.set(y, [x, y, z]);
      });
      if (covered !== undefined) for (const [y, a] of covered) if (!rows.has(y) && this.solid(g.get(a[0], a[1], a[2]))) rows.set(y, a);
      if (rows.size > 0) {
        let y = Math.min(...rows.keys());
        while (rows.has(y + 1)) y += 1;
        const anchor = rows.get(y)!;
        const cell = g.get(anchor[0], anchor[1], anchor[2])!;
        const t = cell.block !== undefined ? this.src.types.get(cell.block) : undefined;
        found = { anchor, cell, corners: t !== undefined && blockTypeSlopes(t) ? cellCorners(cell) : null };
      }
    }
    this.grounds.set(key, found);
    return found;
  }

  /**
   * The columns that may hold ground, in bins CHUNK_SIZE columns a side: a
   * chunk's own columns, and those a larger block anchored elsewhere covers.
   * The nearest-border search skips empty bins, so its cost follows the
   * footprint near a point rather than the blend's area.
   */
  bins(): ColumnBins {
    if (this.binsMade !== null) return this.binsMade;
    const keys: [number, number][] = [];
    for (const c of this.src.data?.chunks ?? []) if (c.columns.length > 0) keys.push([c.cx, c.cz]);
    for (const k of this.coversOf().keys()) {
      const x = Math.floor(k / 0x200000) - 0x100000;
      const z = (k % 0x200000) - 0x100000;
      keys.push([Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)]);
    }
    if (keys.length === 0) return (this.binsMade = { x0: 0, z0: 0, w: 0, h: 0, has: new Uint8Array(0), md: new Float64Array(0), at: new Int32Array(0) });
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of keys) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    const w = x1 - x0 + 1;
    const h = z1 - z0 + 1;
    const has = new Uint8Array(w * h);
    for (const [x, z] of keys) has[(z - z0) * w + (x - x0)] = 1;
    let n = 0;
    for (const v of has) n += v;
    return (this.binsMade = { x0, z0, w, h, has, md: new Float64Array(n), at: new Int32Array(n) });
  }

  /** The ground's height (layer-local metres) of column (x, z) at layer point (u, v) in cells (null: no block). */
  topAt(x: number, z: number, u: number, v: number): number | null {
    const gr = this.ground(x, z);
    if (gr === null) return null;
    const fu = Math.min(1, Math.max(0, u - x));
    const fv = Math.min(1, Math.max(0, v - z));
    if (gr.corners !== null) return (gr.anchor[1] + subdividedHeightAt(gr.corners, this.subdivision, fu, fv)) * this.ch;
    const t = gr.cell.block !== undefined ? this.src.types.get(gr.cell.block) : undefined;
    if (t === undefined) return (gr.anchor[1] + 1) * this.ch;
    const hit = anchoredTopAt(this.grid, this.src.types, gr.anchor, gr.cell, (x + fu) * this.cw, (z + fv) * this.cd);
    return hit === null ? (gr.anchor[1] + 1) * this.ch : gr.anchor[1] * this.ch + hit.sample.height;
  }

  /** How the ground rises along x and z (metres per metre) in column (x, z) at (u, v). */
  gradientAt(x: number, z: number, u: number, v: number): [number, number] {
    const gr = this.ground(x, z);
    if (gr === null || gr.corners === null) return [0, 0];
    const [gu, gv] = subdividedGradientAt(gr.corners, this.subdivision, Math.min(1, Math.max(0, u - x)), Math.min(1, Math.max(0, v - z)));
    return [(gu * this.ch) / this.cw, (gv * this.ch) / this.cd];
  }

  /** A world point in the layer's cells (u along x, v along z). */
  local(wx: number, wz: number): [number, number] {
    return [(wx - this.ox) / this.cw, (wz - this.oz) / this.cd];
  }
}

/** Where a layer point lies against a footprint: the columns touching it (one inside a cell; two on a line; four on a corner). */
function touching(u: number, v: number): { xs: number[]; zs: number[] } {
  const ru = Math.round(u);
  const rv = Math.round(v);
  const xs = Math.abs(u - ru) < ON_LINE ? [ru - 1, ru] : [Math.floor(u)];
  const zs = Math.abs(v - rv) < ON_LINE ? [rv - 1, rv] : [Math.floor(v)];
  return { xs, zs };
}

/**
 * The covered column in box [x0, x1] × [z0, z1] whose square comes nearest
 * layer point (u, v), closer than `limit` metres: the nearest, the first in
 * row order among equally near ones (null: none).
 */
function nearestByScan(l: BlockGround, u: number, v: number, x0: number, x1: number, z0: number, z1: number, limit: number): Nearest | null {
  let out: Nearest | null = null;
  let bd = limit;
  for (let z = z0; z <= z1; z++) {
    const pz = Math.min(z + 1, Math.max(z, v));
    const dz = (pz - v) * l.cd;
    if (dz * dz >= bd * bd) continue;
    for (let x = x0; x <= x1; x++) {
      const px = Math.min(x + 1, Math.max(x, u));
      const dx = (px - u) * l.cw;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= bd) continue;
      if (l.ground(x, z) === null) continue;
      bd = d;
      out = { x, z, px, pz, d };
    }
  }
  return out;
}

/**
 * The same column as {@link nearestByScan}, found by visiting the layer's
 * non-empty bins nearest first and stopping once a bin lies farther than the
 * best found: equally near columns are settled by row order, as the scan does.
 */
function nearestByBins(l: BlockGround, u: number, v: number, x0: number, x1: number, z0: number, z1: number, limit: number): Nearest | null {
  const b = l.bins();
  const bx0 = Math.max(b.x0, Math.floor(x0 / CHUNK_SIZE));
  const bx1 = Math.min(b.x0 + b.w - 1, Math.floor(x1 / CHUNK_SIZE));
  const bz0 = Math.max(b.z0, Math.floor(z0 / CHUNK_SIZE));
  const bz1 = Math.min(b.z0 + b.h - 1, Math.floor(z1 / CHUNK_SIZE));
  let n = 0;
  for (let bz = bz0; bz <= bz1; bz++)
    for (let bx = bx0; bx <= bx1; bx++) {
      const i = (bz - b.z0) * b.w + (bx - b.x0);
      if (b.has[i] === 0) continue;
      // The bin's columns in the box, and the distance to the nearest point of their squares (no column in it is nearer).
      const cx0 = Math.max(x0, bx * CHUNK_SIZE);
      const cx1 = Math.min(x1, bx * CHUNK_SIZE + CHUNK_SIZE - 1);
      const cz0 = Math.max(z0, bz * CHUNK_SIZE);
      const cz1 = Math.min(z1, bz * CHUNK_SIZE + CHUNK_SIZE - 1);
      const dx = (Math.min(cx1 + 1, Math.max(cx0, u)) - u) * l.cw;
      const dz = (Math.min(cz1 + 1, Math.max(cz0, v)) - v) * l.cd;
      const md = Math.sqrt(dx * dx + dz * dz);
      if (md >= limit) continue;
      b.md[n] = md;
      b.at[n] = i;
      n += 1;
    }
  let out: Nearest | null = null;
  let bd = limit;
  for (;;) {
    // The nearest bin not visited yet.
    let k = -1;
    for (let j = 0; j < n; j++) if (b.md[j]! >= 0 && (k < 0 || b.md[j]! < b.md[k]!)) k = j;
    if (k < 0) break;
    const md = b.md[k]!;
    // A bin as near as the best can still hold an equally near column earlier in row order.
    if (out === null ? md >= bd : md > bd) break;
    b.md[k] = -1;
    const i = b.at[k]!;
    const bx = b.x0 + (i % b.w);
    const bz = b.z0 + Math.floor(i / b.w);
    const cx0 = Math.max(x0, bx * CHUNK_SIZE);
    const cx1 = Math.min(x1, bx * CHUNK_SIZE + CHUNK_SIZE - 1);
    const cz0 = Math.max(z0, bz * CHUNK_SIZE);
    const cz1 = Math.min(z1, bz * CHUNK_SIZE + CHUNK_SIZE - 1);
    for (let z = cz0; z <= cz1; z++) {
      const pz = Math.min(z + 1, Math.max(z, v));
      const dz = (pz - v) * l.cd;
      if (dz * dz > bd * bd) continue;
      for (let x = cx0; x <= cx1; x++) {
        const px = Math.min(x + 1, Math.max(x, u));
        const dx = (px - u) * l.cw;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (out === null ? d >= bd : d > bd || (d === bd && (z > out.z || (z === out.z && x > out.x)))) continue;
        if (l.ground(x, z) === null) continue;
        bd = d;
        out = { x, z, px, pz, d };
      }
    }
  }
  return out;
}

/** What one sample of the terrain gets from the blocks (null: nothing reaches it). */
export interface BlockSeamSample {
  /** World height the ground goes to. */
  readonly height: number;
  /** The share of the change (1 on and under the footprint, fading outside). */
  readonly weight: number;
  /** On or under the footprint. */
  readonly under: boolean;
  /** Strictly under it (no uncovered column touches the point). */
  readonly inside: boolean;
  /** The block layer and the layer point the paint is read at (on the footprint, in a covered column). */
  readonly layer: number;
  readonly paintAt: readonly [number, number];
  readonly column: readonly [number, number];
}

/**
 * Block layers as one terrain's edit layer: what they do to its samples,
 * cells and paint (see the module comment). `origin` is the terrain object's
 * position; samples are addressed by global index (tile · cells + local).
 */
export class TerrainBlockSeam {
  private readonly layers: BlockGround[];
  private readonly n: number;
  private readonly sp: number;
  private readonly size: number;
  private readonly range: readonly number[];
  /** The world box the layer changes (footprints grown by the blend), null: none. */
  readonly rect: ScatterRect | null;
  private readonly coveredCells = new Map<number, boolean>();
  /** Each tile's paint, by tile and strength (a bake asks once per box it bakes). */
  private readonly paints = new Map<string, TerrainSplinePaint[] | null>();

  constructor(
    sources: readonly TerrainBlocksSource[],
    readonly settings: TerrainBlocksSettings,
    comp: Pick<TerrainComponent, 'tileSamples' | 'spacing' | 'heightRange'>,
    private readonly origin: readonly number[],
    /** The search box's cell count from which the nearest border is found by bins (both ways give the same samples). */
    private readonly binSearchFrom = BIN_SEARCH_FROM_CELLS,
  ) {
    this.layers = sources.map((s) => new BlockGround(s)).filter((l) => l.rect !== null);
    this.n = comp.tileSamples - 1;
    this.sp = comp.spacing;
    this.size = this.n * this.sp;
    this.range = comp.heightRange;
    const b = settings.blend;
    let r: ScatterRect | null = null;
    for (const l of this.layers) {
      const q = l.rect!;
      const g: ScatterRect = [q[0] - b, q[1] - b, q[2] + b, q[3] + b];
      r = r === null ? g : [Math.min(r[0], g[0]), Math.min(r[1], g[1]), Math.max(r[2], g[2]), Math.max(r[3], g[3])];
    }
    this.rect = r;
  }

  get empty(): boolean {
    return this.rect === null;
  }

  private tileBox(tx: number, tz: number): ScatterRect {
    const x0 = this.origin[0]! + tx * this.size;
    const z0 = this.origin[2]! + tz * this.size;
    return [x0, z0, x0 + this.size, z0 + this.size];
  }

  /** Whether the layer may change tile (tx, tz). */
  reaches(tx: number, tz: number): boolean {
    const r = this.rect;
    if (r === null) return false;
    const b = this.tileBox(tx, tz);
    return r[0] <= b[2] && r[2] >= b[0] && r[1] <= b[3] && r[3] >= b[1];
  }

  /** Whether a world point lies on or under a footprint (scatter keeps off it). */
  covered(wx: number, wz: number): boolean {
    for (const l of this.layers) {
      const q = l.rect!;
      if (wx < q[0] || wx > q[2] || wz < q[1] || wz > q[3]) continue;
      const [u, v] = l.local(wx, wz);
      const { xs, zs } = touching(u, v);
      for (const z of zs) for (const x of xs) if (l.ground(x, z) !== null) return true;
    }
    return false;
  }

  /** What the blocks do at a world point (null: nothing). */
  sample(wx: number, wz: number): BlockSeamSample | null {
    const blend = this.settings.blend;
    let best: BlockSeamSample | null = null;
    let bestD = Infinity;
    for (let li = 0; li < this.layers.length; li++) {
      const l = this.layers[li]!;
      const q = l.rect!;
      if (wx < q[0] - blend || wx > q[2] + blend || wz < q[1] - blend || wz > q[3] + blend) continue;
      const [u, v] = l.local(wx, wz);
      const { xs, zs } = touching(u, v);
      // On or under the footprint: the lowest top of the covered columns touching the point.
      let low = Infinity;
      let col: [number, number] | null = null;
      let open = false;
      for (const z of zs)
        for (const x of xs) {
          const h = l.topAt(x, z, u, v);
          if (h === null) {
            open = true;
            continue;
          }
          if (h < low) {
            low = h;
            col = [x, z];
          }
        }
      if (col !== null) {
        return { height: l.oy + low, weight: 1, under: true, inside: !open, layer: li, paintAt: [u, v], column: col };
      }
      if (blend <= 0) continue;
      // Outside: the nearest point of a covered column's square within the blend (closer than an earlier layer's).
      const bx = blend / l.cw;
      const bz = blend / l.cd;
      const x0 = Math.floor(u - bx);
      const x1 = Math.floor(u + bx);
      const z0 = Math.floor(v - bz);
      const z1 = Math.floor(v + bz);
      const limit = Math.min(blend, bestD);
      const n = (x1 - x0 + 1) * (z1 - z0 + 1) >= this.binSearchFrom ? nearestByBins(l, u, v, x0, x1, z0, z1, limit) : nearestByScan(l, u, v, x0, x1, z0, z1, limit);
      if (n === null) continue;
      // The border point's ground: the lowest top of the covered columns touching it.
      const t = touching(n.px, n.pz);
      let h = Infinity;
      let c: [number, number] = [n.x, n.z];
      for (const cz of t.zs)
        for (const cx of t.xs) {
          const y = l.topAt(cx, cz, n.px, n.pz);
          if (y !== null && y < h) {
            h = y;
            c = [cx, cz];
          }
        }
      bestD = n.d;
      best = { height: l.oy + h, weight: smooth(1 - n.d / blend), under: false, inside: false, layer: li, paintAt: [n.px, n.pz], column: c };
    }
    return best;
  }

  /** World place of global sample (gx, gz). */
  private at(gx: number, gz: number): [number, number] {
    return [this.origin[0]! + gx * this.sp, this.origin[2]! + gz * this.sp];
  }

  /** Whether terrain cell (gx, gz) (global, between samples) lies wholly on a footprint (kept: a cut asks each cell nine times). */
  private cellCovered(gx: number, gz: number): boolean {
    const key = (gx + 0x400000) * 0x800000 + (gz + 0x400000);
    let v = this.coveredCells.get(key);
    if (v === undefined) this.coveredCells.set(key, (v = this.cellOnFootprint(gx, gz)));
    return v;
  }

  private cellOnFootprint(gx: number, gz: number): boolean {
    const [x0, z0] = this.at(gx, gz);
    const x1 = x0 + this.sp;
    const z1 = z0 + this.sp;
    for (const l of this.layers) {
      const q = l.rect!;
      if (x1 <= q[0] || x0 >= q[2] || z1 <= q[1] || z0 >= q[3]) continue;
      const [u0, v0] = l.local(x0, z0);
      const [u1, v1] = l.local(x1, z1);
      // Every column the cell's open square overlaps.
      const cx0 = Math.floor(u0 + ON_LINE);
      const cx1 = Math.ceil(u1 - ON_LINE) - 1;
      const cz0 = Math.floor(v0 + ON_LINE);
      const cz1 = Math.ceil(v1 - ON_LINE) - 1;
      let all = true;
      for (let z = cz0; z <= cz1 && all; z++) for (let x = cx0; x <= cx1 && all; x++) if (l.ground(x, z) === null) all = false;
      if (all) return true;
    }
    return false;
  }

  /** Whether a cell of the terrain is cut: the layer in `cut` mode, the cell and the eight round it wholly on a footprint. */
  private cut(gx: number, gz: number): boolean {
    if (this.settings.mode !== 'cut') return false;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.cellCovered(gx + dx, gz + dz)) return false;
    return true;
  }

  /**
   * Tile (tx, tz)'s heights (16-bit steps) with the blocks applied over
   * `src` by `k` (the layer's strength); the same array when nothing changes.
   */
  heights(tx: number, tz: number, src: Uint16Array, k: number): Uint16Array {
    if (!this.reaches(tx, tz) || k <= 0) return src;
    const S = this.n + 1;
    const oy = this.origin[1]!;
    let out: Uint16Array | null = null;
    const [bx0, bz0, bx1, bz1] = this.rect!;
    const sink = Math.max(TERRAIN_BLOCKS_SINK, (this.range[1]! - this.range[0]!) / TERRAIN_HEIGHT_STEPS);
    for (let j = 0; j < S; j++) {
      const gz = tz * this.n + j;
      const wz = this.origin[2]! + gz * this.sp;
      if (wz < bz0 || wz > bz1) continue;
      for (let i = 0; i < S; i++) {
        const gx = tx * this.n + i;
        const wx = this.origin[0]! + gx * this.sp;
        if (wx < bx0 || wx > bx1) continue;
        const s = this.sample(wx, wz);
        if (s === null) continue;
        let target = s.height - oy;
        // Under the blocks where a drawn cell meets the sample: below their tops.
        if (s.inside && (this.settings.mode === 'flatten' || !(this.cut(gx - 1, gz - 1) && this.cut(gx, gz - 1) && this.cut(gx - 1, gz) && this.cut(gx, gz)))) target -= sink;
        const idx = j * S + i;
        const cur: Uint16Array = out ?? src;
        const h = terrainHeightOf(this.range, cur[idx]!);
        const step = terrainStepOf(this.range, h + (target - h) * s.weight * k);
        if (step === cur[idx]) continue;
        out ??= src.slice();
        out[idx] = step;
      }
    }
    return out ?? src;
  }

  /**
   * Tile (tx, tz)'s hole bits with the footprint's cells cut over `src`
   * (`cut` mode); the same array (or null) when nothing changes.
   */
  holes(tx: number, tz: number, src: Uint8Array | null): Uint8Array | null {
    if (this.settings.mode !== 'cut' || !this.reaches(tx, tz)) return src;
    const n = this.n;
    let out: Uint8Array | null = null;
    const [bx0, bz0, bx1, bz1] = this.rect!;
    for (let j = 0; j < n; j++) {
      const gz = tz * n + j;
      const wz = this.origin[2]! + gz * this.sp;
      if (wz + this.sp < bz0 || wz > bz1) continue;
      for (let i = 0; i < n; i++) {
        const gx = tx * n + i;
        const wx = this.origin[0]! + gx * this.sp;
        if (wx + this.sp < bx0 || wx > bx1) continue;
        const bit = j * n + i;
        const cur = out ?? src;
        if (cur !== null && (cur[bit >> 3]! & (1 << (bit & 7))) !== 0) continue;
        if (!this.cut(gx, gz)) continue;
        out ??= src !== null ? src.slice() : new Uint8Array(Math.ceil((n * n) / 8));
        out[bit >> 3] = out[bit >> 3]! | (1 << (bit & 7));
      }
    }
    return out ?? src;
  }

  /**
   * The layer weights the blocks put over tile (tx, tz)'s material, scaled by
   * `k`: per layer 0–3 an amount, applied in order as the splines' paint is,
   * which together move a sample's weights toward the blocks' by the
   * sample's share (null: none).
   */
  paint(tx: number, tz: number, k: number): TerrainSplinePaint[] | null {
    if (!this.settings.paint || !this.reaches(tx, tz) || k <= 0) return null;
    const key = `${tx},${tz},${k}`;
    if (!this.paints.has(key)) this.paints.set(key, this.paintOf(tx, tz, k));
    return this.paints.get(key)!;
  }

  private paintOf(tx: number, tz: number, k: number): TerrainSplinePaint[] | null {
    const S = this.n + 1;
    type Want = { i: number; a: number; layer: number; p: readonly [number, number]; c: readonly [number, number] };
    const wants: Want[] = [];
    const [bx0, bz0, bx1, bz1] = this.rect!;
    for (let j = 0; j < S; j++) {
      const wz = this.origin[2]! + (tz * this.n + j) * this.sp;
      if (wz < bz0 || wz > bz1) continue;
      for (let i = 0; i < S; i++) {
        const wx = this.origin[0]! + (tx * this.n + i) * this.sp;
        if (wx < bx0 || wx > bx1) continue;
        const s = this.sample(wx, wz);
        if (s === null || s.weight <= 0) continue;
        wants.push({ i: j * S + i, a: s.weight * k, layer: s.layer, p: s.paintAt, c: s.column });
      }
    }
    if (wants.length === 0) return null;
    const amounts = [0, 1, 2, 3].map(() => new Float32Array(S * S));
    // The blocks' weights at the points, one call per chunk of a block layer (a part of one-vertex triangles).
    const groups = new Map<string, Want[]>();
    for (const w of wants) {
      const key = `${w.layer}:${Math.floor(w.c[0] / CHUNK_SIZE)},${Math.floor(w.c[1] / CHUNK_SIZE)}`;
      let list = groups.get(key);
      if (list === undefined) groups.set(key, (list = []));
      list.push(w);
    }
    const t = [0, 0, 0, 0];
    for (const [key, list] of groups) {
      const l = this.layers[Number(key.slice(0, key.indexOf(':')))]!;
      const positions = new Float32Array(list.length * 3);
      const normals = new Float32Array(list.length * 3);
      const indices = new Uint32Array(list.length * 3);
      list.forEach((w, m) => {
        // Nudged into its column, so the point's cell is the column's block.
        const u = Math.min(w.c[0] + 1 - 1e-4, Math.max(w.c[0] + 1e-4, w.p[0]));
        const v = Math.min(w.c[1] + 1 - 1e-4, Math.max(w.c[1] + 1e-4, w.p[1]));
        const y = l.topAt(w.c[0], w.c[1], u, v) ?? 0;
        const [gx, gz] = l.gradientAt(w.c[0], w.c[1], u, v);
        const len = Math.hypot(gx, 1, gz);
        positions.set([u * l.cw, y, v * l.cd], m * 3);
        normals.set([-gx / len, 1 / len, -gz / len], m * 3);
        indices.set([m, m, m], m * 3);
      });
      const [cx, cz] = key.slice(key.indexOf(':') + 1).split(',').map(Number) as [number, number];
      const weights = chunkMeshPaint(l.grid, l.src.types, cx, cz, { wallPaint: false, topSubdivision: l.src.component.topSubdivision ?? 1, ...(l.rules !== undefined ? { rules: l.rules } : {}), origin: l.src.origin }, { positions, normals, indices }).weights;
      list.forEach((w, m) => {
        let sum = 0;
        for (let c = 0; c < TERRAIN_SAMPLE_LAYERS; c++) sum += t[c] = weights[m * 4 + c]!;
        if (sum <= 0) return;
        // Layer by layer, so mixing them in order lands on (1 − a)·weights + a·target.
        let after = 0;
        for (let c = TERRAIN_SAMPLE_LAYERS - 1; c >= 0; c--) {
          const share = t[c]! / sum;
          const rest = 1 - w.a * after;
          amounts[c]![w.i] = rest > 0 ? Math.min(1, (w.a * share) / rest) : 1;
          after += share;
        }
      });
    }
    return amounts.map((amount, layer) => ({ layer, amount }));
  }
}
