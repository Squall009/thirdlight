/**
 * Phase 23.7: the "Library: <name>" centre tab — the code editor for a shared
 * script library (TypeScript and JSON modules every script imports as
 * `@lib/<libraryId>`).
 *
 * - The library's files as a file list (add, rename, delete; the entry
 *   `src/index.ts` — what an import names — stays), plus the behavior API
 *   typings (read-only).
 * - Edits are a draft kept for the session until saved. A short idle pause
 *   and Ctrl+S compile the draft on its own with the backend compiler
 *   (nothing is written); diagnostics are marked in the code and listed.
 * - Save sends one `setScriptLibrary` command with only the changed files;
 *   the backend recompiles every published script that imports the library
 *   in the same command (one undo step). A new library digest those scripts
 *   will link asks for the trust acknowledgment first; a script that no
 *   longer compiles refuses the save and says which one and why.
 *
 * Display + intent: every write is an ordinary command issued by the app.
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { ScriptLibrary } from '@thirdlight/project-model';

import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE, type CompileDiagnosticView } from '../../session/behavior-publication';
import { ENTRY_PATH, libraryFilePatch, pathProblem, type ScriptContainer, type ScriptFile } from '../../session/script-sources';
import { BEHAVIOR_API_DTS } from './behavior-api.generated';
import { CodeEditor, revealPosition, type InlineDiagnostic } from './CodeEditor';
import { API_TYPINGS_PATH, CHECK_IDLE_MS } from './ScriptDocument';

/** A library's unsaved edits (kept by the app while the session lives). */
export interface LibraryDraft {
  files: ScriptFile[];
  /** The stored files' text the draft started from (to tell a newer stored version). */
  base: string;
  dirty: boolean;
  openPath: string;
}

export type LibraryCheckResult =
  | { ok: true; compiled: true; sourceDigest: string; imports: string[]; outputByteLength: number; dependents: string[] }
  | { ok: true; compiled: false; code: string; reason: string; diagnostics: CompileDiagnosticView[]; dependents: string[] }
  | { ok: false; error: { code: string; message: string } };

export type LibrarySaveOutcome =
  | { kind: 'saved'; revision: number; recompiled: string[] }
  | { kind: 'needs-ack'; digest: string }
  | { kind: 'failed'; message: string; diagnostics?: CompileDiagnosticView[] };

export interface LibraryDocumentProps {
  libraryId: string;
  library: ScriptLibrary | null;
  drafts: Map<string, LibraryDraft>;
  activePlay: { snapshotId: string; revision: number } | null;
  check: (libraryId: string, files: readonly ScriptFile[]) => Promise<LibraryCheckResult>;
  save: (libraryId: string, files: { path: string; text: string | null }[], acknowledge: boolean) => Promise<LibrarySaveOutcome>;
}

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; outputByteLength: number; imports: string[]; dependents: string[] }
  | { status: 'errors'; code: string; diagnostics: CompileDiagnosticView[]; dependents: string[] }
  | { status: 'unavailable'; message: string };

