/**
 * Declared-property controls (React; packet 28; phase 15.1: component fields
 * are the descriptor-built Inspector sections, `DescriptorFields`).
 *
 * Display + intent only. Every control is derived from published declaration
 * data (`PropertyControl`); a value edit is parsed and issued by the app as an
 * ordinary typed command — this file never touches scene state, never
 * evaluates behavior code and never offers apply/revert/variant/link
 * affordances (project-model §20.1.2/§20.1.5).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { PropertyControl } from '../session/property-controls';
import { formatPropertyValue } from '../session/property-controls';

export interface ControlErrorView {
  code: string;
  message: string;
}

/**
 * Phase 25.10: the objects an object (`entityRef`) property may name — the
 * picker's choices (the Inspector: the objects of the scene; a prefab's
 * override: the prefab's own objects). Absent: a text field takes an id.
 */
export interface EntityRefOption {
  readonly id: string;
  readonly label: string;
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
  entityOptions,
}: {
  control: PropertyControl;
  onCommit: (raw: string) => void;
  entityOptions?: readonly EntityRefOption[];
}): JSX.Element {
  const [draft, setDraft] = useState(() => formatPropertyValue(control.current));
  const shown = control.error;
  const commit = (raw: string): void => {
    onCommit(raw);
  };
  return (
    <div className="tl-prop" data-property={control.key} title={control.tooltip}>
      {control.header !== undefined && <div className="tl-prop__header">{control.header}</div>}
      <div className="tl-prop__head">
        <span className="tl-prop__label" title={control.tooltip ?? control.key}>
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
      ) : control.type === 'entityRef' && entityOptions !== undefined ? (
        // Phase 25.10: an object property is picked from the objects it may name ("none": null).
        <select
          className="tl-prop__input"
          data-entity-ref={control.key}
          value={formatPropertyValue(control.current)}
          onChange={(e) => commit(e.target.value)}
          title={control.constraintText}
        >
          <option value="">none</option>
          {typeof control.current === 'string' && !entityOptions.some((o) => o.id === control.current) && (
            <option value={control.current}>{control.current} (missing)</option>
          )}
          {entityOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
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
  entityOptions,
}: {
  controls: readonly PropertyControl[];
  onCommit: (key: string, raw: string) => void;
  /** Phase 25.10: the objects object properties may name (a picker instead of an id field). */
  entityOptions?: readonly EntityRefOption[];
}): JSX.Element {
  if (controls.length === 0) return <div className="tl-inspector__empty">no public properties</div>;
  // Remount on a committed value change so the input re-seeds from the
  // authoritative value (the row keeps local draft state while typing).
  const row = (c: PropertyControl): JSX.Element => <PropertyRow key={`${c.key}:${formatPropertyValue(c.current)}`} control={c} onCommit={(raw) => onCommit(c.key, raw)} {...(entityOptions !== undefined ? { entityOptions } : {})} />;
  // Phase 15.4: ungrouped properties first, then one foldable section per
  // group (in the order the groups first appear in the declaration).
  const groups: string[] = [];
  for (const c of controls) if (c.group !== undefined && !groups.includes(c.group)) groups.push(c.group);
  return (
    <div className="tl-props">
      {controls.filter((c) => c.group === undefined).map(row)}
      {groups.map((g) => (
        <details className="tl-props__group" key={`group:${g}`} open data-group={g}>
          <summary className="tl-props__group-title">{g}</summary>
          {controls.filter((c) => c.group === g).map(row)}
        </details>
      ))}
    </div>
  );
}
