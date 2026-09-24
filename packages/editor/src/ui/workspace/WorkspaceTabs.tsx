/**
 * Phase 16.0: the centre workspace — its tab strip (Scene, Game, then the
 * open documents: closable, reorderable by drag, middle-click closes), the
 * maximize toggle, Ctrl+Tab / Ctrl+Shift+Tab cycling, and the layout storage
 * that remembers the tabs per project (localStorage, like the dock sizes).
 *
 * Browser-only (React).
 */
import { useEffect, useReducer, useState, type Dispatch, type JSX } from 'react';

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
} from '../../session/workspace-tabs';
import { KNOWN_DOCUMENT_KINDS, documentKind, documentTitle, type WorkspaceHost } from './kinds';

const TAB_DRAG_TYPE = 'application/x-thirdlight-workspace-tab';

function load(projectId: string | null): WorkspaceState {
  if (projectId === null) return INITIAL_WORKSPACE;
  try {
    return parseWorkspace(window.localStorage.getItem(workspaceStorageKey(projectId)), KNOWN_DOCUMENT_KINDS);
  } catch {
    return INITIAL_WORKSPACE;
  }
}

/** The workspace state of a project, loaded from and saved to the layout storage. */
export function useWorkspace(projectId: string | null): [WorkspaceState, Dispatch<WorkspaceAction>] {
  const [state, dispatch] = useReducer(reduceWorkspace, projectId, load);
  useEffect(() => {
    if (projectId === null) return;
    try {
      window.localStorage.setItem(workspaceStorageKey(projectId), serializeWorkspace(state));
    } catch {
      // no storage: the tabs live for this page only
    }
  }, [projectId, state]);
  // Ctrl+Tab / Ctrl+Shift+Tab cycle the centre tabs, also while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      dispatch({ type: 'cycle', dir: e.shiftKey ? -1 : 1 });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return [state, dispatch];
}

/** Forget every project's remembered workspace tabs (Window → Reset layout). */
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

export interface WorkspaceTabsProps {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  host: WorkspaceHost;
}

export function WorkspaceTabs({ state, dispatch, host }: WorkspaceTabsProps): JSX.Element {
  const [dropKey, setDropKey] = useState<string | null>(null);
  const fixed = (key: 'scene' | 'game', label: string): JSX.Element => (
    <button role="tab" aria-selected={state.active === key} className={`tl-tab${state.active === key ? ' is-active' : ''}`} onClick={() => dispatch({ type: 'activate', key })}>
      {label}
    </button>
  );
  return (
    <div className="tl-tabs tl-tabs--center" role="tablist" aria-label="centre workspace">
      {fixed('scene', 'Scene')}
      {fixed('game', 'Game')}
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

/** The active document's view (null while Scene or Game is active). */
export function ActiveDocument({ state, host }: { state: WorkspaceState; host: WorkspaceHost }): JSX.Element | null {
  const doc = activeDoc(state);
  if (doc === null) return null;
  const kind = documentKind(doc.kind);
  return (
    <div className="tl-workspace__doc" role="tabpanel" aria-label={documentTitle(doc, host)}>
      {/* Keyed by the document: every tab gets its own view state. */}
      <div className="tl-workspace__view" key={docKey(doc)}>
        {kind?.render(doc.id, host) ?? <p className="tl-hint">Unknown document kind "{doc.kind}".</p>}
      </div>
    </div>
  );
}
