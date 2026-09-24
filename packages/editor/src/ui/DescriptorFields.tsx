/**
 * Phase 15.1: the generic Inspector widgets. A component section (or a
 * content block form) is built from its descriptor: one widget per field
 * type, grouped, with the descriptor's tooltip on every row and its unit in
 * the label. Every edit is reported as (path, next value | undefined to
 * remove) and turned into one command by the caller (`componentPatch` → one
 * `setComponent`/`setTransform`/`setGameConfig`, one undo step).
 *
 * The accessible name of a field is its component and path
 * (`fieldAria`: "trigger radius", "mover waypoints 1 x", "position x").
 *
 * Browser-only (React).
 */
import { useEffect, useId, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import * as THREE from 'three';
import type { ComponentDescriptor, FieldDescriptor, ObjectFieldDescriptor } from '@thirdlight/project-model';
import {
  entityChoices,
  fieldAria,
  fieldLabel,
  formatNumber,
  getAt,
  groupFields,
  checkNumber,
  parseNumberInput,
  pickedValue,
  setAt,
  sliderRange,
  startValue,
  visibleFields,
  widgetFor,
  type AddEntry,
  type FieldPath,
  type Level,
  type PickerData,
} from '../session/descriptor-fields';

/** What the pickers offer (assets, objects, scenes, named project items, known signals). */
export interface FieldContext extends PickerData {
  /** Signal names already in use (suggestions). */
  readonly signals: readonly string[];
}

export type Edit = (path: FieldPath, next: unknown) => void;
type Fail = (message: string) => void;

interface RowProps {
  f: FieldDescriptor;
  /** The stored value (undefined: absent). */
  value: unknown;
  /** The object level the field sits in (conditions, `../` lookups). */
  level: Level | undefined;
  path: FieldPath;
  component: string;
  ctx: FieldContext;
  onEdit: Edit;
  onFail: Fail;
  /** Top-level optional objects shown with their defaults while absent (e.g. the player's capsule). */
  expandAbsent?: readonly string[];
  /** A label instead of the descriptor's (list items: their position). */
  label?: string;
}

/** A text box that commits on Enter or blur when it changed, reverts on Escape. */
function CommitInput(p: { value: string; aria: string; title?: string; className?: string; placeholder?: string; list?: string; multiline?: boolean; onCommit: (raw: string) => void }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null && draft !== p.value) p.onCommit(draft);
    setDraft(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !(p.multiline === true && e.shiftKey)) e.currentTarget.blur();
    if (e.key === 'Escape') {
      setDraft(null);
      const t = e.currentTarget;
      requestAnimationFrame(() => t.blur());
    }
  };
  const common = {
    className: p.className ?? 'tl-input',
    'aria-label': p.aria,
    title: p.title,
    value: draft ?? p.value,
    placeholder: p.placeholder,
    onFocus: () => setDraft(p.value),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: onKey,
  };
  return p.multiline === true ? <textarea {...common} rows={3} /> : <input {...common} {...(p.list !== undefined ? { list: p.list } : {})} />;
}

const DEG = 180 / Math.PI;
const eulerOf = (q: readonly number[]): number[] => {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1), 'XYZ');
  return [e.x * DEG, e.y * DEG, e.z * DEG];
};
const quatOf = (d: readonly number[]): number[] => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((d[0] ?? 0) / DEG, (d[1] ?? 0) / DEG, (d[2] ?? 0) / DEG, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
};

function Row(p: { f: FieldDescriptor; label?: string; isDefault: boolean; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`tl-desc__row${p.isDefault ? ' is-default' : ''}${p.className !== undefined ? ` ${p.className}` : ''}`} title={p.f.tooltip} data-field={p.f.key}>
      <span className="tl-field__label">{p.label ?? fieldLabel(p.f)}</span>
      <div className="tl-desc__control">{p.children}</div>
    </div>
  );
}

