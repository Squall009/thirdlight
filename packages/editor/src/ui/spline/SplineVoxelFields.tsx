/**
 * A spline's voxels as a designer sets them: whether it writes a road, a
 * path or a river into its scene's voxel world, its material (the project's
 * solid voxel materials for a road or path, its liquid ones for a river),
 * the bed under it, the shoulders meeting the ground and the air cleared
 * above; and what the backend reports of its last write: the cells it
 * holds, the cells it left alone because someone edited them since it
 * wrote them, the hand edits on it the fit rule could not keep (marked in
 * the Scene view too).
 *
 * The Inspector shows it under a spline's fields. Each change is one
 * `setComponent` of the spline; the backend writes the voxels with it, and
 * what it replaced comes back when the spline moves or the section goes.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

import type { ProjectedEntity } from '../../session/projection';
import { splineStartVoxels } from '../../session/voxel-fill';
import { CommitField } from '../CommitField';
import type { SplineVoxelsValue, SplineVoxelTools } from '../shell/useSplineVoxelTools';

export interface SplineVoxelFieldsProps {
  readonly entity: ProjectedEntity;
  readonly tools: SplineVoxelTools;
}

/** A place in the scene as the report names it (metres, to the decimetre). */
const where = (at: readonly number[]): string => `(${at.map((v) => v.toFixed(1)).join(', ')}) m`;

/** What a new section starts as: a road of the first solid material on a metre of bed, or a river of the first liquid. */
function fresh(kind: SplineVoxelsValue['kind'], tools: SplineVoxelTools): SplineVoxelsValue | null {
  return splineStartVoxels(kind, tools.solids[0]?.id ?? null, tools.liquids[0]?.id ?? null);
}

