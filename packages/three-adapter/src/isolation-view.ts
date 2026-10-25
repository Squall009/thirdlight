/**
 * An editor's edit mode isolating objects: only they are drawn in the view.
 *
 * Every other drawable leaves the view's and the shadow cameras' layers
 * (`view-hidden.ts`): the object is seen alone, without the shadows of what
 * is not drawn, and lit by the scene's lights as before. Nothing is removed
 * from or added to the scene (no realizing again, no program built) and
 * turning isolation off is a layer flip; the cached static shadow is drawn
 * again once each way.
 *
 * A drawable belongs to the entity named by its logical parents (an entity's
 * node, a terrain page's, a spline's or a generated building's root, or a
 * view's group marked with {@link VIEW_OWNER_KEY}: a block layer's chunks, a
 * scatter source's copies). Batches and merged cells draw several objects
 * at once and are hidden whole, so the isolated objects' own meshes are
 * taken out of them while isolated ({@link ISOLATED_DRAW_KEY}): they draw on
 * their own meanwhile. What belongs to no object (the sky, the fog dome, an
 * editor's overlays) stays drawn.
 *
 * Once a frame while on, after the batches are grouped, the scene's
 * drawables are swept (a few thousand userData reads): what came into the
 * scene since (a streamed tile, a LOD level switched in) is placed too.
 */
import type * as THREE from 'three';

import { ISOLATED_DRAW_KEY } from './batching';
import { mergedOwnerOf } from './static-merge';
import { PATH_PAINT_ENTITY_KEY } from './vertex-paint-paths-view';
import { HIDDEN_BY_ISOLATION, hideFromView } from './view-hidden';

/** `object.userData[VIEW_OWNER_KEY]`: the entity a view's group draws for (a block layer's chunks, a scatter source's copies). */
export const VIEW_OWNER_KEY = '__tlViewOwner';

/** A drawable that draws for several objects at once (a batch, a merged cell): never one isolated object's. */
const SHARED_DRAW = '\u0000shared';

export interface IsolationHost {
  readonly scene: THREE.Scene;
  /** The entity an object's logical parents name (an entity node, a terrain page), or null. */
  entityOf(o: THREE.Object3D): string | null;
  /** An entity's node (its meshes hang below it), if realized. */
  node(entityId: string): THREE.Object3D | undefined;
  /** The meshes under `o` are grouped again (they became batchable or not). */
  regroup(o: THREE.Object3D): void;
  /** Casters left or joined the shadows (the cached static shadow is drawn again). */
  shadowsChanged(): void;
}

export interface IsolationDiagnostics {
  /** Objects isolated (0: off). */
  readonly isolated: number;
  /** Drawables hidden by the last sweep, and the drawables swept. */
  readonly hidden: number;
  readonly swept: number;
  readonly sweepMs: number;
}

/** The entity a drawable draws for: a logical parent's mark, a merged cell's one owner, else shared (a batch) or nothing (the sky, overlays). */
export function drawOwner(o: THREE.Object3D, entityOf: (o: THREE.Object3D) => string | null): string | null {
  const id = entityOf(o);
  if (id !== null) return id;
  for (let x: THREE.Object3D | null = o; x !== null; x = x.parent) {
    const mark = (x.userData[VIEW_OWNER_KEY] ?? x.userData[PATH_PAINT_ENTITY_KEY]) as unknown;
    if (typeof mark === 'string') return mark;
  }
  return o.userData['tlBatch'] === true ? (mergedOwnerOf(o) ?? SHARED_DRAW) : null;
}

export class IsolationView {
  private ids: ReadonlySet<string> | null = null;
  /** The isolated entities' nodes whose meshes are marked unbatchable now. */
  private readonly marked = new Map<string, THREE.Object3D>();
  /** Drawables hidden for isolation (unhidden when it ends or they leave the scene). */
  private readonly hidden = new Set<THREE.Object3D>();
  /** Each drawable's owner, read once (a drawable keeps its logical parents). */
  private owners = new WeakMap<THREE.Object3D, string | null>();
  private d: IsolationDiagnostics = { isolated: 0, hidden: 0, swept: 0, sweepMs: 0 };

  constructor(private readonly host: IsolationHost) {}

  /** Draw only these entities (null: everything again); true when that changed what is isolated. */
  set(ids: ReadonlySet<string> | null): boolean {
    const same = ids === null ? this.ids === null : this.ids !== null && ids.size === this.ids.size && [...ids].every((id) => this.ids!.has(id));
    if (same) return false;
    this.ids = ids === null ? null : new Set(ids);
    for (const [id, node] of this.marked) {
      if (this.ids?.has(id) === true) continue;
      this.mark(node, false);
      this.marked.delete(id);
    }
    if (this.ids === null) {
      for (const o of this.hidden) hideFromView(o, HIDDEN_BY_ISOLATION, false);
      if (this.hidden.size > 0) this.host.shadowsChanged();
      this.hidden.clear();
      this.d = { isolated: 0, hidden: 0, swept: 0, sweepMs: 0 };
    }
    return true;
  }

  active(): boolean {
    return this.ids !== null;
  }

  /** Before the batches are grouped: the isolated objects' meshes leave their batches and cells (once realized). */
  beforeBatch(): void {
    const ids = this.ids;
    if (ids === null) return;
    for (const id of ids) {
      const node = this.host.node(id);
      if (node === undefined || this.marked.get(id) === node) continue;
      const was = this.marked.get(id);
      if (was !== undefined) this.mark(was, false);
      this.mark(node, true);
      this.marked.set(id, node);
    }
  }

  /** After the batches are grouped: every drawable not the isolated objects' leaves the view. True when one changed. */
  sweep(): boolean {
    const ids = this.ids;
    if (ids === null) return false;
    const t0 = performance.now();
    let changed = false;
    let hiddenNow = 0;
    const seen = new Set<THREE.Object3D>();
    const children = this.host.scene.children;
    for (const o of children) {
      if ((o as THREE.Light).isLight === true) continue;
      let owner = this.owners.get(o);
      if (owner === undefined) {
        owner = drawOwner(o, (x) => this.host.entityOf(x));
        // A batch's mesh is reused for other groups: its owner is never cached.
        if (owner !== SHARED_DRAW) this.owners.set(o, owner);
      }
      const hide = owner !== null && !ids.has(owner);
      if (hideFromView(o, HIDDEN_BY_ISOLATION, hide)) changed = true;
      if (!hide) continue;
      seen.add(o);
      this.hidden.add(o);
      hiddenNow += 1;
    }
    // Hidden ones that left the scene meanwhile come back as they were (a parked member, a dropped level).
    for (const o of this.hidden) {
      if (seen.has(o)) continue;
      if (hideFromView(o, HIDDEN_BY_ISOLATION, false)) changed = true;
      this.hidden.delete(o);
    }
    this.d = { isolated: ids.size, hidden: hiddenNow, swept: children.length, sweepMs: performance.now() - t0 };
    if (changed) this.host.shadowsChanged();
    return changed;
  }

  diagnostics(): IsolationDiagnostics {
    return this.d;
  }

  dispose(): void {
    this.set(null);
    this.owners = new WeakMap();
  }

  private mark(node: THREE.Object3D, on: boolean): void {
    node.traverse((o) => {
      if ((o as THREE.Mesh).isMesh !== true) return;
      if (on) o.userData[ISOLATED_DRAW_KEY] = true;
      else delete o.userData[ISOLATED_DRAW_KEY];
    });
    this.host.regroup(node);
  }
}
