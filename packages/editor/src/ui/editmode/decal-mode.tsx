/**
 * The decal editor: the scene's edit mode for its decals. The whole scene
 * draws and only decals can be picked. Its rail: Place (click a surface),
 * Scatter (drag the shared brush), Select (click, box, the selection's
 * fields on many at once). Opened from Window → Decals, the toolbar's decal
 * button, or a double-click on a decal (which it opens with selected).
 *
 * The edits are the commands the Scene view always sent for decals (one
 * `createEntity` a placement, one `createEntities` a scatter stroke, one
 * `setTransform` or `setComponent` a grip drag) and one `setComponent` for a
 * field edited on the whole selection. Along the view's bottom, the decal
 * atlas: the decal pages Play and the export will use, composed on request.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { AtlasDrawer } from '../decals/AtlasDrawer';
import { PlaceColumn, ScatterColumn } from '../decals/DecalColumns';
import { DecalView } from '../decals/DecalView';
import { SelectColumn } from '../decals/SelectColumn';
import type { SceneEditModeKind, SceneModeView } from './modes';

const COLUMNS: Readonly<Record<string, (v: SceneModeView) => JSX.Element>> = { place: PlaceColumn, scatter: ScatterColumn, select: SelectColumn };

export const decalMode: SceneEditModeKind = {
  scope: 'scene',
  kind: 'decals',
  label: 'Decal editor',
  action: 'Edit decals',
  icon: 'decal',
  component: 'decal',
  focusMode: 'select',
  applies: (e) => e.components['decal'] !== undefined,
  meta: ({ host }) => {
    const decals = host.entities.filter((e) => e.components['decal'] !== undefined);
    const materials = new Set(decals.map((e) => (e.components['decal'] as { material?: string }).material));
    return `Whole scene · ${decals.length} decal${decals.length === 1 ? '' : 's'} · ${materials.size} material${materials.size === 1 ? '' : 's'}`;
  },
  note: 'Only decals can be picked',
  chip: (
    <>
      Whole scene · <b>decals pickable</b>
    </>
  ),
  rail: [
    { id: 'place', label: 'Place', glyph: 'place', hint: 'Click a surface to place the picked decal.' },
    { id: 'scatter', label: 'Scatter', glyph: 'scatter', hint: 'Drag over the surfaces to scatter the picked decal.' },
    { id: 'select', label: 'Select', glyph: 'select', hint: 'Click a decal; Shift adds, Ctrl removes; drag on empty ground for a box.' },
  ],
  tools: ['decal'],
  column: (view) => {
    const Column = COLUMNS[view.mode] ?? PlaceColumn;
    return <Column key={view.mode} {...view} />;
  },
  viewExtra: (view) => <DecalView {...view} />,
  // The decal atlas: the decal pages Play and the export will use, along the view's bottom edge.
  drawer: (view) => <AtlasDrawer {...view} />,
};
