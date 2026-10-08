/**
 * The terrain tools' brush maths, kept apart from the Scene view so it is
 * checked without a browser: the tools, their brush settings, where a drag
 * drops its dabs, how many dabs one stroke may hold (the command's
 * per-request bounds), the `editTerrain` args a stroke stores and the dab
 * its GPU preview draws (the same numbers, so the preview is the stroke).
 *
 * Ctrl (or the panel's invert) turns raise into lower and back, paint into
 * erasing hand paint, and holes into filling them.
 *
 * Pure.
 */
import { TERRAIN_BRUSH_LIMITS, terrainDabSamples, type BrushFalloff, type ErosionSettings, type TerrainLayer, type TerrainStamp } from '@thirdlight/runtime';
import type { TerrainBrushKind, TerrainPreviewDab } from '@thirdlight/three-adapter';

/**
 * The sculpt and paint tools (previewed on the GPU), the scatter brush (its
 * copies come with the stored edit) and the placed tools: a click puts a
 * stamp in a stamps layer, or erodes the square under the brush into an
 * erosion layer (no preview: the combined ground comes back from the
 * backend).
 */
export type TerrainToolId = TerrainBrushKind | 'scatter' | 'stamp' | 'erode';

/** The tools a click places rather than strokes. */
export const PLACED_TERRAIN_TOOLS: readonly TerrainToolId[] = ['stamp', 'erode'];

/** Whether a tool's dabs are previewed on the GPU. */
export const previewedTool = (t: TerrainToolId): t is TerrainBrushKind => t !== 'scatter' && !PLACED_TERRAIN_TOOLS.includes(t);

export const TERRAIN_TOOLS: readonly { id: TerrainToolId; label: string; title: string }[] = Object.freeze([
  { id: 'raise', label: 'Raise', title: 'Raise the ground under the brush (Ctrl: lower)' },
  { id: 'lower', label: 'Lower', title: 'Lower the ground under the brush (Ctrl: raise)' },
  { id: 'smooth', label: 'Smooth', title: 'Smooth the ground toward its neighbours' },
  { id: 'flatten', label: 'Flatten', title: 'Level the ground to the height where the stroke began' },
  { id: 'noise', label: 'Noise', title: 'Add bumps of the noise size' },
  { id: 'ramp', label: 'Ramp', title: 'Drag from one point to another: the ground between them takes the straight slope' },
  { id: 'paint', label: 'Paint', title: 'Paint the chosen layer (Ctrl: take hand paint back)' },
  { id: 'holes', label: 'Holes', title: 'Cut holes in the ground (Ctrl: fill them)' },
  { id: 'scatter', label: 'Scatter', title: "Put the chosen scatter rule's copies under the brush whatever its conditions (Ctrl: take them off); a bake keeps both" },
  { id: 'stamp', label: 'Stamp', title: 'Click to place the chosen heightmap as a stamp (its side twice the radius) in a stamps layer' },
  { id: 'erode', label: 'Erode', title: 'Click to erode the square under the brush (its side twice the radius) into an erosion layer' },
]);

/** The brush's settings (one set for every tool; each reads its own). */
export interface TerrainBrushState {
  /** Metres. */
  radius: number;
  /** raise, lower, noise: metres a dab moves the ground at its centre. */
  height: number;
  /** smooth, flatten, ramp, paint: the blend a dab makes at its centre (0–1]. */
  blend: number;
  falloff: BrushFalloff;
  /** paint: the material layer (0–255). */
  layer: number;
  /** noise: the bumps' size (metres) and seed. */
  scale: number;
  seed: number;
  /** scatter: the scatter rule whose copies the brush edits ('': none chosen). */
  rule: string;
}

export const DEFAULT_TERRAIN_BRUSH: TerrainBrushState = Object.freeze({ radius: 8, height: 0.5, blend: 0.5, falloff: 'smooth', layer: 1, scale: 16, seed: 1, rule: '' }) as TerrainBrushState;

