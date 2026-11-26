/**
 * The Scene view's structure tool, armed by the structure mode (and, to draw
 * a new building, by GameObject → Structure). Every edit it makes is one
 * existing command, sent when a gesture ends (one undo step a drag):
 *
 * - **Create**: a drag on the voxel world's ground (the ground under the
 *   press, found by the view's voxel pick; the drag then runs on that level)
 *   draws a rectangle on the world's 0.5 m lattice, aligned with it; the
 *   release makes the structure (`createEntity`).
 * - **Shape**: handles on the structure's own grid: a corner moves its two
 *   edges, an edge's middle moves the edge, in whole cells; the arrow over
 *   the roof drags storeys up or down (a ghost shows the new height); the
 *   knob on the ring turns the structure about its footprint's middle,
 *   snapped to 15° (Shift: free). A drag previews live (the outline, the
 *   ghost, the turned house) and sends `setComponent` or `setTransform` at
 *   its end; a shape the building generator refuses is not sent and its
 *   check's message is said.
 * - **Extend**: a drag on the structure's floor level draws a rectangle in
 *   its grid that becomes another polygon (an L, a T, a wing).
 * - **Openings**: over a wall, a ghost of an opening of the chosen size
 *   snapped to that wall's cells at that storey (red where it is refused);
 *   a click adds it (one `setComponent`), or selects the opening clicked; the
 *   selected opening's handle drags it along its wall (one `setComponent` at
 *   the release) and Delete removes it. A refused opening is not sent: the
 *   reason is said (structure-openings.ts).
 *
 * The structure's hand edits (dig, add, paint on its own cells) are the
 * voxel brush tool's (`voxel-brush-tool.ts`), armed on the structure's grid
 * beside this tool in Navigate, which keeps drawing the grid and outline.
 *
 * Tests read `data-structure-tool`: the tool, the handles on screen, the
 * cell under the pointer and the last gesture.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { BUILDING_GENERATOR, VOXEL_SIZE_M, GridFrame, type GridPlacement, type StructureDefinition } from '@thirdlight/voxel';

import { movedOpening, openingAtCell, openingBox, openingOnWall, openingProblem, openingWords, wallUnderCell, withOpening, withoutOpening, type OpeningShape } from '../session/structure-openings';
import { addPolygon, cellsIn, definitionOf, footprintBox, footprintMiddle, moveCorner, moveEdge, rectPoints, snapYaw, storeysFor, structureProblem, turnedPosition, withPolygonPoints, type CellPoint, type StructureValue } from '../session/structure-shape';
import type { ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { aimAtPointer } from './scene-queries';
import { StructureOverlay, type OverlayHandle } from './structure-overlay';
import type { ToolPress } from './tool-input';

export type StructureToolKind = 'create' | 'shape' | 'extend' | 'openings';

/** What the structure mode (or GameObject → Structure) arms the tool with. */
export interface StructureArm {
  readonly tool: StructureToolKind;
  /** No tool in hand: the grid, outline and marker draw, a press is the view's (orbit, select). */
  readonly navigate: boolean;
  /** The world a new structure is drawn in (create), or the structure's. */
  readonly world: string;
  /** The structure edited (null: create). */
  readonly entityId: string | null;
  readonly value: StructureValue | null;
  /** A misfit to show: its cell in the structure's grid (null: none). */
  readonly marker: readonly [number, number, number] | null;
  /** The Openings tool: the size a click places and the opening selected (absent: not the Openings tool). */
  readonly opening?: { readonly shape: OpeningShape; readonly selected: string | null };
}

export interface StructureToolHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  canvas(): HTMLCanvasElement;
  requestRender(): void;
  /** What the voxel worlds meet first under a pointer (null: no world open). */
  pick(clientX: number, clientY: number): Promise<ScenePickHit | null> | null;
  /** Where a structure object's grid is drawn now (`stored`: where its object is stored, a turn's preview aside; null: not drawn yet). */
  place(entityId: string, stored?: boolean): GridPlacement | null;
  /** Draw a structure object at a place while a turn is dragged (null: where it is stored). */
  preview(entityId: string, t: { position: readonly number[]; rotation: readonly number[] } | null): void;
}

export interface StructureToolCallbacks {
  /** A rectangle drawn on the ground: its world corner (metres, at the ground's level) and its size in cells. */
  create(world: string, corner: readonly [number, number, number], w: number, d: number): Promise<void>;
  /** The structure's definition changed (one `setComponent`). */
  define(entityId: string, def: StructureDefinition): Promise<void>;
  /** The structure moved or turned (one `setTransform`). */
  place(entityId: string, position: readonly number[], yawRad: number): Promise<void>;
  /** Why something was not sent (the shell's status line shows it). */
  refused(message: string): void;
  /** What a drag would make, said live (null: nothing in flight). */
  readout(text: string | null): void;
  /** An opening picked in the view, or just placed (null: none selected). */
  selectOpening?(id: string | null): void;
}

