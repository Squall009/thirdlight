/**
 * Lending the Scene view to the editor window's preview pane or to an edit mode.
 *
 * What is previewed on its scene (a timeline, a conversation, a UI document)
 * is drawn by the Scene view itself: its canvas moves into the pane while
 * such an editor is in front (the window covers the default view, so the
 * Scene view is not seen anywhere else meanwhile) and moves back to its host
 * when the editor leaves. The canvas keeps its context, renderer and scene;
 * a renderer backend change meanwhile replaces it in place, wherever it is.
 *
 * Lent to look at (a preview pane), the canvas takes no pointer input. Lent
 * to edit (an edit mode), it keeps all of it: the camera orbits and zooms,
 * and the Scene view's tools take their presses as in the default view
 * (`data-lent` on the canvas says which).
 */
import { useMemo, type RefObject } from 'react';

import type { Viewport } from '../../viewport/viewport';

/** The Scene view's canvas (its class survives a backend change, which copies the attributes). */
const SCENE_CANVAS = 'canvas.tl-viewport';

/** Why the canvas is lent: to look at (no input) or to edit (pointer input reaches the view and its tools). */
export type LendingUse = 'look' | 'edit';

export interface SceneViewLending {
  borrow(host: HTMLElement, use?: LendingUse): () => void;
  resize(): void;
}

export function useSceneViewLending(homeRef: RefObject<HTMLDivElement | null>, viewportRef: RefObject<Viewport | null>): SceneViewLending {
  return useMemo(
    () => ({
      borrow: (host: HTMLElement, use: LendingUse = 'look') => {
        const home = homeRef.current;
        const canvas = home?.querySelector(SCENE_CANVAS) ?? null;
        if (home === null || canvas === null) return () => undefined;
        canvas.setAttribute('data-lent', use);
        host.appendChild(canvas);
        viewportRef.current?.setLent(true);
        viewportRef.current?.resize();
        return () => {
          const lent = host.querySelector(SCENE_CANVAS);
          if (lent !== null) {
            lent.removeAttribute('data-lent');
            home.appendChild(lent);
          }
          viewportRef.current?.setLent(false);
          viewportRef.current?.resize();
        };
      },
      resize: () => viewportRef.current?.resize(),
    }),
    [homeRef, viewportRef],
  );
}
