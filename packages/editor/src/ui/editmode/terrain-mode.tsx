/**
 * The terrain editor: a terrain's edit mode. Its rail holds the terrain
 * editor's modes (`TERRAIN_MODES`: Sculpt, Paint, Holes, Material rules,
 * Scatter, Stack, Tiles, Settings); each mode's column is its own
 * (`ui/terrain/`), and its tools are the Scene view's terrain tools.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import { terrainTileSize, type TerrainComponent } from '@thirdlight/runtime';

import { TERRAIN_MODES, type TerrainModeId } from '../../session/terrain-brush';
import type { ProjectedEntity } from '../../session/projection';
import { HolesColumn, PaintColumn, SculptColumn } from '../terrain/BrushModes';
import { RulesColumn } from '../terrain/RulesMode';
import { ScatterColumn } from '../terrain/ScatterMode';
import { SettingsColumn } from '../terrain/SettingsMode';
import { StackColumn } from '../terrain/StackMode';
import type { TerrainColumnProps } from '../terrain/terrain-column';
import { TilesColumn } from '../terrain/TilesMode';
import type { EditModeKind } from './modes';

/**
 * How much ground the view spans on entering the terrain editor (metres): a
 * brush's worth of work around the middle, near enough that a layer tiled
 * every few metres reads as its texture rather than its average colour.
 * Home frames every tile.
 */
export const TERRAIN_WORK_SPAN_M = 64;

const terrainOf = (e: ProjectedEntity): TerrainComponent | undefined => e.components['terrain'] as TerrainComponent | undefined;

/** The tiles' extent in tile coordinates. */
function tileExtent(c: TerrainComponent): { x0: number; x1: number; z0: number; z1: number } | null {
  if (c.tiles.length === 0) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const t of c.tiles) {
    x0 = Math.min(x0, t.x);
    x1 = Math.max(x1, t.x);
    z0 = Math.min(z0, t.z);
    z1 = Math.max(z1, t.z);
  }
  return { x0, x1, z0, z1 };
}

const COLUMNS: Readonly<Record<TerrainModeId, (p: TerrainColumnProps) => JSX.Element>> = {
  sculpt: SculptColumn,
  paint: PaintColumn,
  holes: HolesColumn,
  rules: RulesColumn,
  scatter: ScatterColumn,
  stack: StackColumn,
  tiles: TilesColumn,
  settings: SettingsColumn,
};

export const terrainMode: EditModeKind = {
  kind: 'terrain',
  label: 'Terrain editor',
  action: 'Edit terrain',
  applies: (e) => terrainOf(e) !== undefined,
  meta: (e) => {
    const c = terrainOf(e)!;
    const ext = tileExtent(c);
    const n = c.tiles.length;
    const size = terrainTileSize(c);
    return ext === null ? 'no tiles' : `${n} tile${n === 1 ? '' : 's'} · ${ext.x1 - ext.x0 + 1} × ${ext.z1 - ext.z0 + 1} · ${size} m each`;
  },
  // The keys of each mode come from its column (the tool picked): the status line lists them.
  rail: TERRAIN_MODES.map((m) => ({ id: m.id, label: m.label, glyph: m.glyph, hint: m.hint, ...(m.id === 'settings' ? { sep: true } : {}) })),
  tools: ['terrain'],
  // Tiles, rules, scatter and the edit layers are edited in the editor; the Inspector keeps the plain fields.
  inspectorSkips: { terrain: ['tiles', 'rules', 'scatter', 'layers', 'overview'] },
  bounds: (e) => {
    const c = terrainOf(e)!;
    const ext = tileExtent(c);
    if (ext === null) return null;
    const size = terrainTileSize(c);
    return { min: [ext.x0 * size, c.heightRange[0], ext.z0 * size], max: [(ext.x1 + 1) * size, c.heightRange[1], (ext.z1 + 1) * size] };
  },
  // The middle of the tiles' extent, on the ground (the view finds its height there).
  workArea: (e) => {
    const c = terrainOf(e)!;
    const ext = tileExtent(c);
    if (ext === null) return null;
    const size = terrainTileSize(c);
    const cx = ((ext.x0 + ext.x1 + 1) * size) / 2;
    const cz = ((ext.z0 + ext.z1 + 1) * size) / 2;
    const half = Math.min(TERRAIN_WORK_SPAN_M, (ext.x1 - ext.x0 + 1) * size, (ext.z1 - ext.z0 + 1) * size) / 2;
    return { min: [cx - half, 0, cz - half], max: [cx + half, 0, cz + half] };
  },
  column: ({ entity, mode, host }) => {
    const id = (TERRAIN_MODES.find((x) => x.id === mode) ?? TERRAIN_MODES[0]!).id;
    const flags = host.flags(entity.id);
    const pos = (entity.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
    const props: TerrainColumnProps = {
      editor: host.terrain.terrainEditor,
      entityId: entity.id,
      entityName: entity.name,
      component: terrainOf(entity)!,
      origin: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0],
      locked: flags?.locked === true,
      hidden: flags?.active === false,
      blockLayers: host.blockLayers,
      run: host.terrain.terrainRun,
      stage: host.terrain.stageFile,
      mapping: entity.components['materials'] as Readonly<Record<string, string>> | undefined,
      palette: host.palette,
    };
    const Column = COLUMNS[id];
    return <Column key={id} {...props} />;
  },
};