/** A pointer within this many pixels of a handle grabs it. */
const GRAB_PX = 14;
/** How far out from the footprint's corner the turn ring lies (metres). */
const RING_MARGIN_M = 2;
/** Cells of grid drawn round the footprint. */
const GRID_MARGIN = 8;
/** Cells of world grid drawn round a rectangle being drawn. */
const CREATE_GRID_CELLS = 24;

type Drag =
  | { kind: 'create'; ground: number; from: THREE.Vector3; to: THREE.Vector3 | null }
  | { kind: 'extend'; from: [number, number]; to: [number, number] | null }
  | { kind: 'corner' | 'edge'; poly: number; k: number; start: [number, number]; points: [number, number][] | null }
  | { kind: 'storey'; start: number; anchorY: number; normal: THREE.Vector3; point: THREE.Vector3; storeys: number }
  | { kind: 'yaw'; start: number; startYaw: number; yaw: number }
  | { kind: 'opening'; id: string; height: number; startCell: number; cells: number };

export class StructureTool {
  private arming: StructureArm | null = null;
  private drag: Drag | null = null;
  private readonly overlay: StructureOverlay;
  private readonly ray = new THREE.Raycaster();
  /** The last voxel hit under the pointer (the Openings tool), and whether a pick is in flight. */
  private hover: ScenePickHit | null = null;
  /** The pointer (client px) the hover was picked for. */
  private hoverAtPx: [number, number] | null = null;
  private picking = false;
  private pendingPointer: { x: number; y: number } | null = null;
  private hot: string | null = null;
  private last: Record<string, unknown> | null = null;
  private stamp = '';
  /** The Openings tool's last readout over a wall. */
  private said: string | null = null;

  constructor(private readonly host: StructureToolHost, private readonly cb: StructureToolCallbacks) {
    this.overlay = new StructureOverlay(host.overlay);
  }

  armed(): boolean {
    return this.arming !== null && !this.arming.navigate;
  }

  /** Arm the tool (null: off; a gesture in flight is dropped). */
  arm(a: StructureArm | null): void {
    if (a?.entityId !== this.arming?.entityId || a?.tool !== this.arming?.tool) this.cancel();
    this.arming = a;
    if (a === null || a.navigate || a.tool !== 'openings') this.hover = null;
    if (a === null) this.overlay.clear();
    this.host.requestRender();
  }

  // ---- input ---------------------------------------------------------------------------------

