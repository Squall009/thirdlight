/**
 * Phase 15.4: the Behaviors tab's declaration editor (React).
 *
 * Edits every declared-property field — key, label, type (all seven), default,
 * visibility (public: shown and set per object in the Inspector; private: not
 * shown, the script reads the default), group, header, tooltip and the
 * type's limits (min/max/step, max length, enum choices, vector bounds) — and
 * saves the whole declaration with one ordinary `publishBehavior` command
 * (`declaration-create` for a new behavior, `declaration-update` otherwise).
 * A declaration derived from the code (`export const properties` in the
 * source) is shown read-only: it is edited in the source.
 *
 * Display + intent only; the backend validates. Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { PropertyDeclaration, PropertyType } from '@thirdlight/project-model';
import {
  PROPERTY_TYPES,
  declarationOf,
  draftsOf,
  newPropertyDraft,
  retype,
  type DraftProblem,
  type PropertyDraft,
} from '../session/declaration-draft';
import type { BehaviorDeclarationView } from '../session/prefab-projection';

export interface DeclarationSave {
  mode: 'declaration-create' | 'declaration-update';
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
}

const TYPE_LABELS: Record<PropertyType, string> = {
  number: 'Number',
  boolean: 'Boolean',
  string: 'Text',
  enum: 'Choice',
  vec3: 'Vector',
  entityRef: 'Object',
  assetRef: 'Asset',
};

function Field({ label, value, onChange, placeholder, problem, width }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; problem?: string | undefined; width?: string }): JSX.Element {
  return (
    <label className="tl-decl__field" style={width !== undefined ? { flexBasis: width } : undefined}>
      <span className="tl-decl__name">{label.replace(/^property \d+ /, '')}</span>
      <input
        className={problem !== undefined ? 'tl-prop__input is-invalid' : 'tl-prop__input'}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        title={problem}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function DeclarationEditor({
  behavior,
  error,
  onSave,
}: {
  /** The behavior being edited; `null` = a new behavior. */
  behavior: BehaviorDeclarationView | null;
  error: { code: string; message: string } | null;
  onSave: (save: DeclarationSave) => Promise<boolean>;
}): JSX.Element {
  const [behaviorId, setBehaviorId] = useState('');
  const [displayName, setDisplayName] = useState(behavior?.displayName ?? '');
  const [drafts, setDrafts] = useState<PropertyDraft[]>(() => (behavior !== null ? draftsOf(behavior.declaration) : [newPropertyDraft([])]));
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [saved, setSaved] = useState(false);
  const inCode = behavior?.source?.declaredInCode === true;

  const update = (i: number, patch: Partial<PropertyDraft>): void => {
    setSaved(false);
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  };
  const move = (i: number, by: -1 | 1): void => {
    setSaved(false);
    setDrafts((ds) => {
      const j = i + by;
      if (j < 0 || j >= ds.length) return ds;
      const next = [...ds];
      [next[i], next[j]] = [next[j] as PropertyDraft, next[i] as PropertyDraft];
      return next;
    });
  };
  const at = (i: number, field: keyof PropertyDraft): string | undefined => (problem !== null && problem.index === i && problem.field === field ? problem.message : undefined);

  const save = async (): Promise<void> => {
    const parsed = declarationOf(drafts);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    const id = behavior?.behaviorId ?? behaviorId.trim();
    const ok = await onSave({
      mode: behavior === null ? 'declaration-create' : 'declaration-update',
      behaviorId: id,
      displayName: displayName.trim() === '' ? id : displayName.trim(),
      declaration: parsed.declaration,
    });
    setSaved(ok);
  };

  return (
    <div className="tl-decl" aria-label="declaration editor" data-behavior={behavior?.behaviorId ?? ''}>
      <div className="tl-panel__title">{behavior === null ? 'New behavior' : `Declaration — ${behavior.displayName}`}</div>
      {inCode && (
        <p className="tl-inspector__hint" data-declared-in-code="true">
          Declared in code: the source's <code>export const properties</code> is the declaration (edit and publish the source to change it).
        </p>
      )}
      <div className="tl-decl__row">
        {behavior === null && <Field label="behavior id" value={behaviorId} placeholder="patrol" onChange={setBehaviorId} />}
        <Field label="display name" value={displayName} placeholder="Patrol" onChange={setDisplayName} />
      </div>
      <fieldset className="tl-decl__props" disabled={inCode}>
        {drafts.map((d, i) => {
          const n = `property ${i + 1}`;
          return (
            <div className="tl-decl__prop" key={i} data-key={d.key} data-visibility={d.visibility}>
              <div className="tl-decl__row">
                <Field label={`${n} key`} value={d.key} onChange={(v) => update(i, { key: v })} problem={at(i, 'key')} />
                <Field label={`${n} label`} value={d.label} placeholder="from the key" onChange={(v) => update(i, { label: v })} problem={at(i, 'label')} />
                <label className="tl-decl__field">
                  <span className="tl-decl__name">type</span>
                  <select className="tl-prop__input" aria-label={`${n} type`} value={d.type} onChange={(e) => update(i, retype(d, e.target.value as PropertyType))}>
                    {PROPERTY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tl-decl__field" title="Public: shown in the Inspector of every object with this script and set per object. Private: not shown; the script always reads the default.">
                  <span className="tl-decl__name">visibility</span>
                  <select className="tl-prop__input" aria-label={`${n} visibility`} value={d.visibility} onChange={(e) => update(i, { visibility: e.target.value === 'private' ? 'private' : 'public' })}>
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </label>
                <span className="tl-decl__tools">
                  <button className="tl-btn tl-btn--small" title="Move up" aria-label={`${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button className="tl-btn tl-btn--small" title="Move down" aria-label={`${n} down`} disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button
                    className="tl-btn tl-btn--small"
                    title="Remove the property"
                    aria-label={`${n} remove`}
                    disabled={drafts.length <= 1}
                    onClick={() => {
                      setSaved(false);
                      setDrafts((ds) => ds.filter((_, j) => j !== i));
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <div className="tl-decl__row">
                {d.type === 'boolean' ? (
                  <label className="tl-decl__field">
                    <span className="tl-decl__name">default</span>
                    <select className="tl-prop__input" aria-label={`${n} default`} value={d.default} onChange={(e) => update(i, { default: e.target.value })}>
                      <option value="false">false</option>
                      <option value="true">true</option>
                    </select>
                  </label>
                ) : (
                  <Field
                    label={`${n} default`}
                    value={d.default}
                    placeholder={d.type === 'vec3' ? 'x, y, z' : d.type === 'entityRef' || d.type === 'assetRef' ? 'none' : ''}
                    onChange={(v) => update(i, { default: v })}
                    problem={at(i, 'default')}
                  />
                )}
                {d.type === 'number' && (
                  <>
                    <Field label={`${n} min`} value={d.min} onChange={(v) => update(i, { min: v })} problem={at(i, 'min')} width="4em" />
                    <Field label={`${n} max`} value={d.max} onChange={(v) => update(i, { max: v })} problem={at(i, 'max')} width="4em" />
                    <Field label={`${n} step`} value={d.step} onChange={(v) => update(i, { step: v })} problem={at(i, 'step')} width="4em" />
                  </>
                )}
                {d.type === 'string' && <Field label={`${n} max length`} value={d.maxLength} placeholder="256" onChange={(v) => update(i, { maxLength: v })} problem={at(i, 'maxLength')} />}
                {d.type === 'enum' && <Field label={`${n} choices`} value={d.values} placeholder="walk, run" onChange={(v) => update(i, { values: v })} problem={at(i, 'values')} />}
                {d.type === 'vec3' && (
                  <>
                    <Field label={`${n} bounds min`} value={d.boundsMin} placeholder="x, y, z" onChange={(v) => update(i, { boundsMin: v })} problem={at(i, 'boundsMin')} />
                    <Field label={`${n} bounds max`} value={d.boundsMax} placeholder="x, y, z" onChange={(v) => update(i, { boundsMax: v })} problem={at(i, 'boundsMax')} />
                  </>
                )}
              </div>
              <div className="tl-decl__row">
                <Field label={`${n} group`} value={d.group} placeholder="section" onChange={(v) => update(i, { group: v })} />
                <Field label={`${n} header`} value={d.header} placeholder="heading" onChange={(v) => update(i, { header: v })} />
                <Field label={`${n} tooltip`} value={d.tooltip} placeholder="help text" onChange={(v) => update(i, { tooltip: v })} />
              </div>
            </div>
          );
        })}
      </fieldset>
      {!inCode && (
        <div className="tl-decl__row">
          <button
            className="tl-btn tl-btn--small"
            disabled={drafts.length >= 32}
            onClick={() => {
              setSaved(false);
              setDrafts((ds) => [...ds, newPropertyDraft(ds)]);
            }}
          >
            + Add property
          </button>
          <button className="tl-btn tl-btn--small" onClick={() => void save()} title="publishBehavior (one undo step)">
            {behavior === null ? 'Create behavior' : 'Save declaration'}
          </button>
          {saved && <span className="tl-prop__caption">saved</span>}
        </div>
      )}
      {problem !== null && (
        <div className="tl-prop__error" role="alert">
          {problem.index >= 0 ? `Property ${problem.index + 1}: ` : ''}
          {problem.message}
        </div>
      )}
      {error !== null && (
        <div className="tl-prop__error" title={error.message}>
          {error.code}: {error.message}
        </div>
      )}
    </div>
  );
}
