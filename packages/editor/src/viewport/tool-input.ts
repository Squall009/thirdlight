/**
 * The Scene view's tools and the routing of pointer input to them.
 *
 * Every tool that edits in the Scene view (vertex paint, block layers and
 * their room tool, terrain, decal grips, the selection's handle grips, the
 * instance brush) is a `SceneTool`. The viewport hands each pointer event to
 * the `ToolRouter` first; only what no tool takes reaches the viewport's own
 * behaviour (the gizmo, orbiting, click-to-pick). An armed tool owns the
 * left button, so the gizmo stands aside while any tool is armed.
 *
 * The router's order is the tools' priority: a vertex paint press on
 * something paintable wins over block and terrain tools, those over the
 * Decal tool's grips, those over handle grips, those over the brush.
 */

import * as THREE from 'three';
import type { InstanceBrush, InstanceStroke } from '@thirdlight/project-model';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { commitValue, type HandleShape } from '../session/handles';
import type { DecalToolSettings } from '../session/decal-place';
import type { VertexPaintSettings } from '../session/vertex-paint-brush';
import type { HelperOverlay } from './helper-overlay';
import { InstanceBrushTool, type InstanceBrushDeps, type InstanceBrushMode } from './instance-brush';
import { BlockEditor, type BlockEditorCallbacks, type BlockEditorHost } from './block-editor';
import { TerrainEditor, type TerrainEditorCallbacks, type TerrainEditorHost } from './terrain-editor';
import { DecalTool, type DecalToolCallbacks, type DecalToolHost } from './decal-tool';
import { VertexPaintTool, type VertexPaintToolCallbacks, type VertexPaintToolHost } from './vertex-paint-tool';

/** A pointer that moved less than this (px) between down and up is a click. */
export const CLICK_SLOP_PX = 4;

/**
 * What a tool did with a press. 'capture': the press begins the tool's
 * gesture (the pointer is captured, orbiting stops until the release).
 * 'consume': the press was the tool's but begins no gesture. null: not the tool's.
 */
export type ToolPress = 'capture' | 'consume' | null;

/**
 * What a tool did with a release. 'stop': it ended the tool's gesture (no
 * other listener sees it). 'pass': the tool acted on it but the orbit
 * controls, which saw the press, must see the release too. null: not the tool's.
 */
export type ToolRelease = 'stop' | 'pass' | null;

/** One Scene-view tool as the router sees it. */
export interface SceneTool {
  readonly name: string;
  /** Armed: the tool owns the left button and the gizmo stands aside. */
  armed(selectedId: string | null): boolean;
  /** A left-button press. */
  pointerDown(e: PointerEvent): ToolPress;
  /** A move; true while the tool owns the pointer (nothing else sees it). */
  pointerMove(e: PointerEvent): boolean;
  /** A release that ends this tool's own gesture. */
  pointerUp(e: PointerEvent): ToolRelease;
  /** A release no tool's gesture claimed (a click a tool acts on, as the Decal tool places). */
  click?(e: PointerEvent): ToolRelease;
  /** The pointer left the view (cursors and previews hide). */
  leave?(): void;
  /** Esc: drop the gesture in flight; true when there was one. */
  cancel(): boolean;
  /** A key while the tool is armed; true when the tool took it. */
  key?(e: KeyboardEvent): boolean;
}

/** What the router needs from the view. */
export interface ToolRouterHost {
  canvas(): HTMLCanvasElement;
  /** Orbiting on or off (off while a tool's gesture owns the pointer). */
  setOrbit(on: boolean): void;
}

/**
 * Hands pointer input and Esc to the Scene view's tools in priority order.
 * `escOrder` names the order Esc asks the tools in (a block layer's room
 * outline, drawn over several presses, is dropped before a stroke a later
 * press began); tools it does not name follow in priority order.
 */
export class ToolRouter {
  private readonly escOrder: readonly SceneTool[];

  constructor(
    private readonly host: ToolRouterHost,
    private readonly tools: readonly SceneTool[],
    escOrder: readonly string[] = [],
  ) {
    const named = escOrder.map((n) => tools.find((t) => t.name === n)).filter((t): t is SceneTool => t !== undefined);
    this.escOrder = [...named, ...tools.filter((t) => !named.includes(t))];
  }

  /** Some tool is armed (the gizmo stands aside). */
  anyArmed(selectedId: string | null): boolean {
    return this.tools.some((t) => t.armed(selectedId));
  }

