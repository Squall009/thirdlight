/**
 * The editor's keyboard shortcuts (tools, frame, delete, undo/redo,
 * duplicate/copy/paste, the block tools' keys) and Shift held to turn
 * snapping off for one gesture. Never while typing into a field; with a
 * the editor window showing only undo/redo stay on.
 */
import { useEffect, type MutableRefObject } from 'react';
import { Gesture } from '../../session/gesture';
import { activeDoc, type WorkspaceState } from '../../session/editor-window';
import type { BlockPanelHandlers } from '../BlocksPanel';
import type { GizmoMode } from '../../viewport/viewport';
import type { ViewportRef } from './commands';
import type { SceneEditing } from './useSceneEditing';

export interface EditorShortcutsDeps {
  viewportRef: ViewportRef;
  gestureRef: MutableRefObject<Gesture | null>;
  shiftRef: MutableRefObject<boolean>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  blockHandlersRef: MutableRefObject<BlockPanelHandlers | null>;
  selectedIdRef: MutableRefObject<string | null>;
  setSelectedId: (id: string | null) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  scene: Pick<SceneEditing, 'undo' | 'redo' | 'del' | 'editRef'>;
}

export function useEditorShortcuts(deps: EditorShortcutsDeps): void {
  const { viewportRef, gestureRef, shiftRef, workspaceRef, blockHandlersRef, selectedIdRef, setSelectedId, setGizmoMode } = deps;
  const { undo, redo, del, editRef } = deps.scene;
  // Local snapping is a gesture option: default on, Shift disables it for the
  // gesture in flight (never persisted). Esc cancels the
  // gesture and sends nothing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftRef.current = true;
      if (e.key === 'Escape' && viewportRef.current?.cancelGesture()) {
        gestureRef.current = null;
        return;
      }
      // Editor shortcuts — never while typing into a field.
      const t = e.target as HTMLElement | null;
      const typing = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      // With the editor window showing, the scene's shortcuts (delete,
      // tools, frame, copy/paste) stay off; undo/redo remain global.
      const sceneHidden = activeDoc(workspaceRef.current) !== null;
      if (!typing && sceneHidden && (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        void (e.key.toLowerCase() === 'z' && !e.shiftKey ? undo() : redo());
        return;
      }
      if (!typing && !sceneHidden && blockHandlersRef.current?.onKey(e) === true) {
        e.preventDefault();
        return;
      }
      if (!typing && !sceneHidden) {
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === 'z') {
          e.preventDefault();
          void (e.shiftKey ? redo() : undo());
          return;
        }
        if (mod && key === 'y') {
          e.preventDefault();
          void redo();
          return;
        }
        if (mod && (key === 'd' || key === 'c' || key === 'v')) {
          e.preventDefault();
          void (key === 'd' ? editRef.current.duplicate() : key === 'c' ? editRef.current.copySelection() : editRef.current.paste());
          return;
        }
        if (!mod && !e.altKey) {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            void del();
            return;
          }
          const mode = key === 'w' ? 'translate' : key === 'e' ? 'rotate' : key === 'r' ? 'scale' : null;
          if (mode !== null) {
            setGizmoMode(mode);
            return;
          }
          if (key === 'f' && selectedIdRef.current !== null) {
            viewportRef.current?.focus(selectedIdRef.current);
            return;
          }
          if (e.key === 'Escape' && !e.defaultPrevented && selectedIdRef.current !== null) {
            setSelectedId(null);
            return;
          }
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftRef.current = false;
    };
    const onBlur = (): void => {
      shiftRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- the key listeners are installed once; undo, redo, del and setSelectedId are stable callbacks declared further down

}
