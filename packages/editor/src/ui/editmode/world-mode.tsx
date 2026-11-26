/**
 * The world editor: the scene's edit mode for a voxel world's ground, on the
 * live Scene view in the shell every editor shares. The whole scene draws
 * (the world with its structures and the objects standing on it); the brush
 * acts on the world's own lattice only. Its rail:
 *
 * - **Sculpt**: Add, Dig, Smooth and Flatten with the shared brush (its
 *   size and spacing, a ball, a box or a cylinder, a soft or a hard rim).
 *   Add writes the palette's picked material.
 * - **Paint**: the material palette (the project's ground and construction
 *   voxel materials, a base material heading its variants), a wetness level
 *   and the brush kit's noise mask. A painted cell keeps its role.
 *
 * It extends what the editors share and builds no tool of its own: the
 * voxel brush tool on the Scene view (`viewport/voxel-brush-tool.ts`, the
 * one the structure mode's hand edits use), the brush panel and noise mask
 * (`brush-panels.tsx`), the layer palette's tiles (`LayerPalette`). Every
 * stroke is one `editVoxels` command, the one MCP sends, on the project's
 * one undo line; the view draws it when the change feed brings its chunks.
 *
 * Opened from a `voxelWorld` object (the Inspector's Edit world, a
 * double-click in the Hierarchy); that object's world is the one edited.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { WETNESS_MAX, type BrushShape } from '@thirdlight/voxel';

import { brushStore, type BrushStore } from '../../session/brush';
import type { ProjectedEntity } from '../../session/projection';
import { VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS } from '../../session/voxel-brush';
import { PAINT_TOOLS, paletteTiles, pickedEntry, SCULPT_TOOLS, WORLD_BRUSH_START, worldBrushArming, type SculptKind, type WorldBrushState, type WorldRail } from '../../session/world-mode';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { LayerPalette } from '../palette/LayerPalette';
import { brushPanels } from './brush-panels';
import { Section, Segmented } from './controls';
import { EditPanels } from './docks';
import { useEditStatus } from './edit-status';
import { useToolArmed } from './edit-tool';
import type { SceneEditModeKind, SceneModeView } from './modes';
import { ToolGrid } from './ToolGrid';

const worldNameOf = (e: ProjectedEntity | undefined): string | null => {
  const w = (e?.components['voxelWorld'] as { world?: unknown } | undefined)?.world;
  return typeof w === 'string' ? w : null;
};

/** The world the mode edits: the one of the object it was opened on, else the scene's first. */
export function editedWorld(view: Pick<SceneModeView, 'focus'> & { host: { entities: readonly ProjectedEntity[] } }): string | null {
  const focused = view.focus === null ? null : worldNameOf(view.host.entities.find((e) => e.id === view.focus));
  if (focused !== null) return focused;
  for (const e of view.host.entities) {
    const w = worldNameOf(e);
    if (w !== null) return w;
  }
  return null;
}

/** Remembered for the page (as each editor remembers its tools). */
let remembered: WorldBrushState = WORLD_BRUSH_START;

const SHAPES: readonly { id: BrushShape; label: string; hint: string }[] = [
  { id: 'sphere', label: 'Ball', hint: 'Cells within a ball' },
  { id: 'box', label: 'Box', hint: 'Whole cells in a cube' },
  { id: 'cylinder', label: 'Cylinder', hint: 'A disc as tall as it is wide' },
];

const WHAT_NAVIGATE = 'A drag orbits; the ground is changed only with a tool.';
const NO_WORLD = 'No voxel world in the open scenes: add a voxel world object first.';
const NO_MATERIAL = 'No ground or construction voxel material in the project: give a material a voxel part (Project → a material → Voxel).';

/** The mode's state for a rail: what it remembers, the brush's store, and the brush armed in the Scene view while the column shows. */
function useWorldBrush(view: SceneModeView, rail: WorldRail): { state: WorldBrushState; set: (patch: Partial<WorldBrushState>) => void; store: BrushStore; world: string | null } {
  const [state, setState] = useState(remembered);
  const set = (patch: Partial<WorldBrushState>): void => {
    remembered = { ...remembered, ...patch };
    setState(remembered);
  };
  const armed = useToolArmed();
  const store = useMemo(() => brushStore('world', rail, VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS), [rail]);
  const world = editedWorld(view);
  const { arm, palette } = view.host.voxelBrush;
  const arming = worldBrushArming(rail, state, palette);
  const key = JSON.stringify([world, armed, arming]);
  useEffect(() => {
    arm(world === null ? null : { ...arming, navigate: !armed, world, grid: 0, entityId: null, store });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every value the arm reads is in `key` (its objects are made again each render)
  }, [key, arm, store]);
  useEffect(() => () => arm(null), [arm]);
  return { state, set, store, world };
}

/** The status line: a refusal first (what to change), then the stroke's readout, then what the tool does. */
function useWorldStatus(view: SceneModeView, tool: string, hint: string, world: string | null): void {
  const b = view.host.voxelBrush;
  useEditStatus({ tool, text: world === null ? NO_WORLD : (b.refusal ?? b.readout ?? hint), keys: [{ keys: ['[', ']'], label: 'Size' }, { keys: ['F'], label: 'Resize in the view' }] });
}

