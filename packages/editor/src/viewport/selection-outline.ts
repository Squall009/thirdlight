/**
 * The outline around the selection's drawn bounds (what the adapter draws
 * for it: a box, a model, an instance set), made again when the selection
 * moved, loaded or changed.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

/** The selection outline's colour. */
const SELECTION_OUTLINE = 0x6ea8ff;

export class SelectionOutline {
  /** The outline follows the selection's drawn bounds (moved, loaded, changed). */
  dirty = true;
  private outline: THREE.Box3Helper | null = null;

  constructor(private readonly overlay: THREE.Object3D) {}

  /** Outline `box` for `id` (null or empty: none); `data-selection-outline` names the entity wearing it. */
  update(root: HTMLElement, id: string | null, box: THREE.Box3 | null): void {
    this.dirty = false;
    this.outline?.removeFromParent();
    this.outline?.dispose();
    this.outline = null;
    root.setAttribute('data-selection-outline', box === null || box.isEmpty() ? '' : id!);
    if (box === null || box.isEmpty()) return;
    this.outline = new THREE.Box3Helper(box, SELECTION_OUTLINE);
    this.outline.name = `selection:${id}`;
    this.outline.raycast = () => undefined;
    this.overlay.add(this.outline);
  }

  dispose(): void {
    this.outline?.dispose();
    this.outline = null;
  }
}
