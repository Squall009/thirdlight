/**
 * The voxel brush's arithmetic: what a drag of the Scene view's voxel brush
 * tool (`viewport/voxel-brush-tool.ts`) becomes. One stroke is one
 * `editVoxels` brush command, on a voxel world's lattice or a structure's
 * own (`command.grid`), the same command MCP sends.
 *
 * It extends the brush kit and adds nothing to the command:
 * - the settings are the shared brush's (`session/brush.ts`): its **size**
 *   (metres across, taken as a whole odd count of cells so a dab sits on a
 *   cell), its **spacing** (the share of the size between dabs) and its
 *   **noise mask** (`paint-brush.ts`'s, anchored to the grid);
 * - a dab sits on a cell of the lattice: the cell under the pointer, or for
 *   Add the cell in front of the face the pointer met;
 * - the dabs a drag passes are **thinned** to the spacing, and a gap between
 *   two picks wider than it is filled along the straight line between them,
 *   so a fast drag leaves no holes;
 * - the edit command has no field for a mask, so a masked Paint is laid as
 *   one-cell columns of the brush's height where the mask lets paint through
 *   (half weight or more), still one command.
 *
 * Pure.
 */
import { brushMask, type BrushMask } from '@thirdlight/runtime';
import { fillLevel, SHAPE_FULL, valueRole, valueShape, VOXEL_EDIT_VERSION, VOXEL_ROLE, VOXEL_SIZE_M, type BrushShape } from '@thirdlight/voxel';
import type { VoxelMaterialUse } from '@thirdlight/project-model/voxel-materials';

import { BRUSH_BOUNDS, DEFAULT_BRUSH, type BrushBounds, type BrushSettings } from './brush';

/** What the voxel brush does: the edit command's brush modes the editor offers. */
export type VoxelBrushKind = 'add' | 'dig' | 'smooth' | 'flatten' | 'paint';

export type VoxelCell = readonly [number, number, number];

/** The voxel a stroke writes: Add's material and role, Paint's material (no role: each cell keeps its own), both with a wetness. */
export interface VoxelBrushVoxel {
  readonly material: number;
  readonly role?: number;
  readonly wetness: number;
}

/**
 * A world brush as it starts: 4 m across, a dab every quarter of its size.
 * The spacing is the brush kit's setting, so the panel's Spacing row changes it.
 */
export const VOXEL_BRUSH: BrushSettings = Object.freeze({ ...DEFAULT_BRUSH, size: 4, spacing: 0.25 }) as BrushSettings;
/** From one cell to 32 m across (65 cells: a stroke's work stays within a few chunks a dab). */
export const VOXEL_BRUSH_BOUNDS: BrushBounds = Object.freeze({ ...BRUSH_BOUNDS, size: [VOXEL_SIZE_M, 32] as const, heightStep: [0.5, 0.5] as const });

/** A brush's size (metres, the shared brush's) as the nearest odd count of cells across, so a dab is centred on a cell. */
export function brushCells(sizeM: number): number {
  return Math.max(1, 2 * Math.round((sizeM / VOXEL_SIZE_M - 1) / 2) + 1);
}

/** The cells between two kept dabs: the spacing's share of the brush in whole cells (dabs sit on cells), never under one. */
export function dabSpacingCells(across: number, spacing: number): number {
  return Math.max(1, Math.round(across * spacing));
}

/** The cell a dab sits on for a hit: the cell met, or for Add the cell in front of the face it was entered by. */
export function dabCell(kind: VoxelBrushKind, cell: VoxelCell, normal: VoxelCell): [number, number, number] {
  return kind === 'add' ? [cell[0] + normal[0], cell[1] + normal[1], cell[2] + normal[2]] : [cell[0], cell[1], cell[2]];
}

/** The height of the surface a hit cell holds, in cells: its row plus its fill (a block: the whole cell; not read: the whole cell). */
export function surfaceHeightCells(cell: VoxelCell, record: number | null): number {
  return cell[1] + (record === null ? 1 : fillLevel(valueRole(record), valueShape(record)) / SHAPE_FULL);
}

/** The role Add writes for a material on a world's ground: ground for a terrain material, a plain wall block for a construction one. */
export function addRoleOf(use: VoxelMaterialUse): number {
  return use === 'terrain' ? VOXEL_ROLE.terrain : VOXEL_ROLE.wall;
}

