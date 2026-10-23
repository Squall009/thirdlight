/**
 * The Scene view's pointer input: the armed tools see it first (in the
 * capture phase, before the orbit and gizmo controls); a left click that is
 * not a drag picks (or deselects), a click on a copy of the selected instance
 * set selects that copy, and a double-click opens the object's edit mode.
 *
 * Browser-only (DOM events).
 */
import type { ProjectedEntity } from '../session/projection';
import type { CopySelection } from './copy-selection';
import type { SceneQueries } from './scene-queries';
import type { SelectionGizmo } from './selection-gizmo';
import { CLICK_SLOP_PX, type ViewportTools } from './tool-input';
import type { ViewIsolationState } from './view-isolation';

export interface ViewPointerHost {
  readonly root: () => HTMLElement;
  readonly tools: ViewportTools;
  readonly gizmo: () => SelectionGizmo;
  readonly isolation: ViewIsolationState;
  readonly selectedId: () => string | null;
  readonly synced: ReadonlyMap<string, ProjectedEntity>;
  readonly queries: SceneQueries;
  readonly copies: CopySelection;
  readonly picked: (entityId: string | null) => void;
  readonly copyPicked: (entityId: string, index: number) => void;
  readonly doublePicked: (entityId: string) => void;
  readonly resize: () => void;
}

export class ViewPointer {
  private downAt: { x: number; y: number } | null = null;

  constructor(private readonly host: ViewPointerHost) {}

  /** Listen on the canvas and the window. */
  bind(): void {
    this.bindCanvas();
    window.addEventListener('resize', this.onWindowResize);
  }

  unbind(): void {
    this.unbindCanvas();
    window.removeEventListener('resize', this.onWindowResize);
  }

  bindCanvas(): void {
    const root = this.host.root();
    // Capture phase: the handle grips route before the orbit/gizmo controls.
    root.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    root.addEventListener('pointermove', this.onPointerMove, { capture: true });
    root.addEventListener('pointerup', this.onPointerUp, { capture: true });
    root.addEventListener('contextmenu', this.onContextMenu);
    root.addEventListener('pointerleave', this.onPointerLeave);
    root.addEventListener('dblclick', this.onDoubleClick);
  }

  unbindCanvas(): void {
    const root = this.host.root();
    root.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    root.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    root.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    root.removeEventListener('contextmenu', this.onContextMenu);
    root.removeEventListener('pointerleave', this.onPointerLeave);
    root.removeEventListener('dblclick', this.onDoubleClick);
  }

  private onPointerLeave = (): void => this.host.tools.router.leave();

  private onContextMenu = (e: Event): void => e.preventDefault();

  /** A double-click a tool takes (going into a building); else one on an object opens its edit mode (never while a tool owns the clicks or a mode is open). */
  private onDoubleClick = (e: MouseEvent): void => {
    if (this.host.tools.router.doubleClick(e)) return;
    if (e.button !== 0 || this.host.isolation.active || this.host.tools.router.anyArmed(this.host.selectedId())) return;
    const id = this.host.queries.pick(e.clientX, e.clientY);
    if (id !== null) this.host.doublePicked(id);
  };

  private onWindowResize = (): void => this.host.resize();

  private onPointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button !== 0) return;
    // A press a tool takes is never a click that picks (or deselects) what is under it.
    if (this.host.tools.router.pointerDown(e)) this.downAt = null;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.host.tools.router.pointerMove(e)) return;
    const gizmo = this.host.gizmo();
    if (gizmo.dragging) gizmo.applySnapping();
  };

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.downAt;
    this.downAt = null;
    // A tool's gesture ends (its press never reached the orbit controls), or a tool acts on the click.
    if (this.host.tools.router.pointerUp(e)) return;
    // A left click (no drag, not on a gizmo handle) picks or deselects; in an edit mode its tools own the clicks.
    const gizmo = this.host.gizmo();
    if (e.button !== 0 || down === null || gizmo.dragging || gizmo.axis !== null || this.host.isolation.active) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    // With an instance set selected, a click on one of its copies selects that copy.
    const sel = this.host.selectedId();
    if (sel !== null && this.host.synced.get(sel)?.instances !== undefined) {
      const copy = this.host.copies.pick(e.clientX, e.clientY, sel);
      if (copy !== null) {
        this.host.copyPicked(sel, copy);
        return;
      }
    }
    this.host.picked(this.host.queries.pick(e.clientX, e.clientY));
  };
}
