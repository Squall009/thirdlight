/**
 * Objects occlusion culling never leaves out: what a host is working on (an
 * editor's selection, the object an edit mode edits). Their draws are drawn
 * whole by every culling path, whatever is in front of them: the user works
 * on what they picked, and an outline, a gizmo or a brush drawn over it
 * stays over the object itself.
 *
 * A draw belongs to an object as isolation tells it (`drawOwner`: its
 * logical parents, a view's owner mark: a block layer's chunks, a terrain's
 * pages, a scatter source's copies). An object drawn through a batch or a
 * merged cell keeps that whole draw: the batches stay as they are (a
 * selection never regroups them), the draw is only not tested.
 *
 * Once a frame, while a culling path is on and something is kept, after the
 * batches are grouped and before occlusion runs; the scene's drawables are
 * swept (owners read once per drawable, as isolation does). Nothing is
 * marked while no path is on.
 */
import type * as THREE from 'three';

import { drawOwner } from './isolation-view';
import { keepFromOcclusion } from './view-hidden';

export interface OcclusionKeepHost {
  readonly scene: THREE.Scene;
  /** The entity an object's logical parents name, or null. */
  entityOf(o: THREE.Object3D): string | null;
  /** An entity's node (its meshes hang below it), if realized. */
  node(entityId: string): THREE.Object3D | undefined;
  /** The batch or merged cell a mesh is drawn through now (null: drawn alone). */
  drawOf(mesh: THREE.Mesh): THREE.Object3D | null;
}

export class OcclusionKeep {
  private ids: ReadonlySet<string> = new Set();
  /** The draws kept now (marked). */
  private kept = new Set<THREE.Object3D>();
  private owners = new WeakMap<THREE.Object3D, string | null>();

  constructor(private readonly host: OcclusionKeepHost) {}

  /** Keep these objects' draws from occlusion culling (an empty set: none). */
  set(ids: ReadonlySet<string>): void {
    this.ids = new Set(ids);
  }

  /** The draws kept in the last frame. */
  get size(): number {
    return this.kept.size;
  }

  /** Mark the kept objects' draws (`culling`: a path is on; off, every mark goes). */
  update(culling: boolean): void {
    if (!culling || this.ids.size === 0) {
      if (this.kept.size > 0) this.release();
      return;
    }
    const ids = this.ids;
    const next = new Set<THREE.Object3D>();
    for (const o of this.host.scene.children) {
      let owner = this.owners.get(o);
      if (owner === undefined) {
        owner = drawOwner(o, (x) => this.host.entityOf(x));
        // A batch's mesh is reused for other groups: its owner is never cached (its members are found below).
        if (o.userData['tlBatch'] !== true) this.owners.set(o, owner);
      }
      if (owner !== null && ids.has(owner)) next.add(o);
    }
    // Members drawn through a batch or a merged cell: that draw is kept whole.
    for (const id of ids) {
      this.host.node(id)?.traverse((m) => {
        if ((m as THREE.Mesh).isMesh !== true) return;
        const shared = this.host.drawOf(m as THREE.Mesh);
        if (shared !== null) next.add(shared);
      });
    }
    for (const o of this.kept) if (!next.has(o)) keepFromOcclusion(o, false);
    for (const o of next) keepFromOcclusion(o, true);
    this.kept = next;
  }

  dispose(): void {
    this.release();
    this.ids = new Set();
    this.owners = new WeakMap();
  }

  private release(): void {
    for (const o of this.kept) keepFromOcclusion(o, false);
    this.kept.clear();
  }
}