/**
 * The dabs of one drag, thinned as they come: the first cell is kept, and
 * each later one adds the cells a spacing apart along the line from the last
 * kept dab toward it (none while it is nearer than a spacing). A cell is
 * kept once.
 */
export class DabTrail {
  readonly cells: [number, number, number][] = [];
  private readonly seen = new Set<string>();

  constructor(readonly spacing: number) {}

  /** The pointer met `cell`: the dabs it adds (none: nearer than a spacing to the last one). */
  add(cell: VoxelCell): number {
    const last = this.cells.at(-1);
    if (last === undefined) return this.keep(cell[0], cell[1], cell[2]);
    const dx = cell[0] - last[0];
    const dy = cell[1] - last[1];
    const dz = cell[2] - last[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.floor(d / this.spacing + 1e-9);
    let added = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i * this.spacing) / d;
      added += this.keep(Math.round(last[0] + dx * t), Math.round(last[1] + dy * t), Math.round(last[2] + dz * t));
    }
    return added;
  }

  private keep(x: number, y: number, z: number): number {
    const key = `${x},${y},${z}`;
    if (this.seen.has(key)) return 0;
    this.seen.add(key);
    this.cells.push([x, y, z]);
    return 1;
  }
}

/** One stroke of the voxel brush: the cells its dabs sit on, its brush, and what it does. */
export interface VoxelStroke {
  /** 0: the world's lattice; else a structure's own grid. */
  readonly grid: number;
  readonly kind: VoxelBrushKind;
  readonly shape: BrushShape;
  /** Cells across (odd). */
  readonly across: number;
  /** A soft rim (Add, Dig, Smooth, Flatten; a Paint has none). */
  readonly soft: boolean;
  readonly cells: readonly VoxelCell[];
  /** What Add writes or Paint gives (absent: Dig, Smooth, Flatten). */
  readonly voxel?: VoxelBrushVoxel;
  /** Flatten's plane, in cells. */
  readonly height?: number;
  /** Paint through this noise (null or absent: none). */
  readonly mask?: BrushMask | null;
}

/** Whether a cell `dx`, `dz` cells from a dab's centre lies in the brush's footprint. */
function inFootprint(shape: BrushShape, half: number, dx: number, dz: number): boolean {
  return shape === 'box' ? Math.abs(dx) <= half && Math.abs(dz) <= half : dx * dx + dz * dz <= half * half;
}

/**
 * The columns a masked stroke paints: every cell column under a dab's
 * footprint where the mask (read at the column's middle, in the grid's
 * metres) is at half weight or more, at that dab's height, each once.
 */
