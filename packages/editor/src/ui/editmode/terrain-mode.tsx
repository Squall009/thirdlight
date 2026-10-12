/**
 * The terrain editor: a terrain's edit mode. Its rail holds the terrain
 * tools' modes (`TERRAIN_MODES`); the settings column is the terrain panel
 * of the mode shown, and its brush tools are the Scene view's terrain tool.
 *
 * Browser-only (React).
 */
import { terrainTileSize, type TerrainComponent } from '@thirdlight/runtime';

import type { BrushUse } from '../../session/brush';
import { brushKeyHints, PALETTE_KEYS, paletteKeyHint } from '../../session/edit-keys';
import { TERRAIN_INVERT_LABELS, TERRAIN_MODES, terrainToolUses, type TerrainMode } from '../../session/terrain-brush';
import type { ProjectedEntity } from '../../session/projection';
import { TerrainPanel } from '../TerrainPanel';
import type { EditModeKind } from './modes';

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

/** A mode's brush keys (the shared map's, for the settings its tools use; inverting named as its first tool does it). */
function modeKeys(m: TerrainMode): ReturnType<typeof brushKeyHints> {
  const uses = new Set<BrushUse>(m.tools.flatMap((t) => [...terrainToolUses(t)]));
  const first = m.tools.find((t) => TERRAIN_INVERT_LABELS[t] !== undefined);
  // Paint picks its layer from the palette by number.
  return [...(m.tools.includes('paint') ? paletteKeyHint(PALETTE_KEYS, 'Layer') : []), ...brushKeyHints([...uses], first !== undefined ? TERRAIN_INVERT_LABELS[first] : undefined)];
}

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
  rail: TERRAIN_MODES.map((m) => ({ id: m.id, label: m.label, glyph: m.glyph, hint: m.hint, ...(m.tools.length > 0 ? { keys: modeKeys(m) } : {}) })),
  tools: ['terrain'],
  bounds: (e) => {
    const c = terrainOf(e)!;
    const ext = tileExtent(c);
    if (ext === null) return null;
    const size = terrainTileSize(c);
    return { min: [ext.x0 * size, c.heightRange[0], ext.z0 * size], max: [(ext.x1 + 1) * size, c.heightRange[1], (ext.z1 + 1) * size] };
  },
  column: ({ entity, mode, host }) => {
    const m = TERRAIN_MODES.find((x) => x.id === mode) ?? TERRAIN_MODES[0]!;
    const flags = host.flags(entity.id);
    return (
      <TerrainPanel
        editor={host.terrain.terrainEditor}
        mode={m}
        visible
        entityId={entity.id}
        component={terrainOf(entity)!}
        locked={flags?.locked === true}
        hidden={flags?.active === false}
        blockLayers={host.blockLayers}
        run={host.terrain.terrainRun}
        stage={host.terrain.stageFile}
        entityName={entity.name}
        mapping={entity.components['materials'] as Readonly<Record<string, string>> | undefined}
        palette={host.palette}
      />
    );
  },
};
