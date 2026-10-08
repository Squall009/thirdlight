/**
 * The block layer's Rooms tool in the Scene view: rooms and runs drawn as
 * outlines of the layer's generated architecture (the object whose
 * `architecture.layer` names the layer; made at the layer's place on the
 * first room), snapped to cell corners on the slice's floor.
 *
 * - Rectangle: press a corner, drag to the other, release.
 * - Polygon / path / building: click corners (each click a corner; the Arc
 *   bulge makes the next segment an arc); click the first corner,
 *   double-click or press Enter to finish (a polygon or a building's
 *   footprint closes, a path stays open); Backspace takes the last corner
 *   back, Esc drops the drawing. A building wears the facade preset and a
 *   hip roof.
 * - Door / window / arch: click a room's wall; the opening goes on the
 *   nearest straight side, whole cells wide.
 * - Walls: drag a straight side across itself by whole cells (a wall the
 *   room beside it shares moves with it); the Scene view draws the moved
 *   room while dragging (only its chunks are made again), the release
 *   stores it. A click without a drag picks the room for the Inspector.
 *
 * Every gesture stores ONE command (one undo step). Browser-only (three.js);
 * the geometry is `session/room-draw.ts`.
 */
import * as THREE from 'three';
import type { ArchitectureComponent, BlockLayerComponent } from '@thirdlight/project-model';

import { allOutlines, DEFAULT_ROOM_OPTIONS, moveWall, nearestSide, NEW_BUILDING_ROOF, nextOutlineId, openingOn, rectPath, roomPath, sideDragOffset, snapCorner, straightSides, withBuilding, withOutline, withOutlineSet, type OutlineSide, type Point3, type RoomToolOptions } from '../session/room-draw';

/** The rooms object of the edited layer (null id and component: none yet). */
export interface RoomsTarget {
  entityId: string | null;
  component: ArchitectureComponent | null;
  /** The object's position (the layer's for a new one). */
  origin: readonly number[];
}

export interface RoomToolHost {
  readonly root: THREE.Object3D;
  readonly canvas: HTMLCanvasElement;
  layer(): { entityId: string; component: BlockLayerComponent; origin: readonly number[] } | null;
  slice(): number;
  ray(clientX: number, clientY: number): THREE.Ray;
  requestRender(): void;
}

export interface RoomToolCallbacks {
  /** Store the layer's rooms (a new rooms object when there is none yet); resolves true when stored. */
  onRooms(layerId: string, next: ArchitectureComponent, what: string): Promise<boolean>;
  /** Draw the rooms object as `next` without storing it (null: as stored). */
  onPreview(entityId: string, next: ArchitectureComponent | null): void;
  /** A room was picked (its outline id; null: none). */
  onPickRoom(outlineId: string | null): void;
  onRefused(message: string): void;
}

const GHOST = 0x9ad7ff;
const PICK = 0xffc857;
/** How near (cells) the pointer must be to a wall to put an opening on it or drag it. */
const WALL_REACH_CELLS = 0.6;
/** Screen pixels a press may move and still be a click. */
const CLICK_PX = 4;

export class RoomTool {
  private opts: RoomToolOptions = DEFAULT_ROOM_OPTIONS;
  private target: RoomsTarget = { entityId: null, component: null, origin: [0, 0, 0] };
  /** Corners of the polygon or path being drawn (object frame) and each segment's bulge. */
  private corners: Point3[] = [];
  private bulges: number[] = [];
  private rectStart: Point3 | null = null;
  private drag: { side: OutlineSide; from: [number, number]; press: [number, number]; offset: number; steps: number; t0: number } | null = null;
  private hover: Point3 | null = null;
  private readonly line: THREE.Line;
  private readonly marker: THREE.Mesh;