export function SplineVoxelFields({ entity, tools }: SplineVoxelFieldsProps): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null);
  const value = (entity.components['spline'] as { voxels?: SplineVoxelsValue } | undefined)?.voxels;
  const send = (next: SplineVoxelsValue | null): void => {
    setProblem(null);
    void tools.set(entity, next);
  };
  const world = tools.world();
  if (value === undefined) {
    const start = (kind: SplineVoxelsValue['kind']): void => {
      if (world === null) return setProblem('A spline writes voxels into its scene’s voxel world: the scene needs exactly one voxel world object.');
      const v = fresh(kind, tools);
      if (v === null) return setProblem(kind === 'river' ? 'A river needs a liquid voxel material: make a material whose voxel use is liquid first.' : 'A road needs a voxel material that is not liquid.');
      send(v);
    };
    return (
      <div className="tl-spline-voxels" aria-label="spline voxels">
        <p className="tl-hint">Write it into the voxel world{world !== null ? ` “${world}”` : ''}: the ground it replaces comes back when it moves or stops.</p>
        <div className="tl-row">
          <button type="button" className="tl-btn" aria-label="write a road" onClick={() => start('road')}>Road</button>
          <button type="button" className="tl-btn" aria-label="write a path" onClick={() => start('path')}>Path</button>
          <button type="button" className="tl-btn" aria-label="write a river" onClick={() => start('river')}>River</button>
        </div>
        {(problem ?? tools.refusal) !== null && <p className="tl-prop__error" role="alert" aria-label="spline voxels refused">{problem ?? tools.refusal}</p>}
      </div>
    );
  }
  const river = value.kind === 'river';
  const choices = river ? tools.liquids : tools.solids;
  const picker = (label: string, aria: string, id: number, list: typeof choices, onPick: (id: number) => void): JSX.Element => (
    <label className="tl-field">
      <span className="tl-field__label">{label}</span>
      <select className="tl-input" aria-label={aria} value={id} onChange={(e) => onPick(Number(e.target.value))}>
        {!list.some((m) => m.id === id) && <option value={id}>voxel id {id}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} · {m.id}
          </option>
        ))}
      </select>
    </label>
  );
  const metres = (label: string, aria: string, current: number | undefined, onSet: (m: number | null) => void, hint: string, above = 0): JSX.Element => (
    <label className="tl-field" title={hint}>
      <span className="tl-field__label">{label}</span>
      <CommitField
        className="tl-input"
        label={aria}
        type="number"
        step={0.5}
        value={current === undefined ? '' : String(current)}
        onCommit={(raw) => {
          if (raw.trim() === '') return onSet(null);
          const m = Number(raw);
          if (!Number.isFinite(m) || m <= above) return setProblem(`${label.replace(/ \(.*\)/, '')} is a number above ${above}`);
          onSet(m);
        }}
      />
    </label>
  );
  const s = tools.state(entity.id);
  const last = s?.lastWrite;
  const { bed: _bed, shoulder: _shoulder, clear: _clear, ...core } = value;
  return (
    <div className="tl-spline-voxels" aria-label="spline voxels" data-kind={value.kind}>
      <label className="tl-field">
        <span className="tl-field__label">Writes</span>
        <select
          className="tl-input"
          aria-label="spline writes kind"
          value={value.kind}
          onChange={(e) => {
            const kind = e.target.value as SplineVoxelsValue['kind'];
            // A river and a road are of different materials: switching between them takes the other kind's first.
            const swap = (kind === 'river') !== river ? fresh(kind, tools) : null;
            send(swap !== null ? { ...value, kind, material: swap.material } : { ...value, kind });
          }}
        >
          <option value="road">Road</option>
          <option value="path">Path</option>
          <option value="river">River</option>
        </select>
      </label>
      {picker(river ? 'Liquid' : 'Surface', 'spline writes material', value.material, choices, (id) => send({ ...value, material: id }))}
      <label className="tl-field">
        <span className="tl-field__label">Bed</span>
        <input type="checkbox" aria-label="spline writes bed" checked={value.bed !== undefined} onChange={(e) => send(e.target.checked ? { ...value, bed: { material: tools.solids[0]?.id ?? value.material, depth: 1 } } : { ...core, ...(value.shoulder !== undefined ? { shoulder: value.shoulder } : {}), ...(value.clear !== undefined ? { clear: value.clear } : {}) })} />
      </label>
      {value.bed !== undefined && picker('Bed material', 'spline writes bed material', value.bed.material, tools.solids, (id) => send({ ...value, bed: { ...value.bed!, material: id } }))}
      {value.bed !== undefined && metres(river ? 'Depth (m)' : 'Bed depth (m)', 'spline writes bed depth', value.bed.depth, (m) => m !== null && send({ ...value, bed: { ...value.bed!, depth: m } }), river ? 'How deep the river runs under its surface.' : 'How deep the bed lies under the surface.')}
      <label className="tl-field">
        <span className="tl-field__label">Shoulders</span>
        <input type="checkbox" aria-label="spline writes shoulders" checked={value.shoulder !== undefined} onChange={(e) => send(e.target.checked ? { ...value, shoulder: { width: 2, slope: 1 } } : { ...core, ...(value.bed !== undefined ? { bed: value.bed } : {}), ...(value.clear !== undefined ? { clear: value.clear } : {}) })} />
      </label>
      {value.shoulder !== undefined && metres('Shoulder width (m)', 'spline writes shoulder width', value.shoulder.width, (m) => m !== null && send({ ...value, shoulder: { ...value.shoulder!, width: m } }), 'How far past the edge the ground is cut or filled to the slope.')}
      {value.shoulder !== undefined && metres('Shoulder slope', 'spline writes shoulder slope', value.shoulder.slope, (m) => m !== null && send({ ...value, shoulder: { ...value.shoulder!, slope: m } }), 'Metres up or down a metre across (1: 45°).')}
      {metres('Clear above (m)', 'spline writes clear', value.clear, (m) => send(m === null || m === 0 ? { ...core, ...(value.bed !== undefined ? { bed: value.bed } : {}), ...(value.shoulder !== undefined ? { shoulder: value.shoulder } : {}) } : { ...value, clear: m }), 'Metres of air cleared above it (a road through a hill); empty: none.', -0.001)}
      <button type="button" className="tl-btn" aria-label="stop writing voxels" title="The ground it replaced comes back (one undo step)." onClick={() => send(null)}>
        Stop writing voxels
      </button>
      {(problem ?? tools.refusal) !== null && <p className="tl-prop__error" role="alert" aria-label="spline voxels refused">{problem ?? tools.refusal}</p>}
      {s === undefined ? (
        <p className="tl-hint" aria-label="spline voxels state">Reading the voxels…</p>
      ) : (
        <p className="tl-hint" aria-label="spline voxels state" data-written={s.written}>
          Holds {s.written.toLocaleString('en')} cells it wrote (what they replaced: {(s.recordBytes / 1024).toFixed(1)} KB).
        </p>
      )}
      {last !== undefined && last.leftAlone.length > 0 && (
        <div className="tl-water__breach" role="status" aria-label="spline voxels left alone" data-cells={last.leftAlone.length}>
          <b>{last.leftAlone.length} cell{last.leftAlone.length === 1 ? '' : 's'} left as edited since it wrote them, first at {where(last.leftAlone[0]!.at)}.</b>
          <span> They were changed by hand after the spline wrote them, so moving it did not put back what lay there (marked in red in the view).</span>
        </div>
      )}
      {last !== undefined && last.misfits.length > 0 && (
        <div className="tl-water__breach" role="status" aria-label="spline voxels misfits" data-cells={last.misfits.length}>
          <b>{last.misfits.length} hand edit{last.misfits.length === 1 ? '' : 's'} on it no longer fit, first at {where(last.misfits[0]!.at)}.</b>
          <span> What the spline makes there now is written instead (undo brings them back).</span>
        </div>
      )}
    </div>
  );
}
