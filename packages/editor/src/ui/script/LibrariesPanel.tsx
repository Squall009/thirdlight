/**
 * The Libraries list (bottom dock) — the project's shared script
 * libraries: create (a name → an id, imported as `@lib/<id>`), rename, delete
 * and open (the "Library: <name>" centre tab). Each action is one command
 * (setScriptLibrary, deleteScriptLibrary — refused while a published script
 * imports the library). "Save all" commits every library with
 * unsaved edits at once (staged in several patches, one commit: one
 * revision, one undo, each importing script compiled once).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { ScriptLibrary } from '@thirdlight/project-model';

import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE } from '../../session/behavior-publication';
import type { LibrarySaveOutcome } from './LibraryDocument';

interface Props {
  libraries: readonly ScriptLibrary[];
  /** Published scripts per library id that import it. */
  dependents: (libraryId: string) => readonly string[];
  openId: string | null;
  error: string | null;
  /** The libraries with unsaved edits in their tabs. */
  dirty: readonly string[];
  /** The last "Save all" outcome. */
  saveAll: LibrarySaveOutcome | { kind: 'working' } | null;
  onSaveAll: (acknowledge: boolean) => void;
  onOpen: (libraryId: string) => void;
  onCreate: (name: string) => void;
  onRename: (libraryId: string, name: string) => void;
  onDelete: (libraryId: string) => void;
}

export function LibrariesPanel({ libraries, dependents, openId, error, dirty, saveAll, onSaveAll, onOpen, onCreate, onRename, onDelete }: Props): JSX.Element {
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
      <div className="tl-script__row" aria-label="unsaved libraries">
        <span className="tl-prop__caption">{dirty.length === 0 ? 'No unsaved library edits.' : `Unsaved edits: ${dirty.map((id) => `@lib/${id}`).join(', ')}`}</span>
        <button className="tl-btn tl-btn--small tl-btn--primary" disabled={dirty.length === 0 || saveAll?.kind === 'working'} onClick={() => onSaveAll(false)} title="Save every library with unsaved edits in one commit (one undo step); each script that imports them is recompiled once">
          Save all
        </button>
      </div>
      {saveAll?.kind === 'needs-ack' && (
        <div className="tl-script__trust" role="group" aria-label="save all trust acknowledgment">
          {BEHAVIOR_TRUST_NOTICE.map((line) => (
            <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
              {line}
            </p>
          ))}
          <div className="tl-prop__caption" title={saveAll.digest}>
            library digest {saveAll.digest.slice(0, 16)}…
          </div>
          <button className="tl-btn tl-btn--small" onClick={() => onSaveAll(true)}>
            {BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL} and save all
          </button>
        </div>
      )}
      {saveAll?.kind === 'saved' && (
        <p className="tl-hint" aria-label="save all result">
          Saved (r{saveAll.revision}) in {saveAll.patches ?? 1} patch{saveAll.patches === 1 ? '' : 'es'}, one commit.{saveAll.recompiled.length > 0 ? ` Recompiled ${saveAll.recompiled.join(', ')} (each once).` : ''}
        </p>
      )}
      {saveAll?.kind === 'failed' && (
        <p className="tl-error" role="alert" aria-label="save all result">
          {saveAll.message}
        </p>
      )}
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