const byPath = (a: ScriptFile, b: ScriptFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const filesText = (files: readonly ScriptFile[]): string => JSON.stringify([...files].sort(byPath).map((f) => [f.path, f.text]));
/** The file-name rules of a script container, applied to a library's file list. */
const asContainer = (files: readonly ScriptFile[]): ScriptContainer => ({ graphVersion: 1, entryPath: ENTRY_PATH, requiredModules: [], ownedTransforms: [], files: [...files] });

export function LibraryDocument(p: LibraryDocumentProps): JSX.Element {
  const { libraryId, library, drafts } = p;
  const storedText = library === null ? null : filesText(library.files);
  const [draft, setDraftState] = useState<LibraryDraft | null>(() => drafts.get(libraryId) ?? null);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [saving, setSaving] = useState<LibrarySaveOutcome | { kind: 'working' } | null>(null);
  const [fileForm, setFileForm] = useState<{ mode: 'add' | 'rename'; value: string; error: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  const setDraft = useCallback(
    (next: LibraryDraft) => {
      drafts.set(libraryId, next);
      setDraftState(next);
    },
    [drafts, libraryId],
  );

  // Start from the stored files, and follow a newer stored version while nothing is edited.
  useEffect(() => {
    if (library === null || storedText === null) return;
    const existing = drafts.get(libraryId);
    if (existing !== undefined && (existing.dirty || existing.base === storedText)) return;
    const keepOpen = existing !== undefined && library.files.some((f) => f.path === existing.openPath) ? existing.openPath : ENTRY_PATH;
    setDraft({ files: library.files.map((f) => ({ path: f.path, text: f.text })), base: storedText, dirty: false, openPath: keepOpen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId, storedText]);

  const runCheck = useCallback(
    async (files: readonly ScriptFile[]) => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const mine = ++seq.current;
      setCheck({ status: 'checking' });
      const r = await p.check(libraryId, files);
      if (mine !== seq.current) return;
      if (!r.ok) setCheck({ status: 'unavailable', message: `${r.error.code}: ${r.error.message}` });
      else if (r.compiled) setCheck({ status: 'ok', outputByteLength: r.outputByteLength, imports: r.imports, dependents: r.dependents });
      else setCheck({ status: 'errors', code: r.code, diagnostics: r.diagnostics, dependents: r.dependents });
    },
    [p, libraryId],
  );

  const draftText = draft === null ? '' : filesText(draft.files);
  useEffect(() => {
    if (draft === null) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const files = draft.files;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void runCheck(files);
    }, CHECK_IDLE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftText]);

  if (library === null) return <p className="tl-hint">This script library no longer exists (deleted or undone). Close the tab.</p>;
  if (draft === null) return <div className="tl-script tl-script--loading" aria-label="library editor" data-library={libraryId}><p className="tl-hint">Loading…</p></div>;

  const openPath = draft.openPath;
  const isApi = openPath === API_TYPINGS_PATH;
  const openFile = draft.files.find((f) => f.path === openPath);
  const shownText = isApi ? BEHAVIOR_API_DTS : (openFile?.text ?? '');
  const saveDiagnostics = saving?.kind === 'failed' ? (saving.diagnostics ?? []) : [];
  const diagnostics = check.status === 'errors' ? check.diagnostics : saveDiagnostics;
  /** A diagnostic's file in this library (null: another library's, or none). */
  const fileOf = (d: CompileDiagnosticView): string | null => (d.library === libraryId && d.path !== undefined ? d.path : null);
  const inline: InlineDiagnostic[] = isApi
    ? []
    : diagnostics.filter((d) => fileOf(d) === openPath).map((d) => ({ line: d.line ?? 1, ...(d.column !== undefined ? { column: d.column } : {}), severity: 'error' as const, message: d.message }));
  const errorsIn = (path: string): number => diagnostics.filter((d) => fileOf(d) === path).length;
  const dependents = check.status === 'ok' || check.status === 'errors' ? check.dependents : [];

  const edit = (files: ScriptFile[], openAt: string = openPath): void => {
    setDraft({ ...draft, files: files.sort(byPath), dirty: filesText(files) !== storedText, openPath: openAt });
    setSaving(null);
  };
  const open = (path: string): void => {
    setConfirmDelete(false);
    setFileForm(null);
    setDraft({ ...draft, openPath: path });
  };
  const submitFileForm = (): void => {
    if (fileForm === null) return;
    const name = fileForm.value.trim();
    if (fileForm.mode === 'add' && draft.files.length >= 16) {
      setFileForm({ ...fileForm, error: 'a library has at most 16 files' });
      return;
    }
    const problem = pathProblem(name, asContainer(draft.files), fileForm.mode === 'rename' ? openPath : undefined);
    if (problem !== null) {
      setFileForm({ ...fileForm, error: problem });
      return;
    }
    setFileForm(null);
    if (fileForm.mode === 'add') edit([...draft.files, { path: name, text: name.endsWith('.json') ? '{}\n' : 'export {};\n' }], name);
    else edit(draft.files.map((f) => (f.path === openPath ? { path: name, text: f.text } : f)), name);
  };
  const doSave = async (acknowledge: boolean): Promise<void> => {
    const files = draft.files;
    const patch = libraryFilePatch(library.files, files);
    if (patch.length === 0) return;
    setSaving({ kind: 'working' });
    const r = await p.save(libraryId, patch, acknowledge);
    setSaving(r);
    if (r.kind === 'saved') {
      const now = drafts.get(libraryId) ?? draft;
      setDraft({ ...now, base: filesText(files), dirty: filesText(now.files) !== filesText(files) });
    }
  };

  const status =
    check.status === 'checking'
      ? 'compiling…'
      : check.status === 'ok'
        ? `compiles (${check.outputByteLength} bytes)`
        : check.status === 'errors'
          ? `${check.diagnostics.length} problem${check.diagnostics.length === 1 ? '' : 's'} (${check.code})`
          : check.status === 'unavailable'
            ? `not checked: ${check.message}`
            : '';

  return (
    <div className="tl-script" aria-label="library editor" data-library={libraryId}>
      <div className="tl-script__files" aria-label="library files">
        <div className="tl-script__heading">Files</div>
        <ul className="tl-script__list">
          {draft.files.map((f) => (
            <li key={f.path}>
              <button className={f.path === openPath ? 'tl-script__file is-open' : 'tl-script__file'} data-file={f.path} aria-current={f.path === openPath ? 'true' : undefined} onClick={() => open(f.path)} title={f.path === ENTRY_PATH ? `The entry file: what import … from '@lib/${libraryId}' names` : f.path}>
                {f.path}
                {errorsIn(f.path) > 0 && <span className="tl-script__badge" title="compile problems">{errorsIn(f.path)}</span>}
              </button>
            </li>
          ))}
          <li>
            <button className={isApi ? 'tl-script__file tl-script__file--api is-open' : 'tl-script__file tl-script__file--api'} data-file={API_TYPINGS_PATH} onClick={() => open(API_TYPINGS_PATH)} title="The behavior API typings (generated from the engine; read-only)">
              {API_TYPINGS_PATH}
            </button>
          </li>
        </ul>
        {fileForm !== null ? (
          <form
            className="tl-script__form"
            onSubmit={(e) => {
              e.preventDefault();
              submitFileForm();
            }}
          >
            <input className="tl-prop__input" aria-label={fileForm.mode === 'add' ? 'new file name' : 'rename file to'} value={fileForm.value} autoFocus onChange={(e) => setFileForm({ ...fileForm, value: e.target.value, error: null })} onKeyDown={(e) => e.key === 'Escape' && setFileForm(null)} />
            <button className="tl-btn tl-btn--small" type="submit">
              {fileForm.mode === 'add' ? 'Add' : 'Rename'}
            </button>
            {fileForm.error !== null && <div className="tl-prop__error">{fileForm.error}</div>}
          </form>
        ) : (
          <div className="tl-script__row">
            <button className="tl-btn tl-btn--small" onClick={() => setFileForm({ mode: 'add', value: 'src/', error: null })} title="Add a .ts module or a .json data file (import it with a relative path, e.g. './table.json')">
              + File
            </button>
            <button className="tl-btn tl-btn--small" disabled={isApi || openPath === ENTRY_PATH} onClick={() => setFileForm({ mode: 'rename', value: openPath, error: null })}>
              Rename
            </button>
            {confirmDelete ? (
              <button
                className="tl-btn tl-btn--small tl-btn--danger"
                onClick={() => {
                  setConfirmDelete(false);
                  edit(draft.files.filter((f) => f.path !== openPath), ENTRY_PATH);
                }}
              >
                Delete {openPath}?
              </button>
            ) : (
              <button className="tl-btn tl-btn--small" disabled={isApi || openPath === ENTRY_PATH} onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tl-script__main">
        <div className="tl-script__bar">
          <span className="tl-script__path">
            @lib/{libraryId} · {openPath}
          </span>
          <span className={`tl-script__status tl-script__status--${check.status}`} aria-label="compile status" data-status={check.status}>
            {status}
          </span>
          <span className="tl-script__spacer" />
          <span className="tl-prop__caption">{draft.dirty ? 'unsaved edits' : 'saved'}</span>
          <button className="tl-btn tl-btn--small" onClick={() => void runCheck(draft.files)} title="Compile now (Ctrl+S); it also compiles after a short pause">
            Compile
          </button>
          <button className="tl-btn tl-btn--small tl-btn--primary" disabled={saving?.kind === 'working' || !draft.dirty} onClick={() => void doSave(false)} title="Save the library (one undo step); the scripts that import it are recompiled with it">
            Save
          </button>
        </div>
        {draft.dirty && draft.base !== storedText && <div className="tl-hint">The library changed since these edits started; saving replaces the files you edited.</div>}
        <div className="tl-script__editor" ref={codeRef}>
          <CodeEditor
            path={openPath}
            text={shownText}
            readOnly={isApi}
            diagnostics={inline}
            label={`code ${openPath}`}
            onChange={(path, t) => {
              if (path === API_TYPINGS_PATH) return;
              const cur = drafts.get(libraryId) ?? draft;
              if (cur.files.find((f) => f.path === path)?.text === t) return;
              const files = cur.files.map((f) => (f.path === path ? { path, text: t } : f));
              setDraft({ ...cur, files, dirty: filesText(files) !== storedText });
              setSaving(null);
            }}
            onSave={() => void runCheck((drafts.get(libraryId) ?? draft).files)}
          />
        </div>
        <div className="tl-script__problems" aria-label="library problems">
          {diagnostics.length === 0 ? (
            <span className="tl-prop__caption">{check.status === 'ok' ? 'No problems.' : check.status === 'unavailable' ? status : ''}</span>
          ) : (
            <ul>
              {diagnostics.map((d, i) => {
                const file = fileOf(d);
                const where = d.path === undefined ? '' : `${d.library !== undefined && d.library !== libraryId ? `@lib/${d.library}/` : ''}${d.path}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''}`;
                return (
                  <li key={`${i}-${d.code}`}>
                    <button
                      className="tl-script__problem"
                      data-line={d.line ?? ''}
                      onClick={() => {
                        if (file === null) return;
                        if (file !== openPath && draft.files.some((f) => f.path === file)) open(file);
                        window.setTimeout(() => revealPosition(codeRef.current, d.line ?? 1, d.column), 0);
                      }}
                    >
                      {where !== '' && <span className="tl-script__where">{where}</span>} {d.message}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="tl-script__side">
        <div className="tl-prop__caption" aria-label="library import">
          Import it in any script: <code>{`import { … } from '@lib/${libraryId}';`}</code>
        </div>
        <div className="tl-prop__caption" aria-label="library dependents">
          {dependents.length === 0 ? 'No published script imports it yet.' : `Imported by: ${dependents.join(', ')} (recompiled when you save).`}
        </div>
        {saving?.kind === 'needs-ack' && (
          <div className="tl-script__trust" role="group" aria-label="trust acknowledgment">
            {BEHAVIOR_TRUST_NOTICE.map((line) => (
              <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
                {line}
              </p>
            ))}
            <div className="tl-prop__caption" title={saving.digest}>
              library digest {saving.digest.slice(0, 16)}…
            </div>
            <button className="tl-btn tl-btn--small" onClick={() => void doSave(true)}>
              {BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL} and save
            </button>
          </div>
        )}
        {saving?.kind === 'saved' && (
          <div className="tl-script__published" aria-label="save result">
            Saved (r{saving.revision}).{saving.recompiled.length > 0 ? ` Recompiled ${saving.recompiled.join(', ')}.` : ''} {p.activePlay !== null ? 'Restart Play to run it.' : ''}
          </div>
        )}
        {saving?.kind === 'failed' && (
          <div className="tl-prop__error" aria-label="save result">
            {saving.message}
          </div>
        )}
      </div>
    </div>
  );
}
