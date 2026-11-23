/**
 * The structure editor: a `voxelStructure` object's edit mode, on the live
 * Scene view in the shell every editor shares. Its rail:
 *
 * - **Shape**: the handles on the structure's own grid (corners, edges, the
 *   storey arrow over the roof, the turn knob), Extend (draw a wing as
 *   another polygon), and the structure's settings (`StructureFields`: the
 *   numbers, the roof, a material a part, what it holds and the edits the
 *   last regenerate could not keep).
 * - **Hand edits**: Dig, Add and Paint with the shared brush (its size, a
 *   box or a ball) on the structure's own cells; Add writes the role and
 *   material picked, Paint a material.
 *
 * Every edit is an existing command (the structure tool, `useStructureTools`).
 * The view draws the structure with its world's ground round it (voxel
 * worlds are not objects the isolation hides; other objects are), its own
 * grid faint under it; a misfit picked in the list is framed and marked.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { BUILDING_GENERATOR, GridFrame, VOXEL_ROLE, VOXEL_SIZE_M } from '@thirdlight/voxel';

import { BRUSH_BOUNDS, brushStore, DEFAULT_BRUSH, type BrushStore } from '../../session/brush';
import type { ProjectedEntity } from '../../session/projection';
import { ADD_ROLES, definitionOf, misfitSummary, type StructureValue } from '../../session/structure-shape';
import type { StructureToolKind } from '../../viewport/structure-tool';
import { useBrush } from '../brush/useBrush';
import { StructureFields } from '../structure/StructureFields';
import { brushPanels } from './brush-panels';
import { Section, Segmented } from './controls';
import { EditPanels } from './docks';
import { useEditStatus } from './edit-status';
import { useToolArmed } from './edit-tool';
import type { EditModeView, ObjectEditModeKind } from './modes';
import { ToolGrid } from './ToolGrid';
import { Toast } from './Banner';

const valueOf = (e: ProjectedEntity): StructureValue | undefined => e.components['voxelStructure'] as StructureValue | undefined;

const SHAPE_TOOLS = [
  { id: 'shape', label: 'Shape', glyph: 'select', key: 'S', hint: 'Drag a corner or an edge (0.5 m steps), the arrow over the roof (storeys) or the knob on the ring (turn, 15° steps; Shift: free).' },
  { id: 'extend', label: 'Extend', glyph: 'plus', key: 'E', hint: 'Drag a rectangle on the floor: a wing (another polygon) joined to the building.' },
] as const;

const HAND_TOOLS = [
  { id: 'dig', label: 'Dig', glyph: 'erase', key: 'D', hint: 'Drag over the structure to take its cells out (a window, a hole).' },
  { id: 'add', label: 'Add', glyph: 'plus', key: 'A', hint: 'Drag over the structure to add cells of the role and material picked, in front of the face under the pointer.' },
  { id: 'paint', label: 'Paint', glyph: 'paint', key: 'P', hint: 'Drag over the structure to give its cells the material picked (each keeps its role).' },
] as const;

/** The hand-edit brush: one cell across to start (a voxel is the unit a hand edit means); size only. */
const HAND_BRUSH = { ...DEFAULT_BRUSH, size: VOXEL_SIZE_M, falloff: 'constant' as const };
const HAND_BOUNDS = { ...BRUSH_BOUNDS, size: [VOXEL_SIZE_M, 8] as const, heightStep: [0.5, 0.5] as const };
const handStore = (): BrushStore => brushStore('structure', 'hand', HAND_BRUSH, HAND_BOUNDS);

/** Remembered for the page: the tool of each column, the brush's shape, Add's role and the materials picked. */
const remembered = { shape: 'shape' as StructureToolKind, hand: 'dig' as StructureToolKind, brushShape: 'box' as 'box' | 'sphere', role: VOXEL_ROLE.wall as number, material: null as number | null };

/** The marker of the picked misfit, when it is this structure's. */
function markerOf(view: EditModeView): readonly [number, number, number] | null {
  const p = view.host.structure.picked;
  return p !== null && p.entityId === view.entity.id ? [p.misfit.x, p.misfit.y, p.misfit.z] : null;
}

/** How many structures of the open scenes an older generator wrote (Regenerate all is offered then). */
function outdatedCount(entities: readonly ProjectedEntity[]): number {
  return entities.filter((e) => (valueOf(e)?.generator ?? BUILDING_GENERATOR.version) < BUILDING_GENERATOR.version).length;
}