/** The settings' bounds in the panel (the command's per-request bounds cap them). */
export const TERRAIN_BRUSH_UI = Object.freeze({ radiusMin: 0.25, radiusMax: TERRAIN_BRUSH_LIMITS.radiusMax, heightMax: TERRAIN_BRUSH_LIMITS.heightStrengthMax, scaleMax: TERRAIN_BRUSH_LIMITS.noiseScaleMax });

/** The kind a stroke of `tool` stores, with Ctrl or the panel's invert (raise and lower trade places). */
export function strokeKind(tool: TerrainToolId, invert: boolean): TerrainToolId {
  if (!invert) return tool;
  if (tool === 'raise') return 'lower';
  if (tool === 'lower') return 'raise';
  return tool;
}

/** Metres between a drag's dabs: a quarter of the radius (a fast drag leaves no gaps), at least half a sample. */
export function terrainDabSpacing(radius: number, spacing: number): number {
  return Math.max(spacing * 0.5, radius / 4);
}

/** The most dabs one stroke may hold at this radius (the command's bounds on dabs and on the samples they cover). */
export function strokeDabLimit(radius: number, spacing: number): number {
  return Math.max(1, Math.min(TERRAIN_BRUSH_LIMITS.dabs, Math.floor(TERRAIN_BRUSH_LIMITS.samples / terrainDabSamples(radius, spacing))));
}

/** The points from `last` toward `to` (x, z) a drag passes at `step` apart (`last` itself excluded); the new last point. */
export function dabsAlong(last: readonly [number, number], to: readonly [number, number], step: number): { points: [number, number][]; last: [number, number] } {
  const dx = to[0] - last[0];
  const dz = to[1] - last[1];
  const n = Math.floor(Math.hypot(dx, dz) / step);
  if (n === 0) return { points: [], last: [last[0], last[1]] };
  const points: [number, number][] = [];
  for (let i = 1; i <= n; i++) points.push([last[0] + (dx * i) / n, last[1] + (dz * i) / n]);
  return { points, last: points[n - 1]! };
}

