/**
 * The project save schema (`content.saveSchema`) — the save
 * document's version and migrations, the slot count, the engine sections a
 * save includes, the slot picture, and the fields of the project settings
 * document the game's own settings screen writes. The panel edits a draft;
 * Apply sends one `setSaveSchema` command (Remove sends null). "Clear Play
 * save" forgets the saves Play keeps in this browser (a game control, not a
 * command; enabled while Play runs).
 */
import { useEffect, useState, type JSX } from 'react';

import type { SaveSchema, SaveSection, SettingsField } from '@thirdlight/project-model';

interface Props {
  schema: SaveSchema | null;
  error: string | null;
  onSave: (next: SaveSchema | null) => void;
  /** Forget Play's saves in this browser (null: Play is not running). */
  onClearPlaySave?: (() => void) | null;
  /** The outcome of the last "Clear Play save". */
  note?: string | null;
}

function PlaySave({ onClear, note }: { onClear: (() => void) | null | undefined; note: string | null | undefined }): JSX.Element {
  return (
    <div className="tl-saves__row">
      <button type="button" className="tl-btn" disabled={onClear === null || onClear === undefined} title={onClear === null || onClear === undefined ? 'start Play first' : undefined} onClick={() => onClear?.()}>
        Clear Play save
      </button>
      {note !== null && note !== undefined && <p className="tl-hint" role="status">{note}</p>}
    </div>
  );
}

const SECTIONS: readonly { id: SaveSection; label: string; hint: string }[] = [
  { id: 'grid', label: 'Block cells', hint: 'the block-layer cells scripts changed (ctx.grid)' },
  { id: 'materials', label: 'Material values', hint: 'material parameters scripts set (ctx.materials)' },
  { id: 'spawned', label: 'Spawned objects', hint: 'prefab copies scripts spawned (placement; their scripts start fresh)' },
  { id: 'storage', label: 'Script storage', hint: 'the values scripts keep with ctx.save' },
  // The dialogue variables and the lines seen (skip-if-seen).
  { id: 'dialogue', label: 'Dialogue', hint: 'the dialogue variables and the lines already seen' },
  { id: 'environment', label: 'Environment', hint: 'the environment preset blend scripts set (ctx.environment)' },
];
const ENGINE = ['', 'music', 'sfx', 'ui', 'quality'] as const;
const DEFAULT_SCHEMA: SaveSchema = { version: 1, slots: 3 };

function defaultFor(type: SettingsField['type'], values?: string[]): SettingsField['default'] {
  return type === 'bool' ? false : type === 'number' ? 0 : type === 'enum' ? (values?.[0] ?? 'a') : '';
}