  /** A left-button press; true when a tool took it (it is then never a click that picks). */
  pointerDown(e: PointerEvent): boolean {
    for (const t of this.tools) {
      const took = t.pointerDown(e);
      if (took === null) continue;
      e.stopImmediatePropagation();
      if (took === 'capture') {
        this.host.setOrbit(false);
        this.host.canvas().setPointerCapture(e.pointerId);
      }
      return true;
    }
    return false;
  }

  /** A move; true when a tool owns the pointer. */
  pointerMove(e: PointerEvent): boolean {
    for (const t of this.tools) {
      if (!t.pointerMove(e)) continue;
      e.stopImmediatePropagation();
      return true;
    }
    return false;
  }

  /** A release: first the tool whose gesture it ends, then a tool that acts on a plain click; true when one did. */
  pointerUp(e: PointerEvent): boolean {
    for (const t of this.tools) if (this.released(e, t.pointerUp(e))) return true;
    for (const t of this.tools) if (t.click !== undefined && this.released(e, t.click(e))) return true;
    return false;
  }

  private released(e: PointerEvent, r: ToolRelease): boolean {
    if (r === null) return false;
    if (r === 'stop') e.stopImmediatePropagation();
    this.host.setOrbit(true);
    return true;
  }

  leave(): void {
    for (const t of this.tools) t.leave?.();
  }

  /** Esc: the first tool with a gesture in flight drops it; true when one did. */
  cancel(): boolean {
    for (const t of this.escOrder) {
      if (!t.cancel()) continue;
      this.host.setOrbit(true);
      return true;
    }
    return false;
  }

  /** A key for the armed tools (the first that takes it); true when one did. */
  key(e: KeyboardEvent, selectedId: string | null): boolean {
    return this.tools.some((t) => t.key !== undefined && t.armed(selectedId) && t.key(e));
  }
}

/** What the Scene view lends its tools. */
export interface ViewportToolsHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly helpers: HelperOverlay;
  canvas(): HTMLCanvasElement;
  selectedId(): string | null;
  /** The selection again: the gizmo follows whether a tool is armed. */
  reselect(): void;
  /** The gizmo axis under the pointer (null: none). */
  gizmoAxis(): string | null;
  snapping(): boolean;
  requestRender(): void;
  blockView: BlockEditorHost['view'];
  terrains: TerrainEditorHost['terrains'];
  /** A handle drag or corner delete to store (one setComponent). */
  handleEdit(entityId: string, component: string, value: Record<string, unknown>): void;
  /** Why an edit cannot be stored (shown to the user). */
  refused(message: string): void;
  /** The view's sides of the Decal tool, the vertex paint tool and the instance brush. */
  decal: DecalToolHost;
  paint: VertexPaintToolHost;
  brush: Omit<InstanceBrushDeps, 'refused'>;
  brushStroke(entityId: string, stroke: InstanceStroke): Promise<boolean>;
}

/**
 * The Scene view's tools: made, armed and routed here. The vertex paint,
 * Decal and instance-brush tools are made with the view; the block and
 * terrain tools on first use, with the App's callbacks.
 */
export class ViewportTools {
  readonly decal: DecalTool;
  readonly paint: VertexPaintTool;
  readonly brush: InstanceBrushTool;
  readonly router: ToolRouter;
  private blockEd: BlockEditor | null = null;
  private terrainEd: TerrainEditor | null = null;
  /** Where the Decal tool's placements and grip edits go (set with the tool's settings). */
  private decalCb: DecalToolCallbacks | null = null;
  private paintCb: VertexPaintToolCallbacks | null = null;
  /** The orbit buttons before the block tools took the left button. */
  private orbitButtons: OrbitControls['mouseButtons'] | null = null;
  /** A handle drag is in flight (the overlay holds the previewed shape). */
  private handleDragging = false;
  /** The left button went down on a brush stroke (its release ends it, even one the brush gave up). */
  private brushPressed = false;

