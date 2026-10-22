/**
 * The scenes open in this browser (the hierarchy and the viewport show them)
 * and the active one (new root entities go there). Remembered per project in
 * localStorage; never part of the project.
 */

import type { Projection, ProjectedEntity } from './projection';

export class OpenScenes {
  private open: string[] = [];
  private active: string | null = null;
  private visibleCache: { all: ProjectedEntity[]; open: readonly string[]; list: ProjectedEntity[] } | null = null;

  constructor(
    private readonly projection: Projection,
    private readonly projectId: string,
  ) {}

  get activeScene(): string | null {
    return this.active;
  }

  /** The open scenes (in index order) and the active one; empty for a single-scene project. */
  view(): { open: readonly string[]; active: string | null } {
    return { open: this.open, active: this.active };
  }

  /** The entities of the open scenes (all of them for a single-scene project). */
  visibleEntities(): ProjectedEntity[] {
    const all = this.projection.listEntities();
    if (this.projection.scenes.length === 0) return all;
    // The same array until the projection or the open scenes change,
    // so views keyed on it (the Hierarchy, the Scene view sync) skip unchanged updates.
    const c = this.visibleCache;
    if (c !== null && c.all === all && c.open === this.open) return c.list;
    const open = new Set(this.open);
    const list = all.filter((e) => e.sceneId === undefined || open.has(e.sceneId));
    this.visibleCache = { all, open: this.open, list };
    return list;
  }

  /** Open or close a scene (the last open scene stays open). False for a scene the index does not hold. */
  setOpen(sceneId: string, open: boolean): boolean {
    const known = this.projection.scenes.some((r) => r.sceneId === sceneId);
    if (!known) return false;
    if (open && !this.open.includes(sceneId)) this.open = [...this.open, sceneId];
    if (!open && this.open.length > 1) this.open = this.open.filter((id) => id !== sceneId);
    this.reconcile();
    return true;
  }

  /** Make a scene the active one (it is opened if needed). False for a scene the index does not hold. */
  setActive(sceneId: string): boolean {
    if (!this.projection.scenes.some((r) => r.sceneId === sceneId)) return false;
    if (!this.open.includes(sceneId)) this.open = [...this.open, sceneId];
    this.active = sceneId;
    this.reconcile();
    return true;
  }

  /** Keep the open/active scenes valid for the current index and remember them. */
  reconcile(): void {
    const scenes = this.projection.scenes;
    if (scenes.length === 0) {
      this.open = [];
      this.active = null;
      return;
    }
    const key = `thirdlight.scenes.${this.projectId}`;
    if (this.open.length === 0 && this.active === null) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { open?: unknown; active?: unknown } | null;
        if (saved !== null && Array.isArray(saved.open)) this.open = saved.open.filter((x): x is string => typeof x === 'string');
        if (saved !== null && typeof saved.active === 'string') this.active = saved.active;
      } catch {
        // storage blocked or corrupt: start from the start scenes
      }
    }
    const known = new Set(scenes.map((r) => r.sceneId));
    let open = this.open.filter((id) => known.has(id));
    if (open.length === 0) open = this.projection.startScenes.filter((id) => known.has(id));
    if (open.length === 0) open = [scenes[0]!.sceneId];
    // Index order keeps the hierarchy stable.
    this.open = scenes.map((r) => r.sceneId).filter((id) => open.includes(id));
    if (this.active === null || !this.open.includes(this.active)) this.active = this.open[0]!;
    try {
      localStorage.setItem(key, JSON.stringify({ open: this.open, active: this.active }));
    } catch {
      // the choice still holds for this page
    }
  }
}