  key(e: KeyboardEvent): boolean {
    if (!this.armed() || this.drag !== null) return false;
    const a = this.arming!;
    if (a.tool === 'openings' && (e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const id = a.opening?.selected ?? null;
      if (id === null || a.value === null || a.entityId === null) return false;
      this.define(a.entityId, withoutOpening(definitionOf(a.value), id), 'remove-opening');
      this.cb.selectOpening?.(null);
      return true;
    }
    return false;
  }

  pointerDown(e: PointerEvent): ToolPress {
    const a = this.arming;
    if (a === null || a.navigate || e.button !== 0 || e.altKey) return null;
    if (a.tool === 'create') return this.beginCreate(e);
    const place = a.entityId === null ? null : this.host.place(a.entityId);
    if (place === null || a.value === null) return null;
    if (a.tool === 'shape') return this.beginHandle(e, a, place);
    if (a.tool === 'openings') return this.pressOpening(e, a, place);
    if (a.tool === 'extend') {
      const at = this.floorPoint(e, place);
      if (at === null) return null;
      this.drag = { kind: 'extend', from: [cellsIn(at[0]), cellsIn(at[2])], to: null };
      return 'capture';
    }
    return null;
  }

  pointerMove(e: PointerEvent): boolean {
    const a = this.arming;
    if (a === null || a.navigate) return false;
    const d = this.drag;
    const place = a.entityId === null ? null : this.host.place(a.entityId);
    if (d === null) {
      if (a.tool === 'shape' && place !== null) {
        const g = this.grab(e.clientX, e.clientY);
        if (g !== this.hot) {
          this.hot = g;
          this.host.requestRender();
        }
      }
      if (a.tool === 'openings') this.hoverAt(e.clientX, e.clientY);
      if (a.tool === 'openings' && place !== null) {
        const g = this.grab(e.clientX, e.clientY);
        if (g !== this.hot) {
          this.hot = g;
          this.host.requestRender();
        }
      }
      return false;
    }
    if (d.kind === 'create') {
      const p = this.planePoint(e, d.ground);
      if (p !== null) d.to = p;
      this.readCreate(d);
    } else if (d.kind === 'extend' && place !== null) {
      const at = this.floorPoint(e, place);
      if (at !== null) d.to = [cellsIn(at[0]), cellsIn(at[2])];
      const r = d.to === null ? null : rectPoints(d.from, d.to);
      this.cb.readout(r === null ? 'Drag out a wing at least 1.5 m a side' : `Wing ${((r[1]![0] - r[0]![0]) * VOXEL_SIZE_M).toFixed(1)} × ${((r[2]![1] - r[1]![1]) * VOXEL_SIZE_M).toFixed(1)} m`);
    } else if ((d.kind === 'corner' || d.kind === 'edge') && place !== null && a.value !== null) {
      const at = this.floorPoint(e, place);
      if (at !== null) {
        const pts = a.value.footprint[d.poly]!.points;
        const dx = Math.round(at[0] / VOXEL_SIZE_M - d.start[0]);
        const dz = Math.round(at[2] / VOXEL_SIZE_M - d.start[1]);
        d.points = d.kind === 'corner' ? moveCorner(pts, d.k, dx, dz) : moveEdge(pts, d.k, pts[d.k]![1] === pts[(d.k + 1) % pts.length]![1] ? dz : dx);
        const b = footprintBox(withPolygonPoints(definitionOf(a.value), d.poly, d.points));
        this.cb.readout(`${((b.maxX - b.minX) * VOXEL_SIZE_M).toFixed(1)} × ${((b.maxZ - b.minZ) * VOXEL_SIZE_M).toFixed(1)} m`);
      }
    } else if (d.kind === 'storey' && a.value !== null) {
      const y = this.verticalPoint(e, d);
      if (y !== null) d.storeys = storeysFor(d.start, y - d.anchorY, a.value.storeyHeight);
      this.cb.readout(`Storeys ${d.storeys}`);
    } else if (d.kind === 'yaw' && place !== null && a.value !== null && a.entityId !== null) {
      const ang = this.ringAngle(e, place, a.value);
      if (ang !== null) {
        d.yaw = snapYaw(d.startYaw - (ang - d.start), e.shiftKey);
        const p = this.basePlace(a.entityId);
        if (p !== null) this.host.preview(a.entityId, { position: turnedPosition(p, footprintMiddle(definitionOf(a.value)), d.yaw), rotation: [0, Math.sin(d.yaw / 2), 0, Math.cos(d.yaw / 2)] });
        this.cb.readout(`Turn ${((d.yaw * 180) / Math.PI).toFixed(e.shiftKey ? 1 : 0)}°${e.shiftKey ? ' (free)' : ''}`);
      }
    } else if (d.kind === 'opening' && place !== null && a.value !== null) {
      const c = this.alongCell(e, place, a.value, d);
      if (c !== null) d.cells = c - d.startCell;
      const o = this.draggedOpening(a.value, d);
      if (o !== null) this.cb.readout(openingProblem(definitionOf(a.value), o) ?? `${openingWords(o)}: ${d.cells >= 0 ? '+' : ''}${(d.cells * VOXEL_SIZE_M).toFixed(1)} m along the wall`);
    }
    this.host.requestRender();
    return true;
  }

  pointerUp(e: PointerEvent): boolean {
    const d = this.drag;
    const a = this.arming;
    if (d === null || a === null) return false;
    this.drag = null;
    this.cb.readout(null);
    this.host.requestRender();
    if (d.kind === 'create') {
      if (d.to === null) d.to = this.planePoint(e, d.ground);
      const r = this.createRect(d);
      if (r === null) this.cb.refused('Drag out a rectangle at least 1.5 m a side on the ground.');
      else void this.send(this.cb.create(a.world, r.corner, r.w, r.d), 'create', { w: r.w, d: r.d });
      return true;
    }
    if (a.value === null || a.entityId === null) return true;
    const def = definitionOf(a.value);
    const id = a.entityId;
    if (d.kind === 'extend') {
      const r = d.to === null ? null : rectPoints(d.from, d.to);
      if (r === null) this.cb.refused('A wing is at least 1.5 m a side: drag out a bigger rectangle.');
      else this.define(id, addPolygon(def, r), 'extend');
    } else if (d.kind === 'corner' || d.kind === 'edge') {
      if (d.points !== null && JSON.stringify(d.points) !== JSON.stringify(def.footprint[d.poly]!.points)) this.define(id, withPolygonPoints(def, d.poly, d.points), d.kind);
    } else if (d.kind === 'storey') {
      if (d.storeys !== def.storeys) this.define(id, { ...def, storeys: d.storeys }, 'storey');
    } else if (d.kind === 'yaw') {
      const p = this.basePlace(id);
      if (p === null || Math.abs(d.yaw - p.yawRad) < 1e-9) this.host.preview(id, null);
      else {
        const position = turnedPosition(p, footprintMiddle(def), d.yaw);
        // The preview stays until the stored turn arrives, so the house never swings back for a frame.
        void this.send(this.cb.place(id, position, d.yaw), 'yaw', { yawDeg: (d.yaw * 180) / Math.PI }).finally(() => this.host.preview(id, null));
      }
    } else if (d.kind === 'opening') {
      const o = this.draggedOpening(a.value, d);
      if (o !== null && d.cells !== 0) {
        const why = openingProblem(def, o);
        if (why !== null) {
          this.cb.refused(why);
          this.last = { gesture: 'move-opening', ok: false, refused: why };
        } else this.define(id, withOpening(def, o), 'move-opening');
      }
    }
    return true;
  }

  leave(): void {
    if (this.drag === null) {
      this.hover = null;
      this.host.requestRender();
    }
  }

  cancel(): boolean {
    const d = this.drag;
    if (d === null) return false;
    this.drag = null;
    if (d.kind === 'yaw' && this.arming?.entityId != null) this.host.preview(this.arming.entityId, null);
    this.cb.readout(null);
    this.host.requestRender();
    return true;
  }

  // ---- gestures ------------------------------------------------------------------------------

  private beginCreate(e: PointerEvent): ToolPress {
    const p = this.host.pick(e.clientX, e.clientY);
    if (p === null) {
      this.cb.refused('No voxel world is drawn here: add a voxel world to the scene, then draw the building on its ground.');
      return 'consume';
    }
    // The ground's level comes with the pick's answer; until then the drag waits at the press.
    const drag: Extract<Drag, { kind: 'create' }> = { kind: 'create', ground: NaN, from: new THREE.Vector3(), to: null };
    this.drag = drag;
    const x = e.clientX;
    const y = e.clientY;
    void p.then((hit) => {
      if (this.drag !== drag) return;
      if (hit === null || hit.grid !== 0) {
        this.drag = null;
        this.cb.refused(hit === null ? 'Draw the building on the voxel world\'s ground (the pointer met nothing there).' : 'Draw the building on the ground, not on another structure.');
        return;
      }
      this.aim(x, y);
      const at = this.ray.ray.at(hit.t, new THREE.Vector3());
      drag.ground = Math.round(at.y / VOXEL_SIZE_M) * VOXEL_SIZE_M;
      const from = this.planePoint(null, drag.ground, x, y);
      if (from !== null) drag.from.copy(from);
      this.host.requestRender();
    });
    return 'capture';
  }

  private readCreate(d: Extract<Drag, { kind: 'create' }>): void {
    const r = this.createRect(d);
    this.cb.readout(r === null ? 'Drag out a rectangle at least 1.5 m a side' : `${(r.w * VOXEL_SIZE_M).toFixed(1)} × ${(r.d * VOXEL_SIZE_M).toFixed(1)} m`);
  }

  /** The rectangle a create drag spans: its minimum corner (world metres, on the lattice, at the ground's level) and its cells (null: too small, or the ground not known yet). */
  private createRect(d: Extract<Drag, { kind: 'create' }>): { corner: [number, number, number]; w: number; d: number } | null {
    if (Number.isNaN(d.ground) || d.to === null) return null;
    const a: CellPoint = [cellsIn(d.from.x), cellsIn(d.from.z)];
    const b: CellPoint = [cellsIn(d.to.x), cellsIn(d.to.z)];
    const r = rectPoints(a, b);
    if (r === null) return null;
    return { corner: [r[0]![0] * VOXEL_SIZE_M, d.ground, r[0]![1] * VOXEL_SIZE_M], w: r[1]![0] - r[0]![0], d: r[2]![1] - r[1]![1] };
  }

  private beginHandle(e: PointerEvent, a: StructureArm, place: GridPlacement): ToolPress {
    const id = this.grab(e.clientX, e.clientY);
    if (id === null || a.value === null) return null;
    const def = definitionOf(a.value);
    const [kind, ...rest] = id.split(':');
    if (kind === 'corner' || kind === 'edge') {
      const at = this.floorPoint(e, place);
      if (at === null) return 'consume';
      this.drag = { kind, poly: Number(rest[0]), k: Number(rest[1]), start: [at[0] / VOXEL_SIZE_M, at[2] / VOXEL_SIZE_M], points: null };
    } else if (kind === 'storey') {
      const handle = this.handles(a.value).find((h) => h.id === 'storey')!;
      const w = new GridFrame(place).toWorld(handle.at[0], handle.at[1], handle.at[2]);
      const point = new THREE.Vector3(w[0], w[1], w[2]);
      // A vertical plane through the arrow, facing the camera across: the drag's height is read on it.
      const normal = new THREE.Vector3().subVectors(this.host.camera.position, point).setY(0);
      if (normal.lengthSq() < 1e-9) normal.set(0, 0, 1);
      normal.normalize();
      const drag: Extract<Drag, { kind: 'storey' }> = { kind: 'storey', start: def.storeys, anchorY: point.y, normal, point, storeys: def.storeys };
      const y = this.verticalPoint(e, drag);
      if (y !== null) drag.anchorY = y;
      this.drag = drag;
    } else if (kind === 'yaw') {
      const ang = this.ringAngle(e, place, a.value);
      if (ang === null) return 'consume';
      const base = this.basePlace(a.entityId!) ?? place;
      this.drag = { kind: 'yaw', start: ang, startYaw: base.yawRad, yaw: base.yawRad };
    } else return null;
    this.hot = id;
    this.host.requestRender();
    return 'capture';
  }

  /**
   * A press with the Openings tool: the selected opening's handle begins its drag along its wall; on an opening, that
   * opening is selected; on a wall, the ghost's opening is added (or the reason it is not is said).
   */
  private pressOpening(e: PointerEvent, a: StructureArm, place: GridPlacement): ToolPress {
    if (a.value === null || a.entityId === null || a.opening === undefined) return null;
    const def = definitionOf(a.value);
    const grabbed = this.grab(e.clientX, e.clientY);
    const sel = a.opening.selected === null ? undefined : def.openings.find((o) => o.id === a.opening!.selected);
    if (grabbed !== null && sel !== undefined && grabbed === `opening:${sel.id}`) {
      const box = openingBox(def, sel)!;
      const d: Extract<Drag, { kind: 'opening' }> = { kind: 'opening', id: sel.id, height: (box.min[1] + box.max[1]) / 2, startCell: 0, cells: 0 };
      const c = this.alongCell(e, place, a.value, d);
      if (c === null) return 'consume';
      d.startCell = c;
      this.drag = d;
      this.hot = grabbed;
      this.host.requestRender();
      return 'capture';
    }
    const h = this.hover;
    if (h === null || h.grid !== a.value.grid || h.world !== a.world) return null;
    const at = openingAtCell(def, h.cell);
    if (at !== null) {
      this.cb.selectOpening?.(at.id);
      this.last = { gesture: 'select-opening', ok: true, id: at.id };
      return 'consume';
    }
    const wall = wallUnderCell(def, h.cell, h.normal);
    if (wall === null) {
      this.cb.refused('Point at a wall of the building, between its floor and the next: an opening goes in a wall.');
      this.last = { gesture: 'opening', ok: false, refused: 'no wall' };
      return 'consume';
    }
    const o = openingOnWall(def, wall, a.opening.shape);
    const why = openingProblem(def, o);
    if (why !== null) {
      this.cb.refused(why);
      this.last = { gesture: 'opening', ok: false, refused: why };
      return 'consume';
    }
    this.define(a.entityId, withOpening(def, o), 'opening');
    this.cb.selectOpening?.(o.id);
    return 'consume';
  }

  /** The cell along a dragged opening's wall under the pointer (its edge's own count, from the edge's start; null: off the plane). */
  private alongCell(e: PointerEvent, place: GridPlacement, value: StructureValue, d: Extract<Drag, { kind: 'opening' }>): number | null {
    const def = definitionOf(value);
    const o = def.openings.find((x) => x.id === d.id);
    const poly = o === undefined ? undefined : def.footprint.find((p) => p.id === o.polygon);
    if (o === undefined || poly === undefined) return null;
    const p = this.planePoint(e, place.position[1] + d.height);
    if (p === null) return null;
    const g = new GridFrame(place).toGrid(p.x, p.y, p.z);
    const a = poly.points[o.edge]!;
    const b = poly.points[(o.edge + 1) % poly.points.length]!;
    const alongX = a[1] === b[1];
    const step = Math.sign(alongX ? b[0] - a[0] : b[1] - a[1]);
    // Along the edge from its start, in cells (the edge's own direction).
    return Math.floor(step * ((alongX ? g[0] : g[2]) / VOXEL_SIZE_M - (alongX ? a[0] : a[1])));
  }

  /** The opening a drag along its wall would make (null: gone from the definition). */
  private draggedOpening(value: StructureValue, d: Extract<Drag, { kind: 'opening' }>): ReturnType<typeof movedOpening> {
    return movedOpening(definitionOf(value), d.id, d.cells);
  }

  /** The Openings tool's ghost under the pointer: the opening a click would add there and why it would be refused (null: no wall under it). */
  private openingGhost(a: StructureArm): { opening: ReturnType<typeof openingOnWall>; problem: string | null } | null {
    const h = this.hover;
    if (a.value === null || a.opening === undefined || h === null || h.grid !== a.value.grid || h.world !== a.world) return null;
    const def = definitionOf(a.value);
    if (openingAtCell(def, h.cell) !== null) return null;
    const wall = wallUnderCell(def, h.cell, h.normal);
    if (wall === null) return null;
    const o = openingOnWall(def, wall, a.opening.shape);
    return { opening: o, problem: openingProblem(def, o) };
  }

  private define(entityId: string, def: StructureDefinition, what: string): void {
    const why = structureProblem(def);
    if (why !== null) {
      this.cb.refused(why);
      this.last = { gesture: what, ok: false, refused: why };
      return;
    }
    void this.send(this.cb.define(entityId, def), what, { storeys: def.storeys, polygons: def.footprint.length });
  }

  /** Sends a gesture's command; the last gesture's answer and its time are kept for the tests and measurements. */
  private send(p: Promise<void>, gesture: string, extra: Record<string, unknown>): Promise<void> {
    const t0 = performance.now();
    const entry: Record<string, unknown> = { gesture, ...extra, sentAt: Math.round(t0), ok: null };
    this.last = entry;
    return p.then(
      () => {
        entry['ok'] = true;
        entry['ms'] = Math.round(performance.now() - t0);
      },
      (err: unknown) => {
        entry['ok'] = false;
        entry['error'] = err instanceof Error ? err.message : String(err);
      },
    );
  }

  // ---- geometry ------------------------------------------------------------------------------

  private aim(x: number, y: number): void {
    aimAtPointer(this.ray, this.host.camera, x, y, this.host.canvas().getBoundingClientRect());
  }

  /** Where the pointer's ray meets the horizontal plane at world height `y` (null: it does not, looking away from it). */
  private planePoint(e: PointerEvent | null, y: number, cx?: number, cy?: number): THREE.Vector3 | null {
    if (Number.isNaN(y)) return null;
    this.aim(e?.clientX ?? cx!, e?.clientY ?? cy!);
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  }

  /** The pointer on the structure's floor level, in its grid's metres (null: off the plane). */
  private floorPoint(e: PointerEvent, place: GridPlacement): [number, number, number] | null {
    const p = this.planePoint(e, place.position[1] + VOXEL_SIZE_M);
    return p === null ? null : new GridFrame(place).toGrid(p.x, p.y, p.z);
  }

  /** The height the pointer's ray reaches on a storey drag's vertical plane (null: parallel to it). */
  private verticalPoint(e: PointerEvent, d: Extract<Drag, { kind: 'storey' }>): number | null {
    this.aim(e.clientX, e.clientY);
    const p = this.ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(d.normal, d.point), new THREE.Vector3());
    return p === null ? null : p.y;
  }

