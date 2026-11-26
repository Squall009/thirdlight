/**
 * The world edit mode's state, apart from its drawing: which brush each rail
 * arms (Sculpt: Add, Dig, Smooth, Flatten; Paint: a material and a wetness
 * through the noise mask), what that brush writes, and the material palette
 * as tiles (a base material heading its variants).
 *
 * Pure.
 */
import { WETNESS_MAX, type BrushShape } from '@thirdlight/voxel';

import type { BrushUse } from './brush';
import type { PaletteLayer } from './layer-palette';
import { addRoleOf, type VoxelBrushKind, type VoxelBrushVoxel, type VoxelPaletteEntry } from './voxel-brush';

export type WorldRail = 'sculpt' | 'paint';
export type SculptKind = Extract<VoxelBrushKind, 'add' | 'dig' | 'smooth' | 'flatten'>;

/** What the mode remembers for the page: the Sculpt tool, the brush's shape and rim, the material picked and Paint's wetness. */
export interface WorldBrushState {
  readonly sculpt: SculptKind;
  readonly shape: BrushShape;
  /** A soft rim (Sculpt; a Paint is hard: a cell holds one material). */
  readonly soft: boolean;
  /** The voxel material id picked in the palette (null: the palette's first). */
  readonly material: number | null;
  /** The wetness Paint gives (0 dry … `WETNESS_MAX`). */
  readonly wetness: number;
}

export const WORLD_BRUSH_START: WorldBrushState = Object.freeze({ sculpt: 'add', shape: 'sphere', soft: true, material: null, wetness: 0 });

export const SCULPT_TOOLS = [
  { id: 'add', label: 'Add', glyph: 'raise', key: 'A', hint: 'Drag over the ground to add the picked material in front of it (hold Ctrl to dig instead).' },
  { id: 'dig', label: 'Dig', glyph: 'lower', key: 'D', hint: 'Drag over the ground to take it out (hold Ctrl to add instead).' },
  { id: 'smooth', label: 'Smooth', glyph: 'smooth', key: 'S', hint: 'Drag over the ground to even out its surface under the brush.' },
  { id: 'flatten', label: 'Flatten', glyph: 'flatten', key: 'T', hint: 'Drag to bring the ground to the height where the stroke starts.' },
] as const;

export const PAINT_TOOLS = [{ id: 'paint', label: 'Paint', glyph: 'paint', key: 'P', hint: 'Drag over the ground to give it the picked material and wetness; each cell keeps what it is (ground stays ground, a wall a wall).' }] as const;

/** The settings each rail's brush uses (the panel's rows, the keys). */
export const WORLD_BRUSH_USES: Readonly<Record<WorldRail, readonly BrushUse[]>> = Object.freeze({ sculpt: ['size', 'spacing', 'invert'], paint: ['size', 'spacing', 'mask'] });

/** The palette entry picked (the palette's first while none is, or once the picked one is gone); null: an empty palette. */
export function pickedEntry(palette: readonly VoxelPaletteEntry[], id: number | null): VoxelPaletteEntry | null {
  return palette.find((e) => e.id === id) ?? palette[0] ?? null;
}

/** What a rail arms the voxel brush with. */
export interface WorldBrushArming {
  readonly kind: VoxelBrushKind;
  readonly shape: BrushShape;
  readonly soft: boolean;
  readonly voxel: VoxelBrushVoxel | null;
  readonly uses: readonly BrushUse[];
}

/**
 * The brush a rail arms: Sculpt's tool with the picked material as what Add
 * writes (its role from the material's use, dry); Paint with the picked
 * material and wetness and no role, so each cell keeps its own.
 */
export function worldBrushArming(rail: WorldRail, s: WorldBrushState, palette: readonly VoxelPaletteEntry[]): WorldBrushArming {
  const m = pickedEntry(palette, s.material);
  if (rail === 'paint') return { kind: 'paint', shape: s.shape, soft: false, voxel: m === null ? null : { material: m.id, wetness: Math.max(0, Math.min(WETNESS_MAX, Math.round(s.wetness))) }, uses: WORLD_BRUSH_USES.paint };
  return { kind: s.sculpt, shape: s.shape, soft: s.soft, voxel: m === null ? null : { material: m.id, role: addRoleOf(m.use), wetness: 0 }, uses: WORLD_BRUSH_USES.sculpt };
}

/**
 * The palette as tiles, in its order (a tile's index is its place, as the
 * number keys pick it): each under its base material's heading when any
 * material has variants, a variant badged "V", the voxel id under its name.
 */
export function paletteTiles(palette: readonly VoxelPaletteEntry[]): PaletteLayer[] {
  const grouped = palette.some((e) => e.variant);
  return palette.map((e, index) => ({
    index,
    name: e.name,
    texture: null,
    colour: e.colour ?? '#808080',
    sub: `${e.use} · ${e.id}`,
    aria: `voxel material ${e.name}`,
    ...(e.variant ? { badge: 'V' } : {}),
    ...(grouped ? { group: e.base } : {}),
  }));
}
