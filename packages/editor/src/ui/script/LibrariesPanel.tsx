/**
 * Phase 23.7: the Libraries list (bottom dock) — the project's shared script
 * libraries: create (a name → an id, imported as `@lib/<id>`), rename, delete
 * and open (the "Library: <name>" centre tab). Each action is one command
 * (setScriptLibrary, deleteScriptLibrary — refused while a published script
 * imports the library).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { ScriptLibrary } from '@thirdlight/project-model';

interface Props {
  libraries: readonly ScriptLibrary[];
  /** Published scripts per library id that import it. */
  dependents: (libraryId: string) => readonly string[];
  openId: string | null;
  error: string | null;
  onOpen: (libraryId: string) => void;
  onCreate: (name: string) => void;
  onRename: (libraryId: string, name: string) => void;
  onDelete: (libraryId: string) => void;
}

export function LibrariesPanel({ libraries, dependents, openId, error, onOpen, onCreate, onRename, onDelete }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="tl-panel tl-effects tl-libraries">
      <div className="tl-panel__title">Script libraries</div>
      <form
        className="tl-graphs__new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() === '') return;
          onCreate(name.trim());
          setName('');
        }}
      >
        <input className="tl-input" aria-label="New library name" placeholder="New library name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="tl-btn tl-btn--small" type="submit" disabled={name.trim() === ''}>
          Create library
        </button>
      </form>
      <p className="tl-hint">Shared TypeScript and JSON every script can import: import {'{ … }'} from '@lib/&lt;id&gt;'. Saving a library recompiles the scripts that import it.</p>
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
      {libraries.length === 0 ? (
        <div className="tl-inspector__empty">No script libraries yet.</div>
      ) : (
        <ul className="tl-effects__list" aria-label="Library list">
          {libraries.map((lib) => {
            const users = dependents(lib.libraryId);
            return (
              <li key={lib.libraryId} className={`tl-effects__row${openId === lib.libraryId ? ' is-active' : ''}`} data-library-id={lib.libraryId} onDoubleClick={() => onOpen(lib.libraryId)}>
                {renaming?.id === lib.libraryId ? (
                  <input
                    autoFocus
                    className="tl-input"
                    aria-label="Library name"
                    maxLength={64}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: lib.libraryId, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim() !== '' && renaming.name.trim() !== lib.name) onRename(lib.libraryId, renaming.name.trim());
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="tl-effects__name">{lib.name}</span>
                )}
                <span className="tl-effects__meta">
                  @lib/{lib.libraryId} · {lib.files.length} file{lib.files.length === 1 ? '' : 's'}
                  {users.length > 0 ? ` · used by ${users.join(', ')}` : ''}
                </span>
                <button className="tl-btn tl-btn--small" onClick={() => onOpen(lib.libraryId)} aria-label={`Open ${lib.name}`}>
                  Open
                </button>
                <button className="tl-btn tl-btn--small" onClick={() => setRenaming({ id: lib.libraryId, name: lib.name })} aria-label={`Rename ${lib.name}`}>
                  Rename
                </button>
                <button className="tl-btn tl-btn--small" disabled={users.length > 0} title={users.length > 0 ? 'Imported by a published script' : undefined} onClick={() => onDelete(lib.libraryId)} aria-label={`Delete ${lib.name}`}>
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
