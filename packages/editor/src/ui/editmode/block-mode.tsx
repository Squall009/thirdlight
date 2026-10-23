/**
 * The block editor: a block layer's edit mode. Its rail holds the editor's
 * modes (`BLOCK_MODES`: Build, Shape, Paint, Regions, Rooms & buildings,
 * Rules); each mode's column is its own (`ui/blocks/`) and declares its
 * docked panels (the block type picked in the palette is edited in Build's
 * Block type panel), and the strokes are the Scene view's block tools, one `editBlocks` each, as
 * before. The rooms drawn on the layer are drawn and picked with it.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { ArchitectureComponent, BlockLayerComponent } from '@thirdlight/project-model';

import { BLOCK_MODES, type BlockModeId } from '../../session/block-mode';
import type { ProjectedEntity } from '../../session/projection';
import { BlockView } from '../blocks/BlockView';
import { PaintColumn, ShapeColumn } from '../blocks/BrushColumns';
import { BuildColumn } from '../blocks/BuildColumn';
import { RegionsColumn } from '../blocks/RegionsColumn';
import { RoomsColumn } from '../blocks/RoomsColumn';
import { RulesColumn } from '../blocks/RulesColumn';
import type { EditModeView, ObjectEditModeKind } from './modes';

const layerOf = (e: ProjectedEntity): BlockLayerComponent | undefined => e.components['blockLayer'] as BlockLayerComponent | undefined;

const COLUMNS: Readonly<Record<BlockModeId, (v: EditModeView) => JSX.Element>> = {
  build: BuildColumn,
  shape: ShapeColumn,
  paint: PaintColumn,
  regions: RegionsColumn,
  rooms: RoomsColumn,
  rules: RulesColumn,
};

export const blockMode: ObjectEditModeKind = {
  kind: 'blocks',
  label: 'Block editor',
  action: 'Edit blocks',
  applies: (e) => layerOf(e) !== undefined,
  meta: (e) => {
    const c = layerOf(e)!;
    const b = c.bounds;
    return `Block layer · ${b.max[0] - b.min[0]} × ${b.max[1] - b.min[1]} × ${b.max[2] - b.min[2]} cells`;
  },
  rail: BLOCK_MODES.map((m) => ({ id: m.id, label: m.label, glyph: m.glyph, hint: m.hint, navigate: m.id === 'rooms' ? 'A drag orbits; a click selects a building, room or path; a double-click goes into a building.' : 'A drag orbits; a click selects a block: its cell and its block type.' })),
  tools: ['block'],
  // Themes, rules and scatter are edited in the editor; the Inspector keeps the plain fields.
  inspectorSkips: { blockLayer: ['kits', 'rules', 'scatter'] },
  // No working view: entering an existing layer keeps the view (the layer is often seen from where it is worked on);
  // a new layer is framed whole.
  bounds: (e) => {
    const c = layerOf(e)!;
    return { min: c.bounds.min.map((v, i) => v * c.cellSize[i]!), max: c.bounds.max.map((v, i) => v * c.cellSize[i]!) };
  },
  // The rooms and buildings drawn on the layer (generated architecture naming it).
  companions: (e, entities) => entities.filter((x) => (x.components['architecture'] as ArchitectureComponent | undefined)?.layer === e.id).map((x) => x.id),
  // The rooms object opens its layer's editor in Rooms & buildings, which edits its rooms, buildings, pieces and kit.
  via: (e, entities) => {
    const layer = (e.components['architecture'] as ArchitectureComponent | undefined)?.layer;
    return layer !== undefined && entities.some((x) => x.id === layer && layerOf(x) !== undefined) ? { entityId: layer, mode: 'rooms', label: 'Edit in block editor', skips: { architecture: ['outlines', 'buildings', 'overrides', 'kitId'] } } : null;
  },
  column: (view) => {
    const Column = COLUMNS[view.mode as BlockModeId] ?? BuildColumn;
    return <Column key={view.mode} {...view} />;
  },
  viewExtra: (view) => <BlockView {...view} />,
};