/** Arms the structure tool for a column while it shows (off when it goes). */
function useArm(view: EditModeView, tool: StructureToolKind, extra: { store?: BrushStore; voxel?: { material: number; role: number } | null; brushShape?: 'box' | 'sphere' }): boolean {
  const armed = useToolArmed();
  const value = valueOf(view.entity) ?? null;
  const marker = markerOf(view);
  const arm = view.host.structure.arm;
  const entityId = view.entity.id;
  const store = extra.store ?? null;
  const key = JSON.stringify([tool, armed, value, marker, extra.voxel ?? null, extra.brushShape ?? 'box']);
  useEffect(() => {
    arm({ tool, navigate: !armed, entityId, value, store, brushShape: extra.brushShape ?? 'box', voxel: extra.voxel ?? null, marker });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every value the arm reads is in `key` (its objects are made again each render)
  }, [key, arm, entityId, store]);
  useEffect(() => () => arm(null), [arm]);
  return armed;
}

/** The status line: a refusal first (what to change), then a drag's readout, then what the tool does. */
function useStructureStatus(view: EditModeView, tool: string, hint: string): void {
  const s = view.host.structure;
  useEditStatus({ tool, text: s.refusal ?? s.readout ?? hint, keys: [] });
}

function ShapeColumn(view: EditModeView): JSX.Element {
  const [tool, setTool] = useState<StructureToolKind>(remembered.shape);
  useArm(view, tool, {});
  const value = valueOf(view.entity)!;
  const t = SHAPE_TOOLS.find((x) => x.id === tool) ?? SHAPE_TOOLS[0];
  useStructureStatus(view, t.label, t.hint);
  const s = view.host.structure;
  return (
    <div className="tl-structure-mode" aria-label="structure shape tools">
      <Section title="Tool">
        <ToolGrid
          tools={SHAPE_TOOLS}
          active={tool}
          onPick={(id) => {
            remembered.shape = id as StructureToolKind;
            setTool(id as StructureToolKind);
          }}
          aria="structure shape tool"
          cols={3}
        />
      </Section>
      <Section title="Structure">
        <StructureFields
          entityId={view.entity.id}
          value={value}
          tools={s}
          picked={s.picked?.entityId === view.entity.id ? s.picked.misfit : null}
          onMisfit={(m) => {
            s.pick(m === null ? null : { entityId: view.entity.id, misfit: m });
            if (m !== null) frameCell(view, [m.x, m.y, m.z]);
          }}
          outdated={outdatedCount(view.host.entities)}
        />
      </Section>
    </div>
  );
}

/** Frames a cell of the structure's grid (a misfit's place) with a few metres round it. */
function frameCell(view: EditModeView, cell: readonly [number, number, number]): void {
  const t = view.entity.components['transform'] as { position?: number[]; rotation?: number[] } | undefined;
  const q = t?.rotation ?? [0, 0, 0, 1];
  const f = new GridFrame({ gridId: valueOf(view.entity)!.grid, position: [t?.position?.[0] ?? 0, t?.position?.[1] ?? 0, t?.position?.[2] ?? 0], yawRad: 2 * Math.atan2(q[1]!, q[3]!) });
  const w = f.toWorld((cell[0] + 0.5) * VOXEL_SIZE_M, (cell[1] + 0.5) * VOXEL_SIZE_M, (cell[2] + 0.5) * VOXEL_SIZE_M);
  const r = 6;
  view.host.frameBox({ min: [w[0] - r, w[1] - r, w[2] - r], max: [w[0] + r, w[1] + r, w[2] + r] });
}

