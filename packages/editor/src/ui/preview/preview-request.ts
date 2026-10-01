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
import type { AnimatorController, EffectDef, MaterialDef } from '@thirdlight/project-model';
import type { MaterialFunctionLike } from '@thirdlight/three-adapter';

export type PreviewRequest =
  /** A graph material on a shape or a model of the project. */
  | { readonly kind: 'material'; readonly materialId: string; readonly materials: readonly MaterialDef[]; readonly functions: readonly MaterialFunctionLike[] }
  /** An effect looping on its timeline. */
  | { readonly kind: 'effect'; readonly effect: EffectDef }
  /** A controller running on its model; `onStates` hears every layer's current state. */
  | { readonly kind: 'animator'; readonly controller: AnimatorController; readonly onStates?: (names: readonly string[]) => void };

/** The subject a request asks for (a new key builds a new subject; the same key updates it). */
export function previewKey(r: PreviewRequest): string {
  switch (r.kind) {
    case 'material':
      return `material:${r.materialId}`;
    case 'effect':
      return `effect:${r.effect.effectId}`;
    case 'animator':
      return `animator:${r.controller.controllerId}`;
  }
}

export const PreviewRequestContext = createContext<(request: PreviewRequest | null) => void>(() => undefined);

/** Ask the preview pane to show `request` while this editor is in front (null: nothing). */
export function usePreview(request: PreviewRequest | null): void {
  const set = useContext(PreviewRequestContext);
  useEffect(() => set(request), [set, request]);
  useEffect(() => () => set(null), [set]);
}
