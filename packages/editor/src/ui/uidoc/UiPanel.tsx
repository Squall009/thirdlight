/**
 * The UI list (bottom dock) — the project's UI documents and UI
 * themes: create (a name → an id), rename, delete and open (the "UI: <name>"
 * and "UI theme: <name>" editor window tabs). Each action is one command
 * (setUiDocument / deleteUiDocument, setUiTheme / deleteUiTheme); the
 * backend refuses deleting a document a flow screen or a show action names,
 * or a theme in use.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { UiDocument, UiTheme } from '@thirdlight/project-model';

interface Props {
  documents: readonly UiDocument[];
  themes: readonly UiTheme[];
  error: string | null;
  onOpenDocument: (id: string) => void;
  onOpenTheme: (id: string) => void;
  onCreateDocument: (name: string) => void;
  onCreateTheme: (name: string) => void;
  onRenameDocument: (id: string, name: string) => void;
  onRenameTheme: (id: string, name: string) => void;
  onDeleteDocument: (id: string) => void;
  onDeleteTheme: (id: string) => void;
}

function NewRow(p: { label: string; onCreate: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  return (
    <form
      className="tl-graphs__new"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() === '') return;
        p.onCreate(name.trim());
        setName('');
      }}
    >
      <input className="tl-input" aria-label={`New ${p.label} name`} placeholder={`New ${p.label} name`} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
      <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === ''}>
        Create {p.label}
      </button>
    </form>
  );
}

function Rows(p: { kind: string; items: readonly { id: string; name: string; meta: string }[]; onOpen: (id: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void }): JSX.Element {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  if (p.items.length === 0) return <div className="tl-inspector__empty">No {p.kind}s yet.</div>;
  return (
    <ul className="tl-effects__list" aria-label={`${p.kind} list`}>
      {p.items.map((it) => (
        <li key={it.id} className="tl-effects__row" data-ui-id={it.id} onDoubleClick={() => p.onOpen(it.id)}>
          {renaming?.id === it.id ? (
            <input
              autoFocus
              className="tl-input"
              aria-label={`${p.kind} name`}
              maxLength={64}
              value={renaming.name}
              onChange={(e) => setRenaming({ id: it.id, name: e.target.value })}
              onBlur={() => {
                if (renaming.name.trim() !== '' && renaming.name.trim() !== it.name) p.onRename(it.id, renaming.name.trim());
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <span className="tl-effects__name">{it.name}</span>
          )}
          <span className="tl-effects__meta">{it.meta}</span>
          <button className="tl-btn tl-btn--small" onClick={() => p.onOpen(it.id)} aria-label={`Open ${it.name}`}>
            Open
          </button>
          <button className="tl-btn tl-btn--small" onClick={() => setRenaming({ id: it.id, name: it.name })} aria-label={`Rename ${it.name}`}>
            Rename
          </button>
          <button className="tl-btn tl-btn--small" onClick={() => p.onDelete(it.id)} aria-label={`Delete ${it.name}`}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}

const count = (w: UiDocument['root']): number => 1 + (w.children ?? []).reduce((n, c) => n + count(c), 0) + (w.template !== undefined ? count(w.template) : 0);

export function UiPanel(p: Props): JSX.Element {
  return (
    <div className="tl-panel tl-effects tl-uipanel">
      <div className="tl-panel__title">UI documents</div>
      <p className="tl-hint">HUDs, menus and screens drawn over the game view. Scripts show them with ctx.ui.show and feed their bindings with ctx.ui.set; the Game window can replace built-in screens with them.</p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <NewRow label="UI document" onCreate={p.onCreateDocument} />
      <Rows kind="UI document" items={p.documents.map((d) => ({ id: d.uiDocumentId, name: d.name, meta: `${d.uiDocumentId} · ${count(d.root)} widget(s)${d.theme !== undefined ? ` · theme ${d.theme}` : ''}` }))} onOpen={p.onOpenDocument} onRename={p.onRenameDocument} onDelete={p.onDeleteDocument} />
      <div className="tl-panel__title">UI themes</div>
      <NewRow label="UI theme" onCreate={p.onCreateTheme} />
      <Rows kind="UI theme" items={p.themes.map((t) => ({ id: t.uiThemeId, name: t.name, meta: `${Object.keys(t.styles).length} style(s)` }))} onOpen={p.onOpenTheme} onRename={p.onRenameTheme} onDelete={p.onDeleteTheme} />
    </div>
  );
}