  /** The pointer's angle about the footprint's middle, in the grid's frame (null: off the floor plane). */
  private ringAngle(e: PointerEvent, place: GridPlacement, value: StructureValue): number | null {
    const p = this.planePoint(e, place.position[1] + VOXEL_SIZE_M);
    if (p === null) return null;
    const mid = footprintMiddle(definitionOf(value));
    const w = new GridFrame(place).toWorld(mid[0], mid[1], mid[2]);
    // World angle: the turn is measured in the world so a drag reads the same while the preview turns the frame.
    return Math.atan2(p.z - w[2], p.x - w[0]);
  }

  /** The place as its object stores it, without this tool's preview (what a turn starts from). */
  private basePlace(entityId: string): GridPlacement | null {
    return this.host.place(entityId, true);
  }

  /** The handles of a structure (grid metres). */
  private handles(value: StructureValue): OverlayHandle[] {
    const def = definitionOf(value);
    const floor = VOXEL_SIZE_M;
    const out: OverlayHandle[] = [];
    def.footprint.forEach((p, i) => {
      p.points.forEach((q, k) => {
        const r = p.points[(k + 1) % p.points.length]!;
        out.push({ id: `corner:${i}:${k}`, kind: 'corner', at: [q[0] * VOXEL_SIZE_M, floor, q[1] * VOXEL_SIZE_M] });
        out.push({ id: `edge:${i}:${k}`, kind: 'edge', at: [((q[0] + r[0]) / 2) * VOXEL_SIZE_M, floor, ((q[1] + r[1]) / 2) * VOXEL_SIZE_M] });
      });
    });
    const box = BUILDING_GENERATOR.box(def);
    const mid = footprintMiddle(def);
    out.push({ id: 'storey', kind: 'storey', at: [mid[0], (box.maxY + 1) * VOXEL_SIZE_M + 1.2, mid[2]] });
    const fb = footprintBox(def);
    const radius = this.ringRadius(fb);
    out.push({ id: 'yaw', kind: 'yaw', at: [mid[0] + radius, floor, mid[2]] });
    return out;
  }