export function SavesPanel({ schema, error, onSave, onClearPlaySave, note }: Props): JSX.Element {
  const [draft, setDraft] = useState<SaveSchema | null>(schema);
  useEffect(() => setDraft(schema), [schema]);
  if (draft === null) {
    return (
      <div className="tl-panel tl-saves" aria-label="project saves">
        <div className="tl-panel__title">Project saves</div>
        <p className="tl-tags__hint">No save schema: scripts cannot save project documents (ctx.saves). A schema declares the document version, the slots and the settings document.</p>
        <button className="tl-btn" aria-label="add save schema" onClick={() => onSave(DEFAULT_SCHEMA)}>
          Add save schema
        </button>
        {error !== null && <div className="tl-prop__error">{error}</div>}
        <PlaySave onClear={onClearPlaySave} note={note} />
      </div>
    );
  }
  const set = (patch: Partial<SaveSchema>): void => setDraft({ ...draft, ...patch });
  const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));
  const sections = draft.sections ?? [];
  const migrations = draft.migrations ?? [];
  const fields = draft.settings ?? [];
  const setField = (i: number, patch: Partial<SettingsField>): void => {
    const next = fields.map((f, k) => (k === i ? { ...f, ...patch } : f));
    set({ settings: next });
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(schema);
  return (
    <div className="tl-panel tl-saves" aria-label="project saves">
      <div className="tl-panel__title">Project saves</div>
      <p className="tl-tags__hint">
        Scripts write the document with <code>ctx.saves.write</code> and save, load, list and delete slots; saves live in the player&apos;s browser (up to 1 MiB per slot).
      </p>
      <div className="tl-saves__row">
        <label>
          Version <input aria-label="save version" type="number" min={1} value={draft.version} onChange={(e) => set({ version: num(e.target.value) })} />
        </label>
        <label>
          Slots <input aria-label="save slots" type="number" min={1} max={99} value={draft.slots} onChange={(e) => set({ slots: num(e.target.value) })} />
        </label>
      </div>
      <fieldset className="tl-saves__sections">
        <legend>Included in every save</legend>
        {SECTIONS.map((s) => (
          <label key={s.id} title={s.hint}>
            <input
              type="checkbox"
              aria-label={`save section ${s.id}`}
              checked={sections.includes(s.id)}
              onChange={(e) => set({ sections: e.target.checked ? [...sections, s.id] : sections.filter((x) => x !== s.id) })}
            />{' '}
            {s.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Migrations (a script registers each with ctx.saves.migration(name, fn))</legend>
        {migrations.map((m, i) => (
          <div key={i} className="tl-saves__row" data-migration={m.from}>
            <label>
              from v<input aria-label={`migration ${i} from`} type="number" min={1} value={m.from} onChange={(e) => set({ migrations: migrations.map((x, k) => (k === i ? { ...x, from: num(e.target.value) } : x)) })} />
            </label>
            <label>
              name <input aria-label={`migration ${i} name`} value={m.name} onChange={(e) => set({ migrations: migrations.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
            </label>
            <button className="tl-btn" aria-label={`remove migration ${i}`} onClick={() => set({ migrations: migrations.filter((_, k) => k !== i) })}>
              remove
            </button>
          </div>
        ))}
        <button className="tl-btn" aria-label="add migration" onClick={() => set({ migrations: [...migrations, { from: Math.max(1, draft.version - 1), name: `v${Math.max(1, draft.version - 1)}to${Math.max(2, draft.version)}` }] })}>
          add migration
        </button>
      </fieldset>
      <fieldset>
        <legend>Slot picture</legend>
        <label>
          <input
            type="checkbox"
            aria-label="custom thumbnail size"
            checked={draft.thumbnail !== undefined}
            onChange={(e) => {
              if (e.target.checked) set({ thumbnail: { width: 256, height: 144, format: 'jpeg' } });
              else {
                const { thumbnail: _t, ...rest } = draft;
                setDraft(rest);
              }
            }}
          />{' '}
          custom (default 256 × 144 JPEG)
        </label>
        {draft.thumbnail !== undefined && (
          <div className="tl-saves__row">
            <input aria-label="thumbnail width" type="number" min={16} max={512} value={draft.thumbnail.width} onChange={(e) => set({ thumbnail: { ...draft.thumbnail!, width: num(e.target.value) } })} />
            ×
            <input aria-label="thumbnail height" type="number" min={16} max={512} value={draft.thumbnail.height} onChange={(e) => set({ thumbnail: { ...draft.thumbnail!, height: num(e.target.value) } })} />
            <select aria-label="thumbnail format" value={draft.thumbnail.format} onChange={(e) => set({ thumbnail: { ...draft.thumbnail!, format: e.target.value as 'jpeg' | 'webp' } })}>
              <option value="jpeg">JPEG</option>
              <option value="webp">WebP</option>
            </select>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>Settings document (the game&apos;s settings screen writes it: ctx.saves.setSetting)</legend>
        {fields.map((f, i) => (
          <div key={i} className="tl-saves__row" data-setting={f.key}>
            <input aria-label={`setting ${i} key`} value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
            <select
              aria-label={`setting ${i} type`}
              value={f.type}
              onChange={(e) => {
                const type = e.target.value as SettingsField['type'];
                const values = type === 'enum' ? (f.values ?? ['a']) : undefined;
                const { values: _v, min: _mi, max: _ma, ...rest } = f;
                const next: SettingsField = { ...rest, type, default: defaultFor(type, values), ...(values !== undefined ? { values } : {}) };
                set({ settings: fields.map((x, k) => (k === i ? next : x)) });
              }}
            >
              <option value="bool">bool</option>
              <option value="number">number</option>
              <option value="string">string</option>
              <option value="enum">enum</option>
            </select>
            {f.type === 'bool' ? (
              <input type="checkbox" aria-label={`setting ${i} default`} checked={f.default === true} onChange={(e) => setField(i, { default: e.target.checked })} />
            ) : f.type === 'enum' ? (
              <>
                <input aria-label={`setting ${i} choices`} value={(f.values ?? []).join(', ')} onChange={(e) => setField(i, { values: e.target.value.split(',').map((x) => x.trim()).filter((x) => x.length > 0) })} />
                <input aria-label={`setting ${i} default`} value={String(f.default)} onChange={(e) => setField(i, { default: e.target.value })} />
              </>
            ) : (
              <input aria-label={`setting ${i} default`} value={String(f.default)} onChange={(e) => setField(i, { default: f.type === 'number' ? num(e.target.value) : e.target.value })} />
            )}
            <select
              aria-label={`setting ${i} engine`}
              value={f.engine ?? ''}
              onChange={(e) => {
                const { engine: _e, ...rest } = f;
                const v = e.target.value;
                set({ settings: fields.map((x, k) => (k === i ? (v === '' ? rest : { ...rest, engine: v as NonNullable<SettingsField['engine']> }) : x)) });
              }}
            >
              {ENGINE.map((e) => (
                <option key={e} value={e}>
                  {e === '' ? 'no engine setting' : `drives ${e}`}
                </option>
              ))}
            </select>
            <button className="tl-btn" aria-label={`remove setting ${i}`} onClick={() => set({ settings: fields.filter((_, k) => k !== i) })}>
              remove
            </button>
          </div>
        ))}
        <button className="tl-btn" aria-label="add setting" onClick={() => set({ settings: [...fields, { key: `setting${fields.length + 1}`, type: 'bool', default: false }] })}>
          add setting
        </button>
      </fieldset>
      <div className="tl-saves__row">
        <button className="tl-btn" aria-label="apply save schema" disabled={!dirty} onClick={() => onSave(draft)}>
          Apply
        </button>
        <button className="tl-btn" aria-label="revert save schema" disabled={!dirty} onClick={() => setDraft(schema)}>
          Revert
        </button>
        <button className="tl-btn" aria-label="remove save schema" onClick={() => onSave(null)}>
          Remove schema
        </button>
      </div>
      {error !== null && <div className="tl-prop__error">{error}</div>}
      <PlaySave onClear={onClearPlaySave} note={note} />
    </div>
  );
}