  constructor(private readonly host: RoomToolHost, private readonly cb: RoomToolCallbacks) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 256), 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: GHOST, depthTest: false, transparent: true }));
    this.line.renderOrder = 21;
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: PICK, depthTest: false, transparent: true }));
    this.marker.renderOrder = 21;
    this.marker.visible = false;
    host.root.add(this.line, this.marker);
  }

  setOptions(o: RoomToolOptions): void {
    if (o.mode !== this.opts.mode) this.cancel();
    this.opts = o;
    this.host.canvas.setAttribute('data-room-mode', o.mode);
  }

  setTarget(t: RoomsTarget): void {
    this.target = t;
  }

  /** The layer's offset of the rooms object (object-local = layer-local − offset). */
  private offset(): [number, number, number] {
    const l = this.host.layer();
    const o = this.target.origin;
    const lo = l?.origin ?? [0, 0, 0];
    return [(o[0] ?? 0) - (lo[0] ?? 0), (o[1] ?? 0) - (lo[1] ?? 0), (o[2] ?? 0) - (lo[2] ?? 0)];
  }

  /** The pointer on the slice's floor: layer metres and the snapped corner in the object's frame (null: off the plane). */
  private under(clientX: number, clientY: number): { x: number; z: number; corner: Point3 } | null {
    const l = this.host.layer();
    if (l === null) return null;
    const cs = l.component.cellSize;
    const floor = (l.origin[1] ?? 0) + this.host.slice() * cs[1];
    const p = this.host.ray(clientX, clientY).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -floor), new THREE.Vector3());
    if (p === null) return null;
    const off = this.offset();
    const lx = p.x - (l.origin[0] ?? 0);
    const lz = p.z - (l.origin[2] ?? 0);
    const c = snapCorner(lx, lz, this.host.slice() * cs[1], cs);
    return { x: lx - off[0], z: lz - off[2], corner: [c[0] - off[0], c[1] - off[1], c[2] - off[2]] };
  }

  pointerDown(e: PointerEvent): boolean {
    const l = this.host.layer();
    const at = this.under(e.clientX, e.clientY);
    if (l === null || at === null) return true;
    const cs = l.component.cellSize;
    const m = this.opts.mode;
    if (m === 'rect') {
      this.rectStart = at.corner;
      this.drawGhost(at.corner);
      return true;
    }
    if (m === 'polygon' || m === 'path' || m === 'building') {
      const first = this.corners[0];
      const last = this.corners[this.corners.length - 1];
      const enough = this.corners.length >= (m === 'path' ? 2 : 3);
      // A click on the first corner closes a polygon (or ends a path); a second click on the last corner (a double click) finishes either.
      const onFirst = first !== undefined && at.corner[0] === first[0] && at.corner[2] === first[2];
      const onLast = last !== undefined && at.corner[0] === last[0] && at.corner[2] === last[2];
      if (enough && (onFirst || onLast)) {
        void this.finishOutline();
        return true;
      }
      if (!onLast) {
        if (this.corners.length > 0) this.bulges.push(this.opts.bulge);
        this.corners.push(at.corner);
      }
      this.drawGhost(at.corner);
      return true;
    }
    const near = nearestSide(this.target.component, at.x, at.z, WALL_REACH_CELLS * cs[0], m !== 'walls');
    if (m === 'walls') {
      if (near === null) {
        this.cb.onPickRoom(null);
        return true;
      }
      this.drag = { side: near.side, from: [at.x, at.z], press: [e.clientX, e.clientY], offset: 0, steps: 0, t0: performance.now() };
      return true;
    }
    if (near === null) {
      this.cb.onRefused('Click on a room\'s straight wall to put an opening on it.');
      return true;
    }
    const c = this.target.component!;
    const o = near.side.outline;
    const storeyHeight = o.storeyHeight ?? 3;
    const storey = Math.max(0, Math.min((o.storeys ?? 1) - 1, Math.round((at.corner[1] - (o.path.points[0]?.[1] ?? 0)) / storeyHeight)));
    const opening = openingOn(near.side, near.along, m, cs, storey);
    if (opening === null) {
      this.cb.onRefused(`The wall is too short for a${m === 'arch' ? 'n' : ''} ${m}.`);
      return true;
    }
    void this.cb.onRooms(l.entityId, withOutlineSet(c, o.id, { ...o, openings: [...(o.openings ?? []), opening] }), `Add ${m}`);
    this.cb.onPickRoom(o.id);
    return true;
  }

  pointerMove(e: PointerEvent): boolean {
    const at = this.under(e.clientX, e.clientY);
    this.hover = at?.corner ?? null;
    const d = this.drag;
    if (d !== null && at !== null) {
      const l = this.host.layer()!;
      const offset = sideDragOffset(d.side, d.from[0], d.from[1], at.x, at.z, l.component.cellSize);
      if (offset !== d.offset && this.target.entityId !== null && this.target.component !== null) {
        d.offset = offset;
        d.steps += 1;
        this.cb.onPreview(this.target.entityId, moveWall(this.target.component, d.side.outline.id, d.side.index, offset));
        this.host.canvas.setAttribute('data-room-drag', JSON.stringify({ steps: d.steps, offset }));
      }
      return true;
    }
    if (this.rectStart !== null || this.corners.length > 0) this.drawGhost(this.hover);
    else this.drawMarker(this.hover);
    return this.rectStart !== null;
  }

  pointerUp(e: PointerEvent): boolean {
    const l = this.host.layer();
    if (this.rectStart !== null) {
      const a = this.rectStart;
      this.rectStart = null;
      const at = this.under(e.clientX, e.clientY);
      this.drawGhost(null);
      const path = at === null ? null : rectPath(a, at.corner);
      if (l === null || path === null) return true;
      const id = nextOutlineId(this.target.component, 'room');
      void this.cb.onRooms(l.entityId, withOutline(this.target.component, l.entityId, { id, preset: this.opts.roomPreset, path }), 'Draw room');
      this.cb.onPickRoom(id);
      return true;
    }
    const d = this.drag;
    if (d !== null) {
      this.drag = null;
      const moved = Math.hypot(e.clientX - d.press[0], e.clientY - d.press[1]) > CLICK_PX;
      if (!moved || d.offset === 0 || l === null || this.target.component === null) {
        if (this.target.entityId !== null && d.steps > 0) this.cb.onPreview(this.target.entityId, null);
        this.cb.onPickRoom(d.side.outline.id);
        return true;
      }
      const next = moveWall(this.target.component, d.side.outline.id, d.side.index, d.offset);
      this.host.canvas.setAttribute('data-room-drag', JSON.stringify({ steps: d.steps, offset: d.offset, ms: Math.round((performance.now() - d.t0) * 100) / 100 }));
      void this.cb.onRooms(l.entityId, next, 'Move wall').then((ok) => {
        if (!ok && this.target.entityId !== null) this.cb.onPreview(this.target.entityId, null);
      });
      this.cb.onPickRoom(d.side.outline.id);
      return true;
    }
    return false;
  }

  /** Enter finishes a polygon or path, Backspace takes its last corner back, Escape drops it (true: handled). */
  key(e: KeyboardEvent): boolean {
    if (this.corners.length === 0 && this.rectStart === null && this.drag === null) return false;
    if (e.key === 'Enter') {
      void this.finishOutline();
      return true;
    }
    if (e.key === 'Backspace' && this.corners.length > 0) {
      this.corners.pop();
      this.bulges.pop();
      this.drawGhost(this.hover);
      return true;
    }
    if (e.key === 'Escape') return this.cancel();
    return false;
  }

  /** Drop the drawing or drag in flight (true: there was one). */
  cancel(): boolean {
    const had = this.corners.length > 0 || this.rectStart !== null || this.drag !== null;
    if (this.drag !== null && this.drag.steps > 0 && this.target.entityId !== null) this.cb.onPreview(this.target.entityId, null);
    this.corners = [];
    this.bulges = [];
    this.rectStart = null;
    this.drag = null;
    this.drawGhost(null);
    return had;
  }

  inFlight(): boolean {
    return this.corners.length > 0 || this.rectStart !== null || this.drag !== null;
  }

  private async finishOutline(): Promise<void> {
    const l = this.host.layer();
    const pts = this.corners;
    const bulges = this.bulges;
    const closed = this.opts.mode === 'polygon' || this.opts.mode === 'building';
    this.corners = [];
    this.bulges = [];
    this.drawGhost(null);
    if (l === null || pts.length < (closed ? 3 : 2)) return;
    if (this.opts.mode === 'building') {
      const id = nextOutlineId(this.target.component, 'building');
      const facade = this.opts.facadePreset;
      await this.cb.onRooms(l.entityId, withBuilding(this.target.component, l.entityId, { id, preset: this.opts.roomPreset, ...(facade !== '' ? { outside: facade } : {}), path: roomPath(pts, [...bulges, 0]), roof: { ...NEW_BUILDING_ROOF } }), 'Draw building');
      this.cb.onPickRoom(id);
      return;
    }
    if (closed) {
      const id = nextOutlineId(this.target.component, 'room');
      // The closing side is straight.
      await this.cb.onRooms(l.entityId, withOutline(this.target.component, l.entityId, { id, preset: this.opts.roomPreset, path: roomPath(pts, [...bulges, 0]) }), 'Draw room');
      this.cb.onPickRoom(id);
      return;
    }
    const id = nextOutlineId(this.target.component, 'run');
    const any = bulges.some((b) => b !== 0);
    await this.cb.onRooms(l.entityId, withOutline(this.target.component, l.entityId, { id, preset: this.opts.pathPreset, path: { points: pts, ...(any ? { bulges } : {}) } }), 'Draw path');
    this.cb.onPickRoom(id);
  }

  /** The outline being drawn (and the pointer's corner), in the layer's frame. */
  private drawGhost(pointer: Point3 | null): void {
    const pts: Point3[] = [];
    if (this.rectStart !== null && pointer !== null) {
      const a = this.rectStart;
      pts.push(a, [pointer[0], a[1], a[2]], [pointer[0], a[1], pointer[2]], [a[0], a[1], pointer[2]], a);
    } else if (this.corners.length > 0) {
      const all = pointer !== null ? [...this.corners, pointer] : [...this.corners];
      const bulges = [...this.bulges, this.opts.bulge];
      for (let i = 0; i < all.length; i++) {
        if (i > 0) pts.push(...arcPoints(all[i - 1]!, all[i]!, bulges[i - 1] ?? 0).slice(1));
        else pts.push(all[0]!);
      }
    }
    const off = this.offset();
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = Math.min(pts.length, attr.count);
    for (let i = 0; i < n; i++) attr.setXYZ(i, pts[i]![0] + off[0], pts[i]![1] + off[1] + 0.03, pts[i]![2] + off[2]);
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, n);
    this.line.visible = n >= 2;
    this.drawMarker(pointer);
    this.host.canvas.setAttribute('data-room-corners', String(this.corners.length));
  }

  private drawMarker(p: Point3 | null): void {
    const off = this.offset();
    this.marker.visible = p !== null;
    if (p !== null) this.marker.position.set(p[0] + off[0], p[1] + off[1] + 0.03, p[2] + off[2]);
    this.host.canvas.setAttribute('data-room-hover', p === null ? '' : p.join(','));
    this.host.requestRender();
  }

  /** The straight sides of the edited rooms (tests read where walls stand). */
  sides(): OutlineSide[] {
    return allOutlines(this.target.component).flatMap(straightSides);
  }

  dispose(): void {
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

/** Points along a segment drawn as an arc of `bulge` (to the right of travel when positive), for the ghost. */
function arcPoints(a: Point3, b: Point3, bulge: number): Point3[] {
  if (bulge === 0) return [a, b];
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const chord = Math.hypot(dx, dz);
  if (chord === 0) return [a, b];
  // Right of travel: (-dz, dx); the sagitta is bulge × half the chord.
  const s = (bulge * chord) / 2;
  const mx = (a[0] + b[0]) / 2 + (-dz / chord) * s;
  const mz = (a[2] + b[2]) / 2 + (dx / chord) * s;
  const out: Point3[] = [];
  // A quadratic through a, the arc's middle and b (its control point twice the sagitta out).
  const cx = 2 * mx - (a[0] + b[0]) / 2;
  const cz = 2 * mz - (a[2] + b[2]) / 2;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], a[1], u * u * a[2] + 2 * u * t * cz + t * t * b[2]]);
  }
  return out;
}