  private ringRadius(fb: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
    return Math.hypot(fb.maxX - fb.minX, fb.maxZ - fb.minZ) * VOXEL_SIZE_M * 0.5 + RING_MARGIN_M;
  }

  /** The handle under a pointer (null: none within reach). */
  private grab(x: number, y: number): string | null {
    const pts = this.overlay.handlePoints(this.host.camera, this.host.canvas().getBoundingClientRect());
    let best: string | null = null;
    let bestD = GRAB_PX;
    for (const p of pts) {
      const dd = Math.hypot(p.x - x, p.y - y);
      // Corners win over edges and the arrows at the same distance (listed first).
      if (dd < bestD) {
        best = p.id;
        bestD = dd;
      }
    }
    return best;
  }

  /** Picks the cell under the pointer (one pick in flight; the latest position is picked next). */
  private hoverAt(x: number, y: number): void {
    if (this.picking) {
      this.pendingPointer = { x, y };
      return;
    }
    const p = this.host.pick(x, y);
    if (p === null) return;
    this.picking = true;
    void p.then((hit) => {
      this.picking = false;
      const a = this.arming;
      this.hover = hit;
      this.hoverAtPx = [Math.round(x), Math.round(y)];
      if (a?.tool === 'openings' && this.drag === null) this.sayGhost(a);
      this.host.requestRender();
      const next = this.pendingPointer;
      this.pendingPointer = null;
      if (next !== null) this.hoverAt(next.x, next.y);
    });
  }

