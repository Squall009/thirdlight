/**
 * The arithmetic of a terrain stroke's GPU preview (`terrain-brush-gpu.ts`),
 * kept apart from the drawing so it is checked without a GPU: a dab as the
 * editor sends it (world metres, as `editTerrain` takes it) in the terrain's
 * own frame, the samples it reaches, the rectangle of each tile it writes,
 * and how a previewed rectangle compares with the stored tile that replaced
 * it.
 *
 * Pure.
 */
import { TERRAIN_HEIGHT_STEPS, type BrushFalloff } from '@thirdlight/runtime';

import { terrainBrushMargin, type TerrainBrushDab, type TerrainBrushKind } from './terrain-brush-gpu';
import { TERRAIN_TEXEL_BYTES } from './terrain-texels';

/** One dab of a stroke in world metres, the fields of `editTerrain` for its kind (a ramp is one "dab" from `from` to `to`). */
export interface TerrainPreviewDab {
  kind: TerrainBrushKind;
  /** The dab's centre, world (x, z). */
  at?: readonly [number, number];
  radius: number;
  /** raise, lower, noise: metres at the centre; smooth, flatten, ramp, paint: the blend at the centre. */
  strength?: number;
  falloff?: BrushFalloff;
  /** flatten: the world height levelled to. */
  height?: number;
  scale?: number;
  seed?: number;
  /** ramp: its world ends. */
  from?: readonly [number, number, number];
  to?: readonly [number, number, number];
  layer?: number;
  erase?: boolean;
}

/** The terrain's shape a dab is put into. */
export interface PreviewShape {
  origin: readonly number[];
  heightRange: readonly number[];
  spacing: number;
}

/** A dab in the terrain's frame, heights as steps (what the GPU pass reads). */
export function brushDabOf(d: TerrainPreviewDab, s: PreviewShape): TerrainBrushDab {
  const [ox, oy, oz] = [s.origin[0] ?? 0, s.origin[1] ?? 0, s.origin[2] ?? 0];
  const low = s.heightRange[0]!;
  const mps = (s.heightRange[1]! - low) / TERRAIN_HEIGHT_STEPS;
  const stepOf = (worldY: number): number => (worldY - oy - low) / mps;
  const metres = d.kind === 'raise' || d.kind === 'lower' || d.kind === 'noise';
  const strength = d.kind === 'holes' ? 1 : metres ? (d.strength ?? 0) / mps : Math.min(1, d.strength ?? 0);
  const from = d.from ?? [0, 0, 0];
  const to = d.to ?? from;
  return {
    kind: d.kind,
    cx: (d.at?.[0] ?? 0) - ox,
    cz: (d.at?.[1] ?? 0) - oz,
    radius: d.radius,
    falloff: d.falloff ?? 'smooth',
    strength,
    target: d.kind === 'flatten' ? stepOf(d.height ?? 0) : 0,
    scale: d.scale ?? 8 * s.spacing,
    seed: d.seed ?? 0,
    from: [from[0] - ox, from[2] - oz, stepOf(from[1])],
    to: [to[0] - ox, to[2] - oz, stepOf(to[1])],
    layer: d.layer ?? 0,
    erase: d.erase === true,
  };
}

/**
 * The global samples a dab writes, inclusive [x0, z0, x1, z1]: those its
 * core changes (`terrain-edit.ts`'s boxes; holes: the cells, by their min
 * corner sample) and the kind's margin.
 */
export function brushSampleBox(d: TerrainBrushDab, spacing: number): [number, number, number, number] {
  const m = terrainBrushMargin(d.kind);
  const r = d.radius;
  if (d.kind === 'holes') {
    return [Math.ceil((d.cx - r) / spacing - 0.5), Math.ceil((d.cz - r) / spacing - 0.5), Math.floor((d.cx + r) / spacing - 0.5), Math.floor((d.cz + r) / spacing - 0.5)];
  }
  let [x0, z0, x1, z1] = [d.cx - r, d.cz - r, d.cx + r, d.cz + r];
  if (d.kind === 'ramp') [x0, z0, x1, z1] = [Math.min(d.from[0], d.to[0]) - r, Math.min(d.from[1], d.to[1]) - r, Math.max(d.from[0], d.to[0]) + r, Math.max(d.from[1], d.to[1]) + r];
  return [Math.ceil(x0 / spacing) - m, Math.ceil(z0 / spacing) - m, Math.floor(x1 / spacing) + m, Math.floor(z1 / spacing) + m];
}