/** A number (or int) with its text box and, when both ends are bounded, a slider (commits on release). */
function NumberWidget(p: RowProps & { shown: number | undefined; aria: string }): JSX.Element {
  const range = sliderRange(p.f);
  const [slide, setSlide] = useState<number | null>(null);
  useEffect(() => setSlide(null), [p.shown]);
  const commitSlide = (): void => {
    if (slide === null || slide === p.shown) return;
    const r = checkNumber(p.f, slide);
    if (!r.ok) p.onFail(r.message);
    else p.onEdit(p.path, r.value);
  };
  return (
    <span className="tl-param__number">
      <CommitInput
        className="tl-input tl-input--num"
        aria={p.aria}
        title={p.f.tooltip}
        value={p.shown === undefined ? '' : formatNumber(p.shown)}
        onCommit={(raw) => {
          const r = parseNumberInput(p.f, raw);
          if (!r.ok) return p.onFail(r.message);
          if (r.value === undefined && p.f.required === true) return p.onFail(`${p.f.label}: a value is needed`);
          p.onEdit(p.path, r.value);
        }}
      />
      {range !== null && (
        <input
          type="range"
          aria-label={`${p.aria} slider`}
          min={range.min}
          max={range.max}
          step={range.step}
          value={slide ?? p.shown ?? range.min}
          onChange={(e) => setSlide(Number(e.target.value))}
          onPointerUp={commitSlide}
          onKeyUp={commitSlide}
        />
      )}
    </span>
  );
}

function VectorWidget(p: RowProps & { shown: readonly number[]; aria: string; labels: readonly string[]; euler?: boolean }): JSX.Element {
  const f = p.f as { min?: number; max?: number; label: string };
  return (
    <span className="tl-vec__nums">
      {p.labels.map((l, i) => (
        <CommitInput
          key={i}
          className="tl-vec__num"
          aria={`${p.aria} ${l}`}
          title={`${p.f.label} ${l}`}
          value={p.shown[i] === undefined ? '' : formatNumber(p.shown[i]!)}
          onCommit={(raw) => {
            const n = Number(raw);
            if (raw.trim() === '' || !Number.isFinite(n)) return p.onFail(`${p.f.label} ${l}: a number`);
            if (p.euler !== true && ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max))) return p.onFail(`${p.f.label} ${l}: ${f.min ?? '…'} to ${f.max ?? '…'}`);
            const next = [...p.shown];
            next[i] = n;
            p.onEdit(p.path, p.euler === true ? quatOf(next) : next);
          }}
        />
      ))}
    </span>
  );
}

function ColorWidget(p: { aria: string; value: string; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(p.value);
  useEffect(() => setDraft(p.value), [p.value]);
  return <input type="color" aria-label={p.aria} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.toLowerCase() !== p.value.toLowerCase() && p.onCommit(draft)} />;
}

