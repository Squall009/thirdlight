/**
 * Probe tiles as the probe lighting holds them on the GPU: each tile packed
 * on its own (once, when its file is decoded), its place in the shared 3D
 * texture (`ProbeAtlasLayout`) and its row in the tile table.
 *
 * A packed tile is three's `LightProbeGrid` atlas layout (nx × ny ×
 * PROBE_GPU_TEXELS (nz + 2) — a sub-volume per texel of `PACKED` along z,
 * each with a padding slice at both ends, so trilinear filtering never reads
 * across sub-volumes) with each probe's light multiplied by its weight (the
 * filter then interpolates weighted light and weights; the shader divides).
 * Its bytes are exactly its region of the GPU texture, so it uploads as one
 * copy into its place and nothing else moves.
 *
 * The texture is cut into columns as wide as the widest tile; a tile takes a
 * run of rows (its ny) in a column, first fit, and gives them back when it
 * goes. When nothing fits the texture grows (columns or rows), keeping every
 * placed tile where it is — growing is one GPU copy of the old texture.
 */
import * as THREE from 'three/webgpu';
import { PROBE_ARTIFACT_ROW_PROBES, PROBE_ATLAS_PADDING, PROBE_FILLED, PROBE_GPU_TEXELS, PROBE_MOVED, PROBE_SH_TEXELS, PROBE_TEXELS, probeArtifactSize, type ProbeGridRecord } from '@thirdlight/runtime';

/**
 * How much a probe counts in the interpolation, by validity: a probe moved
 * out of geometry saw its light from up to half a spacing away (maybe the
 * other side of a thin wall), one filled from its neighbours inside geometry
 * is only a fallback where no valid probe is near.
 */
export const PROBE_WEIGHT_VALID = 1;
export const PROBE_WEIGHT_MOVED = 0.5;
export const PROBE_WEIGHT_FILLED = 1 / 64;

/** A probe's weight from its validity. */
export function probeWeight(validity: number): number {
  return validity === PROBE_FILLED ? PROBE_WEIGHT_FILLED : validity === PROBE_MOVED ? PROBE_WEIGHT_MOVED : PROBE_WEIGHT_VALID;
}

/**
 * What a probe holds in the packed texture, per texel: the first-order
 * spherical harmonics (L1: the irradiance of three's L2 terms without the
 * second band — what Unity's probe volumes draw by default, at four samples
 * instead of seven) times the probe's weight, the weight, then its walls as
 * the file has them. Each entry: a value of the file's probe (its 28 light
 * values, then its 8 wall values), 'w' (the weight) or null (0).
 */
const WALLS = PROBE_SH_TEXELS * 4;
const PACKED: readonly (readonly (number | 'w' | null)[])[] = [
  [0, 1, 2, 'w'],
  [3, 4, 5, 6],
  [7, 8, 9, 10],
  [11, null, null, null],
  [WALLS, WALLS + 1, WALLS + 2, WALLS + 3],
  [WALLS + 4, WALLS + 5, WALLS + 6, WALLS + 7],
];
/** Texels of a packed probe holding its light (the rest hold its walls). */
export const PACKED_LIGHT_TEXELS = 4;
// The GPU memory the bake reports (project-model `probeGridGpuBytes`) counts this layout.
if (PACKED.length !== PROBE_GPU_TEXELS) throw new Error(`probe texels packed: ${PACKED.length}, PROBE_GPU_TEXELS ${PROBE_GPU_TEXELS}`);

/** Bytes of a packed texel (RGBA half floats). */
export const PROBE_TEXEL_BYTES = 8;

/** A tile's depth in the packed texture (texels along z). */
export function packedProbeDepth(resolution: readonly number[]): number {
  return PROBE_GPU_TEXELS * (resolution[2]! + 2 * PROBE_ATLAS_PADDING);
}

export interface PackedProbeTile {
  /** RGBA half floats, nx × ny × depth (x fastest). */
  readonly data: Uint16Array;
  readonly nx: number;
  readonly ny: number;
  readonly depth: number;
}