  constructor(private readonly host: ViewportToolsHost) {
    this.brush = new InstanceBrushTool({ ...host.brush, refused: (m) => host.refused(m) }, (id, stroke) => host.brushStroke(id, stroke));
    const decalCb = (): DecalToolCallbacks | null => this.decalCb;
    this.decal = new DecalTool(host.decal, {
      place: (args) => decalCb()?.place(args) ?? Promise.resolve(null),
      turn: (id, t) => decalCb()?.turn(id, t) ?? Promise.resolve(false),
      resize: (id, d) => decalCb()?.resize(id, d) ?? Promise.resolve(false),
      refused: (m) => decalCb()?.refused(m),
    });
    this.paint = new VertexPaintTool(host.paint, { stroke: (args) => this.paintCb?.stroke(args) ?? Promise.resolve({ ok: false, message: 'the Scene view is not connected' }), refused: (m) => this.paintCb?.refused(m) });
    this.router = new ToolRouter({ canvas: () => host.canvas(), setOrbit: (on) => (host.orbit.enabled = on) }, [this.paintTool(), this.blockTool(), this.terrainTool(), this.decalTool(), this.handleTool(), this.brushTool()], ['block', 'terrain', 'handles', 'brush', 'decal', 'paint']);
  }

  /** The block-layer tools (made on first use with the App's callbacks). */
  blockEditor(cb?: BlockEditorCallbacks): BlockEditor | null {
    if (this.blockEd === null && cb !== undefined) {
      const h = this.host;
      this.blockEd = new BlockEditor({ scene: h.overlay, camera: h.camera, canvas: h.canvas(), requestRender: () => h.requestRender(), view: () => h.blockView(), armed: () => h.reselect() }, cb);
    }
    return this.blockEd;
  }

  /** The terrain tools (made on first use with the App's callbacks). */
  terrainEditor(cb?: TerrainEditorCallbacks): TerrainEditor | null {
    if (this.terrainEd === null && cb !== undefined) {
      const h = this.host;
      this.terrainEd = new TerrainEditor({ scene: h.overlay, camera: h.camera, canvas: h.canvas(), requestRender: () => h.requestRender(), terrains: () => h.terrains(), armed: () => h.reselect() }, cb);
    }
    return this.terrainEd;
  }

  /** Arm the block tools: a left drag paints (Alt+drag or the right button orbits), clicks pick no objects. */
  setBlockToolsActive(on: boolean): void {
    const ed = this.blockEd;
    if (ed === null) return;
    ed.setActive(on);
    const orbit = this.host.orbit;
    if (on && this.orbitButtons === null) {
      this.orbitButtons = { ...orbit.mouseButtons };
      orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    } else if (!on && this.orbitButtons !== null) {
      orbit.mouseButtons = this.orbitButtons;
      this.orbitButtons = null;
    }
  }

  /** The instance brush paints or erases on this set (null: off). */
  setInstanceBrush(entityId: string | null, mode: InstanceBrushMode, brush: InstanceBrush): void {
    this.brush.set(entityId, mode, brush);
    this.host.orbit.enabled = true;
    this.host.reselect();
  }

  /** The Decal tool armed with these settings in `sceneId`, its edits sent through `cb` (null: off). */
  setDecalTool(settings: DecalToolSettings | null, sceneId: string | null, cb: DecalToolCallbacks | null): void {
    this.decalCb = cb;
    this.decal.arm(settings, sceneId);
    this.host.reselect();
    this.host.requestRender();
  }

  /** The vertex paint mode armed with these settings, its strokes sent through `cb` (null: off). */
  setVertexPaintTool(settings: VertexPaintSettings | null, cb: VertexPaintToolCallbacks | null): void {
    this.paintCb = cb;
    this.paint.arm(settings);
    this.host.reselect();
  }

  /** Before a frame: the tools' grips and published state follow the view. */
  frame(): void {
    this.decal.frame();
    this.paint.frame();
  }

  /** After a drawn frame. */
  afterFrame(): void {
    this.terrainEd?.afterFrame();
  }

  dispose(): void {
    this.blockEd?.dispose();
    this.blockEd = null;
    this.terrainEd?.dispose();
    this.terrainEd = null;
    this.brush.dispose();
    this.decal.dispose();
    this.paint.dispose();
  }

  // ---- The tools as the router sees them -----------------------------------

  private paintTool(): SceneTool {
    const p = this.paint;
    return {
      name: 'paint',
      armed: () => p.armed(),
      // Only a press on something it paints is the tool's: a press elsewhere still orbits, picks or edits.
      pointerDown: (e) => (p.pointerDown(e) ? 'capture' : null),
      pointerMove: (e) => p.pointerMove(e),
      pointerUp: (e) => (p.pointerUp(e) ? 'stop' : null),
      leave: () => p.leave(),
      cancel: () => p.cancel(),
    };
  }

