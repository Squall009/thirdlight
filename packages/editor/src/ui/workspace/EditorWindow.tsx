/**
 * The editor window and the default view's centre tabs.
 *
 * An item opened from the project window (or an Inspector reference's
 * "Open") shows in one full window over the editor: the item's editor on the
 * left, the editor's one Inspector on the right (the same component the
 * default view docks, moved here while the window shows, never a second
 * copy), one splitter between them whose width the layout storage remembers.
 * Editors that preview share one preview pane above that Inspector.
 * Several open items are tabs of the window: closable, reorderable by drag,
 * middle-click closes, Ctrl+Tab / Ctrl+Shift+Tab cycle them. Esc or the
 * window's × return to the default view with the selection it had; the tabs
 * stay for the next item opened. The default view's centre keeps the Scene
 * and Game views only.
 *
 * Browser-only (React).
 */
import { useEffect, useReducer, useRef, useState, type Dispatch, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import {
  INITIAL_WORKSPACE,
  WORKSPACE_STORAGE_PREFIX,
  activeDoc,
  docKey,
  parseWorkspace,
  reduceWorkspace,
  serializeWorkspace,
  workspaceStorageKey,
  type WorkspaceAction,
  type WorkspaceState,
} from '../../session/editor-window';
import { KNOWN_DOCUMENT_KINDS, documentKind, documentTitle, type WorkspaceHost } from './kinds';
import { PreviewPane } from '../preview/PreviewPane';
import { PreviewRequestContext, type PreviewRequest } from '../preview/preview-request';

const TAB_DRAG_TYPE = 'application/x-thirdlight-workspace-tab';

function load(projectId: string | null): WorkspaceState {
  if (projectId === null) return INITIAL_WORKSPACE;
  try {
    return parseWorkspace(window.localStorage.getItem(workspaceStorageKey(projectId)), KNOWN_DOCUMENT_KINDS);
  } catch {
    return INITIAL_WORKSPACE;
  }
}

/** Whether a key goes to a field being typed in (window keys leave it alone). */
export const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
};

/**
 * The window's state for a project, loaded from and saved to the layout
 * storage, with its keys: Ctrl+Tab / Ctrl+Shift+Tab (also while typing in a
 * field) and Esc (not while typing, and not while a modal dialog or an
 * editor's own Esc — a wire being drawn, a search open — takes it).
 */
export function useWorkspace(projectId: string | null): [WorkspaceState, Dispatch<WorkspaceAction>] {
  const [state, dispatch] = useReducer(reduceWorkspace, projectId, load);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (projectId === null) return;
    try {
      window.localStorage.setItem(workspaceStorageKey(projectId), serializeWorkspace(state));
    } catch {
      // no storage: the window's tabs live for this page only
    }
  }, [projectId, state]);
  useEffect(() => {
    const onCycle = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      dispatch({ type: 'cycle', dir: e.shiftKey ? -1 : 1 });
    };
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || !stateRef.current.open || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      // Taken: the default view's own Esc (clear the selection) must not also act on it.
      e.preventDefault();
      dispatch({ type: 'show', on: false });
    };
    window.addEventListener('keydown', onCycle, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('keydown', onCycle, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);
  return [state, dispatch];
}

/**
 * The default view's selection survives the window: what was selected when
 * the window opened is selected again when it closes (the objects that still
 * exist), whatever the window's editors selected meanwhile.
 */
export function useSelectionAcrossWindow<S extends { ids: string[]; primary: string | null }>(open: boolean, selection: S, restore: (s: { ids: string[]; primary: string | null }) => void, exists: (id: string) => boolean): void {
  const saved = useRef<{ ids: string[]; primary: string | null } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    if (open) {
      if (saved.current === null) saved.current = { ids: selectionRef.current.ids, primary: selectionRef.current.primary };
      return;
    }
    const s = saved.current;
    saved.current = null;
    if (s === null) return;
    const ids = s.ids.filter(exists);
    const primary = s.primary !== null && exists(s.primary) ? s.primary : (ids.at(-1) ?? null);
    const now = selectionRef.current;
    if (now.primary === primary && now.ids.length === ids.length && now.ids.every((id, i) => id === ids[i])) return;
    restore({ ids, primary });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- runs on the window opening or closing only; the selection and the existence check are read when it does
}

/** Forget every project's remembered editor window tabs (Window → Reset layout). */
export function resetWorkspaces(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null && k.startsWith(WORKSPACE_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // nothing stored
  }
}

