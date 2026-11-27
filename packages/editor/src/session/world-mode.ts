/**
 * The world edit mode's state, apart from its drawing: which brush each rail
 * arms (Sculpt: Add, Dig, Smooth, Flatten; Paint: a material and a wetness
 * through the noise mask, or with a gas picked the fog brush: paint at a
 * density, erase, smooth; Fill: fog to a level, a drain, a water body;
 * Splines: a road, a path or a river started; Rules: the probe that reads
 * the surface under the pointer), what each writes, and the material
 * palettes as tiles (a base material heading its variants).
 *
 * Pure.
 */
import { SHAPE_FULL, VOXEL_ROLE, WETNESS_MAX, type BrushShape } from '@thirdlight/voxel';

import type { BrushUse } from './brush';
import type { PaletteLayer } from './layer-palette';
import { addRoleOf, type VoxelBrushKind, type VoxelBrushVoxel, type VoxelPaletteEntry } from './voxel-brush';
import { fogDensity, splineStartVoxels, type SplineStartKind, type SplineStartVoxels, type VoxelFillKind } from './voxel-fill';

export type WorldRail = 'sculpt' | 'paint' | 'fill' | 'spline' | 'rules';
export type SculptKind = Extract<VoxelBrushKind, 'add' | 'dig' | 'smooth' | 'flatten'>;
export type FogKind = Extract<VoxelBrushKind, 'fog' | 'fog-erase' | 'fog-smooth'>;
export type FillKind = Exclude<VoxelFillKind, 'spline'>;

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
  /** Paint's tool while a gas is picked. */
  readonly fog: FogKind;
  /** The density fog is painted at, in the levels a cell holds (1 … `SHAPE_FULL`). */
  readonly density: number;
  /** The Fill rail's tool. */
  readonly fill: FillKind;
  /** The gas a fog fill writes and the liquid a water body holds (voxel material ids; null: the palette's first). */
  readonly gas: number | null;
  readonly liquid: number | null;
  /** The level a click gives, metres over the point clicked (a drag sets it). */
  readonly depth: number;
  /** A fog fill's fade under its level, metres (0: full density up to the level). */
  readonly fade: number;
  /** A fill's reach from the point clicked, metres. */
  readonly reach: number;
  /** What the spline entry starts. */
  readonly spline: SplineStartKind;
  /** Whether the Scene view shows fog by its density (the overlay) while a fog tool's column shows. */
  readonly overlay: boolean;
}

export const WORLD_BRUSH_START: WorldBrushState = Object.freeze({ sculpt: 'add', shape: 'sphere', soft: true, material: null, wetness: 0, fog: 'fog', density: 8, fill: 'fog', gas: null, liquid: null, depth: 2, fade: 1, reach: 32, spline: 'road', overlay: false });

export const SCULPT_TOOLS = [
  { id: 'add', label: 'Add', glyph: 'raise', key: 'A', hint: 'Drag over the ground to add the picked material in front of it (hold Ctrl to dig instead).' },
  { id: 'dig', label: 'Dig', glyph: 'lower', key: 'D', hint: 'Drag over the ground to take it out (hold Ctrl to add instead).' },
  { id: 'smooth', label: 'Smooth', glyph: 'smooth', key: 'S', hint: 'Drag over the ground to even out its surface under the brush.' },
  { id: 'flatten', label: 'Flatten', glyph: 'flatten', key: 'T', hint: 'Drag to bring the ground to the height where the stroke starts.' },
] as const;

export const PAINT_TOOLS = [{ id: 'paint', label: 'Paint', glyph: 'paint', key: 'P', hint: 'Drag over the ground to give it the picked material and wetness; each cell keeps what it is (ground stays ground, a wall a wall).' }] as const;

/** Paint's tools while a gas is picked: the fog brush. */
export const FOG_TOOLS = [
  { id: 'fog', label: 'Fog', glyph: 'paint', key: 'P', hint: 'Drag to paint the picked fog into the open cells over the ground, at the density set; ground, walls and water are left as they are (hold Ctrl to erase instead).' },
  { id: 'fog-erase', label: 'Erase', glyph: 'erase', key: 'E', hint: 'Drag to take fog out of the cells under the brush: fog only, of any kind; ground and water are left (hold Ctrl to paint instead).' },
  { id: 'fog-smooth', label: 'Smooth', glyph: 'smooth', key: 'S', hint: 'Drag to even out the picked fog\'s density under the brush: its edge thins into the air beside it.' },
] as const;

