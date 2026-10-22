/**
 * One selected copy of an instance set: the stand-in the gizmo moves (in the
 * set's local frame, from the stored buffer), the box drawn around the copy,
 * the click that picks a copy, and where the copies are on screen. A drag
 * previews the copy locally; its release stores one buffer (the caller).
 *
 * Browser-only (three.js, the scene adapter).
 */
import type { SceneAdapter } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import type { ProjectedEntity } from '../session/projection';
import { clampScale } from '../session/snapping';
import { copyAt, type CopyTransform } from '../session/instance-copies';
import { frameObject, type SceneQueries } from './scene-queries';

/** The selected copy's box colour. */
const COPY_HIGHLIGHT = 0xffe27a;
/** At most this many copies are reported on screen (tests click them). */
const COPY_POINTS_MAX = 64;

export interface CopySelectionHost {
  readonly adapter: () => SceneAdapter;
  readonly root: () => HTMLElement;
  readonly camera: THREE.Camera;
  readonly overlay: THREE.Object3D;
  readonly synced: ReadonlyMap<string, ProjectedEntity>;
  /** Made after the copies (the adapter may report content while it is made). */
  readonly queries: () => SceneQueries;
  readonly selectedId: () => string | null;
  readonly requestRender: () => void;
}

export class CopySelection {
  private sel: { entityId: string; index: number } | null = null;
  /** The copy gizmo's stand-in; its parent frame is the set's world matrix (copies are in its local frame). */
  private readonly frame = frameObject();
  readonly proxy = new THREE.Object3D();
  private highlight: THREE.Box3Helper | null = null;

  constructor(private readonly host: CopySelectionHost) {
    this.frame.add(this.proxy);
  }

  get selection(): { entityId: string; index: number } | null {
    return this.sel;
  }

  /** The stand-in stands on a copy (the gizmo may take it). */
  get placed(): boolean {
    return this.proxy.parent !== null;
  }

  /** Select one copy of the selected instance set (null: the whole set). */
  select(index: number | null): void {
    const selected = this.host.selectedId();
    this.sel = index === null || selected === null ? null : { entityId: selected, index };
  }

  /** Another object was selected: no copy is. */
  clear(): void {
    this.sel = null;
  }

  read(): CopyTransform {
    const p = this.proxy;
    return { position: [p.position.x, p.position.y, p.position.z], rotation: [p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w], scale: [clampScale(p.scale.x), clampScale(p.scale.y), clampScale(p.scale.z)] };
  }

  /** Preview the selected copy where the stand-in is (the stored buffer is untouched). */
  previewDrag(): void {
    if (this.sel === null) return;
    const t = this.read();
    this.preview(this.sel.entityId, this.sel.index, [...t.position, ...t.rotation, ...t.scale]);
    this.updateHighlight();
  }

  /** Preview one copy at a transform while it is dragged (the stored buffer is untouched). */
  private preview(entityId: string, index: number, transform: readonly number[]): void {
    this.host.adapter().instanceSet?.(entityId)?.setCopy(index, transform);
    this.host.requestRender();
  }

  /** Put the gizmo's stand-in on the selected copy (from the stored buffer; `reset` also redraws the copy there). */
  sync(reset = false): void {
    const sel = this.sel;
    const e = sel === null ? undefined : this.host.synced.get(sel.entityId);
    if (sel !== null && (e?.instances === undefined || sel.index >= e.instances.count)) this.sel = null;
    const now = this.sel;
    const world = now === null ? null : this.host.queries().worldOf(now.entityId);
    if (now === null || world === null) {
      this.proxy.removeFromParent();
      this.updateHighlight();
      return;
    }
    // A buffer still loading keeps the stand-in where it is (the drag left it at the stored transform).
    const floats = e?.instances !== undefined ? this.host.adapter().instanceBuffer?.(e.instances.buffer) : undefined;
    const t = floats === undefined ? null : copyAt(floats, now.index);
    this.frame.matrix.copy(world);
    this.frame.matrixWorld.copy(world);
    if (this.proxy.parent !== this.frame) this.frame.add(this.proxy);
    if (t !== null) {
      this.proxy.position.set(...t.position);
      this.proxy.quaternion.set(...t.rotation);
      this.proxy.scale.set(...t.scale);
      if (reset) this.preview(now.entityId, now.index, [...t.position, ...t.rotation, ...t.scale]);
    }
    this.proxy.updateMatrixWorld(true);
    this.updateHighlight();
  }

  /** A box around the selected copy (and its index on the view element, for tests). */
  private updateHighlight(): void {
    this.highlight?.removeFromParent();
    this.highlight?.dispose();
    this.highlight = null;
    const sel = this.sel;
    this.host.root().setAttribute('data-instance-copy', sel === null ? '' : String(sel.index));
    if (sel === null) return;
    // The set is drawn in chunks; it finds the copy's own bounds.
    const set = this.host.adapter().instanceSet?.(sel.entityId) ?? null;
    set?.group.updateWorldMatrix(true, true);
    const box = set?.copyBox(sel.index) ?? null;
    if (box === null) return;
    this.highlight = new THREE.Box3Helper(box, COPY_HIGHLIGHT);
    this.highlight.raycast = () => undefined;
    this.host.overlay.add(this.highlight);
  }

  /** The copy of an instance set under the pointer, or null. */
  pick(clientX: number, clientY: number, entityId: string): number | null {
    const adapter = this.host.adapter();
    const set = adapter.instanceSet?.(entityId) ?? null;
    const meshes = set?.meshes ?? [];
    if (set === null || meshes.length === 0) return null;
    const queries = this.host.queries();
    queries.aim(clientX, clientY);
    adapter.sync?.();
    for (const h of queries.raycaster.intersectObjects([...meshes], false)) {
      if (h.instanceId === undefined) continue;
      const copy = set.copyOf(h.object, h.instanceId);
      if (copy !== null) return copy;
    }
    return null;
  }

  /** Where the copies of an instance set are on screen (the middle of each drawn copy; tests click them). */
  clientPoints(entityId: string): { index: number; x: number; y: number }[] {
    const set = this.host.adapter().instanceSet?.(entityId) ?? null;
    if (set === null) return [];
    const rect = this.host.root().getBoundingClientRect();
    set.group.updateWorldMatrix(true, true);
    const out: { index: number; x: number; y: number }[] = [];
    const centre = new THREE.Vector3();
    for (let i = 0; i < Math.min(COPY_POINTS_MAX, set.count); i++) {
      const box = set.copyBox(i);
      if (box === null) continue;
      const v = box.getCenter(centre).project(this.host.camera);
      out.push({ index: i, x: Math.round(rect.left + ((v.x + 1) / 2) * rect.width), y: Math.round(rect.top + ((1 - v.y) / 2) * rect.height) });
    }
    return out;
  }

  dispose(): void {
    this.highlight?.removeFromParent();
    this.highlight?.dispose();
    this.highlight = null;
  }
}