  /** The block or terrain tools: armed, they take the left button; the Decal tool, opened over them, wins. */
  private editorTool(name: string, ed: () => BlockEditor | TerrainEditor | null): SceneTool {
    const live = (): BlockEditor | TerrainEditor | null => (this.decal.armed() ? null : ed());
    return {
      name,
      armed: () => ed()?.isActive() === true,
      pointerDown: (e) => {
        const x = live();
        return x?.isActive() === true && x.pointerDown(e) ? 'capture' : null;
      },
      pointerMove: (e) => {
        const x = live();
        return x?.isActive() === true && x.pointerMove(e);
      },
      // A stroke ends on release even when the tools were disarmed meanwhile.
      pointerUp: (e) => (live()?.pointerUp(e) === true ? 'stop' : null),
      cancel: () => ed()?.cancel() === true,
    };
  }

  private blockTool(): SceneTool {
    return this.editorTool('block', () => this.blockEd);
  }

  private terrainTool(): SceneTool {
    return this.editorTool('terrain', () => this.terrainEd);
  }

  private decalTool(): SceneTool {
    const d = this.decal;
    return {
      name: 'decal',
      armed: () => d.armed(),
      // The turn and size grips (a press elsewhere may still be its click that places).
      pointerDown: (e) => (d.pointerDown(e) ? 'capture' : null),
      pointerMove: (e) => d.pointerMove(e),
      pointerUp: (e) => (d.dragging() && d.pointerUp(e, CLICK_SLOP_PX) === 'drag' ? 'stop' : null),
      // A click places a decal (it picks nothing); its press also went to the orbit controls.
      click: (e) => {
        const r = d.pointerUp(e, CLICK_SLOP_PX);
        return r === null ? null : r === 'drag' ? 'stop' : 'pass';
      },
      leave: () => d.leave(),
      cancel: () => d.cancel(),
    };
  }

  /** The selected entity's handle grips: Alt+click deletes a corner/point, a drag edits (one command on release). */
  private handleTool(): SceneTool {
    const h = this.host;
    return {
      name: 'handles',
      armed: () => false,
      pointerDown: (e) => {
        const grip = h.helpers.pickHandle(e.clientX, e.clientY);
        if (grip === null) return null;
        // A press on a grip is never a click that picks (or deselects) what is under it.
        if (e.altKey && grip.role === 'vertex') {
          const del = h.helpers.deleteHandlePoint(grip);
          if (!del.ok) h.refused(del.message);
          else this.commitHandle(del.shape);
          return 'consume';
        }
        if (!h.helpers.beginHandleDrag(grip)) return 'consume';
        this.handleDragging = true;
        h.requestRender();
        return 'capture';
      },
      pointerMove: (e) => {
        if (!this.handleDragging) return false;
        h.helpers.moveHandleDrag(e.clientX, e.clientY, h.snapping());
        h.requestRender();
        return true;
      },
      pointerUp: () => {
        if (!this.handleDragging) return null;
        this.handleDragging = false;
        const shape = h.helpers.endHandleDrag();
        h.requestRender();
        if (shape !== null) this.commitHandle(shape);
        return 'stop';
      },
      cancel: () => {
        if (!this.handleDragging) return false;
        this.handleDragging = false;
        h.helpers.cancelHandleDrag();
        h.requestRender();
        return true;
      },
    };
  }

  /** Store a handle shape (one setComponent), or say why it cannot be stored. */
  private commitHandle(shape: HandleShape): void {
    const edit = commitValue(shape);
    if (edit === null) return;
    if (!edit.ok) {
      this.host.refused(edit.message);
      return;
    }
    this.host.handleEdit(shape.entityId, edit.component, edit.value);
  }

  /** The instance brush paints or erases on the selected set (not while the gizmo is under the pointer). */
  private brushTool(): SceneTool {
    const b = this.brush;
    const h = this.host;
    return {
      name: 'brush',
      armed: (sel) => b.active(sel),
      pointerDown: (e) => {
        if (!b.active(h.selectedId()) || e.altKey || h.gizmoAxis() !== null || !b.begin(e.clientX, e.clientY)) return null;
        this.brushPressed = true;
        return 'capture';
      },
      pointerMove: (e) => {
        if (!b.active(h.selectedId())) return false;
        b.move(e.clientX, e.clientY);
        return b.stroking();
      },
      pointerUp: (e) => {
        if (!this.brushPressed) return null;
        this.brushPressed = false;
        b.end(e.clientX, e.clientY);
        return 'stop';
      },
      leave: () => b.leave(),
      cancel: () => b.cancel(),
    };
  }
}
