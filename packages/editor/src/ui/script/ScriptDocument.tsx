/**
 * Phase 16.3: the "Script: <behavior>" centre tab — a code editor for a
 * behavior's source.
 *
 * - The source-graph container's files as a file list (add, rename, delete;
 *   the entry `src/index.ts` stays), plus the generated behavior API typings
 *   (`behavior-api.d.ts`, read-only).
 * - The published source loads from the backend; edits are a draft kept for
 *   the session (switching tabs keeps it) until they are published.
 * - Ctrl+S and a short idle pause compile the draft with the backend compiler
 *   (the source route's `check` mode — nothing is written); its diagnostics
 *   are marked in the code and listed below it (click → the position).
 * - Publish stages the container, asks for the trust acknowledgment of that
 *   exact digest when it is new, and publishes through the ordinary source
 *   route (one `publishBehavior` command, one undo step).
 * - The declaration editor (15.4) and the owned transforms dock beside the code.
 *
 * Display + intent: every write is an ordinary command issued by the app.
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { PropertyDeclaration } from '@thirdlight/project-model';

import { BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL, BEHAVIOR_TRUST_NOTICE, type CompileDiagnosticView } from '../../session/behavior-publication';
import type { BehaviorDeclarationView } from '../../session/prefab-projection';
import {
  API_MODULE,
  ENTRY_PATH,
  addFile,
  containerBytes,
  containerText,
  deleteFile,
  newScript,
  ownedTransformsOf,
  parseContainer,
  renameFile,
  setFileText,
  type ScriptContainer,
} from '../../session/script-sources';
import { DeclarationEditor, type DeclarationSave } from '../DeclarationEditor';
import { BEHAVIOR_API_DTS } from './behavior-api.generated';
import { CodeEditor, revealPosition, type InlineDiagnostic } from './CodeEditor';

/** The read-only typings entry of the file list. */
export const API_TYPINGS_PATH = 'behavior-api.d.ts';
/** Idle pause before a draft is compiled (long enough not to compile mid-word). */
export const CHECK_IDLE_MS = 700;

/** A behavior's unpublished edits (kept by the app while the session lives). */
export interface ScriptDraft {
  container: ScriptContainer;
  /** The published source digest the draft started from (`null`: none yet). */
  baseDigest: string | null;
  /** Edited since it was loaded or published. */
  dirty: boolean;
  openPath: string;
}

export type ScriptCheckResult =
  | { ok: true; compiled: true; declaredInCode: boolean; declaration: PropertyDeclaration; outputByteLength: number }
  | { ok: true; compiled: false; code: string; reason: string; diagnostics: CompileDiagnosticView[] }
  | { ok: false; error: { code: string; message: string } };

export type ScriptPublishOutcome =
  | { kind: 'published'; revision: number; digest: string }
  | { kind: 'needs-ack'; digest: string }
  | { kind: 'failed'; message: string };

export interface ScriptDocumentProps {
  behaviorId: string;
  behavior: BehaviorDeclarationView | null;
  drafts: Map<string, ScriptDraft>;
  declarationError: { code: string; message: string } | null;
  activePlay: { snapshotId: string; revision: number } | null;
  onSaveDeclaration: (save: DeclarationSave) => Promise<boolean>;
  loadSource: (behaviorId: string) => Promise<{ ok: true; source: string | null; sourceDigest: string | null } | { ok: false; error: { code: string; message: string } }>;
  check: (behaviorId: string, bytes: Uint8Array, declaration: PropertyDeclaration | null) => Promise<ScriptCheckResult>;
  publish: (behaviorId: string, bytes: Uint8Array, acknowledge: boolean) => Promise<ScriptPublishOutcome>;
}

type CheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; declaredInCode: boolean; outputByteLength: number }
  | { status: 'errors'; code: string; reason: string; diagnostics: CompileDiagnosticView[] }
  | { status: 'unavailable'; message: string };

/** `@thirdlight/runtime` in requiredModules whenever a file imports its types (the compiler requires it). */
function withRequiredModules(c: ScriptContainer): ScriptContainer {
  const uses = c.files.some((f) => f.text.includes(`'${API_MODULE}'`) || f.text.includes(`"${API_MODULE}"`));
  if (!uses || c.requiredModules.includes(API_MODULE)) return c;
  return { ...c, requiredModules: [...c.requiredModules, API_MODULE].sort() };
}

