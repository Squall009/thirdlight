/**
 * An edit mode's isolation of the Scene view: which objects the mode edits,
 * what the view draws meanwhile and what a click or a tool can hit.
 *
 * - An object's mode (a terrain, a model's vertex paint) names its object:
 *   only it and its descendants are drawn (with Context, the rest too) and
 *   only they are hit.
 * - A scene's mode (decals) names a component instead: the whole scene is
 *   drawn and the objects carrying the component are the edited ones — only
 *   they are hit, followed as they come and go.
 *
 * Either way the gizmo, the selection outline and the other objects'
 * helpers and icons stand aside; the grid and its ground square go while
 * the rest is hidden (they lie at y = 0, where a terrain's ground usually
 * is, and showed through the one object the mode is meant to show).
 *
 * Browser-only (three.js scene state through the host).
 */
import type * as THREE from 'three';

/** An edit mode's isolation: the objects it edits, and whether the rest of the scene is shown as context. */
export interface ViewIsolation {
  readonly ids: readonly string[];
  /** The rest drawn too (still not pickable). */
  readonly context: boolean;
  /** The objects with this component are the edited ones (the scene's mode): the whole scene is drawn and they alone are hit. */
  readonly component?: string;
}

/** What the isolation reads and sets on the Scene view. */
export interface ViewIsolationHost {
  /** An object and its descendants. */
  subtreeIds(rootId: string): readonly string[];
  /** The objects that carry a component now. */
  withComponent(component: string): readonly string[];
  /** The adapter draws only these (null: everything). */
  drawOnly(ids: ReadonlySet<string> | null): void;
  /** The grid and ground square shown or not. */
  showGround(on: boolean): void;
  /** The edited objects' icons stand aside (`all`: every object's, a scene's mode), and their helpers alone are drawn. */
  editing(ids: ReadonlySet<string>, all: boolean): void;
  publish(state: string): void;
  requestRender(): void;
}

export class ViewIsolationState {
  private iso: { ids: ReadonlySet<string>; given: ViewIsolation } | null = null;

  constructor(private readonly host: ViewIsolationHost) {}

  /** Some mode isolates the view. */
  get active(): boolean {
    return this.iso !== null;
  }

  /** The edited objects (with descendants), null while none is open. */
  get ids(): ReadonlySet<string> | null {
    return this.iso?.ids ?? null;
  }

  /** Whether the rest of the scene is hidden (an object's mode without Context). */
  get hidesRest(): boolean {
    const g = this.iso?.given;
    return g !== undefined && !g.context && g.component === undefined;
  }

  /** Open, change or close (null) the isolation; false when nothing changed. */
  set(iso: ViewIsolation | null): boolean {
    if (iso === null && this.iso === null) return false;
    this.iso = iso === null ? null : { ids: this.idsOf(iso), given: iso };
    this.apply();
    this.host.editing(this.iso?.ids ?? new Set(), this.iso?.given.component !== undefined);
    return true;
  }

  /** Objects added, removed or moved under an edited one while the mode is open are drawn (or hidden) like the rest. */
  follow(): void {
    const iso = this.iso;
    if (iso === null) return;
    const ids = this.idsOf(iso.given);
    if (ids.size === iso.ids.size && [...ids].every((id) => iso.ids.has(id))) return;
    this.iso = { ids, given: iso.given };
    this.apply();
    this.host.editing(ids, iso.given.component !== undefined);
  }

  /** Draw as the isolation says (again after a renderer backend change). */
  apply(): void {
    const iso = this.iso;
    this.host.showGround(!this.hidesRest);
    this.host.drawOnly(iso === null || !this.hidesRest ? null : iso.ids);
    this.host.publish(iso === null ? '' : JSON.stringify({ ids: [...iso.given.ids], context: iso.given.context, ...(iso.given.component !== undefined ? { component: iso.given.component } : {}), drawn: iso.ids.size }));
    this.host.requestRender();
  }

  /** The hits a click or a tool may take: only the edited objects' while a mode is open. */
  hits(hits: THREE.Intersection[], owner: (o: THREE.Object3D) => string | null): THREE.Intersection[] {
    const iso = this.iso;
    return iso === null ? hits : hits.filter((h) => iso.ids.has(owner(h.object) ?? ''));
  }

  /** Whether an object's helpers are drawn (all while no mode is open). */
  shows(id: string): boolean {
    return this.iso === null || this.iso.ids.has(id);
  }

  private idsOf(iso: ViewIsolation): Set<string> {
    const ids = new Set<string>();
    const roots = iso.component !== undefined ? [...iso.ids, ...this.host.withComponent(iso.component)] : iso.ids;
    for (const id of roots) for (const x of this.host.subtreeIds(id)) ids.add(x);
    return ids;
  }
}