  // ---- each frame ----------------------------------------------------------------------------

  /** Before a frame: the overlay follows the structure where it is drawn now, the drag's previews included. */
  frame(): void {
    const a = this.arming;
    const root = this.host.canvas();
    if (a === null) {
      if (this.stamp !== '') {
        this.stamp = '';
        root.removeAttribute('data-structure-tool');
      }
      return;
    }
    const d = this.drag;
    if (a.tool === 'create' || a.value === null || a.entityId === null) this.frameCreate(d);
    else this.frameStructure(a, d);
    this.overlay.scaleHandles(this.host.camera);
    const handles = this.overlay.handlePoints(this.host.camera, root.getBoundingClientRect());
    const ghost = a.tool === 'openings' && !a.navigate ? this.openingGhost(a) : null;
    const mark = JSON.stringify({ tool: a.tool, navigate: a.navigate, entityId: a.entityId, drag: d?.kind ?? null, marker: a.marker, handles, hover: this.hover === null ? null : { grid: this.hover.grid, cell: this.hover.cell, normal: this.hover.normal, at: this.hoverAtPx }, last: this.last, ...(a.opening !== undefined ? { opening: { selected: a.opening.selected, ghost } } : {}) });
    if (mark !== this.stamp) {
      this.stamp = mark;
      root.setAttribute('data-structure-tool', mark);
    }
  }