export const FILL_TOOLS = [
  { id: 'fog', label: 'Fog', glyph: 'fill', key: 'G', hint: 'Click in a hollow and drag up or down to set the level: the picked fog fills the open space joined to that point, up to the level.' },
  { id: 'drain', label: 'Drain', glyph: 'erase', key: 'R', hint: 'Click and drag the level as for a fill: fog and water under the level, joined to that point, are taken out.' },
  { id: 'water', label: 'Water', glyph: 'drop', key: 'L', hint: 'Click in a basin and drag the level: a water body is made there, which fills the basin and fills it again when the ground changes.' },
] as const;

export const SPLINE_TOOLS = [
  { id: 'road', label: 'Road', glyph: 'ramp', key: 'R', hint: 'Drag on the ground from where the road starts to where its first stretch ends; it is made as a spline and handed to its handles.' },
  { id: 'path', label: 'Path', glyph: 'grip', key: 'P', hint: 'Drag on the ground from where the path starts to where its first stretch ends; it is made as a spline and handed to its handles.' },
  { id: 'river', label: 'River', glyph: 'drop', key: 'V', hint: 'Drag on the ground from the river\'s source along its first stretch; it is made as a spline and handed to its handles.' },
] as const;

/** The Rules rail's one tool: the probe. */
export const RULES_TOOLS = [{ id: 'read', label: 'Read', glyph: 'info', key: 'I', hint: 'Move over the ground to read what grows there and why not; click to hold the read where it is (Esc lets go).' }] as const;

/** The settings each rail's brush uses (the panel's rows, the keys); a fill and a spline have no brush. */
export const WORLD_BRUSH_USES: Readonly<Record<WorldRail, readonly BrushUse[]>> = Object.freeze({ sculpt: ['size', 'spacing', 'invert'], paint: ['size', 'spacing', 'mask'], fill: [], spline: [], rules: [] });
/** The fog brush's settings: its size and spacing, and Ctrl swapping paint and erase. */
export const FOG_BRUSH_USES: readonly BrushUse[] = Object.freeze(['size', 'spacing', 'invert']);

/** The palettes the mode reads: Add's (ground and construction), Paint's (those and the gases), the Fill rail's two groups. */
export interface WorldPalettes {
  readonly solid: readonly VoxelPaletteEntry[];
  readonly paint: readonly VoxelPaletteEntry[];
  readonly gas: readonly VoxelPaletteEntry[];
  readonly liquid: readonly VoxelPaletteEntry[];
}

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
  /** A fog paint's density (the fog brush). */
  readonly density?: number;
  /** A fill has the tool in place of the brush (the Fill rail, the spline entry). */
  /** The rules probe has the tool in place of the brush (the Rules rail): the pointer reads, nothing is written. */
  readonly probe?: boolean;
  readonly fill?: { readonly kind: VoxelFillKind; readonly material: number | null; readonly depthM: number; readonly reachM: number; readonly fadeM: number; readonly sceneId: string | null; readonly spline?: SplineStartVoxels | null };
}

/**
 * Whether the Scene view draws the density overlay: the switch is on and the
 * rail shown has fog tools (Fill, or Paint with a gas picked). Sculpting and
 * laying a spline see the fog as a game draws it.
 */
export function gasOverlayShown(rail: WorldRail, s: WorldBrushState, palettes: Pick<WorldPalettes, 'paint'>): boolean {
  return s.overlay && (rail === 'fill' || (rail === 'paint' && paintsFog(s, palettes)));
}

/** Whether Paint has a gas picked: its brush is then the fog brush. */
export function paintsFog(s: WorldBrushState, palettes: Pick<WorldPalettes, 'paint'>): boolean {
  return pickedEntry(palettes.paint, s.material)?.use === 'gas';
}

