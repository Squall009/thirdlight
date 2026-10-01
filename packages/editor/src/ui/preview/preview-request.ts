/**
 * What an editor asks the editor window's preview pane to show.
 *
 * An editor says what to preview — a description, never a renderer — with
 * `usePreview(request)`; the pane above the Inspector builds the subject on
 * its one renderer path and shows the subject's controls. The front editor's
 * request wins (only the front editor is mounted); an editor without a
 * preview asks for nothing and the pane folds away.
 *
 * Requests are compared by identity: an editor memoizes its request so a
 * re-render without a change does not ask again.
 */
import { createContext, useContext, useEffect } from 'react';
import type { AnimatorController, DialogueDocument, EffectDef, MaterialDef, UiDocument, UiTheme } from '@thirdlight/project-model';
import type { MaterialFunctionLike } from '@thirdlight/three-adapter';

import type { DialogueDocumentProps } from '../dialogue/DialogueDocument';
import type { PreviewAssets } from '../uidoc/ui-layer-view';

/** What the dialogue previewer reads: the conversation's speakers, settings and UI, and the asset bytes. */
export type DialoguePreviewSource = Pick<DialogueDocumentProps, 'speakers' | 'settings' | 'uiDocuments' | 'uiThemes' | 'assets' | 'readAsset' | 'conversations'>;

export type PreviewRequest =
  /** A graph material on a shape or a model of the project. */
  | { readonly kind: 'material'; readonly materialId: string; readonly materials: readonly MaterialDef[]; readonly functions: readonly MaterialFunctionLike[] }
  /** An effect looping on its timeline. */
  | { readonly kind: 'effect'; readonly effect: EffectDef }
  /** A controller running on its model; `onStates` hears every layer's current state. */
  | { readonly kind: 'animator'; readonly controller: AnimatorController; readonly onStates?: (names: readonly string[]) => void }
  /** A timeline at its playhead, shown on its scene (the editor applies the playhead to the Scene view). */
  | { readonly kind: 'timeline'; readonly timelineId: string }
  /** A conversation played by the game's dialogue UI over its scene; `selection` offers "from the selected node". */
  | { readonly kind: 'dialogue'; readonly dialogue: DialogueDocument; readonly selection: readonly string[]; readonly source: DialoguePreviewSource }
  /** A UI document at a resolution over its scene, fed with the editor's mock values. */
  | { readonly kind: 'ui'; readonly doc: UiDocument; readonly themes: readonly UiTheme[]; readonly mock: Record<string, unknown>; readonly size: { w: number; h: number }; readonly assets: PreviewAssets };

/** The subject a request asks for (a new key builds a new subject; the same key updates it). */
export function previewKey(r: PreviewRequest): string {
  switch (r.kind) {
    case 'material':
      return `material:${r.materialId}`;
    case 'effect':
      return `effect:${r.effect.effectId}`;
    case 'animator':
      return `animator:${r.controller.controllerId}`;
    case 'timeline':
      return `timeline:${r.timelineId}`;
    case 'dialogue':
      return `dialogue:${r.dialogue.dialogueId}`;
    case 'ui':
      return `ui:${r.doc.uiDocumentId}`;
  }
}

export const PreviewRequestContext = createContext<(request: PreviewRequest | null) => void>(() => undefined);

/** Ask the preview pane to show `request` while this editor is in front (null: nothing). */
export function usePreview(request: PreviewRequest | null): void {
  const set = useContext(PreviewRequestContext);
  useEffect(() => set(request), [set, request]);
  useEffect(() => () => set(null), [set]);
}
