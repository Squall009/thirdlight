/**
 * Lending the Scene view to the editor window's preview pane.
 *
 * What is previewed on its scene (a timeline, a conversation, a UI document)
 * is drawn by the Scene view itself: its canvas moves into the pane while
 * such an editor is in front (the window covers the default view, so the
 * Scene view is not seen anywhere else meanwhile) and moves back to its host
 * when the editor leaves. The canvas keeps its context, renderer and scene;
 * a renderer backend change meanwhile replaces it in place, wherever it is.
 */
import { useMemo, type RefObject } from 'react';

import type { Viewport } from '../../viewport/viewport';

/** The Scene view's canvas (its class survives a backend change, which copies the attributes). */
const SCENE_CANVAS = 'canvas.tl-viewport';

export function useSceneViewLending(homeRef: RefObject<HTMLDivElement | null>, viewportRef: RefObject<Viewport | null>): { borrow(host: HTMLElement): () => void; resize(): void } {
  return useMemo(
    () => ({
      borrow: (host: HTMLElement) => {
        const home = homeRef.current;
        const canvas = home?.querySelector(SCENE_CANVAS) ?? null;
        if (home === null || canvas === null) return () => undefined;
        host.appendChild(canvas);
        viewportRef.current?.resize();
        return () => {
          const lent = host.querySelector(SCENE_CANVAS);
          if (lent !== null) home.appendChild(lent);
          viewportRef.current?.resize();
        };
      },
      resize: () => viewportRef.current?.resize(),
    }),
    [homeRef, viewportRef],
  );
}