/** The tiles a sample box reaches ([tx0, tz0, tx1, tz1]: a tile of `cells` holds samples [t·cells, (t + 1)·cells]). */
export function boxTiles(box: readonly number[], cells: number): [number, number, number, number] {
  return [Math.ceil(box[0]! / cells) - 1, Math.ceil(box[1]! / cells) - 1, Math.floor(box[2]! / cells), Math.floor(box[3]! / cells)];
}

/** A sample box's part in tile (tx, tz), local inclusive [x0, z0, x1, z1], or null. */
export function tileRect(box: readonly number[], tx: number, tz: number, cells: number): [number, number, number, number] | null {
  const x0 = Math.max(0, box[0]! - tx * cells);
  const z0 = Math.max(0, box[1]! - tz * cells);
  const x1 = Math.min(cells, box[2]! - tx * cells);
  const z1 = Math.min(cells, box[3]! - tz * cells);
  return x0 > x1 || z0 > z1 ? null : [x0, z0, x1, z1];
}

/** The union of two rectangles (`a` null: `b`). */
export function rectUnion(a: readonly number[] | null, b: readonly number[]): [number, number, number, number] {
  if (a === null) return [b[0]!, b[1]!, b[2]!, b[3]!];
  return [Math.min(a[0]!, b[0]!), Math.min(a[1]!, b[1]!), Math.max(a[2]!, b[2]!), Math.max(a[3]!, b[3]!)];
}

/** How a previewed rectangle differs from the stored tile that replaced it. */
export interface PreviewDiff {
  /** Samples compared. */
  samples: number;
  /** Heights: the largest difference in steps and the samples that differ at all. */
  stepsMax: number;
  stepsDiffering: number;
  /** Normals: the largest difference of a stored byte (x or z). */
  normalMax: number;
  /** Layer weights: the largest difference of a weight byte; holes that differ. */
  weightMax: number;
  holesDiffering: number;
  /** Samples where a channel with weight names another layer. */
  indicesDiffering: number;
}

export function emptyDiff(): PreviewDiff {
  return { samples: 0, stepsMax: 0, stepsDiffering: 0, normalMax: 0, weightMax: 0, holesDiffering: 0, indicesDiffering: 0 };
}

/**
 * Add one rectangle's comparison to `out`: `preview` holds the rectangle's
 * texels as read back (rows of its width), `stored` the tile's whole layer
 * (rows of `samples`). `weights` is the tile's stored weights layer, which
 * says which index channels matter (for `part` 'indices').
 */
export function compareRect(out: PreviewDiff, part: 'heights' | 'layers' | 'indices', preview: Uint8Array, stored: Uint8Array, rect: readonly number[], samples: number, weights?: Uint8Array): void {
  const [x0, z0, x1, z1] = rect as [number, number, number, number];
  const w = x1 - x0 + 1;
  const B = TERRAIN_TEXEL_BYTES;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const p = ((z - z0) * w + (x - x0)) * B;
      const s = (z * samples + x) * B;
      if (part === 'heights') {
        out.samples += 1;
        const d = Math.abs(preview[p]! * 256 + preview[p + 1]! - (stored[s]! * 256 + stored[s + 1]!));
        if (d > 0) out.stepsDiffering += 1;
        out.stepsMax = Math.max(out.stepsMax, d);
        out.normalMax = Math.max(out.normalMax, Math.abs(preview[p + 2]! - stored[s + 2]!), Math.abs(preview[p + 3]! - stored[s + 3]!));
      } else if (part === 'layers') {
        out.samples += 1;
        for (let c = 0; c < 3; c++) out.weightMax = Math.max(out.weightMax, Math.abs(preview[p + c]! - stored[s + c]!));
        if ((preview[p + 3]! >= 128) !== (stored[s + 3]! >= 128)) out.holesDiffering += 1;
      } else {
        const wt = weights!;
        const rest = 255 - wt[s]! - wt[s + 1]! - wt[s + 2]!;
        for (let c = 0; c < 4; c++) {
          const weight = c < 3 ? wt[s + c]! : rest;
          if (weight > 2 && preview[p + c] !== stored[s + c]) {
            out.indicesDiffering += 1;
            break;
          }
        }
      }
    }
  }
}
