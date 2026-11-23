/**
 * A structure's settings as a designer reads them: storeys, storey height,
 * foundation depth and the roof in metres, a voxel material for each part
 * (walls, floors, roof, foundation, stairs; a swap is one `setComponent` in
 * which only material ids change), and what it holds: its polygons (one may
 * go while another stays), openings, stairs, the hand edits kept, and the
 * edits the last regenerate could not keep, listed with what each was.
 *
 * The Inspector shows it for a `voxelStructure` in place of the record's
 * raw fields, and the structure mode's Shape column shows the same: the
 * footprint is edited by the handles in the Scene view, never as text; its
 * openings are listed (kind, size, wall, prop) to select or delete, the
 * selected one's size and prop set below the list.
 * Each change is checked by the building generator's checks first; a
 * refused one is said here and not sent.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { BUILDING_GENERATOR, ROOF_AXES, ROOF_SHAPES, VOXEL_SIZE_M, type StructureDefinition, type StructureMaterials } from '@thirdlight/voxel';

import { definitionOf, misfitSummary, misfitWords, removePolygon, STRUCTURE_PARTS, structureProblem, type MisfitLike, type StructureValue } from '../../session/structure-shape';
import { CommitField } from '../CommitField';
import type { StructureTools } from '../shell/useStructureTools';
import { OpeningsList } from './OpeningsPanel';

const PART_LABELS: Readonly<Record<keyof StructureMaterials, string>> = { wall: 'Walls', floor: 'Floors', roof: 'Roof material', foundation: 'Foundation material', stair: 'Stairs' };

export interface StructureFieldsProps {
  readonly entityId: string;
  readonly value: StructureValue;
  readonly tools: StructureTools;
  /** A misfit picked in the list (null: none): the mode frames it and marks its cell. */
  readonly onMisfit?: (m: MisfitLike | null) => void;
  readonly picked?: MisfitLike | null;
  /** Whether any structure of the project was written by an older generator (Regenerate all is offered). */
  readonly outdated?: number;
}

/** Metres as the fields show them (a cell is 0.5 m). */
const metres = (cells: number): string => String(cells * VOXEL_SIZE_M);

