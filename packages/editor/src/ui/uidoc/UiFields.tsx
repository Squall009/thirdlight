/**
 * The UI editor's own field controls — the `json` descriptor
 * fields of the UI vocabulary (bindings, actions, style references,
 * padding), a widget's size (a missing value sizes to the content), the font
 * picker, and the style editor shared by a document's styles, a widget's own
 * style and the theme editor (descriptor rows for the plain values, these
 * controls for the rest; hover / focus / pressed / disabled states).
 *
 * Every control reports a whole new value; the caller turns it into one
 * `setUiDocument` / `setUiTheme` (one undo step).
 *
 * Browser-only (React).
 */
import { UI_LIMITS } from '@thirdlight/project-model/limits';
import { useEffect, useState, type JSX } from 'react';
import type { FieldDescriptor, ObjectFieldDescriptor, UiAction, UiEngineAction, UiStyle } from '@thirdlight/project-model';

import { ObjectFields, type FieldContext } from '../DescriptorFields';
import { getAt, setAt, type FieldPath } from '../../session/descriptor-fields';
import { setStyleValue, uniqueName } from '../../session/ui-edit';
import { FONT_KINDS, RefPicker, TEXTURE_KINDS, useFirstEntry } from '../catalog/RefPicker';

/** A text box that commits on Enter or blur. */
export function CommitText(p: { value: string; aria: string; placeholder?: string; title?: string; wide?: boolean; onCommit: (v: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(p.value);
  useEffect(() => setDraft(p.value), [p.value]);
  return (
    <input
      className={p.wide === true ? 'tl-input tl-input--wide' : 'tl-input'}
      aria-label={p.aria}
      title={p.title}
      placeholder={p.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== p.value && p.onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(p.value);
      }}
    />
  );
}

const isBinding = (v: unknown): v is { bind: string } => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { bind?: unknown }).bind === 'string';

