/**
 * Phase 23.16: the Dialogue window (bottom dock) — the project's
 * conversations (create, rename, delete, open the "Dialogue: <name>" tab),
 * the speaker registry (name, name-plate colour, portraits per expression,
 * default expression, voice profile, text blip) and the dialogue settings
 * (text speed, auto-advance and its delay, the music/SFX duck under a voice,
 * the backlog length, the UI document and theme). Every change is one
 * command (setDialogue, deleteDialogue, setSpeaker, deleteSpeaker,
 * setDialogueSettings), the same MCP sends.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { DialogueDocument, DialogueSettings, DialogueSpeaker, UiDocument, UiTheme } from '@thirdlight/project-model';

interface AssetOption {
  assetId: string;
  displayName: string;
  kind: string;
}

export interface DialoguePanelProps {
  dialogues: readonly DialogueDocument[];
  speakers: readonly DialogueSpeaker[];
  settings: DialogueSettings | null;
  uiDocuments: readonly UiDocument[];
  uiThemes: readonly UiTheme[];
  assets: readonly AssetOption[];
  openId: string | null;
  error: string | null;
  onOpen: (dialogueId: string) => void;
  onCreate: (name: string) => void;
  onRename: (dialogueId: string, name: string) => void;
  onDelete: (dialogueId: string) => void;
  onSaveSpeaker: (speaker: DialogueSpeaker) => void;
  onDeleteSpeaker: (speakerId: string) => void;
  onSaveSettings: (settings: DialogueSettings | null) => void;
}

/** A lower-case id from a name, unique among `taken`. */
export function dialogueIdFrom(name: string, taken: readonly string[], fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 56) || fallback;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function DialoguePanel(p: DialoguePanelProps): JSX.Element {
  const [name, setName] = useState('');
  const [section, setSection] = useState<'dialogues' | 'speakers' | 'settings'>('dialogues');
  return (
    <div className="tl-panel tl-dialogue-panel">
      <div className="tl-panel__title">Dialogue</div>
      <div className="tl-tabs" role="tablist" aria-label="dialogue sections">
        {(['dialogues', 'speakers', 'settings'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={section === s} className={`tl-tab${section === s ? ' is-active' : ''}`} onClick={() => setSection(s)}>
            {s === 'dialogues' ? 'Conversations' : s === 'speakers' ? 'Speakers' : 'Settings'}
          </button>
        ))}
      </div>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      {section === 'dialogues' && (
        <>
          <form
            className="tl-graphs__new"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() === '') return;
              p.onCreate(name.trim());
              setName('');
            }}
          >
            <input className="tl-input" aria-label="New dialogue name" placeholder="New conversation name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === ''}>
              Create dialogue
            </button>
          </form>
          <p className="tl-hint">A conversation is a node graph: lines (speaker, expression, text, voice clip), choices, conditions and effects on dialogue variables, signals, jumps. Scripts start one with ctx.dialogue.start(id).</p>
          {p.dialogues.length === 0 ? (
            <div className="tl-inspector__empty">No conversations yet.</div>
          ) : (
            <ul className="tl-effects__list" aria-label="Dialogue list">
              {p.dialogues.map((d) => (
                <DialogueRow key={d.dialogueId} d={d} active={p.openId === d.dialogueId} onOpen={p.onOpen} onRename={p.onRename} onDelete={p.onDelete} />
              ))}
            </ul>
          )}
        </>
      )}
      {section === 'speakers' && <SpeakersEditor {...p} />}
      {section === 'settings' && <SettingsEditor {...p} />}
    </div>
  );
}

function DialogueRow({ d, active, onOpen, onRename, onDelete }: { d: DialogueDocument; active: boolean; onOpen: (id: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void }): JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null);
  const lines = d.graph.nodes.filter((n) => n.type === 'line').length;
  return (
    <li className={`tl-effects__row${active ? ' is-active' : ''}`} data-dialogue-id={d.dialogueId} onDoubleClick={() => onOpen(d.dialogueId)}>
      {renaming !== null ? (
        <input
          autoFocus
          className="tl-input"
          aria-label="Dialogue name"
          maxLength={64}
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={() => {
            if (renaming.trim() !== '' && renaming.trim() !== d.name) onRename(d.dialogueId, renaming.trim());
            setRenaming(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(null);
          }}
        />
      ) : (
        <span className="tl-effects__name">{d.name}</span>
      )}
      <span className="tl-effects__meta">
        {d.dialogueId} · {lines} line{lines === 1 ? '' : 's'}
      </span>
      <button className="tl-btn tl-btn--small" onClick={() => onOpen(d.dialogueId)} aria-label={`Open ${d.name}`}>
        Open
      </button>
      <button className="tl-btn tl-btn--small" onClick={() => setRenaming(d.name)} aria-label={`Rename ${d.name}`}>
        Rename
      </button>
      <button className="tl-btn tl-btn--small" onClick={() => onDelete(d.dialogueId)} aria-label={`Delete ${d.name}`}>
        Delete
      </button>
    </li>
  );
}