export function StructureFields({ entityId, value, tools, onMisfit, picked, outdated }: StructureFieldsProps): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null);
  const [listed, setListed] = useState(false);
  const def = definitionOf(value);
  const grid = tools.grids(value.world)?.get(value.grid);
  const misfits = grid?.lastRegenerate?.misfits ?? [];
  const send = (next: StructureDefinition): void => {
    const why = structureProblem(next);
    setProblem(why);
    if (why === null) void tools.define(entityId, value, next);
  };
  const cellsField = (label: string, cells: number, min: number, apply: (c: number) => StructureDefinition, hint: string): JSX.Element => (
    <label className="tl-field" title={hint}>
      <span className="tl-field__label">{label}</span>
      <CommitField
        className="tl-input"
        label={`structure ${label.replace(' (m)', '').toLowerCase()}`}
        type="number"
        step={VOXEL_SIZE_M}
        min={min * VOXEL_SIZE_M}
        value={metres(cells)}
        onCommit={(raw) => {
          const m = Number(raw);
          const c = Math.round(m / VOXEL_SIZE_M);
          if (!Number.isFinite(m) || c < min) return setProblem(`${label.replace(' (m)', '')} is at least ${min * VOXEL_SIZE_M} m, in 0.5 m steps`);
          send(apply(c));
        }}
      />
    </label>
  );
  const known = new Set(tools.materials.map((m) => m.id));
  return (
    <div className="tl-structure" aria-label="structure settings" data-structure-grid={value.grid}>
      <label className="tl-field" title="Floors stacked on the ground floor (the arrow over the roof drags them too).">
        <span className="tl-field__label">Storeys</span>
        <CommitField
          className="tl-input"
          label="structure storeys"
          type="number"
          step={1}
          min={1}
          value={String(def.storeys)}
          onCommit={(raw) => {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 1) return setProblem('Storeys is a whole number from 1');
            send({ ...def, storeys: n });
          }}
        />
      </label>
      {cellsField('Storey height (m)', def.storeyHeight, 2, (c) => ({ ...def, storeyHeight: c }), 'A storey from floor to floor, its slab included (3 m: a 2.5 m room).')}
      {cellsField('Foundation (m)', def.foundationDepth, 0, (c) => ({ ...def, foundationDepth: c }), 'How deep the foundation goes below the ground floor (the building leaves the ground alone: dig or fill the site).')}
      <label className="tl-field">
        <span className="tl-field__label">Roof</span>
        <select className="tl-input" aria-label="structure roof shape" value={def.roof.shape} onChange={(e) => send({ ...def, roof: { ...def.roof, shape: e.target.value as StructureDefinition['roof']['shape'] } })}>
          {ROOF_SHAPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {cellsField('Overhang (m)', def.roof.overhang, 0, (c) => ({ ...def, roof: { ...def.roof, overhang: c } }), 'How far the roof reaches past the walls on every side.')}
      {def.roof.shape === 'gable' && (
        <label className="tl-field" title="The direction the gable's ridge runs (one for the whole building).">
          <span className="tl-field__label">Ridge along</span>
          <select className="tl-input" aria-label="structure ridge axis" value={def.roof.axis} onChange={(e) => send({ ...def, roof: { ...def.roof, axis: e.target.value as StructureDefinition['roof']['axis'] } })}>
            {ROOF_AXES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      )}
      {STRUCTURE_PARTS.map((part) => (
        <label key={part} className="tl-field" title={`The voxel material of the ${part === 'wall' ? 'walls and openings' : part}; its kit draws it. A swap changes material ids only: hand-painted cells keep their paint.`}>
          <span className="tl-field__label">{PART_LABELS[part]}</span>
          <select className="tl-input" aria-label={`structure ${part} material`} value={def.materials[part]} onChange={(e) => send({ ...def, materials: { ...def.materials, [part]: Number(e.target.value) } })}>
            {!known.has(def.materials[part]) && <option value={def.materials[part]}>voxel id {def.materials[part]} (no material names it)</option>}
            {tools.materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.id}{m.use === 'construction' ? '' : ` · ${m.use}`}
              </option>
            ))}
          </select>
        </label>
      ))}
      {problem !== null && (
        <p className="tl-prop__error" role="alert" aria-label="structure refused">
          {problem}
        </p>
      )}
      <dl className="tl-structure__counts" aria-label="structure counts">
        <dt>Polygons</dt>
        <dd data-count="polygons">{def.footprint.length}</dd>
        <dt>Openings</dt>
        <dd data-count="openings">{def.openings.length}</dd>
        <dt>Stairs</dt>
        <dd data-count="stairs">{def.stairs.length}</dd>
        <dt>Hand edits</dt>
        <dd data-count="hand-edits">{grid === undefined ? '…' : `${grid.overrides} kept`}</dd>
      </dl>
      <OpeningsList entityId={entityId} value={value} tools={tools} selected={tools.opening?.entityId === entityId ? tools.opening.id : null} onSelect={(id) => tools.selectOpening(id === null ? null : { entityId, id })} />
      {def.footprint.length > 1 && (
        <ul className="tl-structure__polygons" aria-label="structure polygons">
          {def.footprint.map((p, i) => (
            <li key={p.id}>
              <span>{p.id}</span>
              <button
                type="button"
                className="tl-btn tl-btn--small"
                aria-label={`remove polygon ${p.id}`}
                onClick={() => {
                  const next = removePolygon(def, i);
                  if (typeof next === 'string') setProblem(next);
                  else send(next);
                }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {misfits.length > 0 && (
        <div className="tl-structure__misfits" role="status" aria-label="structure misfits">
          <b>{misfitSummary(misfits.length)}</b>
          <button type="button" className="tl-btn tl-btn--small" aria-expanded={listed} onClick={() => setListed((l) => !l)}>
            {listed ? 'hide the list' : 'list them'}
          </button>
          {listed && (
            <ol aria-label="misfit list">
              {misfits.map((m, i) => {
                const on = picked !== null && picked !== undefined && picked.x === m.x && picked.y === m.y && picked.z === m.z;
                return (
                  <li key={i}>
                    <button type="button" className={`tl-structure__misfit${on ? ' is-active' : ''}`} aria-pressed={on} data-cell={`${m.x},${m.y},${m.z}`} onClick={() => onMisfit?.(on ? null : m)}>
                      Cell ({m.x}, {m.y}, {m.z}): {misfitWords(m, (mid) => tools.materials.find((x) => x.id === mid)?.name ?? `material ${mid}`)}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="tl-hint">Undo brings them back. A hand edit that should follow its wall belongs in the definition (an opening).</p>
        </div>
      )}
      {(outdated ?? 0) > 0 && (
        <div className="tl-structure__outdated" role="status">
          <span>
            {outdated} structure{outdated === 1 ? ' was' : 's were'} written by an older building generator (this build's is {BUILDING_GENERATOR.version}).
          </span>
          <button type="button" className="tl-btn tl-btn--small" onClick={() => void tools.regenerateAll()}>
            Regenerate all
          </button>
        </div>
      )}
    </div>
  );
}