/** What a stroke stores besides its points: flatten's level, a ramp's ends (world). */
export interface StrokeExtra {
  height?: number;
  from?: [number, number, number];
  to?: [number, number, number];
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** One dab of the preview, as the stroke stores it (null: the tool has no preview — the scatter brush). */
export function previewDab(tool: TerrainToolId, b: TerrainBrushState, at: readonly [number, number], invert: boolean, extra: StrokeExtra): TerrainPreviewDab | null {
  const kind = strokeKind(tool, invert);
  if (!previewedTool(kind)) return null;
  const base = { kind, at: [r4(at[0]), r4(at[1])] as [number, number], radius: b.radius, falloff: b.falloff };
  switch (kind) {
    case 'raise':
    case 'lower':
      return { ...base, strength: b.height };
    case 'noise':
      return { ...base, strength: b.height, scale: b.scale, seed: b.seed };
    case 'smooth':
      return { ...base, strength: b.blend };
    case 'flatten':
      return { ...base, strength: b.blend, height: extra.height ?? 0 };
    case 'ramp':
      return { kind, radius: b.radius, falloff: b.falloff, strength: b.blend, from: extra.from ?? [at[0], 0, at[1]], to: extra.to ?? [at[0], 0, at[1]] };
    case 'paint':
      return { ...base, strength: b.blend, layer: b.layer, ...(invert ? { erase: true } : {}) };
    case 'holes':
      return { kind, at: base.at, radius: b.radius, ...(invert ? { erase: true } : {}) };
  }
}

/** The `editTerrain` args of a stroke (its dabs' points in world metres). */
export function strokeArgs(entityId: string, tool: TerrainToolId, b: TerrainBrushState, dabs: readonly (readonly [number, number])[], invert: boolean, extra: StrokeExtra): Record<string, unknown> {
  const kind = strokeKind(tool, invert);
  const points = dabs.map((d) => [r4(d[0]), r4(d[1])]);
  switch (kind) {
    case 'raise':
    case 'lower':
      return { entityId, kind, dabs: points, radius: b.radius, strength: b.height, falloff: b.falloff };
    case 'noise':
      return { entityId, kind, dabs: points, radius: b.radius, strength: b.height, falloff: b.falloff, scale: b.scale, seed: b.seed };
    case 'smooth':
      return { entityId, kind, dabs: points, radius: b.radius, strength: b.blend, falloff: b.falloff };
    case 'flatten':
      return { entityId, kind, dabs: points, radius: b.radius, strength: b.blend, falloff: b.falloff, height: extra.height ?? 0 };
    case 'ramp':
      return { entityId, kind, from: extra.from, to: extra.to, radius: b.radius, strength: b.blend, falloff: b.falloff };
    case 'paint':
      return { entityId, kind, dabs: points, radius: b.radius, strength: b.blend, falloff: b.falloff, layer: b.layer, ...(invert ? { erase: true } : {}) };
    case 'holes':
      return { entityId, kind, dabs: points, radius: b.radius, ...(invert ? { erase: true } : {}) };
    case 'scatter':
      return { entityId, kind, rule: b.rule, dabs: points, radius: b.radius, ...(invert ? { erase: true } : {}) };
    case 'stamp':
    case 'erode':
      return { entityId, kind };
  }
}

/** The stamp tool's settings (its side is twice the brush radius). */
export interface StampToolState {
  /** The texture asset whose first channel is the shape ('': none chosen). */
  asset: string;
  height: number;
  rotation: number;
  mode: TerrainStamp['mode'] & string;
  falloff: number;
  /** The stamps layer placed into ('': the first, or a new one). */
  layer: string;
}

export const DEFAULT_STAMP_TOOL: StampToolState = Object.freeze({ asset: '', height: 30, rotation: 0, mode: 'add', falloff: 0.15, layer: '' }) as StampToolState;

/** A free layer id from `base` ("stamps", "stamps-2", …). */
export function freeLayerId(layers: readonly TerrainLayer[], base: string): string {
  const taken = new Set(layers.map((l) => l.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The layers after a stamp is placed at world (x, z): into the chosen
 * stamps layer, else the first, else a new one on top (under the splines).
 */
export function layersWithStamp(layers: readonly TerrainLayer[], st: StampToolState, at: readonly [number, number], radius: number): TerrainLayer[] {
  const stamp: TerrainStamp = { asset: st.asset, at: [r4(at[0]), r4(at[1])], size: r4(radius * 2), height: st.height, ...(st.rotation !== 0 ? { rotation: st.rotation } : {}), ...(st.mode !== 'add' ? { mode: st.mode } : {}), falloff: st.falloff };
  const target = layers.find((l) => l.kind === 'stamps' && (st.layer === '' || l.id === st.layer));
  if (target === undefined) {
    const made: TerrainLayer = { id: freeLayerId(layers, 'stamps'), kind: 'stamps', stamps: [stamp] };
    const splines = layers.findIndex((l) => l.kind === 'splines');
    return splines < 0 ? [...layers, made] : [...layers.slice(0, splines), made, ...layers.slice(splines)];
  }
  return layers.map((l) => (l === target && l.kind === 'stamps' ? { ...l, stamps: [...l.stamps, stamp] } : l));
}

/** The erode tool's settings (each run on or off). */
export interface ErodeToolState {
  hydraulic: boolean;
  droplets: number;
  erosion: number;
  deposition: number;
  thermal: boolean;
  iterations: number;
  talus: number;
  seed: number;
}

export const DEFAULT_ERODE_TOOL: ErodeToolState = Object.freeze({ hydraulic: true, droplets: 0.5, erosion: 0.3, deposition: 0.3, thermal: true, iterations: 40, talus: 35, seed: 1 }) as ErodeToolState;

/** The `editTerrain` erode args for a click at world (x, z): the square of side twice the radius. */
export function erodeArgs(entityId: string, e: ErodeToolState, at: readonly [number, number], radius: number): Record<string, unknown> {
  const settings: ErosionSettings = { ...(e.hydraulic ? { hydraulic: { droplets: e.droplets, erosion: e.erosion, deposition: e.deposition } } : {}), ...(e.thermal ? { thermal: { iterations: e.iterations, talus: e.talus } } : {}) };
  return { entityId, kind: 'erode', rect: [r4(at[0] - radius), r4(at[1] - radius), r4(at[0] + radius), r4(at[1] + radius)], ...settings, seed: e.seed };
}
