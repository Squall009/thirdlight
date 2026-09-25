/**
 * Phase 21.5: releasing three's OrbitControls for good.
 *
 * OrbitControls (three 0.186) adds its Control-key listeners to
 * `domElement.getRootNode()` — the document while the canvas is in the page —
 * and removes them from `getRootNode()` again on `disconnect()`/`dispose()`.
 * A canvas that already left the page (a closed tab or preview pane: React
 * removes the DOM before the cleanup runs; a swapped Scene-view canvas) is its
 * own root node by then, so the removal misses and the document keeps the
 * listener — and through it the controls, their camera, the canvas and the
 * React tree the canvas belonged to. This disposes the controls and removes
 * those listeners from the canvas's document as well (a no-op when the
 * removal already worked).
 */
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type ControlKeyListeners = { _interceptControlDown?: EventListener; _interceptControlUp?: EventListener };

/** Remove the Control-key listeners OrbitControls put on the canvas's document. */
export function releaseControlKeyListeners(controls: OrbitControls): void {
  const c = controls as unknown as ControlKeyListeners;
  const doc = controls.domElement?.ownerDocument;
  if (doc === undefined || doc === null) return;
  if (c._interceptControlDown !== undefined) doc.removeEventListener('keydown', c._interceptControlDown, { capture: true });
  if (c._interceptControlUp !== undefined) doc.removeEventListener('keyup', c._interceptControlUp, { capture: true });
}

/** `controls.dispose()` plus the document listeners a detached canvas would leave behind. */
export function disposeOrbitControls(controls: OrbitControls): void {
  controls.dispose();
  releaseControlKeyListeners(controls);
}
