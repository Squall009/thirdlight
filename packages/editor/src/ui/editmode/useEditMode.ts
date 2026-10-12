/**
 * Which edit mode is open, on which object, and what it does to the rest of
 * the editor.
 *
 * Entering (a double-click on the object in the Hierarchy or the Scene view,
 * the Inspector's Edit button, or right after the object is made) brings the
 * Scene view to the front, closes the editor window and Project Settings, and
 * clears the selection; Done (or Esc) selects again what was selected before
 * (what still exists). The mode stays open while it is set aside — the Game
 * view in front (Play), the editor window or Project Settings over it — and
 * shows again when the Scene view is back. It closes by itself when its
 * object is gone or no longer has what it edits (deleted, undone).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';

import type { WorkspaceAction } from '../../session/editor-window';
import type { ProjectedEntity } from '../../session/projection';
import { editModeFor, editModeKind, type EditModeKind } from './modes';

export interface EditModeState {
  readonly kind: string;
  readonly entityId: string;
  /** The rail's mode shown. */
  readonly mode: string;
  /** The rest of the scene shown around the object (not pickable). */
  readonly context: boolean;
}

export interface EditModeDeps {
  entities: readonly ProjectedEntity[];
  selection: { ids: string[]; primary: string | null };
  setSelection: (s: { ids: string[]; primary: string | null }) => void;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  closeSettings: () => void;
  /** The Scene view is in front with nothing over it (else the mode is set aside). */
  sceneInFront: boolean;
}

export function useEditMode(deps: EditModeDeps) {
  const { entities, setSelection, workspaceDispatch, closeSettings, sceneInFront } = deps;
  const [state, setState] = useState<EditModeState | null>(null);
  /** The selection before the mode opened (restored on Done). */
  const saved = useRef<{ ids: string[]; primary: string | null } | null>(null);
  /** The edited object was in the projection since the mode opened (a new one arrives after it is entered). */
  const seen = useRef(false);
  /**
   * The working view the view still owes the mode (entered, not framed yet; not again on coming back from Play):
   * 'always' for an object just made, 'away' — only if the view is not already working on it — for one entered.
   */
  const owesFrame = useRef<'always' | 'away' | null>(null);
  /** The rail's mode last shown, per editor (for this page). */
  const lastMode = useRef(new Map<string, string>());
  const selectionRef = useRef(deps.selection);
  selectionRef.current = deps.selection;
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;

  /** Open the edit mode of an object (`kind`: an object just made, maybe not in the projection yet); false when it has none. */
  const enter = useCallback(
    (entityId: string, kind?: string): boolean => {
      const e = entitiesRef.current.find((x) => x.id === entityId);
      const k: EditModeKind | undefined = e !== undefined ? editModeFor(e) : kind !== undefined ? editModeKind(kind) : undefined;
      if (k === undefined) return false;
      if (saved.current === null) saved.current = { ids: selectionRef.current.ids, primary: selectionRef.current.primary };
      seen.current = e !== undefined;
      owesFrame.current = kind !== undefined ? 'always' : 'away';
      setSelection({ ids: [], primary: null });
      setState({ kind: k.kind, entityId, mode: lastMode.current.get(k.kind) ?? k.rail[0]?.id ?? '', context: false });
      workspaceDispatch({ type: 'view', view: 'scene' });
      workspaceDispatch({ type: 'show', on: false });
      closeSettings();
      return true;
    },
    [setSelection, workspaceDispatch, closeSettings],
  );

  /** Close the mode (Done): the selection from before it opened comes back. */
  const leave = useCallback(() => {
    setState(null);
    const s = saved.current;
    saved.current = null;
    if (s === null) return;
    const exists = new Set(entitiesRef.current.map((e) => e.id));
    const ids = s.ids.filter((id) => exists.has(id));
    setSelection({ ids, primary: s.primary !== null && exists.has(s.primary) ? s.primary : (ids.at(-1) ?? null) });
  }, [setSelection]);

  const setMode = useCallback((mode: string) => {
    setState((s) => {
      if (s === null || s.mode === mode) return s;
      lastMode.current.set(s.kind, mode);
      return { ...s, mode };
    });
  }, []);

  /** The working view the shell still owes (null: none), and that it is settled. */
  const frameOwed = useCallback((): 'always' | 'away' | null => owesFrame.current, []);
  const frameDone = useCallback((): void => {
    owesFrame.current = null;
  }, []);

  const toggleContext = useCallback(() => setState((s) => (s === null ? s : { ...s, context: !s.context })), []);

  const entity = state === null ? undefined : entities.find((e) => e.id === state.entityId);
  const kind = state === null ? undefined : editModeKind(state.kind);
  // Gone, or no longer what the mode edits (deleted, its component removed, undone): the mode closes.
  useEffect(() => {
    if (state === null) return;
    if (entity !== undefined) seen.current = true;
    if ((entity === undefined && seen.current) || (entity !== undefined && kind?.applies(entity) !== true)) leave();
  }, [state, entity, kind, leave]);

  const shown = state !== null && entity !== undefined && kind !== undefined && sceneInFront;
  return { state, entity, kind, shown, enter, leave, setMode, toggleContext, frameOwed, frameDone };
}

export type EditMode = ReturnType<typeof useEditMode>;