  private frameCreate(d: Drag | null): void {
    this.overlay.setPlace(null);
    if (d?.kind !== 'create' || Number.isNaN(d.ground)) {
      this.overlay.setOutline('world-rect', null, 0, true);
      this.overlay.setGrid(null, 0, true);
      return;
    }
    const to = d.to ?? d.from;
    const cx = cellsIn(to.x);
    const cz = cellsIn(to.z);
    const fx = cellsIn(d.from.x);
    const fz = cellsIn(d.from.z);
    this.overlay.setGrid({ minX: Math.min(fx, cx) - CREATE_GRID_CELLS, maxX: Math.max(fx, cx) + CREATE_GRID_CELLS, minZ: Math.min(fz, cz) - CREATE_GRID_CELLS, maxZ: Math.max(fz, cz) + CREATE_GRID_CELLS }, d.ground, true);
    this.overlay.setOutline('world-rect', [[[fx, fz], [cx, fz], [cx, cz], [fx, cz]]], d.ground, true);
  }

  private frameStructure(a: StructureArm, d: Drag | null): void {
    this.overlay.setOutline('world-rect', null, 0, true);
    this.overlay.setGrid(null, 0, true);
    const place = this.host.place(a.entityId!);
    this.overlay.setPlace(place);
    if (place === null || a.value === null) return;
    const def = definitionOf(a.value);
    const fb = footprintBox(def);
    const floor = VOXEL_SIZE_M;
    this.overlay.setGrid({ minX: fb.minX - GRID_MARGIN, maxX: fb.maxX + GRID_MARGIN, minZ: fb.minZ - GRID_MARGIN, maxZ: fb.maxZ + GRID_MARGIN }, floor);
    this.overlay.setOutline('outline', def.footprint.map((p) => p.points), floor);
    // The live preview: a dragged polygon, a wing being drawn.
    let preview: (readonly (readonly [number, number])[])[] | null = null;
    if ((d?.kind === 'corner' || d?.kind === 'edge') && d.points !== null) preview = [d.points];
    else if (d?.kind === 'extend' && d.to !== null) {
      const r = rectPoints(d.from, d.to);
      preview = [r ?? [[d.from[0], d.from[1]], [d.to[0], d.from[1]], [d.to[0], d.to[1]], [d.from[0], d.to[1]]]];
    }
    this.overlay.setOutline('preview', preview, floor);
    // The storey drag's ghost: the footprint's box up to the new height.
    if (d?.kind === 'storey') this.overlay.setBox('ghost', { min: [fb.minX * VOXEL_SIZE_M, 0, fb.minZ * VOXEL_SIZE_M], max: [fb.maxX * VOXEL_SIZE_M, d.storeys * def.storeyHeight * VOXEL_SIZE_M, fb.maxZ * VOXEL_SIZE_M] }, 'ghost');
    else if (a.tool === 'openings' && !a.navigate) this.frameOpenings(a, def, d);
    else this.overlay.setBox('ghost', null);
    if (a.tool !== 'openings') this.overlay.setBox('opening', null);
    const shape = a.tool === 'shape' && !a.navigate;
    const handles = shape ? this.handles(a.value) : a.tool === 'openings' && !a.navigate ? this.openingHandles(def, a) : [];
    this.overlay.setHandles(handles, this.hot);
    const mid = footprintMiddle(def);
    this.overlay.setRing(shape ? [mid[0], floor, mid[2]] : null, this.ringRadius(fb));
    const m = a.marker;
    this.overlay.setBox('marker', m === null ? null : { min: [m[0] * VOXEL_SIZE_M - 0.05, m[1] * VOXEL_SIZE_M - 0.05, m[2] * VOXEL_SIZE_M - 0.05], max: [(m[0] + 1) * VOXEL_SIZE_M + 0.05, (m[1] + 1) * VOXEL_SIZE_M + 0.05, (m[2] + 1) * VOXEL_SIZE_M + 0.05] }, 'misfit');
  }

