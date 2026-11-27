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
 *   voxel materials, a base material heading its variants, then its gases),
 *   a wetness level and the brush kit's noise mask. A painted cell keeps its
 *   role. With a gas picked the brush is the fog brush: Fog (into the open
 *   cells, at a density), Erase (fog only) and Smooth (its density).
 * - **Fill**: Fog to a level (click a point, drag the level; a fade, a
 *   reach; where a refused fill leaked is marked), Drain, and Water, which
 *   makes a water body at the click so the lake follows later ground edits.
 * - **Splines**: starts a road, a path or a river as a spline object whose
 *   voxels section is preset, and hands it to the spline's own handles.
 * - **Rules**: what grows at the cursor and why not. The pointer reads the
 *   surface under it (its fields, from the view's worker); the column lists
 *   each species of that material's dressing with "grows" or the condition
 *   that fails and the value read, and the fields as numbers. It writes
 *   nothing; the rules are edited on the material's Dressing card.
 *
 * It extends what the editors share and builds no tool of its own: the
 * voxel brush tool on the Scene view (`viewport/voxel-brush-tool.ts`, the
 * one the structure mode's hand edits use), the brush panel and noise mask
 * (`brush-panels.tsx`), the layer palette's tiles (`LayerPalette`), the
 * water bodies' level ring and leak markers. Every stroke is one
 * `editVoxels` command, the one MCP sends, on the project's one undo line;
 * a water body and a spline are one `createEntity`. The view draws a
 * change when the feed brings its chunks.
 *
 * Opened from a `voxelWorld` object (the Inspector's Edit world, a
 * double-click in the Hierarchy); that object's world is the one edited.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { SHAPE_FULL, WETNESS_MAX, type BrushShape } from '@thirdlight/voxel';

import { brushStore, type BrushStore } from '../../session/brush';
import type { ProjectedEntity } from '../../session/projection';
import { FOG_BRUSH, FOG_BRUSH_BOUNDS, VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS, type VoxelPaletteEntry } from '../../session/voxel-brush';
import { FILL_LEVEL_STEP_M, floodReachBoundM } from '../../session/voxel-fill';
import { rulesAt } from '../../session/world-rules';
import { densityPercent, FILL_TOOLS, FOG_TOOLS, gasOverlayShown, PAINT_TOOLS, paintsFog, paletteTiles, pickedEntry, RULES_TOOLS, SCULPT_TOOLS, SPLINE_TOOLS, STARTER_GROUNDS, starterGround, starterGroundsOffered, starterMedium, WORLD_BRUSH_START, worldBrushArming, type FillKind, type FogKind, type SculptKind, type StarterGround, type WorldBrushState, type WorldRail } from '../../session/world-mode';
import { SliderField } from '../brush/SliderField';
import { useBrush } from '../brush/useBrush';
import { MODEL_KINDS, useEntryNames } from '../catalog/RefPicker';
import { freeVoxelId } from '../material/MaterialVoxelSection';
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

const STARTER_DRESSINGS: ReadonlySet<string> = new Set(STARTER_GROUNDS.map((g) => g.dressing));

const WHAT_NAVIGATE = 'A drag orbits; the ground is changed only with a tool.';
const NO_WORLD = 'No voxel world in the open scenes: add a voxel world object first.';
const NO_MATERIAL = 'No ground or construction voxel material in the project: give a material a voxel part (Project → a material → Voxel).';
const NO_GAS = 'No gas voxel material in the project (a material whose voxel use is gas).';
const NO_LIQUID = 'No liquid voxel material in the project (a material whose voxel use is liquid).';

/** The mode's state for a rail: what it remembers, the brush's store, and the brush armed in the Scene view while the column shows. */
function useWorldBrush(view: SceneModeView, rail: WorldRail): { state: WorldBrushState; set: (patch: Partial<WorldBrushState>) => void; store: BrushStore; world: string | null; note: string | null } {
  const [state, setState] = useState(remembered);
  const [note, setNote] = useState<string | null>(null);
  const set = (patch: Partial<WorldBrushState>): void => {
    remembered = { ...remembered, ...patch };
    setState(remembered);
  };
  const armed = useToolArmed();
  const { arm, palettes } = view.host.voxelBrush;
  // The fog brush has its own size and bounds (its strokes name their cells).
  const fog = rail === 'paint' && paintsFog(state, palettes);
  const store = useMemo(() => (fog ? brushStore('world', 'fog', FOG_BRUSH, FOG_BRUSH_BOUNDS) : brushStore('world', rail, VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS)), [rail, fog]);
  const world = editedWorld(view);
  const arming = worldBrushArming(rail, state, palettes, view.host.scene?.sceneId ?? null);
  const key = JSON.stringify([world, armed, arming]);
  const handOver = view.host.handOver;
  useEffect(() => {
    arm(world === null ? null : { ...arming, navigate: !armed, world, grid: 0, entityId: null, store }, {
      // A dragged level is where the next click starts.
      depth: (m) => set({ depth: Math.max(FILL_LEVEL_STEP_M, Math.round(m / FILL_LEVEL_STEP_M) * FILL_LEVEL_STEP_M) }),
      made: (what, id) => {
        if (what === 'spline') handOver(id);
        else setNote('Water body made: it fills the basin now and again when the ground changes. Select it (after Done) for its level, liquid and reach.');
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every value the arm reads is in `key` (its objects are made again each render)
  }, [key, arm, store, handOver]);
  useEffect(() => () => arm(null), [arm]);
  // Fog by its density while the switch is on and this rail has fog tools; as a game draws it otherwise and after.
  const { gasOverlay } = view.host.voxelBrush;
  const overlay = gasOverlayShown(rail, state, palettes);
  useEffect(() => {
    gasOverlay(overlay);
    return () => gasOverlay(false);
  }, [gasOverlay, overlay]);
  return { state, set, store, world, note };
}

/** The status line: a refusal first (what to change), then the stroke's readout, then the last thing made, then what the tool does. */
function useWorldStatus(view: SceneModeView, tool: string, hint: string, world: string | null, o: { brush?: boolean; note?: string | null } = {}): void {
  const b = view.host.voxelBrush;
  useEditStatus({ tool, text: world === null ? NO_WORLD : (b.refusal ?? b.readout ?? o.note ?? hint), keys: o.brush === false ? [] : [{ keys: ['[', ']'], label: 'Size' }, { keys: ['F'], label: 'Resize in the view' }] });
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

/** A material palette: the picked tile is what the tool writes. `empty`: what to do when the project has no such material. */
function MaterialPalette({ view, palette, picked, onPick, title, aria = 'voxel materials', empty = <MakeGround view={view} empty /> }: { view: SceneModeView; palette: readonly VoxelPaletteEntry[]; picked: VoxelPaletteEntry | null; onPick: (id: number | null) => void; title: string; aria?: string; empty?: JSX.Element }): JSX.Element {
  return (
    <Section title={title} aside={<span className="tl-sec__note">{picked === null ? '' : `${picked.name} · ${picked.id}`}</span>}>
      {palette.length === 0 ? empty : <LayerPalette layers={paletteTiles(palette)} active={picked === null ? null : palette.indexOf(picked)} onPick={(i) => onPick(palette[i]?.id ?? null)} thumbnails={view.host.palette.thumbnails} keys aria={aria} />}
    </Section>
  );
}

/**
 * What a fill shows when the project has no gas or liquid material: why,
 * and a button that makes a plain one (the engine ships no voxel material;
 * a voxel id is the project's own, so none can come with a kit).
 */
function MakeMedium({ view, use }: { view: SceneModeView; use: 'gas' | 'liquid' }): JSX.Element {
  const host = view.host.palette;
  const [problem, setProblem] = useState<string | null>(null);
  const make = async (): Promise<void> => {
    const id = freeVoxelId(host.materials);
    if (id === null) return setProblem('Every voxel material id of the project is taken.');
    const name = use === 'gas' ? 'Mist' : 'Water';
    const ok = await host.run(`${name} material`, 'setMaterial', { material: starterMedium(use, await host.newMaterialId(name), id) });
    setProblem(ok ? null : 'The material was refused (the reason is in the notice).');
  };
  return (
    <div className="tl-world-mode__make">
      <p className="tl-hint">{use === 'gas' ? NO_GAS : NO_LIQUID}</p>
      <button type="button" className="tl-btn" aria-label={use === 'gas' ? 'make a mist material' : 'make a water material'} onClick={() => void make()}>
        {use === 'gas' ? 'Make a mist material' : 'Make a water material'}
      </button>
      {problem !== null && <p className="tl-prop__error" role="alert">{problem}</p>}
    </div>
  );
}

const NO_KIT = 'The plants and the dressings Meadow, Shore and Gravel come with the Basic Kit (Create → Basic Kit); a ground made before it is added grows nothing until its material names a dressing.';

/**
 * The starter grounds: a button a ground material that can be made (plain
 * terrain materials naming the Basic Kit's dressings; the engine ships no
 * voxel material, whose id is the project's own). `empty`: shown in place of
 * an empty palette, where it offers the grass alone.
 */
function MakeGround({ view, empty }: { view: SceneModeView; empty?: boolean }): JSX.Element {
  const host = view.host.palette;
  const dressings = view.host.voxelBrush.dressings;
  const [problem, setProblem] = useState<string | null>(null);
  const offered = starterGroundsOffered(host.materials, dressings).filter((o) => (empty === true ? o.ground.id === 'grass' : o.dressing && !o.made));
  const kit = dressings.some((d) => STARTER_DRESSINGS.has(d.dressingId));
  const make = async (g: StarterGround): Promise<void> => {
    const id = freeVoxelId(host.materials);
    if (id === null) return setProblem('Every voxel material id of the project is taken.');
    const ok = await host.run(`${g.name} material`, 'setMaterial', { material: starterGround(g, await host.newMaterialId(g.name), id, dressings) });
    setProblem(ok ? null : 'The material was refused (the reason is in the notice).');
  };
  return (
    <div className="tl-world-mode__make">
      {empty === true && <p className="tl-hint">{NO_MATERIAL}</p>}
      {offered.map((o) => (
        <button key={o.ground.id} type="button" className="tl-btn" aria-label={`make a ${o.ground.name.toLowerCase()} material`} title={o.dressing ? `A plain ${o.ground.name.toLowerCase()} ground that grows ${o.ground.grows} (the dressing ${o.ground.dressing}).` : `A plain ${o.ground.name.toLowerCase()} ground.`} onClick={() => void make(o.ground)}>
          Make a {o.ground.name.toLowerCase()} material
        </button>
      ))}
      {!kit && <p className="tl-hint">{NO_KIT}</p>}
      {problem !== null && <p className="tl-prop__error" role="alert">{problem}</p>}
    </div>
  );
}

/** The switch between fog as a game draws it and fog by its density, where thin fog is found to erase. */
function FogViewSection({ state, set }: { state: WorldBrushState; set: (p: Partial<WorldBrushState>) => void }): JSX.Element {
  return (
    <Section title="Fog in the view">
      <Segmented
        aria="world fog view"
        small
        options={[{ id: 'look', label: 'As drawn', hint: 'Fog as a game draws it: see-through by how much of it lies behind each pixel' }, { id: 'density', label: 'Density', hint: 'Every fog face in a colour for its density (blue the thinnest, magenta half, yellow the full density), nearly opaque: thin fog shows' }]}
        value={state.overlay ? 'density' : 'look'}
        onChange={(v) => set({ overlay: v === 'density' })}
      />
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
      {state.sculpt === 'add' && <MaterialPalette view={view} palette={view.host.voxelBrush.palettes.solid} picked={pickedEntry(view.host.voxelBrush.palettes.solid, state.material)} onPick={(material) => set({ material })} title="Adds" />}
      {state.sculpt === 'flatten' && <p className="tl-hint">The ground is brought to the height of the surface where the stroke starts.</p>}
      <EditPanels panels={brushPanels({ settings, store, uses: swaps ? ['size', 'spacing', 'invert'] : ['size', 'spacing'], ...(swaps ? { invert: state.sculpt === 'add' ? 'Dig' : 'Add' } : {}), title: 'Brush', badge: 'cells of the world' })} />
    </div>
  );
}

function PaintColumn(view: SceneModeView): JSX.Element {
  const { state, set, store, world } = useWorldBrush(view, 'paint');
  const settings = useBrush(store);
  const palette = view.host.voxelBrush.palettes.paint;
  const picked = pickedEntry(palette, state.material);
  const fog = picked?.use === 'gas';
  const t = fog ? (FOG_TOOLS.find((x) => x.id === state.fog) ?? FOG_TOOLS[0]) : PAINT_TOOLS[0];
  useWorldStatus(view, t.label, t.hint, world);
  return (
    <div className="tl-world-mode" aria-label="world paint tools">
      <Section title="Tool">
        {fog ? (
          <ToolGrid tools={FOG_TOOLS} active={state.fog} onPick={(id) => set({ fog: id as FogKind })} aria="world fog tool" cols={3} disabled={world === null} />
        ) : (
          <ToolGrid tools={PAINT_TOOLS} active="paint" onPick={() => undefined} aria="world paint tool" cols={3} disabled={world === null} />
        )}
      </Section>
      <MaterialPalette view={view} palette={palette} picked={picked} onPick={(material) => set({ material })} title="Material" />
      {fog ? (
        state.fog === 'fog' && (
          <Section title="Density" aside={<span className="tl-sec__note">{densityPercent(state.density)} %</span>}>
            <SliderField label="Density" aria="world fog density" value={state.density} min={1} max={SHAPE_FULL} step={1} hint={`How thick the painted fog is: 1 the thinnest a cell holds … ${SHAPE_FULL} the material's full density.`} onChange={(density) => set({ density })} />
          </Section>
        )
      ) : (
        <Section title="Wetness">
          <SliderField label="Wetness" aria="world paint wetness" value={state.wetness} min={0} max={WETNESS_MAX} step={1} hint={`The wetness painted cells get: 0 dry … ${WETNESS_MAX} soaked (it darkens the surface and adds shine).`} onChange={(wetness) => set({ wetness })} />
        </Section>
      )}
      {fog && <p className="tl-hint">Fog is written into open cells only: ground, walls and water under the brush stay as they are. A fog brush is at most {FOG_BRUSH_BOUNDS.size[1]} m across; a wider bank is the Fill rail's.</p>}
      {fog && <FogViewSection state={state} set={set} />}
      <ShapeSection state={state} set={set} rim={fog && state.fog === 'fog-smooth'} />
      <EditPanels panels={brushPanels(fog ? { settings, store, uses: state.fog === 'fog-smooth' ? ['size', 'spacing'] : ['size', 'spacing', 'invert'], ...(state.fog === 'fog-smooth' ? {} : { invert: state.fog === 'fog' ? 'Erase' : 'Paint' }), title: 'Brush', badge: 'the fog brush' } : { settings, store, uses: ['size', 'spacing', 'mask'], title: 'Brush', badge: 'cells of the world' })} />
    </div>
  );
}

/** One stroke's work bounds a flood's reach; asked of the command once. */
let reachBound: number | null = null;
const fillReachBoundM = (): number => (reachBound ??= floodReachBoundM());

function FillColumn(view: SceneModeView): JSX.Element {
  const { state, set, world, note } = useWorldBrush(view, 'fill');
  const { gas, liquid } = view.host.voxelBrush.palettes;
  const t = FILL_TOOLS.find((x) => x.id === state.fill) ?? FILL_TOOLS[0];
  useWorldStatus(view, t.label, t.hint, world, { brush: false, note });
  const bound = fillReachBoundM();
  return (
    <div className="tl-world-mode" aria-label="world fill tools">
      <Section title="Tool">
        <ToolGrid tools={FILL_TOOLS} active={state.fill} onPick={(id) => set({ fill: id as FillKind })} aria="world fill tool" cols={3} disabled={world === null} />
      </Section>
      {state.fill === 'fog' && <MaterialPalette view={view} palette={gas} picked={pickedEntry(gas, state.gas)} onPick={(id) => set({ gas: id })} title="Fog" aria="gas voxel materials" empty={<MakeMedium view={view} use="gas" />} />}
      {state.fill === 'water' && <MaterialPalette view={view} palette={liquid} picked={pickedEntry(liquid, state.liquid)} onPick={(id) => set({ liquid: id })} title="Liquid" aria="liquid voxel materials" empty={<MakeMedium view={view} use="liquid" />} />}
      <Section title="Level">
        <SliderField label="Depth" aria="world fill depth" value={state.depth} min={FILL_LEVEL_STEP_M} max={32} step={FILL_LEVEL_STEP_M} unit="m" decimals={2} hint="The level a click gives, over the point clicked. Dragging up or down after the press changes it, and the ring in the view shows it." onChange={(depth) => set({ depth })} />
        {state.fill === 'fog' && <SliderField label="Fade" aria="world fill fade" value={state.fade} min={0} max={8} step={FILL_LEVEL_STEP_M} unit="m" decimals={2} hint="The metres under the level over which the fog thins to nothing at the level (0: full density up to the level)." onChange={(fade) => set({ fade })} />}
      </Section>
      {state.fill !== 'water' && <FogViewSection state={state} set={set} />}
      {state.fill === 'water' ? (
        <p className="tl-hint">A water body is an object at the point clicked: it fills the basin joined to it, and again whenever the ground there changes. Its level, liquid and reach are in the Inspector; where it leaks is marked in red.</p>
      ) : (
        <Section title="Reach">
          <SliderField label="Reach" aria="world fill reach" value={Math.min(state.reach, bound)} min={1} max={bound} step={1} unit="m" hint="How far from the point clicked the fill may spread, and how deep under it." onChange={(reach) => set({ reach })} />
          <p className="tl-hint">
            A fill that would pass its reach, or leave the world, is a leak: nothing is written and the places are marked in red. One fill reaches at most {bound} m (the work one stroke may take), so a hollow wider than twice that cannot be filled yet. {state.fill === 'fog' ? 'A fog fill does not follow later ground edits.' : 'A drain in open ground leaks as a fill does; fog on open ground is erased with the fog brush (Paint, a gas picked).'}
          </p>
        </Section>
      )}
    </div>
  );
}

function SplineColumn(view: SceneModeView): JSX.Element {
  const { state, set, world } = useWorldBrush(view, 'spline');
  const { solid, liquid } = view.host.voxelBrush.palettes;
  const t = SPLINE_TOOLS.find((x) => x.id === state.spline) ?? SPLINE_TOOLS[0];
  useWorldStatus(view, t.label, t.hint, world, { brush: false });
  const river = state.spline === 'river';
  return (
    <div className="tl-world-mode" aria-label="world spline tools">
      <Section title="Start">
        <ToolGrid tools={SPLINE_TOOLS} active={state.spline} onPick={(id) => set({ spline: id as WorldBrushState['spline'] })} aria="world spline kind" cols={3} disabled={world === null} />
      </Section>
      {river ? (
        <MaterialPalette view={view} palette={liquid} picked={pickedEntry(liquid, state.liquid)} onPick={(id) => set({ liquid: id })} title="Liquid" aria="liquid voxel materials" empty={<MakeMedium view={view} use="liquid" />} />
      ) : (
        <MaterialPalette view={view} palette={solid} picked={pickedEntry(solid, state.material)} onPick={(material) => set({ material })} title="Surface" />
      )}
      <p className="tl-hint">
        Drag on the ground from where it starts to where its first stretch ends. It is made as a spline object that writes {river ? 'a river' : `a ${state.spline}`} into the world, and this editor closes with it selected: its points are moved, added and removed with its handles in the Scene view, its width, bed and shoulders set in the Inspector.
      </p>
    </div>
  );
}

const RULES_HINT = RULES_TOOLS[0].hint;

/** The starter grounds on the Rules rail, while there is one to make or the kit is missing. */
function MakeGroundSection({ view }: { view: SceneModeView }): JSX.Element | null {
  const dressings = view.host.voxelBrush.dressings;
  const kit = dressings.some((d) => STARTER_DRESSINGS.has(d.dressingId));
  const left = starterGroundsOffered(view.host.palette.materials, dressings).some((o) => o.dressing && !o.made);
  if (kit && !left) return null;
  return (
    <Section title="Starter ground">
      <MakeGround view={view} />
    </Section>
  );
}

/** What grows at the cursor and why not, and the surface's fields there. Reads only: the rules are the material's Dressing card's. */
function RulesColumn(view: SceneModeView): JSX.Element {
  const { world } = useWorldBrush(view, 'rules');
  useWorldStatus(view, 'Rules', RULES_HINT, world, { brush: false });
  const b = view.host.voxelBrush;
  const probe = b.probe;
  const read = probe?.read ?? null;
  const materials = view.host.palette.materials;
  const answer = useMemo(
    () => (probe === null || read === null || read.state !== 'surface' ? null : rulesAt({ materials, dressings: b.dressings, point: read.point, x: probe.at[0], z: probe.at[2], clear: b.coverClear() })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is the probe's own answer; the boxes are read when it changes
    [probe, read, materials, b.dressings],
  );
  const names = useEntryNames(answer?.species.map((s) => s.model) ?? [], MODEL_KINDS);
  return (
    <div className="tl-world-mode" aria-label="world rules" data-rules-probe={probe === null ? '' : JSON.stringify({ at: probe.at, pinned: probe.pinned, state: read?.state ?? 'unread', grows: answer?.species.map((s) => (s.grows ? 1 : 0)) ?? [] })}>
      <Section title="Tool">
        <ToolGrid tools={RULES_TOOLS} active="read" onPick={() => undefined} aria="world rules tool" cols={3} disabled={world === null} />
      </Section>
      <Section title="Here" aside={<span className="tl-sec__note">{probe === null ? '' : probe.pinned ? 'held' : 'under the pointer'}</span>}>
        {probe === null ? (
          <p className="tl-hint">{RULES_HINT}</p>
        ) : (
          <p className="tl-hint">
            ({probe.at[0].toFixed(2)}, {probe.at[1].toFixed(2)}, {probe.at[2].toFixed(2)}) m{probe.pinned ? ': held; click elsewhere to move it, Esc to let go.' : ': click to hold it.'}
          </p>
        )}
        {probe !== null && read === null && <p className="tl-hint">The view could not read the ground here.</p>}
        {read?.state === 'unloaded' && <p className="tl-hint">The ground here is not loaded in the view yet: wait for it to settle, or move closer.</p>}
        {read?.state === 'none' && <p className="tl-hint">No surface here (inside a building's own cells, or open air).</p>}
      </Section>
      <MakeGroundSection view={view} />
      {answer !== null && (
        <>
          <Section title="What grows here" aside={<span className="tl-sec__note">{answer.dressing === null ? answer.material.name : `${answer.material.name} · ${answer.dressing.name}`}</span>}>
            {answer.note !== null && <p className="tl-hint">{answer.note}</p>}
            <ul className="tl-world-rules" aria-label="species at the cursor">
              {answer.species.map((s) => (
                <li key={s.index} className={`tl-world-rules__species${s.grows ? ' is-growing' : ''}`} data-grows={s.grows ? '1' : '0'} data-why={s.why ?? ''}>
                  <b>
                    {s.grows ? '✓' : '✗'} {s.index + 1}. {names.get(s.model) ?? s.model}
                  </b>{' '}
                  {s.text}
                </li>
              ))}
            </ul>
            {answer.dressing !== null && <p className="tl-hint">The rules are edited on the material's Dressing card (Project → {answer.material.name} → Voxel use → Dressing). Cover is drawn within about 40 m of the camera.</p>}
          </Section>
          <Section title="The ground here">
            <dl className="tl-world-rules__fields" aria-label="surface fields at the cursor">
              {answer.fields.map((f) => (
                <div key={f.name} className="tl-world-rules__field">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            <p className="tl-hint">These are the numbers a species' conditions are checked against at this point.</p>
          </Section>
        </>
      )}
    </div>
  );
}

const COLUMNS: Readonly<Record<string, (v: SceneModeView) => JSX.Element>> = { sculpt: SculptColumn, paint: PaintColumn, fill: FillColumn, spline: SplineColumn, rules: RulesColumn };

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
    { id: 'paint', label: 'Paint', glyph: 'paint', hint: 'Paint a material and a wetness on the ground; with a gas picked, paint, erase and smooth fog.', navigate: WHAT_NAVIGATE },
    { id: 'fill', label: 'Fill', glyph: 'fill', hint: 'Fill a hollow with fog to a level, drain it, or make a water body in a basin.', navigate: WHAT_NAVIGATE },
    { id: 'spline', label: 'Splines', glyph: 'ramp', hint: 'Start a road, a path or a river as a spline that writes voxels.', navigate: WHAT_NAVIGATE },
    { id: 'rules', label: 'Rules', glyph: 'rules', hint: 'Read what grows at a point of the ground and why not: the conditions at the cursor.', navigate: WHAT_NAVIGATE },
  ],
  tools: ['voxel-brush'],
  column: (view) => {
    const Column = COLUMNS[view.mode] ?? SculptColumn;
    return <Column key={view.mode} {...view} />;
  },
};
