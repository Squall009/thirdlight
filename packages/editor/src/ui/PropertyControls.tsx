/**
 * Declared-property and component controls (React; packet 28).
 *
 * Display + intent only. Every control is derived from published declaration
 * data (`PropertyControl`) or the contract component shapes
 * (`ComponentControl`); a value edit is parsed and issued by the app as an
 * ordinary typed command — this file never touches scene state, never
 * evaluates behavior code and never offers apply/revert/variant/link
 * affordances (project-model §20.1.2/§20.1.5).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { ComponentControl, PropertyControl } from '../session/property-controls';
import { formatPropertyValue } from '../session/property-controls';

export interface ControlErrorView {
  code: string;
  message: string;
}

function inputMode(control: PropertyControl): string {
  switch (control.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    default:
      return 'text';
  }
}

function PropertyRow({
  control,
  onCommit,
}: {
  control: PropertyControl;
  onCommit: (raw: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => formatPropertyValue(control.current));
  const shown = control.error;
  const commit = (raw: string): void => {
    onCommit(raw);
  };
  return (
    <div className="tl-prop">
      <div className="tl-prop__head">
        <span className="tl-prop__label" title={control.key}>
          {control.label}
        </span>
        <span className="tl-prop__type">{control.type}</span>
      </div>
      {control.type === 'enum' ? (
        <select
          className="tl-prop__input"
          value={formatPropertyValue(control.current)}
          onChange={(e) => commit(e.target.value)}
          title={control.constraintText}
        >
          {(control.constraints.values ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : control.type === 'boolean' ? (
        <input
          className="tl-prop__check"
          type="checkbox"
          checked={control.current === true}
          onChange={(e) => commit(e.target.checked ? 'true' : 'false')}
          title={control.constraintText}
        />
      ) : (
        <input
          className="tl-prop__input"
          type={inputMode(control)}
          value={draft}
          placeholder={formatPropertyValue(control.default)}
          title={control.constraintText}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== formatPropertyValue(control.current)) commit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft);
            if (e.key === 'Escape') setDraft(formatPropertyValue(control.current));
          }}
        />
      )}
      <div className="tl-prop__caption">{control.constraintText}</div>
      {control.modified && <div className="tl-prop__caption">changed from default</div>}
      {shown && (
        <div className="tl-prop__error" title={shown.message}>
          {shown.code}: {shown.message}
        </div>
      )}
    </div>
  );
}

export function PropertyControlList({
  controls,
  onCommit,
}: {
  controls: readonly PropertyControl[];
  onCommit: (key: string, raw: string) => void;
}): JSX.Element {
  if (controls.length === 0) return <div className="tl-inspector__empty">no declared properties</div>;
  return (
    <div className="tl-props">
      {controls.map((c) => (
        // Remount on a committed value change so the input re-seeds from the
        // authoritative value (the row keeps local draft state while typing).
        <PropertyRow key={`${c.key}:${formatPropertyValue(c.current)}`} control={c} onCommit={(raw) => onCommit(c.key, raw)} />
      ))}
    </div>
  );
}

/** Editable contract component controls (collider/controller add/edit/remove). */
export function ComponentControlList({
  controls,
  onEditColliderBox,
  onAdd,
  onRemove,
}: {
  controls: readonly ComponentControl[];
  onEditColliderBox: (hx: string, hy: string) => void;
  onAdd: (component: 'collider' | 'controller') => void;
  onRemove: (component: 'collider' | 'controller') => void;
}): JSX.Element | null {
  const [hx, setHx] = useState('');
  const [hy, setHy] = useState('');
  if (controls.length === 0) return null;
  return (
    <div className="tl-props">
      {controls.map((c) => {
        const shapeType = c.fields.find((f) => f.path === 'collider.shape.type')?.value;
        return (
          <div className="tl-comp" key={c.component}>
            <div className="tl-prop__head">
              <span className="tl-prop__label">{c.label}</span>
              <span className="tl-prop__type">{c.present ? c.component : 'absent'}</span>
            </div>
            {c.fields.map((f) => (
              <div className="tl-comp__field" key={f.path} title={f.path}>
                <span className="tl-comp__name">{f.label}</span>
                <span className="tl-comp__value">{f.value}</span>
                <span className="tl-comp__type">{f.type}</span>
              </div>
            ))}
            {c.component === 'collider' && c.present && shapeType === 'box' && (
              <div className="tl-comp__field">
                <span className="tl-comp__name">hx/hy</span>
                <input className="tl-prop__input" type="number" value={hx} placeholder={c.fields.find((f) => f.path === 'collider.shape.hx')?.value} onChange={(e) => setHx(e.target.value)} />
                <input className="tl-prop__input" type="number" value={hy} placeholder={c.fields.find((f) => f.path === 'collider.shape.hy')?.value} onChange={(e) => setHy(e.target.value)} />
                <button className="tl-btn tl-btn--small" onClick={() => onEditColliderBox(hx, hy)}>
                  set
                </button>
              </div>
            )}
            {!c.present && (
              <button className="tl-btn tl-btn--small" onClick={() => onAdd(c.component)} title="Add this component">
                add
              </button>
            )}
            {c.present && (
              <button className="tl-btn tl-btn--small" onClick={() => onRemove(c.component)} title="Remove this component">
                remove
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