  /** The Openings tool's drawings: the ghost under the pointer (or of the opening dragged), red where refused; the selected opening's box. */
  private frameOpenings(a: StructureArm, def: StructureDefinition, d: Drag | null): void {
    const moved = d?.kind === 'opening' ? movedOpening(def, d.id, d.cells) : null;
    const ghost = moved !== null ? { opening: moved, problem: openingProblem(def, moved) } : this.drag === null ? this.openingGhost(a) : null;
    this.overlay.setBox('ghost', ghost === null ? null : openingBox(def, ghost.opening), ghost?.problem == null ? 'ghost' : 'misfit');
    const sel = a.opening?.selected == null ? undefined : def.openings.find((o) => o.id === a.opening!.selected);
    this.overlay.setBox('opening', sel === undefined ? null : openingBox(def, sel), 'cursor');
  }

  /** The status line's readout over a wall with the Openings tool: what a click adds there, or why it would not (said once a change). */
  private sayGhost(a: StructureArm): void {
    const g = this.openingGhost(a);
    const text = g === null ? null : g.problem !== null ? `Not here: ${g.problem}` : `Click: ${openingWords(g.opening)} on wall ${g.opening.edge} of ${g.opening.polygon}, storey ${g.opening.storey}`;
    if (text === this.said) return;
    this.said = text;
    this.cb.readout(text);
  }

  /** The selected opening's handle: at the middle of its cells (grid metres). */
  private openingHandles(def: StructureDefinition, a: StructureArm): OverlayHandle[] {
    const sel = a.opening?.selected == null ? undefined : def.openings.find((o) => o.id === a.opening!.selected);
    const box = sel === undefined ? null : openingBox(def, sel);
    if (sel === undefined || box === null) return [];
    return [{ id: `opening:${sel.id}`, kind: 'edge', at: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] }];
  }

  dispose(): void {
    this.overlay.dispose();
  }
}