/**
 * Pack one tile's probes into its GPU layout from its file's samples
 * (`PROBE_TEXELS` texels a probe, `PROBE_ARTIFACT_ROW_PROBES` probes a row;
 * see probe-artifact.ts).
 */
export function packProbeTile(grid: Pick<ProbeGridRecord, 'resolution'>, samples: Uint16Array, validity: Float32Array): PackedProbeTile {
  const [nx, ny, nz] = grid.resolution as [number, number, number];
  const fileWidth = probeArtifactSize(nx * ny * nz).width;
  const pad = PROBE_ATLAS_PADDING;
  const padded = nz + 2 * pad;
  const depth = PROBE_GPU_TEXELS * padded;
  const plane = nx * ny * 4;
  const data = new Uint16Array(plane * depth);
  const toHalf = THREE.DataUtils.toHalfFloat;
  const fromHalf = THREE.DataUtils.fromHalfFloat;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const p = ix + iy * nx + iz * nx * ny;
        const w = probeWeight(validity[p]!);
        const base = (Math.floor(p / PROBE_ARTIFACT_ROW_PROBES) * fileWidth + (p % PROBE_ARTIFACT_ROW_PROBES) * PROBE_TEXELS) * 4;
        const half = toHalf(w);
        const xy = (iy * nx + ix) * 4;
        for (let r = 0; r < PACKED.length; r++) {
          const texel = PACKED[r]!;
          const weighted = r < PACKED_LIGHT_TEXELS && w !== 1;
          const o = (r * padded + pad + iz) * plane + xy;
          for (let ch = 0; ch < 4; ch++) {
            const src = texel[ch];
            if (src === null || src === undefined) continue;
            if (src === 'w') {
              data[o + ch] = half;
              continue;
            }
            const raw = samples[base + src]!;
            data[o + ch] = weighted ? toHalf(fromHalf(raw) * w) : raw;
          }
        }
      }
    }
  }
  // The padding slices copy each sub-volume's edge slices.
  for (let r = 0; r < PACKED.length; r++) {
    const first = r * padded + pad;
    const last = first + nz - 1;
    for (let s = 0; s < pad; s++) {
      data.copyWithin((r * padded + s) * plane, first * plane, (first + 1) * plane);
      data.copyWithin((last + 1 + s) * plane, last * plane, (last + 1) * plane);
    }
  }
  return { data, nx, ny, depth };
}

/** Texels per tile in the tile table, and tiles per line of the table texture. */
export const TABLE_TEXELS = 3;
export const TABLE_ROWS_PER_LINE = 256;
/** Floats of one table row. */
export const TABLE_ROW_FLOATS = TABLE_TEXELS * 4;

/**
 * A tile's table row, what the shader needs ready-made: (scale.xyz, fade),
 * (offset.xyz, nz), (nx, ny, x place, y place) — a world point p is at probe
 * coordinates p × scale + offset; the fade is the tile's horizontal spacing.
 */
export function probeTableRow(grid: Pick<ProbeGridRecord, 'min' | 'max' | 'resolution'>, at: { x: number; y: number }): number[] {
  const [nx, ny, nz] = grid.resolution as [number, number, number];
  const n = [nx, ny, nz];
  const { min, max: hi } = grid;
  const scale = [0, 1, 2].map((a) => (n[a]! - 1) / (hi[a]! - min[a]!));
  return [scale[0]!, scale[1]!, scale[2]!, probeFade(grid), -min[0] * scale[0]!, -min[1] * scale[1]!, -min[2] * scale[2]!, nz, nx, ny, at.x, at.y];
}

/** How far past a tile's edge its light fades out: its horizontal spacing. */
export function probeFade(grid: Pick<ProbeGridRecord, 'min' | 'max' | 'resolution'>): number {
  const { min, max: hi, resolution: r } = grid;
  return Math.max((hi[0] - min[0]) / (r[0] - 1), (hi[2] - min[2]) / (r[2] - 1));
}

/** Where a tile sits in the texture (texels). */
export interface ProbePlace {
  readonly x: number;
  readonly y: number;
}

