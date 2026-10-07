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
import { TERRAIN_BRUSH_LIMITS, terrainDabSamples, type BrushFalloff } from '@thirdlight/runtime';
import type { TerrainBrushKind, TerrainPreviewDab } from '@thirdlight/three-adapter';

export type TerrainToolId = TerrainBrushKind;

export const TERRAIN_TOOLS: readonly { id: TerrainToolId; label: string; title: string }[] = Object.freeze([
  { id: 'raise', label: 'Raise', title: 'Raise the ground under the brush (Ctrl: lower)' },
  { id: 'lower', label: 'Lower', title: 'Lower the ground under the brush (Ctrl: raise)' },
  { id: 'smooth', label: 'Smooth', title: 'Smooth the ground toward its neighbours' },
  { id: 'flatten', label: 'Flatten', title: 'Level the ground to the height where the stroke began' },
  { id: 'noise', label: 'Noise', title: 'Add bumps of the noise size' },
  { id: 'ramp', label: 'Ramp', title: 'Drag from one point to another: the ground between them takes the straight slope' },
  { id: 'paint', label: 'Paint', title: 'Paint the chosen layer (Ctrl: take hand paint back)' },
  { id: 'holes', label: 'Holes', title: 'Cut holes in the ground (Ctrl: fill them)' },
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
}

export const DEFAULT_TERRAIN_BRUSH: TerrainBrushState = Object.freeze({ radius: 8, height: 0.5, blend: 0.5, falloff: 'smooth', layer: 1, scale: 16, seed: 1 }) as TerrainBrushState;

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

/** One dab of the preview, as the stroke stores it. */
export function previewDab(tool: TerrainToolId, b: TerrainBrushState, at: readonly [number, number], invert: boolean, extra: StrokeExtra): TerrainPreviewDab {
  const kind = strokeKind(tool, invert);
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
  }
}