function SelectWidget(p: { aria: string; value: string; options: readonly { value: string; label: string }[]; none: string | null; onPick: (v: string) => void }): JSX.Element {
  const known = p.value === '' || p.options.some((o) => o.value === p.value);
  return (
    <select className="tl-input" aria-label={p.aria} value={p.value} onChange={(e) => p.onPick(e.target.value)}>
      {(p.none !== null || p.value === '') && <option value="">{p.none ?? '— choose —'}</option>}
      {!known && <option value={p.value}>{p.value}</option>}
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** One field: its widget, by type. */
export function FieldRow(p: RowProps): JSX.Element | null {
  const { f } = p;
  const aria = fieldAria(p.component, p.path);
  const stored = p.value;
  const shown = stored !== undefined ? stored : f.default;
  const isDefault = stored === undefined;
  const optional = f.required !== true;
  const kind = widgetFor(f);
  const listId = useId();
  const clear = (): void => p.onEdit(p.path, f.nullable === true && !optional ? null : undefined);
  switch (kind) {
    case 'number':
    case 'int':
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <NumberWidget {...p} aria={aria} shown={typeof shown === 'number' ? shown : undefined} />
        </Row>
      );
    case 'bool':
      return (
        <label className={`tl-flag tl-desc__row${isDefault ? ' is-default' : ''}`} title={f.tooltip} data-field={f.key}>
          <input type="checkbox" aria-label={aria} checked={shown === true} onChange={(e) => p.onEdit(p.path, e.target.checked)} />
          <span>{p.label ?? fieldLabel(f)}</span>
        </label>
      );
    case 'enum': {
      const options = f.type === 'enum' ? f.options : [];
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <SelectWidget aria={aria} value={typeof shown === 'string' ? shown : ''} options={options} none={optional && f.default === undefined ? '—' : null} onPick={(v) => (v === '' ? clear() : p.onEdit(p.path, v))} />
        </Row>
      );
    }
    case 'vector': {
      const labels = f.type === 'vec2' || f.type === 'vec3' ? f.labels : [];
      const arr = Array.isArray(shown) ? (shown as number[]) : labels.map(() => 0);
      return (
        <Row f={f} label={p.label} isDefault={isDefault} className="tl-vec">
          <VectorWidget {...p} aria={aria} shown={arr} labels={labels} />
        </Row>
      );
    }
    case 'euler': {
      const q = Array.isArray(shown) ? (shown as number[]) : [0, 0, 0, 1];
      return (
        <Row f={f} label={`${p.label ?? f.label} (deg)`} isDefault={isDefault} className="tl-vec">
          <VectorWidget {...p} aria={aria} shown={eulerOf(q)} labels={['x', 'y', 'z']} euler />
        </Row>
      );
    }
    case 'color':
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <ColorWidget aria={aria} value={typeof shown === 'string' ? shown : '#ffffff'} onCommit={(v) => p.onEdit(p.path, v)} />
        </Row>
      );
    case 'asset': {
      const kinds = f.type === 'assetRef' ? f.kinds : [];
      const options = p.ctx.assets.filter((a) => kinds.includes(a.kind as never)).map((a) => ({ value: a.assetId, label: `${a.displayName}${kinds.length > 1 ? ` (${a.kind})` : ''}` }));
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <SelectWidget aria={aria} value={typeof shown === 'string' ? shown : ''} options={options} none={optional || f.nullable === true ? 'none' : null} onPick={(v) => (v === '' ? clear() : p.onEdit(p.path, v))} />
        </Row>
      );
    }
    case 'entity': {
      const sceneName = (id: string | undefined): string => p.ctx.scenes.find((s) => s.sceneId === id)?.name ?? '';
      const anyScene = f.type === 'entityRef' && f.anyScene === true;
      const options = entityChoices(f, p.ctx.entities, p.ctx.sceneId).map((e) => ({ value: e.id, label: anyScene && e.sceneId !== undefined ? `${e.name} (${sceneName(e.sceneId)})` : e.name }));
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <SelectWidget aria={aria} value={typeof shown === 'string' ? shown : ''} options={options} none={optional || f.nullable === true ? 'none' : null} onPick={(v) => (v === '' ? clear() : p.onEdit(p.path, v))} />
        </Row>
      );
    }
    case 'scene':
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <SelectWidget aria={aria} value={typeof shown === 'string' ? shown : ''} options={p.ctx.scenes.map((s) => ({ value: s.sceneId, label: s.name }))} none={optional ? 'none' : null} onPick={(v) => (v === '' ? clear() : p.onEdit(p.path, v))} />
        </Row>
      );
    case 'ref': {
      const target = f.type === 'ref' ? f.target : 'material';
      const list = p.ctx.refs[target as 'material'];
      if (list === undefined) {
        return (
          <Row f={f} label={p.label} isDefault={isDefault}>
            <CommitInput aria={aria} title={f.tooltip} value={typeof shown === 'string' ? shown : ''} onCommit={(raw) => (raw.trim() === '' ? clear() : p.onEdit(p.path, raw.trim()))} />
          </Row>
        );
      }
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <SelectWidget aria={aria} value={typeof shown === 'string' ? shown : ''} options={list.map((r) => ({ value: r.id, label: r.name }))} none={optional ? 'none' : null} onPick={(v) => (v === '' ? clear() : p.onEdit(p.path, v))} />
        </Row>
      );
    }
    case 'signal':
    case 'text':
    case 'multiline':
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <CommitInput
            aria={aria}
            title={f.tooltip}
            multiline={kind === 'multiline'}
            value={typeof shown === 'string' ? shown : ''}
            {...(kind === 'signal' ? { list: listId } : {})}
            onCommit={(raw) => {
              const t = kind === 'multiline' ? raw : raw.trim();
              if (t === '') return optional ? clear() : p.onFail(`${f.label}: a value is needed`);
              p.onEdit(p.path, t);
            }}
          />
          {kind === 'signal' && (
            <datalist id={listId}>
              {p.ctx.signals.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </Row>
      );
    case 'object':
      return <ObjectWidget {...p} aria={aria} />;
    case 'list':
      return <ListWidget {...p} aria={aria} />;
    case 'map':
      return <MapWidget {...p} aria={aria} />;
    case 'readonly':
      return (
        <Row f={f} label={p.label} isDefault={isDefault}>
          <span className="tl-desc__readonly" aria-label={aria}>
            {shown === undefined ? '—' : typeof shown === 'string' || typeof shown === 'number' || typeof shown === 'boolean' ? String(shown) : JSON.stringify(shown).slice(0, 240)}
          </span>
        </Row>
      );
  }
}

