/**
 * A water body's settings as a designer reads them: the level in metres
 * (the ring over the object in the Scene view drags it too), the liquid (a
 * picker of the project's liquid voxel materials), the reach, and the
 * body's state as the backend reports it: how many cells of water it holds,
 * or a warning where it leaks (nothing is written past its reach: the basin
 * shows dry until the gap is closed or the level lowered) or when its seed
 * stands in solid ground.
 *
 * The Inspector shows it for a `waterBody` in place of the record's raw
 * fields. Each change is one `setComponent`; the backend writes the water
 * with it.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

import { CommitField } from '../CommitField';
import type { WaterBodyValue, WaterTools } from '../shell/useWaterTools';

export interface WaterBodyFieldsProps {
  readonly entityId: string;
  readonly value: WaterBodyValue;
  readonly tools: WaterTools;
}

/** A place in the scene as the warning names it (metres, to the decimetre). */
const where = (at: readonly number[]): string => `(${at.map((v) => v.toFixed(1)).join(', ')}) m`;

export function WaterBodyFields({ entityId, value, tools }: WaterBodyFieldsProps): JSX.Element {
  const [problem, setProblem] = useState<string | null>(null);
  const state = tools.state(value.world, entityId);
  const send = (next: WaterBodyValue): void => {
    setProblem(null);
    void tools.set(entityId, next);
  };
  const metres = (label: string, key: 'level' | 'reach', hint: string, min?: number): JSX.Element => (
    <label className="tl-field" title={hint}>
      <span className="tl-field__label">{label}</span>
      <CommitField
        className="tl-input"
        label={`water ${key}`}
        type="number"
        step={key === 'level' ? 0.5 : 1}
        {...(min !== undefined ? { min } : {})}
        value={String(value[key])}
        onCommit={(raw) => {
          const m = Number(raw);
          if (!Number.isFinite(m) || (min !== undefined && m <= min)) return setProblem(`${label.replace(' (m)', '')} is a number of metres${min !== undefined ? ` above ${min}` : ''}`);
          send({ ...value, [key]: m });
        }}
      />
    </label>
  );
  const known = tools.liquids.some((m) => m.id === value.material);
  return (
    <div className="tl-water" aria-label="water body settings">
      {metres('Level (m)', 'level', 'The water surface’s height in the scene; the cells under it fill, the top ones partly.')}
      <label className="tl-field" title="The liquid’s voxel material (the project’s materials whose voxel use is liquid).">
        <span className="tl-field__label">Liquid</span>
        <select className="tl-input" aria-label="water liquid material" value={value.material} onChange={(e) => send({ ...value, material: Number(e.target.value) })}>
          {!known && <option value={value.material}>voxel id {value.material} (no liquid material names it)</option>}
          {tools.liquids.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} · {m.id}
            </option>
          ))}
        </select>
      </label>
      {metres('Reach (m)', 'reach', 'How far from the object the water may spread; water that would pass it is a leak (flagged, nothing written).', 0)}
      {(problem ?? tools.refusal) !== null && (
        <p className="tl-prop__error" role="alert" aria-label="water refused">
          {problem ?? tools.refusal}
        </p>
      )}
      {state === undefined ? (
        <p className="tl-hint" aria-label="water state">Reading the water…</p>
      ) : state.status === 'breached' ? (
        <div className="tl-water__breach" role="alert" aria-label="water breach">
          <b>
            The water leaks {state.leaks[0]?.kind === 'world' ? 'out of the world' : 'past its reach'} at {state.leaks.length} place{state.leaks.length === 1 ? '' : 's'}
            {state.leaks[0] !== undefined ? `, first at ${where(state.leaks[0].at)}` : ''}.
          </b>
          <span> Nothing is written past the reach, and the basin holds no water until the gap is closed, the level lowered or the reach widened (the red marks in the view show where).</span>
        </div>
      ) : state.status === 'seed_blocked' ? (
        <div className="tl-water__breach" role="alert" aria-label="water seed blocked">
          <b>The object stands in solid ground (or above its level in a column with no room under it): move it into the basin.</b>
        </div>
      ) : (
        <p className="tl-hint" aria-label="water state" data-cells={state.cells}>
          Holds {state.cells.toLocaleString('en')} cells of water ({(state.cells / 8).toLocaleString('en')} m³).
        </p>
      )}
    </div>
  );
}