/**
 * What a rail arms the tool with. Sculpt: its tool with the picked material
 * as what Add writes (its role from the material's use, dry). Paint: the
 * picked material and wetness and no role, so each cell keeps its own; with
 * a gas picked, the fog brush (the gas, dry, at the density; a hard rim but
 * for Smooth). Fill: fog (the picked gas), a drain or a water body (the
 * picked liquid) at the depth, reach and fade set. Splines: a road or path
 * of the picked ground material, a river of the picked liquid. Rules: the
 * probe, which writes nothing. `sceneId`:
 * the scene a made object goes into.
 */
export function worldBrushArming(rail: WorldRail, s: WorldBrushState, palettes: WorldPalettes, sceneId: string | null = null): WorldBrushArming {
  if (rail === 'rules') return { kind: 'paint', shape: s.shape, soft: false, voxel: null, uses: WORLD_BRUSH_USES.rules, probe: true };
  if (rail === 'fill' || rail === 'spline') {
    const gas = pickedEntry(palettes.gas, s.gas);
    const liquid = pickedEntry(palettes.liquid, s.liquid);
    const base = { kind: 'fog' as const, shape: s.shape, soft: false, voxel: null, uses: WORLD_BRUSH_USES[rail] };
    const fill = { depthM: Math.max(0, s.depth), reachM: Math.max(1, s.reach), fadeM: Math.max(0, s.fade), sceneId };
    if (rail === 'spline') return { ...base, fill: { ...fill, kind: 'spline', material: null, spline: splineStartVoxels(s.spline, pickedEntry(palettes.solid, s.material)?.id ?? null, liquid?.id ?? null) } };
    return { ...base, fill: { ...fill, kind: s.fill, material: s.fill === 'fog' ? (gas?.id ?? null) : s.fill === 'water' ? (liquid?.id ?? null) : null } };
  }
  if (rail === 'paint') {
    const m = pickedEntry(palettes.paint, s.material);
    if (m?.use === 'gas') return { kind: s.fog, shape: s.shape, soft: s.fog === 'fog-smooth' && s.soft, voxel: { material: m.id, role: VOXEL_ROLE.gas, wetness: 0 }, uses: FOG_BRUSH_USES, density: fogDensity(s.density) };
    return { kind: 'paint', shape: s.shape, soft: false, voxel: m === null ? null : { material: m.id, wetness: Math.max(0, Math.min(WETNESS_MAX, Math.round(s.wetness))) }, uses: WORLD_BRUSH_USES.paint };
  }
  const m = pickedEntry(palettes.solid, s.material);
  return { kind: s.sculpt, shape: s.shape, soft: s.soft, voxel: m === null ? null : { material: m.id, role: addRoleOf(m.use), wetness: 0 }, uses: WORLD_BRUSH_USES.sculpt };
}

/** A density level as a share of the material's full density, in whole per cent. */
export function densityPercent(level: number): number {
  return Math.round((fogDensity(level) / SHAPE_FULL) * 100);
}

/** A voxel material made for a fill that has none to offer: a plain mist, or plain water (the engine ships no voxel material). */
export function starterMedium(use: 'gas' | 'liquid', materialId: string, voxelId: number): Record<string, unknown> {
  const colour = use === 'gas' ? '#dfe6ea' : '#2a5fc0';
  return { materialId, name: use === 'gas' ? 'Mist' : 'Water', shader: 'standard', params: { color: colour }, textures: {}, voxel: { id: voxelId, use, ...(use === 'gas' ? { gas: { color: colour } } : {}) } };
}

/** A use's heading over the materials that have no variants. */
const USE_HEADINGS: Readonly<Record<string, string>> = Object.freeze({ terrain: 'Ground', construction: 'Construction', liquid: 'Liquids', gas: 'Gases' });

/**
 * The palette as tiles, in its order (a tile's index is its place, as the
 * number keys pick it): the materials without variants under their use's
 * heading, each family under its base material's name, a variant badged
 * "V", the voxel id under its name.
 */
export function paletteTiles(palette: readonly VoxelPaletteEntry[]): PaletteLayer[] {
  return palette.map((e, index) => ({
    index,
    name: e.name,
    texture: null,
    colour: e.colour ?? '#808080',
    sub: `${e.use} · ${e.id}`,
    aria: `voxel material ${e.name}`,
    ...(e.variant ? { badge: 'V' } : {}),
    group: e.family ? e.base : (USE_HEADINGS[e.use] ?? e.use),
  }));
}