function ObjectWidget(p: RowProps & { aria: string }): JSX.Element {
  const f = p.f as ObjectFieldDescriptor;
  const present = p.value !== undefined && p.value !== null;
  const optional = f.required !== true;
  const expanded = present || p.expandAbsent?.includes(f.key) === true || !optional;
  return (
    <fieldset className={`tl-desc__object${present ? '' : ' is-default'}`} aria-label={p.aria} title={f.tooltip} data-field={f.key}>
      <legend className="tl-desc__legend">
        {p.label ?? f.label}
        {optional && present && (
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${p.aria}`} title={`Remove ${f.label.toLowerCase()} (back to the engine default)`} onClick={() => p.onEdit(p.path, undefined)}>
            ×
          </button>
        )}
      </legend>
      {expanded ? (
        <ObjectFields desc={f} value={present ? (p.value as Record<string, unknown>) : {}} parent={p.level} path={p.path} component={p.component} ctx={p.ctx} onEdit={p.onEdit} onFail={p.onFail} />
      ) : (
        <div className="tl-desc__absent">
          <span className="tl-inspector__hint">none</span>
          <button type="button" className="tl-btn tl-btn--small" aria-label={`add ${p.aria}`} onClick={() => p.onEdit(p.path, startValue(f, p.level))}>
            + add
          </button>
        </div>
      )}
      {f.rules !== undefined && expanded && <p className="tl-inspector__hint">{f.rules.join(' ')}</p>}
    </fieldset>
  );
}

function ListWidget(p: RowProps & { aria: string }): JSX.Element {
  const f = p.f;
  if (f.type !== 'list') return <></>;
  const items = Array.isArray(p.value) ? (p.value as unknown[]) : Array.isArray(f.default) ? (f.default as unknown[]) : [];
  const max = f.length ?? f.maxItems ?? Infinity;
  const min = f.length ?? f.minItems ?? 0;
  const fresh = (): unknown => startValue(f.item) ?? (items.length > 0 ? JSON.parse(JSON.stringify(items[items.length - 1])) : undefined);
  return (
    <div className="tl-desc__list" aria-label={p.aria} title={f.tooltip} data-field={f.key}>
      <div className="tl-field__label">
        {fieldLabel(f)} ({items.length})
      </div>
      {items.map((x, i) => (
        <div className="tl-desc__item" key={i}>
          {/* An item edit replaces the whole list (a list shown from its default is then stored). */}
          <FieldRow {...p} f={f.item} value={x} path={[...p.path, i]} label={String(i + 1)} onEdit={(at, next) => p.onEdit(p.path, setAt(items, at.slice(p.path.length), next))} />
          {items.length > min && (
            <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${p.aria} ${i + 1}`} onClick={() => p.onEdit(p.path, items.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      {items.length < max && fresh() !== undefined && (
        <button type="button" className="tl-btn tl-btn--small" aria-label={`add ${p.aria}`} onClick={() => p.onEdit(p.path, [...items, fresh()])}>
          + add
        </button>
      )}
    </div>
  );
}

function MapWidget(p: RowProps & { aria: string }): JSX.Element {
  const f = p.f;
  const [key, setKey] = useState('');
  if (f.type !== 'map') return <></>;
  const entries = p.value !== null && typeof p.value === 'object' ? Object.entries(p.value as Record<string, unknown>) : [];
  const editable = widgetFor(f.value) !== 'readonly';
  return (
    <div className="tl-desc__list" aria-label={p.aria} title={f.tooltip} data-field={f.key}>
      <div className="tl-field__label">{fieldLabel(f)}</div>
      {entries.length === 0 && <span className="tl-inspector__hint">none</span>}
      {entries.map(([k, v]) => (
        <div className="tl-desc__item" key={k}>
          <FieldRow {...p} f={f.value} value={v} path={[...p.path, k]} label={k} />
          {editable && (
            <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${p.aria} ${k}`} onClick={() => p.onEdit([...p.path, k], undefined)}>
              ×
            </button>
          )}
        </div>
      ))}
      {editable && (
        <div className="tl-desc__item">
          <input className="tl-input" aria-label={`new ${p.aria} ${f.keyLabel.toLowerCase()}`} placeholder={f.keyLabel} value={key} onChange={(e) => setKey(e.target.value)} />
          <button
            type="button"
            className="tl-btn tl-btn--small"
            aria-label={`add ${p.aria}`}
            disabled={key.trim() === ''}
            onClick={() => {
              const v = startValue(f.value);
              if (v === undefined) return p.onFail(`${f.label}: pick a value after adding`);
              p.onEdit([...p.path, key.trim()], v);
              setKey('');
            }}
          >
            + add
          </button>
        </div>
      )}
    </div>
  );
}

/** An object's applicable fields, grouped (fields without a group first). */
export function ObjectFields(p: {
  desc: ObjectFieldDescriptor;
  value: Record<string, unknown>;
  parent?: Level | undefined;
  path: FieldPath;
  component: string;
  ctx: FieldContext;
  onEdit: Edit;
  onFail: Fail;
  expandAbsent?: readonly string[];
  /** Keys shown elsewhere (a custom widget). */
  skip?: readonly string[];
}): JSX.Element {
  const level: Level = { desc: p.desc, value: p.value, ...(p.parent !== undefined ? { parent: p.parent } : {}) };
  const fields = visibleFields(level).filter((f) => !(p.skip ?? []).includes(f.key));
  return (
    <>
      {groupFields(fields).map((g) => (
        <div className="tl-desc__group" key={g.group ?? ''} {...(g.group !== null ? { 'aria-label': `${fieldAria(p.component, p.path)} ${g.group}`.trim() } : {})}>
          {g.group !== null && <div className="tl-desc__group-title">{g.group}</div>}
          {g.fields.map((f) => (
            <FieldRow
              key={f.key}
              f={f}
              value={p.value[f.key]}
              level={level}
              path={[...p.path, f.key]}
              component={p.component}
              ctx={p.ctx}
              onEdit={p.onEdit}
              onFail={p.onFail}
              {...(p.expandAbsent !== undefined ? { expandAbsent: p.expandAbsent } : {})}
            />
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * One component's section: its title and tooltip, its fields, its custom
 * extension (descriptor-keyed: the capsule's "Fit to model", an exit's
 * editor…), a remove button and its own input errors.
 */
export function ComponentSection(p: {
  desc: ComponentDescriptor;
  value: Record<string, unknown>;
  ctx: FieldContext;
  onEdit: Edit;
  /** Remove the component (absent: not removable). */
  onRemove?: () => void;
  readOnly?: boolean;
  expandAbsent?: readonly string[];
  skip?: readonly string[];
  /** Replaces the generic fields. */
  body?: ReactNode;
  /** Shown after the fields. */
  extension?: ReactNode;
  /** Extra attributes on the section (tests, styling). */
  data?: Record<string, string>;
  className?: string;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const valueKey = JSON.stringify(p.value);
  useEffect(() => setError(null), [valueKey]);
  const desc = p.desc.value;
  return (
    <div className={`tl-inspector__section tl-desc__section${p.className !== undefined ? ` ${p.className}` : ''}`} aria-label={`${p.desc.name} component`} data-component={p.desc.name} {...Object.fromEntries(Object.entries(p.data ?? {}).map(([k, v]) => [`data-${k}`, v]))}>
      <div className="tl-desc__head" title={p.desc.tooltip}>
        <span className="tl-panel__title">{p.desc.label}</span>
        {p.onRemove !== undefined && (
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${p.desc.name}`} title={`Remove ${p.desc.label}`} onClick={p.onRemove}>
            remove
          </button>
        )}
      </div>
      {p.body ??
        (desc.type === 'object' ? (
          <ObjectFields
            desc={desc}
            value={p.value}
            path={[]}
            component={p.desc.name}
            ctx={p.ctx}
            onEdit={p.readOnly === true ? () => undefined : (path, next) => { setError(null); p.onEdit(path, next); }}
            onFail={setError}
            {...(p.expandAbsent !== undefined ? { expandAbsent: p.expandAbsent } : {})}
            {...(p.skip !== undefined ? { skip: p.skip } : {})}
          />
        ) : (
          <FieldRow f={desc} value={p.value} level={undefined} path={[]} component={p.desc.name} ctx={p.ctx} onEdit={(path, next) => { setError(null); p.onEdit(path, next); }} onFail={setError} />
        ))}
      {p.extension}
      {desc.type === 'object' && desc.fields.length === 0 && p.body === undefined && <p className="tl-inspector__hint">{desc.tooltip}</p>}
      {p.desc.rules !== undefined && <p className="tl-inspector__hint">{p.desc.rules.join(' ')}</p>}
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * "+ Add component": every component by category, with its presets; those
 * that cannot be added are listed disabled with the reason. A component
 * whose add needs a choice (a model's asset, a script, a controller…) opens
 * a small form with those fields first.
 */
export function AddComponent(p: {
  entries: readonly AddEntry[];
  components: readonly ComponentDescriptor[];
  ctx: FieldContext;
  onAdd: (component: string, value: Record<string, unknown>) => void;
}): JSX.Element {
  const [picking, setPicking] = useState<{ component: string; draft: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const categories = [...new Set(p.entries.map((e) => e.category))];
  const desc = picking !== null ? p.components.find((c) => c.name === picking.component) : undefined;
  return (
    <div className="tl-inspector__section tl-desc__add">
      <select
        className="tl-input"
        aria-label="add component"
        value=""
        onChange={(e) => {
          const entry = p.entries.find((x) => x.id === e.target.value);
          if (entry === undefined || !entry.enabled) return;
          setError(null);
          const value = (entry.value ?? {}) as Record<string, unknown>;
          if (entry.pick.length > 0) setPicking({ component: entry.component, draft: JSON.parse(JSON.stringify(value)) as Record<string, unknown> });
          else {
            setPicking(null);
            p.onAdd(entry.component, value);
          }
        }}
      >
        <option value="">+ Add component…</option>
        {categories.map((cat) => (
          <optgroup key={cat} label={cat}>
            {p.entries
              .filter((e) => e.category === cat)
              .map((e) => (
                <option key={e.id} value={e.id} disabled={!e.enabled} title={e.reason ?? undefined}>
                  {e.enabled ? e.label : `${e.label} — ${e.reason}`}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {picking !== null && desc !== undefined && (
        <div className="tl-desc__pick" aria-label={`add ${desc.name}`}>
          <div className="tl-field__label">{desc.label}: choose {desc.add.kind === 'pick' ? desc.add.pick.map((x) => x.split('/').pop()).join(', ') : ''}</div>
          {(desc.add.kind === 'pick' ? desc.add.pick : []).map((pick) => {
            const path = pick.split('/');
            const f = pickField(desc.value, path);
            if (f === null) return null;
            return (
              <FieldRow
                key={pick}
                f={{ ...f, required: true } as FieldDescriptor}
                value={getAt(picking.draft, path)}
                level={undefined}
                path={path}
                component={desc.name}
                ctx={p.ctx}
                onEdit={(at, next) => setPicking({ component: desc.name, draft: setAt(picking.draft, at, next) as Record<string, unknown> })}
                onFail={setError}
              />
            );
          })}
          <div className="tl-inspector__modes">
            <button
              type="button"
              className="tl-btn"
              onClick={() => {
                const r = pickedValue(desc, picking.draft);
                if (!r.ok) return setError(`choose ${r.missing.join(', ')} first`);
                setPicking(null);
                p.onAdd(desc.name, r.value);
              }}
            >
              Add
            </button>
            <button type="button" className="tl-btn" onClick={() => setPicking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error !== null && (
        <div className="tl-prop__error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** The field a pick path names (object keys, `*` for a map value). */
function pickField(root: FieldDescriptor, path: readonly string[]): FieldDescriptor | null {
  let f: FieldDescriptor | undefined = root;
  for (const p of path) {
    if (f === undefined) return null;
    if (f.type === 'object') f = f.fields.find((x: FieldDescriptor) => x.key === p);
    else if (f.type === 'map') f = f.value;
    else return null;
  }
  return f ?? null;
}