function HandColumn(view: EditModeView): JSX.Element {
  const [tool, setTool] = useState<StructureToolKind>(remembered.hand);
  const [shape, setShape] = useState(remembered.brushShape);
  const [role, setRole] = useState(remembered.role);
  const value = valueOf(view.entity)!;
  const s = view.host.structure;
  const [material, setMaterial] = useState<number>(remembered.material ?? value.materials.wall);
  const store = useMemo(handStore, []);
  const settings = useBrush(store);
  const voxel = tool === 'dig' ? null : { material, role: tool === 'paint' ? VOXEL_ROLE.wall : role };
  useArm(view, tool, { store, voxel, brushShape: shape });
  const t = HAND_TOOLS.find((x) => x.id === tool) ?? HAND_TOOLS[0];
  useStructureStatus(view, t.label, t.hint);
  const grid = s.grids(value.world)?.get(value.grid);
  return (
    <div className="tl-structure-mode" aria-label="structure hand edit tools">
      <Section title="Tool" aside={<span className="tl-sec__note">{grid === undefined ? '' : `${grid.overrides} hand edits kept`}</span>}>
        <ToolGrid
          tools={HAND_TOOLS}
          active={tool}
          onPick={(id) => {
            remembered.hand = id as StructureToolKind;
            setTool(id as StructureToolKind);
          }}
          aria="structure hand edit tool"
          cols={3}
        />
      </Section>
      <Section title="Brush">
        <Segmented
          aria="structure brush shape"
          options={[{ id: 'box', label: 'Box', hint: 'Whole cells in a cube' }, { id: 'sphere', label: 'Ball', hint: 'Cells within a ball' }]}
          value={shape}
          onChange={(v) => {
            remembered.brushShape = v;
            setShape(v);
          }}
        />
      </Section>
      {tool === 'add' && (
        <Section title="Adds">
          <Segmented
            aria="structure add role"
            small
            options={ADD_ROLES.map((r) => ({ id: r.role, label: r.label }))}
            value={role}
            onChange={(v) => {
              remembered.role = v;
              setRole(v);
            }}
          />
        </Section>
      )}
      {tool !== 'dig' && (
        <Section title="Material">
          <select
            className="tl-input"
            aria-label="structure hand edit material"
            value={material}
            onChange={(e) => {
              remembered.material = Number(e.target.value);
              setMaterial(Number(e.target.value));
            }}
          >
            {s.materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.id}
              </option>
            ))}
          </select>
          <p className="tl-hint">Paint gives a cell the material and keeps the role of the cell the stroke starts on.</p>
        </Section>
      )}
      <EditPanels panels={brushPanels({ settings, store, uses: ['size'], title: 'Brush', badge: 'cells of the structure' })} />
    </div>
  );
}

const COLUMNS: Readonly<Record<string, (v: EditModeView) => JSX.Element>> = { shape: ShapeColumn, hand: HandColumn };

export const structureMode: ObjectEditModeKind = {
  kind: 'structure',
  label: 'Structure editor',
  action: 'Edit structure',
  applies: (e) => valueOf(e) !== undefined,
  framesOnEnter: true,
  meta: (e) => {
    const v = valueOf(e)!;
    const n = v.footprint.length;
    return `${v.storeys} storey${v.storeys === 1 ? '' : 's'} · ${n} polygon${n === 1 ? '' : 's'} · ${v.roof.shape} roof · grid ${v.grid} of ${v.world}`;
  },
  rail: [
    { id: 'shape', label: 'Shape', glyph: 'select', hint: 'Drag the handles to reshape the building; Extend draws a wing.', navigate: 'A drag orbits; pick Shape (S) or Extend (E) to edit.' },
    { id: 'hand', label: 'Hand edits', glyph: 'paint', hint: 'Dig, add or paint cells of the structure; they are kept over what the definition makes.', navigate: 'A drag orbits; pick Dig (D), Add (A) or Paint (P).' },
  ],
  tools: ['structure'],
  bounds: (e) => {
    const v = valueOf(e)!;
    try {
      const b = BUILDING_GENERATOR.box(definitionOf(v));
      return { min: [b.minX * VOXEL_SIZE_M, b.minY * VOXEL_SIZE_M, b.minZ * VOXEL_SIZE_M], max: [(b.maxX + 1) * VOXEL_SIZE_M, (b.maxY + 1) * VOXEL_SIZE_M, (b.maxZ + 1) * VOXEL_SIZE_M] };
    } catch {
      return null;
    }
  },
  column: (view) => {
    const Column = COLUMNS[view.mode] ?? ShapeColumn;
    return <Column key={view.mode} {...view} />;
  },
  viewExtra: (view) => {
    const v = valueOf(view.entity);
    const misfits = v === undefined ? 0 : (view.host.structure.grids(v.world)?.get(v.grid)?.lastRegenerate?.misfits.length ?? 0);
    const outdated = outdatedCount(view.host.entities);
    if (misfits > 0) return <Toast aria="structure misfits banner">{misfitSummary(misfits)}: Shape → Structure lists them.</Toast>;
    if (outdated > 0) return <Toast aria="structures outdated" action={{ label: 'Regenerate all', onClick: () => void view.host.structure.regenerateAll() }}>{outdated} structure{outdated === 1 ? '' : 's'} written by an older generator.</Toast>;
    return null;
  },
};