/** A value or a view-model binding (`{ "bind": "path" }`). */
export function BindingField(p: {
  f: FieldDescriptor;
  value: unknown;
  aria: string;
  entities: readonly { id: string; name: string }[];
  onChange: (v: unknown) => void;
}): JSX.Element {
  const vt = p.f.type === 'json' ? p.f.valueType : undefined;
  const bound = isBinding(p.value) || vt === undefined;
  const required = p.f.required === true;
  const firstTexture = useFirstEntry(TEXTURE_KINDS).first;
  const plainDefault = (): unknown => (vt === 'number' ? 0 : vt === 'bool' ? true : vt === 'texture' ? (firstTexture ?? '') : vt === 'entity' ? (p.entities[0]?.id ?? '') : '');
  return (
    <div className="tl-desc__row tl-uidoc__bind" title={p.f.tooltip} data-field={p.f.key}>
      <span className="tl-field__label">{p.f.label}</span>
      <div className="tl-desc__control">
        {vt !== undefined && (
          <label className="tl-flag" title="Read the value from the view model (scripts write it with ctx.ui.set)">
            <input type="checkbox" aria-label={`${p.aria} bound`} checked={bound} onChange={(e) => p.onChange(e.target.checked ? { bind: 'value' } : plainDefault())} />
            bind
          </label>
        )}
        {bound ? (
          <CommitText aria={`${p.aria} path`} placeholder="hud.value" value={isBinding(p.value) ? p.value.bind : ''} onCommit={(v) => (v.trim() === '' ? (required ? undefined : p.onChange(undefined)) : p.onChange({ bind: v.trim() }))} />
        ) : vt === 'number' ? (
          <CommitText aria={p.aria} value={typeof p.value === 'number' ? String(p.value) : ''} onCommit={(v) => (v.trim() === '' ? !required && p.onChange(undefined) : Number.isFinite(Number(v)) && p.onChange(Number(v)))} />
        ) : vt === 'bool' ? (
          <select className="tl-input" aria-label={p.aria} value={p.value === undefined ? '' : String(p.value)} onChange={(e) => p.onChange(e.target.value === '' ? undefined : e.target.value === 'true')}>
            <option value="">— default —</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : vt === 'texture' ? (
          <RefPicker aria={p.aria} kinds={TEXTURE_KINDS} value={typeof p.value === 'string' ? p.value : ''} none={required ? null : 'none'} onPick={(id) => p.onChange(id === '' ? undefined : id)} />
        ) : vt === 'entity' ? (
          <select className="tl-input" aria-label={p.aria} value={typeof p.value === 'string' ? p.value : ''} onChange={(e) => p.onChange(e.target.value === '' ? undefined : e.target.value)}>
            <option value="">none</option>
            {p.entities.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <CommitText aria={p.aria} value={typeof p.value === 'string' ? p.value : ''} onCommit={(v) => p.onChange(v === '' && !required ? undefined : v)} />
        )}
      </div>
    </div>
  );
}

/** Style names (1–4) from the document and its theme. */
export function StyleRefField(p: { label: string; aria: string; value: unknown; names: readonly string[]; onChange: (v: string | string[] | undefined) => void }): JSX.Element {
  const cur = p.value === undefined ? [] : Array.isArray(p.value) ? (p.value as string[]) : [p.value as string];
  const set = (list: string[]): void => p.onChange(list.length === 0 ? undefined : list.length === 1 ? list[0] : list.slice(0, 4));
  return (
    <div className="tl-desc__row" data-field="style">
      <span className="tl-field__label">{p.label}</span>
      <div className="tl-desc__control tl-uidoc__styles">
        {p.names.length === 0 && <span className="tl-hint">No styles: add one in Document → Styles or in a theme.</span>}
        {p.names.map((n) => (
          <label key={n} className="tl-flag">
            <input type="checkbox" aria-label={`${p.aria} ${n}`} checked={cur.includes(n)} disabled={!cur.includes(n) && cur.length >= 4} onChange={(e) => set(e.target.checked ? [...cur, n] : cur.filter((x) => x !== n))} />
            {n}
          </label>
        ))}
      </div>
    </div>
  );
}

/** A size axis: px, null (the content) or a view-model binding. */
type SizeAxis = number | null | { bind: string };

/**
 * A widget's size: each axis a number, empty for "fit the content", or
 *  a view-model path whose number is the px size (`hud.width`).
 */
export function SizeField(p: { value: readonly unknown[] | undefined; aria: string; disabledAxes: readonly boolean[]; onChange: (v: [SizeAxis, SizeAxis] | undefined) => void }): JSX.Element {
  const axisOf = (x: unknown): SizeAxis => (typeof x === 'number' ? x : isBinding(x) ? { bind: x.bind } : null);
  const v: [SizeAxis, SizeAxis] = [axisOf(p.value?.[0]), axisOf(p.value?.[1])];
  const commit = (i: 0 | 1, raw: string): void => {
    const next: [SizeAxis, SizeAxis] = [v[0], v[1]];
    const t = raw.trim();
    const n = Number(t);
    if (t === '') next[i] = null;
    else if (Number.isFinite(n)) next[i] = n >= 0 && n <= 16_384 ? n : v[i];
    else next[i] = /^[$A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(t) ? { bind: t } : v[i];
    p.onChange(next[0] === null && next[1] === null ? undefined : next);
  };
  const shown = (x: SizeAxis): string => (x === null ? '' : typeof x === 'number' ? String(x) : x.bind);
  return (
    <div className="tl-desc__row tl-vec" data-field="size" title="Width and height in px; empty: sized to the content; a view-model path (e.g. hud.width): the number it holds.">
      <span className="tl-field__label">Size (px)</span>
      <span className="tl-vec__nums">
        {(['w', 'h'] as const).map((l, i) => (
          <CommitText key={l} aria={`${p.aria} ${l}`} placeholder={p.disabledAxes[i] === true ? 'stretch' : 'auto'} value={shown(v[i]!)} onCommit={(raw) => commit(i as 0 | 1, raw)} />
        ))}
      </span>
    </div>
  );
}

/** Padding: one number for every side, or four (top, right, bottom, left). */
export function PaddingField(p: { value: unknown; aria: string; onChange: (v: number | number[] | undefined) => void }): JSX.Element {
  const shown = typeof p.value === 'number' ? String(p.value) : Array.isArray(p.value) ? p.value.join(', ') : '';
  return (
    <div className="tl-desc__row" data-field="padding" title="One number (every side) or top, right, bottom, left">
      <span className="tl-field__label">Padding (px)</span>
      <div className="tl-desc__control">
        <CommitText
          aria={`${p.aria} padding`}
          placeholder="8 or 4, 8, 4, 8"
          value={shown}
          onCommit={(raw) => {
            if (raw.trim() === '') return p.onChange(undefined);
            const parts = raw.split(',').map((x) => Number(x.trim()));
            if (parts.some((x) => !Number.isFinite(x) || x < 0 || x > 1024)) return;
            if (parts.length === 1) p.onChange(parts[0]!);
            else if (parts.length === 4) p.onChange(parts);
          }}
        />
      </div>
    </div>
  );
}

export const GENERIC_FONTS = ['sans', 'serif', 'mono', 'rounded'] as const;

const GENERIC_FONT_CHOICES = GENERIC_FONTS.map((f) => ({ value: f, label: f }));

export function FontField(p: { value: unknown; aria: string; onChange: (v: string | undefined) => void }): JSX.Element {
  return (
    <div className="tl-desc__row" data-field="font" title="A project font asset, or a generic family">
      <span className="tl-field__label">Font</span>
      <div className="tl-desc__control">
        <RefPicker aria={`${p.aria} font`} kinds={FONT_KINDS} value={typeof p.value === 'string' ? p.value : ''} none="— inherit —" extra={GENERIC_FONT_CHOICES} onPick={(v) => p.onChange(v === '' ? undefined : v)} />
      </div>
    </div>
  );
}

type StyleState = 'hover' | 'focus' | 'pressed' | 'disabled';
const STATES: readonly StyleState[] = ['hover', 'focus', 'pressed', 'disabled'];

/** One style's values (and a state's), from the style descriptor. */
export function StyleEditor(p: {
  desc: ObjectFieldDescriptor;
  style: UiStyle;
  /** Accessible-name prefix ("theme label", "widget css"). */
  aria: string;
  ctx: FieldContext;
  withStates: boolean;
  onChange: (next: UiStyle) => void;
  onFail: (msg: string) => void;
}): JSX.Element {
  const [state, setState] = useState<StyleState | null>(null);
  const values = (state === null ? p.style : (p.style[state] ?? {})) as Record<string, unknown>;
  const fieldDesc: ObjectFieldDescriptor = { ...p.desc, fields: p.desc.fields.filter((f) => !(f.type === 'json' && f.typedBy === 'uiStyleState')) };
  const put = (key: string, v: unknown): void => p.onChange(setStyleValue(p.style, state, key, v));
  const aria = state === null ? p.aria : `${p.aria} ${state}`;
  return (
    <div className="tl-uidoc__style" aria-label={`${p.aria} style`}>
      {p.withStates && (
        <div className="tl-uidoc__states" role="tablist" aria-label={`${p.aria} states`}>
          {[null, ...STATES].map((s) => (
            <button key={s ?? 'base'} type="button" role="tab" aria-selected={state === s} className={`tl-tab${state === s ? ' is-active' : ''}`} onClick={() => setState(s)}>
              {s ?? 'base'}
              {s !== null && p.style[s] !== undefined ? ' •' : ''}
            </button>
          ))}
        </div>
      )}
      <FontField value={values['font']} aria={aria} onChange={(v) => put('font', v)} />
      <PaddingField value={values['padding']} aria={aria} onChange={(v) => put('padding', v)} />
      <ObjectFields
        desc={fieldDesc}
        value={values}
        path={[]}
        component={aria}
        ctx={p.ctx}
        skip={['font', 'padding']}
        onEdit={(path: FieldPath, next: unknown) => {
          const key = String(path[0]);
          const cur = values[key];
          put(key, path.length === 1 ? next : setAt(cur, path.slice(1), next));
        }}
        onFail={p.onFail}
      />
    </div>
  );
}

/** A named map of styles (a document's own styles, a theme's): pick, add, rename, delete, edit. */
export function StyleMapEditor(p: {
  desc: ObjectFieldDescriptor;
  styles: Readonly<Record<string, UiStyle>>;
  aria: string;
  ctx: FieldContext;
  onChange: (next: Record<string, UiStyle>) => void;
  onFail: (msg: string) => void;
}): JSX.Element {
  const names = Object.keys(p.styles).sort();
  const [picked, setPicked] = useState<string | null>(names[0] ?? null);
  const [newName, setNewName] = useState('');
  const current = picked !== null && Object.prototype.hasOwnProperty.call(p.styles, picked) ? picked : (names[0] ?? null);
  return (
    <div className="tl-uidoc__stylemap" aria-label={`${p.aria} styles`}>
      <div className="tl-uidoc__row">
        <select className="tl-input" aria-label={`${p.aria} style`} value={current ?? ''} onChange={(e) => setPicked(e.target.value)}>
          {names.length === 0 && <option value="">no styles</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {current !== null && (
          <button
            type="button"
            className="tl-btn tl-btn--small"
            aria-label={`delete style ${current}`}
            onClick={() => {
              const { [current]: _gone, ...rest } = p.styles;
              p.onChange(rest);
              setPicked(null);
            }}
          >
            Delete
          </button>
        )}
      </div>
      <form
        className="tl-uidoc__row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim() === '') return;
          const n = uniqueName(newName.trim(), new Set(names));
          p.onChange({ ...p.styles, [n]: {} });
          setPicked(n);
          setNewName('');
        }}
      >
        <input className="tl-input" aria-label={`${p.aria} new style name`} placeholder="new style name" maxLength={32} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="tl-btn tl-btn--small" disabled={newName.trim() === '' || names.length >= UI_LIMITS.styles}>
          + Style
        </button>
      </form>
      {current !== null && (
        <StyleEditor
          key={current}
          desc={p.desc}
          style={p.styles[current]!}
          aria={`${p.aria} ${current}`}
          ctx={p.ctx}
          withStates
          onChange={(next) => p.onChange({ ...p.styles, [current]: next })}
          onFail={p.onFail}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// + open (a game shell screen) and nextScene (the shell's scene list).
const ENGINE_ACTIONS: readonly UiEngineAction[] = ['resume', 'pause', 'restartLevel', 'newGame', 'continue', 'quitToTitle', 'settings', 'load', 'save', 'back', 'setSetting', 'mute', 'unmute', 'open', 'nextScene'];
const SHELL_SCREENS = ['title', 'pause', 'settings', 'controls', 'save', 'load'] as const;
// + dialogue (advance, choose, skip, auto, backlog — a dialogue document's buttons).
const DO_KINDS = ['event', 'engine', 'show', 'hide', 'toggle', 'play', 'dialogue'] as const;
const DIALOGUE_INPUTS = ['advance', 'choose', 'skip', 'auto', 'backlog'] as const;

function newAction(kind: (typeof DO_KINDS)[number], docs: readonly string[], tweens: readonly string[]): UiAction | null {
  switch (kind) {
    case 'event':
      return { do: 'event', name: 'click' };
    case 'engine':
      return { do: 'engine', action: 'resume' };
    case 'show':
    case 'hide':
    case 'toggle':
      return docs[0] !== undefined ? { do: kind, doc: docs[0] } : null;
    case 'play':
      return tweens[0] !== undefined ? { do: 'play', tween: tweens[0] } : null;
    case 'dialogue':
      return { do: 'dialogue', input: 'advance' };
  }
}

/** A list of 1–4 actions (a click, a submit, a focus, a cancel). */
export function ActionsField(p: {
  label: string;
  aria: string;
  value: unknown;
  docs: readonly string[];
  tweens: readonly string[];
  widgets: readonly string[];
  onChange: (v: UiAction | UiAction[] | undefined) => void;
  onFail: (msg: string) => void;
}): JSX.Element {
  const list: UiAction[] = p.value === undefined ? [] : Array.isArray(p.value) ? (p.value as UiAction[]) : [p.value as UiAction];
  const put = (next: UiAction[]): void => p.onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next);
  const setAtI = (i: number, a: UiAction): void => put(list.map((x, j) => (j === i ? a : x)));
  const [adding, setAdding] = useState<(typeof DO_KINDS)[number]>('event');
  return (
    <fieldset className="tl-desc__object tl-uidoc__actions" aria-label={p.aria} data-field={p.aria}>
      <legend className="tl-desc__legend">{p.label}</legend>
      {list.map((a, i) => (
        <div key={i} className="tl-uidoc__action" data-action={a.do}>
          <span className="tl-hint">{a.do}</span>
          {a.do === 'event' && (
            <>
              <CommitText aria={`${p.aria} ${i + 1} event name`} value={a.name} onCommit={(v) => (/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(v) ? setAtI(i, { ...a, name: v }) : p.onFail('an event name is a letter or _, then letters, digits, _ or -'))} />
              <CommitText
                aria={`${p.aria} ${i + 1} event value`}
                placeholder="value (optional)"
                value={a.value === undefined ? '' : typeof a.value === 'object' && a.value !== null ? `{${(a.value as { bind: string }).bind}}` : String(a.value)}
                onCommit={(v) => {
                  const t = v.trim();
                  const { value: _v, ...rest } = a;
                  if (t === '') return setAtI(i, rest);
                  const bound = /^\{(.+)\}$/.exec(t);
                  const val = bound !== null ? { bind: bound[1]! } : t === 'true' ? true : t === 'false' ? false : Number.isFinite(Number(t)) ? Number(t) : t;
                  setAtI(i, { ...rest, value: val } as UiAction);
                }}
              />
            </>
          )}
          {a.do === 'engine' && (
            <>
              <select className="tl-input" aria-label={`${p.aria} ${i + 1} engine action`} value={a.action} onChange={(e) => setAtI(i, { do: 'engine', action: e.target.value as UiEngineAction, ...(e.target.value === 'setSetting' ? { setting: 'music', step: 1 } : {}), ...(e.target.value === 'open' ? { screen: 'settings' } : {}) })}>
                {ENGINE_ACTIONS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
              {a.action === 'open' && (
                <select className="tl-input" aria-label={`${p.aria} ${i + 1} screen`} value={a.screen ?? 'settings'} onChange={(e) => setAtI(i, { ...a, screen: e.target.value as (typeof SHELL_SCREENS)[number] })}>
                  {SHELL_SCREENS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              {(a.action === 'load' || a.action === 'save') && (
                <select className="tl-input" aria-label={`${p.aria} ${i + 1} slot`} value={a.slot ?? ''} onChange={(e) => setAtI(i, e.target.value === '' ? (({ slot: _s, ...r }) => r)(a) : { ...a, slot: e.target.value })}>
                  <option value="">default slot</option>
                  {['auto', '1', '2', '3'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              )}
              {a.action === 'setSetting' && (
                <>
                  <select className="tl-input" aria-label={`${p.aria} ${i + 1} setting`} value={a.setting ?? 'music'} onChange={(e) => setAtI(i, { ...a, setting: e.target.value as 'music' })}>
                    {['music', 'sfx', 'ui', 'quality'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <select className="tl-input" aria-label={`${p.aria} ${i + 1} step`} value={String(a.step ?? 1)} onChange={(e) => setAtI(i, { ...a, step: Number(e.target.value) })}>
                    <option value="1">+1 step</option>
                    <option value="-1">−1 step</option>
                  </select>
                </>
              )}
            </>
          )}
          {a.do === 'dialogue' && (
            <select className="tl-input" aria-label={`${p.aria} ${i + 1} dialogue input`} value={a.input} onChange={(e) => setAtI(i, { do: 'dialogue', input: e.target.value as (typeof DIALOGUE_INPUTS)[number] })}>
              {DIALOGUE_INPUTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          )}
          {(a.do === 'show' || a.do === 'hide' || a.do === 'toggle') && (
            <select className="tl-input" aria-label={`${p.aria} ${i + 1} document`} value={a.doc} onChange={(e) => setAtI(i, { ...a, doc: e.target.value })}>
              {p.docs.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {a.do === 'play' && (
            <>
              <select className="tl-input" aria-label={`${p.aria} ${i + 1} tween`} value={a.tween} onChange={(e) => setAtI(i, { ...a, tween: e.target.value })}>
                {p.tweens.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select className="tl-input" aria-label={`${p.aria} ${i + 1} widget`} value={a.widget ?? ''} onChange={(e) => setAtI(i, e.target.value === '' ? { do: 'play', tween: a.tween } : { ...a, widget: e.target.value })}>
                <option value="">the whole document</option>
                {p.widgets.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </>
          )}
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove ${p.aria} ${i + 1}`} onClick={() => put(list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      {list.length < 4 && (
        <div className="tl-uidoc__row">
          <select className="tl-input" aria-label={`${p.aria} new action`} value={adding} onChange={(e) => setAdding(e.target.value as (typeof DO_KINDS)[number])}>
            {DO_KINDS.map((k) => (
              <option key={k} value={k}>
                {k === 'event' ? 'raise an event' : k === 'engine' ? 'engine action' : k === 'play' ? 'play a tween' : `${k} a document`}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tl-btn tl-btn--small"
            aria-label={`add ${p.aria}`}
            onClick={() => {
              const a = newAction(adding, p.docs, p.tweens);
              if (a === null) p.onFail(adding === 'play' ? 'add a tween to the document first' : 'no UI document to name');
              else put([...list, a]);
            }}
          >
            + Action
          </button>
        </div>
      )}
    </fieldset>
  );
}

/** Read a nested value (object fields of the Inspector). */
export const valueAt = (v: unknown, path: FieldPath): unknown => getAt(v, path);