function fileOfDiagnostic(d: CompileDiagnosticView): string | null {
  if (d.path !== undefined) return d.path;
  return d.line !== undefined ? ENTRY_PATH : null;
}

export function ScriptDocument(p: ScriptDocumentProps): JSX.Element {
  const { behaviorId, behavior, drafts } = p;
  const [draft, setDraftState] = useState<ScriptDraft | null>(() => drafts.get(behaviorId) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ status: 'idle' });
  const [publishing, setPublishing] = useState<ScriptPublishOutcome | { kind: 'working' } | null>(null);
  const [fileForm, setFileForm] = useState<{ mode: 'add' | 'rename'; value: string; error: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [owned, setOwned] = useState<string>(() => (drafts.get(behaviorId)?.container.ownedTransforms ?? []).join(', '));
  const codeRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  const publishedDigest = behavior?.source?.sourceDigest ?? null;

  const setDraft = useCallback(
    (next: ScriptDraft) => {
      drafts.set(behaviorId, next);
      setDraftState(next);
    },
    [drafts, behaviorId],
  );

  // Load the published source (or start a new one) when there is no draft,
  // and follow a new publication while nothing is edited.
  useEffect(() => {
    const existing = drafts.get(behaviorId);
    if (existing !== undefined && (existing.dirty || existing.baseDigest === publishedDigest)) return;
    if (behavior === null) return;
    let live = true;
    if (publishedDigest === null) {
      const fresh: ScriptDraft = { container: newScript(behavior.declaration.properties.length > 0), baseDigest: null, dirty: false, openPath: ENTRY_PATH };
      setDraft(fresh);
      setOwned('');
      return;
    }
    void p.loadSource(behaviorId).then((r) => {
      if (!live) return;
      if (!r.ok) {
        setLoadError(`${r.error.code}: ${r.error.message}`);
        return;
      }
      if (r.source === null) return;
      const parsed = parseContainer(r.source);
      if (!parsed.ok) {
        setLoadError(parsed.message);
        return;
      }
      setLoadError(null);
      const keepOpen = existing !== undefined && parsed.container.files.some((f) => f.path === existing.openPath) ? existing.openPath : ENTRY_PATH;
      setDraft({ container: parsed.container, baseDigest: r.sourceDigest, dirty: false, openPath: keepOpen });
      setOwned(parsed.container.ownedTransforms.join(', '));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behaviorId, publishedDigest, behavior === null]);

  const runCheck = useCallback(
    async (c: ScriptContainer) => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const mine = ++seq.current;
      setCheck({ status: 'checking' });
      const r = await p.check(behaviorId, containerBytes(c), behavior?.declaration ?? null);
      if (mine !== seq.current) return;
      if (!r.ok) setCheck({ status: 'unavailable', message: `${r.error.code}: ${r.error.message}` });
      else if (r.compiled) setCheck({ status: 'ok', declaredInCode: r.declaredInCode, outputByteLength: r.outputByteLength });
      else setCheck({ status: 'errors', code: r.code, reason: r.reason, diagnostics: r.diagnostics });
    },
    [p, behaviorId, behavior],
  );

  // Compile after a short idle pause following each edit (and once on load).
  const text = draft === null ? '' : containerText(draft.container);
  useEffect(() => {
    if (draft === null) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    const c = draft.container;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void runCheck(c);
    }, CHECK_IDLE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (behavior === null) {
    return <p className="tl-hint">This behavior no longer exists (deleted or undone). Close the tab.</p>;
  }
  if (draft === null) {
    return (
      <div className="tl-script tl-script--loading" aria-label="script editor" data-behavior={behaviorId}>
        <p className="tl-hint">{loadError ?? 'Loading the source…'}</p>
      </div>
    );
  }

  const openPath = draft.openPath;
  const isApi = openPath === API_TYPINGS_PATH;
  const openFile = draft.container.files.find((f) => f.path === openPath);
  const shownText = isApi ? BEHAVIOR_API_DTS : (openFile?.text ?? '');
  const diagnostics = check.status === 'errors' ? check.diagnostics : [];
  const inline: InlineDiagnostic[] = isApi
    ? []
    : diagnostics
        .filter((d) => fileOfDiagnostic(d) === openPath)
        .map((d) => ({ line: d.line ?? 1, ...(d.column !== undefined ? { column: d.column } : {}), severity: 'error' as const, message: d.message }));
  const errorsIn = (path: string): number => diagnostics.filter((d) => fileOfDiagnostic(d) === path).length;

  const edit = (container: ScriptContainer, openAt: string = openPath): void => {
    setDraft({ ...draft, container: withRequiredModules(container), dirty: true, openPath: openAt });
    setPublishing(null);
  };
  const open = (path: string): void => {
    setConfirmDelete(false);
    setFileForm(null);
    setDraft({ ...draft, openPath: path });
  };
  const submitFileForm = (): void => {
    if (fileForm === null) return;
    const name = fileForm.value.trim();
    const r = fileForm.mode === 'add' ? addFile(draft.container, name) : renameFile(draft.container, openPath, name);
    if (!r.ok) {
      setFileForm({ ...fileForm, error: r.message });
      return;
    }
    setFileForm(null);
    edit(r.container, name);
  };
  const saveNow = (): void => {
    void runCheck(draft.container);
  };
  const doPublish = async (acknowledge: boolean): Promise<void> => {
    setPublishing({ kind: 'working' });
    const c = draft.container;
    const r = await p.publish(behaviorId, containerBytes(c), acknowledge);
    setPublishing(r);
    if (r.kind === 'published') {
      const now = drafts.get(behaviorId) ?? draft;
      // Still the published text (no edit while publishing): clean again.
      setDraft({ ...now, baseDigest: r.digest, dirty: containerText(now.container) !== containerText(c) });
    }
  };

  const status =
    check.status === 'checking'
      ? 'compiling…'
      : check.status === 'ok'
        ? `compiles (${check.outputByteLength} bytes${check.declaredInCode ? ', properties declared in code' : ''})`
        : check.status === 'errors'
          ? `${check.diagnostics.length} problem${check.diagnostics.length === 1 ? '' : 's'} (${check.code})`
          : check.status === 'unavailable'
            ? `not checked: ${check.message}`
            : '';
  const stale = draft.dirty && draft.baseDigest !== publishedDigest;

  return (
    <div className="tl-script" aria-label="script editor" data-behavior={behaviorId}>
      <div className="tl-script__files" aria-label="script files">
        <div className="tl-script__heading">Files</div>
        <ul className="tl-script__list">
          {draft.container.files.map((f) => (
            <li key={f.path}>
              <button
                className={f.path === openPath ? 'tl-script__file is-open' : 'tl-script__file'}
                data-file={f.path}
                aria-current={f.path === openPath ? 'true' : undefined}
                onClick={() => open(f.path)}
                title={f.path === draft.container.entryPath ? 'The entry file (its default export is the behavior)' : f.path}
              >
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
            <input
              className="tl-prop__input"
              aria-label={fileForm.mode === 'add' ? 'new file name' : 'rename file to'}
              value={fileForm.value}
              autoFocus
              onChange={(e) => setFileForm({ ...fileForm, value: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setFileForm(null);
              }}
            />
            <button className="tl-btn tl-btn--small" type="submit">
              {fileForm.mode === 'add' ? 'Add' : 'Rename'}
            </button>
            {fileForm.error !== null && <div className="tl-prop__error">{fileForm.error}</div>}
          </form>
        ) : (
          <div className="tl-script__row">
            <button className="tl-btn tl-btn--small" onClick={() => setFileForm({ mode: 'add', value: 'src/', error: null })} title="Add a file (import it with a relative path, e.g. './util')">
              + File
            </button>
            <button className="tl-btn tl-btn--small" disabled={isApi || openPath === draft.container.entryPath} onClick={() => setFileForm({ mode: 'rename', value: openPath, error: null })}>
              Rename
            </button>
            {confirmDelete ? (
              <button
                className="tl-btn tl-btn--small tl-btn--danger"
                onClick={() => {
                  const r = deleteFile(draft.container, openPath);
                  setConfirmDelete(false);
                  if (r.ok) edit(r.container, draft.container.entryPath);
                }}
              >
                Delete {openPath}?
              </button>
            ) : (
              <button className="tl-btn tl-btn--small" disabled={isApi || openPath === draft.container.entryPath} onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tl-script__main">
        <div className="tl-script__bar">
          <span className="tl-script__path">{openPath}</span>
          <span className={`tl-script__status tl-script__status--${check.status}`} aria-label="compile status" data-status={check.status}>
            {status}
          </span>
          <span className="tl-script__spacer" />
          <span className="tl-prop__caption">{draft.dirty ? 'unpublished edits' : draft.baseDigest !== null ? 'published' : 'not published yet'}</span>
          <button className="tl-btn tl-btn--small" onClick={saveNow} title="Compile now (Ctrl+S); it also compiles after a short pause">
            Compile
          </button>
          <button className="tl-btn tl-btn--small tl-btn--primary" disabled={publishing?.kind === 'working'} onClick={() => void doPublish(false)} title="Compile and publish this source (one undo step); Play then runs it">
            Publish
          </button>
        </div>
        {stale && <div className="tl-hint">The published source changed since these edits started; publishing replaces it.</div>}
        <div className="tl-script__editor" ref={codeRef}>
          <CodeEditor
            path={openPath}
            text={shownText}
            readOnly={isApi}
            diagnostics={inline}
            label={`code ${openPath}`}
            onChange={(path, t) => {
              if (path === API_TYPINGS_PATH) return;
              const cur = drafts.get(behaviorId) ?? draft;
              if (cur.container.files.find((f) => f.path === path)?.text === t) return;
              setDraft({ ...cur, container: withRequiredModules(setFileText(cur.container, path, t)), dirty: true });
              setPublishing(null);
            }}
            onSave={() => void runCheck((drafts.get(behaviorId) ?? draft).container)}
          />
        </div>
        <div className="tl-script__problems" aria-label="script problems">
          {diagnostics.length === 0 ? (
            <span className="tl-prop__caption">{check.status === 'ok' ? 'No problems.' : check.status === 'unavailable' ? status : ''}</span>
          ) : (
            <ul>
              {diagnostics.map((d, i) => {
                const file = fileOfDiagnostic(d);
                const where = file === null ? '' : `${file}${d.line !== undefined ? `:${d.line}${d.column !== undefined ? `:${d.column}` : ''}` : ''}`;
                return (
                  <li key={`${i}-${d.code}`}>
                    <button
                      className="tl-script__problem"
                      data-line={d.line ?? ''}
                      onClick={() => {
                        if (file === null) return;
                        if (file !== openPath && draft.container.files.some((f) => f.path === file)) open(file);
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
        {publishing?.kind === 'needs-ack' && (
          <div className="tl-script__trust" role="group" aria-label="trust acknowledgment">
            {BEHAVIOR_TRUST_NOTICE.map((line) => (
              <p key={line.slice(0, 24)} className="tl-behaviors__notice-line">
                {line}
              </p>
            ))}
            <div className="tl-prop__caption" title={publishing.digest}>
              source digest {publishing.digest.slice(0, 16)}…
            </div>
            <button className="tl-btn tl-btn--small" onClick={() => void doPublish(true)}>
              {BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL} and publish
            </button>
          </div>
        )}
        {publishing?.kind === 'published' && (
          <div className="tl-script__published" aria-label="publish result">
            Published (r{publishing.revision}). {p.activePlay !== null ? 'Restart Play to run it.' : 'Play runs it.'}
          </div>
        )}
        {publishing?.kind === 'failed' && (
          <div className="tl-prop__error" aria-label="publish result">
            {publishing.message}
          </div>
        )}
        <label className="tl-script__owned">
          <span className="tl-decl__name">Moves (owned transforms)</span>
          <input
            className="tl-prop__input"
            aria-label="owned transforms"
            value={owned}
            placeholder="@self, or object ids"
            title="Objects this script may move (emit transform/pose intents for): @self = the object carrying it"
            onChange={(e) => setOwned(e.target.value)}
            onBlur={() => {
              const list = ownedTransformsOf(owned);
              if (list.join(',') !== draft.container.ownedTransforms.join(',')) edit({ ...draft.container, ownedTransforms: list });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
        {/* Keyed by the revision so a publication re-seeds the drafts (as in the Behaviors tab). */}
        <DeclarationEditor key={`${behavior.behaviorId}@${behavior.publishedRevision}`} behavior={behavior} error={p.declarationError} onSave={p.onSaveDeclaration} />
      </div>
    </div>
  );
}