/** Speakers: pick one to edit (or a new one); Save sends one setSpeaker. */
function SpeakersEditor(p: DialoguePanelProps): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const current = editing !== null ? (p.speakers.find((s) => s.speakerId === editing) ?? null) : null;
  const blank: DialogueSpeaker = { speakerId: '', name: '' };
  const [draft, setDraft] = useState<DialogueSpeaker>(blank);
  useEffect(() => setDraft(current !== null ? structuredClone(current) : blank), [editing, current]); // eslint-disable-line react-hooks/exhaustive-deps
  const textures = p.assets.filter((a) => a.kind === 'texture');
  const sounds = p.assets.filter((a) => a.kind === 'audio');
  const portraits = Object.entries(draft.portraits ?? {});
  const set = (patch: Partial<DialogueSpeaker>): void => setDraft((d) => {
    const next = { ...d, ...patch } as DialogueSpeaker & Record<string, unknown>;
    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
    return next;
  });
  const setPortraits = (list: [string, string][]): void => set({ portraits: list.length > 0 ? Object.fromEntries(list) : undefined });
  const isNew = editing === null;
  return (
    <div className="tl-dialogue-speakers" aria-label="speakers">
      <div className="tl-dialogue-speakers__list">
        <button type="button" className={`tl-btn tl-btn--small${isNew ? ' is-active' : ''}`} onClick={() => setEditing(null)}>
          + New speaker
        </button>
        {p.speakers.map((s) => (
          <button key={s.speakerId} type="button" className={`tl-btn tl-btn--small${editing === s.speakerId ? ' is-active' : ''}`} aria-label={`Speaker ${s.name}`} data-speaker-id={s.speakerId} onClick={() => setEditing(s.speakerId)}>
            <span style={{ color: s.color ?? undefined }}>●</span> {s.name}
          </button>
        ))}
      </div>
      <div className="tl-effect-doc__settings" aria-label="speaker form">
        <span>Id</span>
        <input className="tl-input" aria-label="speaker id" value={draft.speakerId} disabled={!isNew} maxLength={64} onChange={(e) => set({ speakerId: e.target.value })} placeholder="e.g. guide" />
        <span>Name</span>
        <input className="tl-input" aria-label="speaker name" value={draft.name} maxLength={64} onChange={(e) => set({ name: e.target.value, ...(isNew && draft.speakerId === dialogueIdFrom(draft.name, [], '') ? { speakerId: dialogueIdFrom(e.target.value, [], '') } : {}) })} />
        <span>Name plate colour</span>
        <input className="tl-input" type="color" aria-label="speaker colour" value={draft.color ?? '#ffd480'} onChange={(e) => set({ color: e.target.value.toLowerCase() })} />
        <span>Default expression</span>
        <input className="tl-input" aria-label="speaker default expression" value={draft.defaultExpression ?? ''} maxLength={32} onChange={(e) => set({ defaultExpression: e.target.value === '' ? undefined : e.target.value })} placeholder="neutral" />
        <span>Voice profile</span>
        <input className="tl-input" aria-label="speaker voice profile" value={draft.voiceProfile ?? ''} maxLength={64} onChange={(e) => set({ voiceProfile: e.target.value === '' ? undefined : e.target.value })} />
        <span>Text blip</span>
        <select className="tl-input" aria-label="speaker blip" value={draft.blip ?? ''} onChange={(e) => set({ blip: e.target.value === '' ? undefined : e.target.value })}>
          <option value="">(none)</option>
          {sounds.map((a) => (
            <option key={a.assetId} value={a.assetId}>
              {a.displayName}
            </option>
          ))}
        </select>
        <span>Blip every (chars)</span>
        <input className="tl-input tl-input--num" type="number" min={1} max={16} aria-label="speaker blip every" value={draft.blipEvery ?? ''} placeholder="2" onChange={(e) => set({ blipEvery: e.target.value === '' ? undefined : Math.max(1, Math.min(16, Math.round(Number(e.target.value)))) })} />
      </div>
      <div className="tl-subhead">
        Portraits
        <button type="button" className="tl-btn tl-btn--small" aria-label="add portrait" disabled={portraits.length >= 32} onClick={() => setPortraits([...portraits, [portraits.length === 0 ? 'neutral' : `expression${portraits.length + 1}`, textures[0]?.assetId ?? '']])}>
          + portrait
        </button>
      </div>
      {portraits.length === 0 && <p className="tl-hint">No portraits: lines of this speaker show no picture. Add one per expression (texture assets).</p>}
      {portraits.map(([expr, tex], i) => (
        <div key={i} className="tl-material-param">
          <input className="tl-input" aria-label={`portrait ${i + 1} expression`} value={expr} maxLength={32} onChange={(e) => setPortraits(portraits.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          <select className="tl-input" aria-label={`portrait ${i + 1} texture`} value={tex} onChange={(e) => setPortraits(portraits.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}>
            {tex === '' && <option value="">(choose a texture)</option>}
            {textures.map((a) => (
              <option key={a.assetId} value={a.assetId}>
                {a.displayName}
              </option>
            ))}
          </select>
          <button type="button" className="tl-btn tl-btn--small" aria-label={`remove portrait ${expr}`} onClick={() => setPortraits(portraits.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="tl-dialogue-speakers__actions">
        <button type="button" className="tl-btn" aria-label="save speaker" disabled={draft.speakerId === '' || draft.name.trim() === ''} onClick={() => p.onSaveSpeaker(draft)}>
          {isNew ? 'Add speaker' : 'Save speaker'}
        </button>
        {!isNew && (
          <button type="button" className="tl-btn" aria-label="delete speaker" onClick={() => current !== null && p.onDeleteSpeaker(current.speakerId)}>
            Delete speaker
          </button>
        )}
      </div>
    </div>
  );
}

/** The dialogue settings; Apply sends one setDialogueSettings (Reset sends null). */
function SettingsEditor(p: DialoguePanelProps): JSX.Element {
  const [draft, setDraft] = useState<DialogueSettings>(p.settings ?? {});
  useEffect(() => setDraft(p.settings ?? {}), [p.settings]);
  const num = (k: 'textSpeed' | 'autoDelay' | 'duck' | 'backlog', v: string): void => setDraft((d) => {
    const next = { ...d } as Record<string, unknown>;
    if (v === '') delete next[k];
    else next[k] = Number(v);
    return next as DialogueSettings;
  });
  const opt = (k: 'document' | 'theme', v: string): void => setDraft((d) => {
    const next = { ...d } as Record<string, unknown>;
    if (v === '') delete next[k];
    else next[k] = v;
    return next as DialogueSettings;
  });
  return (
    <div aria-label="dialogue settings">
      <div className="tl-effect-doc__settings">
        <span>Text speed (chars/s, 0 = instant)</span>
        <input className="tl-input tl-input--num" type="number" min={0} max={1000} aria-label="text speed" placeholder="40" value={draft.textSpeed ?? ''} onChange={(e) => num('textSpeed', e.target.value)} />
        <span>Auto-advance</span>
        <input type="checkbox" aria-label="auto advance" checked={draft.autoAdvance === true} onChange={(e) => setDraft((d) => ({ ...d, autoAdvance: e.target.checked }))} />
        <span>Auto-advance delay (s)</span>
        <input className="tl-input tl-input--num" type="number" min={0} max={10} step={0.1} aria-label="auto delay" placeholder="0.5" value={draft.autoDelay ?? ''} onChange={(e) => num('autoDelay', e.target.value)} />
        <span>Music/SFX under a voice (0–1)</span>
        <input className="tl-input tl-input--num" type="number" min={0} max={1} step={0.05} aria-label="voice duck" placeholder="0.4" value={draft.duck ?? ''} onChange={(e) => num('duck', e.target.value)} />
        <span>Backlog lines</span>
        <input className="tl-input tl-input--num" type="number" min={1} max={100} aria-label="backlog lines" placeholder="50" value={draft.backlog ?? ''} onChange={(e) => num('backlog', e.target.value)} />
        <span>UI document</span>
        <select className="tl-input" aria-label="dialogue ui document" value={draft.document ?? ''} onChange={(e) => opt('document', e.target.value)}>
          <option value="">Engine dialogue box (tl-dialogue)</option>
          {p.uiDocuments.map((d) => (
            <option key={d.uiDocumentId} value={d.uiDocumentId}>
              {d.name}
            </option>
          ))}
        </select>
        <span>Theme (engine box)</span>
        <select className="tl-input" aria-label="dialogue theme" value={draft.theme ?? ''} onChange={(e) => opt('theme', e.target.value)}>
          <option value="">(the default look)</option>
          {p.uiThemes.map((t) => (
            <option key={t.uiThemeId} value={t.uiThemeId}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <p className="tl-hint">A theme restyles the engine box with the style names dialogueBox, dialogueName, dialogueText, dialoguePortrait, dialogueChoice, dialogueButton, dialogueBacklog, dialogueBacklogName, dialogueBacklogText. Your own document binds the dialogue.* view-model paths instead.</p>
      <div className="tl-dialogue-speakers__actions">
        <button type="button" className="tl-btn" aria-label="apply dialogue settings" onClick={() => p.onSaveSettings(draft)}>
          Apply
        </button>
        <button type="button" className="tl-btn" aria-label="reset dialogue settings" onClick={() => p.onSaveSettings(null)} disabled={p.settings === null}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