export function maskedColumns(s: Pick<VoxelStroke, 'shape' | 'across' | 'cells'>, mask: BrushMask): number[] {
  const half = s.across / 2;
  const r = (s.across - 1) / 2;
  const seen = new Set<string>();
  const out: number[] = [];
  for (const c of s.cells) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (!inFootprint(s.shape, half, dx, dz)) continue;
        const x = c[0] + dx;
        const z = c[2] + dz;
        const key = `${x},${c[1]},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (brushMask(mask, (x + 0.5) * VOXEL_SIZE_M, (z + 0.5) * VOXEL_SIZE_M) >= 0.5) out.push(x + 0.5, c[1] + 0.5, z + 0.5);
      }
    }
  }
  return out;
}

/**
 * The stroke as one `editVoxels` brush command (null: nothing to send, a
 * stroke with no dab or a mask that let nothing through). Sizes are the
 * brush's half extents in cells; a Paint is hard-rimmed and names no role
 * unless its voxel does.
 */
export function voxelStrokeCommand(s: VoxelStroke): Record<string, unknown> | null {
  if (s.cells.length === 0) return null;
  const h = s.across / 2;
  const voxel = s.voxel === undefined || s.kind === 'dig' || s.kind === 'smooth' || s.kind === 'flatten' ? undefined : { material: s.voxel.material, ...(s.voxel.role !== undefined ? { role: s.voxel.role } : {}), wetness: s.voxel.wetness };
  const masked = s.kind === 'paint' && s.mask != null ? maskedColumns(s, s.mask) : null;
  if (masked !== null && masked.length === 0) return null;
  return {
    v: VOXEL_EDIT_VERSION,
    grid: s.grid,
    kind: 'brush',
    shape: masked !== null ? 'box' : s.shape,
    size: masked !== null ? [0.5, h, 0.5] : [h, h, h],
    points: masked ?? s.cells.flatMap((c) => [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5]),
    mode: s.kind,
    ...(voxel !== undefined ? { voxel } : {}),
    smooth: s.kind === 'paint' ? false : s.soft,
    ...(s.kind === 'flatten' ? { height: s.height ?? 0 } : {}),
  };
}

// ---- the palette ----------------------------------------------------------------------------

/** A voxel material as the world mode's palette offers it. */
export interface VoxelPaletteEntry {
  /** Its voxel material id (what a stroke writes). */
  readonly id: number;
  readonly materialId: string;
  readonly name: string;
  readonly use: VoxelMaterialUse;
  /** Its colour as drawn flat ("#rrggbb"; absent: none known). */
  readonly colour?: string;
  /** The base material it is a variant of (its instance chain's root), by name: the palette's group. */
  readonly base: string;
  /** It is an instance of its base, not the base itself. */
  readonly variant: boolean;
}

interface PaletteMaterial {
  readonly materialId: string;
  readonly name: string;
  readonly instanceOf?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The uses a brush on the ground or on construction offers. A gas is painted as fog and a liquid is a water body's: neither is a ground material. */
export const SOLID_PALETTE_USES: readonly VoxelMaterialUse[] = Object.freeze(['terrain', 'construction']);

/**
 * The project's voxel materials of `uses` as palette entries: a base
 * material followed by its variants (the material instances whose chain ends
 * at it, each with a voxel id of its own), bases in the order of `uses` and
 * then by voxel id, variants by voxel id. `parts`: each material's resolved
 * voxel part (`resolvedVoxelParts`).
 */
export function voxelPalette(materials: readonly PaletteMaterial[], parts: ReadonlyMap<string, { readonly id: number; readonly use?: VoxelMaterialUse }>, uses: readonly VoxelMaterialUse[] = SOLID_PALETTE_USES): VoxelPaletteEntry[] {
  const byId = new Map(materials.map((m) => [m.materialId, m]));
  const rootOf = (m: PaletteMaterial): PaletteMaterial => {
    const seen = new Set<string>([m.materialId]);
    let cur = m;
    while (cur.instanceOf !== undefined) {
      const up = byId.get(cur.instanceOf);
      if (up === undefined || seen.has(up.materialId)) break;
      seen.add(up.materialId);
      cur = up;
    }
    return cur;
  };
  const colourOf = (m: PaletteMaterial): string | undefined => {
    const seen = new Set<string>();
    for (let cur: PaletteMaterial | undefined = m; cur !== undefined && !seen.has(cur.materialId); cur = cur.instanceOf !== undefined ? byId.get(cur.instanceOf) : undefined) {
      seen.add(cur.materialId);
      const c = cur.params?.['color'];
      if (typeof c === 'string') return c;
    }
    return undefined;
  };
  const taken = new Set<number>();
  const entries: (VoxelPaletteEntry & { root: string; rootId: number })[] = [];
  for (const m of materials) {
    const v = parts.get(m.materialId);
    if (v === undefined || v.use === undefined || !uses.includes(v.use) || taken.has(v.id)) continue;
    taken.add(v.id);
    const root = rootOf(m);
    const colour = colourOf(m);
    entries.push({ id: v.id, materialId: m.materialId, name: m.name, use: v.use, ...(colour !== undefined ? { colour } : {}), base: root.name, variant: root.materialId !== m.materialId, root: root.materialId, rootId: parts.get(root.materialId)?.id ?? v.id });
  }
  // A group stands where its base's id puts it (a base that is no voxel material itself: its first variant's).
  const groupId = new Map<string, number>();
  for (const e of entries) groupId.set(e.root, Math.min(groupId.get(e.root) ?? Infinity, e.variant ? e.id : e.rootId));
  const groupUse = new Map<string, number>();
  for (const e of entries) groupUse.set(e.root, Math.min(groupUse.get(e.root) ?? Infinity, uses.indexOf(e.use)));
  entries.sort((a, b) => groupUse.get(a.root)! - groupUse.get(b.root)! || groupId.get(a.root)! - groupId.get(b.root)! || a.root.localeCompare(b.root) || Number(a.variant) - Number(b.variant) || a.id - b.id);
  return entries.map(({ root: _root, rootId: _rootId, ...e }) => e);
}