/** The default view's centre tabs: the Scene and Game views and the maximize toggle. */
export function CentreTabs({ state, dispatch }: { state: WorkspaceState; dispatch: Dispatch<WorkspaceAction> }): JSX.Element {
  const view = (key: 'scene' | 'game', label: string): JSX.Element => (
    <button role="tab" aria-selected={state.view === key} className={`tl-tab${state.view === key ? ' is-active' : ''}`} onClick={() => dispatch({ type: 'view', view: key })}>
      {label}
    </button>
  );
  return (
    <div className="tl-tabs tl-tabs--center" role="tablist" aria-label="centre workspace">
      {view('scene', 'Scene')}
      {view('game', 'Game')}
      <button
        type="button"
        className={`tl-tabs__maximize${state.maximized ? ' is-active' : ''}`}
        aria-pressed={state.maximized}
        aria-label="Maximize the centre area"
        title={state.maximized ? 'Restore the docks' : 'Maximize the centre area (hide the docks)'}
        onClick={() => dispatch({ type: 'maximize' })}
      >
        {state.maximized ? '⤡' : '⤢'}
      </button>
    </div>
  );
}

export interface EditorWindowProps {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  host: WorkspaceHost;
  /** The editor's one Inspector, placed on the window's right. */
  inspector: ReactNode;
  /** The splitter's pointer-down handler (the Inspector's remembered width). */
  onSplitter: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/** The full window over the editor (rendered only while it shows). */
export function EditorWindow(props: EditorWindowProps): JSX.Element | null {
  return activeDoc(props.state) === null ? null : <OpenEditorWindow {...props} />;
}

function OpenEditorWindow({ state, dispatch, host, inspector, onSplitter }: EditorWindowProps): JSX.Element {
  const doc = activeDoc(state)!;
  // What the front editor asks the preview pane to show (it asks again when it comes to the front).
  const [preview, setPreview] = useState<PreviewRequest | null>(null);
  return (
    <section className="tl-editor-window" aria-label="editor window" data-doc-kind={doc.kind}>
      <div className="tl-editor-window__head">
        <WindowTabs state={state} dispatch={dispatch} host={host} />
        <button type="button" className="tl-editor-window__close" aria-label="Close the editor window" title="Back to the Scene (Esc)" onClick={() => dispatch({ type: 'show', on: false })}>
          ×
        </button>
      </div>
      <div className="tl-editor-window__body">
        <div className="tl-editor-window__editor">
          <div className="tl-workspace__doc" role="tabpanel" aria-label={documentTitle(doc, host)}>
            {/* Keyed by the document: every tab gets its own view state. */}
            <div className="tl-workspace__view" key={docKey(doc)}>
              <PreviewRequestContext.Provider value={setPreview}>{documentKind(doc.kind)?.render(doc.id, host) ?? <p className="tl-hint">Unknown document kind "{doc.kind}".</p>}</PreviewRequestContext.Provider>
            </div>
          </div>
        </div>
        <div className="tl-splitter tl-splitter--v" onPointerDown={onSplitter} role="separator" aria-orientation="vertical" aria-label="Resize the editor window's inspector" />
        {/* The one preview pane above the one Inspector; it keeps its renderer while the window shows. */}
        <div className="tl-editor-window__side">
          <PreviewPane request={preview} deps={host.preview} />
          {inspector}
        </div>
      </div>
    </section>
  );
}

function WindowTabs({ state, dispatch, host }: { state: WorkspaceState; dispatch: Dispatch<WorkspaceAction>; host: WorkspaceHost }): JSX.Element {
  const [dropKey, setDropKey] = useState<string | null>(null);
  return (
    <div className="tl-tabs tl-tabs--window" role="tablist" aria-label="open items">
      {state.docs.map((d) => {
        const key = docKey(d);
        const title = documentTitle(d, host);
        const active = state.active === key;
        return (
          <div
            key={key}
            className={`tl-wtab${active ? ' is-active' : ''}${dropKey === key ? ' is-drop-target' : ''}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (dropKey !== key) setDropKey(key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(null);
            }}
            onDrop={(e) => {
              setDropKey(null);
              const from = e.dataTransfer.getData(TAB_DRAG_TYPE);
              if (from === '') return;
              e.preventDefault();
              dispatch({ type: 'move', from, to: key });
            }}
          >
            <button
              role="tab"
              aria-selected={active}
              className={`tl-tab tl-tab--doc${active ? ' is-active' : ''}`}
              title={`${title} — drag to reorder, middle-click to close`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_TYPE, key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDropKey(null)}
              onClick={() => dispatch({ type: 'activate', key })}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                dispatch({ type: 'close', key });
              }}
            >
              <img className="tl-tab__icon" src={documentKind(d.kind)?.icon} alt="" aria-hidden="true" />
              {title}
            </button>
            <button type="button" className="tl-wtab__close" aria-label={`Close ${title}`} title="Close" onClick={() => dispatch({ type: 'close', key })}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