function ShapeSection({ state, set, rim }: { state: WorldBrushState; set: (p: Partial<WorldBrushState>) => void; rim: boolean }): JSX.Element {
  return (
    <Section title="Shape">
      <Segmented aria="world brush shape" options={SHAPES} value={state.shape} onChange={(shape) => set({ shape })} />
      {rim && (
        <Segmented
          aria="world brush rim"
          small
          options={[{ id: 'soft', label: 'Soft rim', hint: 'The stroke fades over the brush\'s rim (ground meets it smoothly)' }, { id: 'hard', label: 'Hard rim', hint: 'Whole cells to the brush\'s edge' }]}
          value={state.soft ? 'soft' : 'hard'}
          onChange={(v) => set({ soft: v === 'soft' })}
        />
      )}
    </Section>
  );
}

/** The material palette: the picked tile is what Add writes and Paint gives. */
function MaterialPalette({ view, state, set, title }: { view: SceneModeView; state: WorldBrushState; set: (p: Partial<WorldBrushState>) => void; title: string }): JSX.Element {
  const palette = view.host.voxelBrush.palette;
  const picked = pickedEntry(palette, state.material);
  return (
    <Section title={title} aside={<span className="tl-sec__note">{picked === null ? '' : `${picked.name} · ${picked.id}`}</span>}>
      {palette.length === 0 ? (
        <p className="tl-hint">{NO_MATERIAL}</p>
      ) : (
        <LayerPalette layers={paletteTiles(palette)} active={picked === null ? null : palette.indexOf(picked)} onPick={(i) => set({ material: palette[i]?.id ?? null })} thumbnails={view.host.palette.thumbnails} keys aria="voxel materials" />
      )}
    </Section>
  );
}

function SculptColumn(view: SceneModeView): JSX.Element {
  const { state, set, store, world } = useWorldBrush(view, 'sculpt');
  const settings = useBrush(store);
  const t = SCULPT_TOOLS.find((x) => x.id === state.sculpt) ?? SCULPT_TOOLS[0];
  useWorldStatus(view, t.label, t.hint, world);
  const swaps = state.sculpt === 'add' || state.sculpt === 'dig';
  return (
    <div className="tl-world-mode" aria-label="world sculpt tools">
      <Section title="Tool">
        <ToolGrid tools={SCULPT_TOOLS} active={state.sculpt} onPick={(id) => set({ sculpt: id as SculptKind })} aria="world sculpt tool" cols={3} disabled={world === null} />
      </Section>
      <ShapeSection state={state} set={set} rim />
      {state.sculpt === 'add' && <MaterialPalette view={view} state={state} set={set} title="Adds" />}
      {state.sculpt === 'flatten' && <p className="tl-hint">The ground is brought to the height of the surface where the stroke starts.</p>}
      <EditPanels panels={brushPanels({ settings, store, uses: swaps ? ['size', 'spacing', 'invert'] : ['size', 'spacing'], ...(swaps ? { invert: state.sculpt === 'add' ? 'Dig' : 'Add' } : {}), title: 'Brush', badge: 'cells of the world' })} />
    </div>
  );
}

function PaintColumn(view: SceneModeView): JSX.Element {
  const { state, set, store, world } = useWorldBrush(view, 'paint');
  const settings = useBrush(store);
  useWorldStatus(view, 'Paint', PAINT_TOOLS[0].hint, world);
  return (
    <div className="tl-world-mode" aria-label="world paint tools">
      <Section title="Tool">
        <ToolGrid tools={PAINT_TOOLS} active="paint" onPick={() => undefined} aria="world paint tool" cols={3} disabled={world === null} />
      </Section>
      <MaterialPalette view={view} state={state} set={set} title="Material" />
      <Section title="Wetness">
        <SliderField label="Wetness" aria="world paint wetness" value={state.wetness} min={0} max={WETNESS_MAX} step={1} hint={`The wetness painted cells get: 0 dry … ${WETNESS_MAX} soaked (it darkens the surface and adds shine).`} onChange={(wetness) => set({ wetness })} />
      </Section>
      <ShapeSection state={state} set={set} rim={false} />
      <EditPanels panels={brushPanels({ settings, store, uses: ['size', 'spacing', 'mask'], title: 'Brush', badge: 'cells of the world' })} />
    </div>
  );
}

const COLUMNS: Readonly<Record<string, (v: SceneModeView) => JSX.Element>> = { sculpt: SculptColumn, paint: PaintColumn };

export const worldMode: SceneEditModeKind = {
  scope: 'scene',
  kind: 'world',
  label: 'World editor',
  action: 'Edit world',
  icon: 'terrain',
  component: 'voxelWorld',
  applies: (e) => worldNameOf(e) !== null,
  meta: (view) => {
    const world = editedWorld(view);
    return world === null ? 'no voxel world' : `Whole scene · voxel world ${world}`;
  },
  note: 'The brush edits the world\'s ground',
  chip: (
    <>
      Whole scene · <b>the world's ground is edited</b>
    </>
  ),
  rail: [
    { id: 'sculpt', label: 'Sculpt', glyph: 'sculpt', hint: 'Add, dig, smooth or flatten the ground with the brush.', navigate: WHAT_NAVIGATE },
    { id: 'paint', label: 'Paint', glyph: 'paint', hint: 'Paint a material and a wetness on the ground.', navigate: WHAT_NAVIGATE },
  ],
  tools: ['voxel-brush'],
  column: (view) => {
    const Column = COLUMNS[view.mode] ?? SculptColumn;
    return <Column key={view.mode} {...view} />;
  },
};