/**
 * The texture's columns and the runs of rows free in each. Every tile's
 * depth fits `depth`; every tile's width fits `columnWidth`.
 */
export class ProbeAtlasLayout {
  cols = 0;
  height = 0;
  /** Per column, its free runs of rows [from, to), sorted. */
  private free: [number, number][][] = [];

  constructor(
    readonly columnWidth: number,
    readonly depth: number,
    readonly maxEdge: number,
  ) {}

  get width(): number {
    return Math.max(1, this.cols * this.columnWidth);
  }

  /** The texture's bytes at this size (or another). */
  bytes(cols = this.cols, height = this.height): number {
    return cols * this.columnWidth * height * this.depth * PROBE_TEXEL_BYTES;
  }

  /** Place `ny` rows in the first column with room, or null. */
  place(ny: number): ProbePlace | null {
    for (let c = 0; c < this.cols; c++) {
      const runs = this.free[c]!;
      for (let k = 0; k < runs.length; k++) {
        const run = runs[k]!;
        if (run[1] - run[0] < ny) continue;
        const y = run[0];
        run[0] += ny;
        if (run[0] === run[1]) runs.splice(k, 1);
        return { x: c * this.columnWidth, y };
      }
    }
    return null;
  }

  /** Give back a placed tile's rows. */
  release(at: ProbePlace, ny: number): void {
    const runs = this.free[Math.floor(at.x / this.columnWidth)];
    if (runs === undefined) return;
    runs.push([at.y, at.y + ny]);
    runs.sort((a, b) => a[0] - b[0]);
    for (let k = runs.length - 1; k > 0; k--) {
      if (runs[k - 1]![1] >= runs[k]![0]) {
        runs[k - 1]![1] = Math.max(runs[k - 1]![1], runs[k]![1]);
        runs.splice(k, 1);
      }
    }
  }

  /**
   * Grow so a tile of `ny` rows fits, within `budget` bytes and the edge:
   * more columns while the texture is taller than wide, else more rows;
   * doubling, else just enough. Placed tiles keep their places. False: it
   * cannot grow that far.
   */
  grow(ny: number, budget: number): boolean {
    const maxCols = Math.floor(this.maxEdge / this.columnWidth);
    if (ny > this.maxEdge || maxCols < 1) return false;
    const tall = Math.max(this.height, ny);
    const wider = (cols: number) => ({ cols: Math.min(maxCols, cols), height: tall });
    const taller = (height: number) => ({ cols: Math.max(1, this.cols), height: Math.min(this.maxEdge, height) });
    const byCols = [wider(Math.max(1, this.cols * 2)), wider(this.cols + 1)];
    const byRows = [taller(Math.max(this.height * 2, ny)), taller(this.height + ny)];
    const order = this.cols * this.columnWidth < this.height ? [...byCols, ...byRows] : [...byRows, ...byCols];
    for (const o of order) {
      const bigger = o.cols > this.cols || o.height > this.height;
      const fits = o.height >= ny && (o.cols > this.cols || this.freeTail(o.height) >= ny);
      if (bigger && fits && this.bytes(o.cols, o.height) <= budget) {
        this.resize(o.cols, o.height);
        return true;
      }
    }
    return false;
  }

  /** Set the size (never smaller): new rows extend each column's free runs, new columns are all free. */
  resize(cols: number, height: number): void {
    if (height > this.height) {
      for (const runs of this.free) {
        const last = runs[runs.length - 1];
        if (last !== undefined && last[1] === this.height) last[1] = height;
        else runs.push([this.height, height]);
      }
      this.height = height;
    }
    while (this.cols < cols) {
      this.free.push(this.height > 0 ? [[0, this.height]] : []);
      this.cols++;
    }
  }

  /** The most rows free at the bottom of any column if it were `height` tall. */
  private freeTail(height: number): number {
    let best = 0;
    for (const runs of this.free) {
      const last = runs[runs.length - 1];
      best = Math.max(best, height - (last !== undefined && last[1] === this.height ? last[0] : this.height));
    }
    return best;
  }
}
