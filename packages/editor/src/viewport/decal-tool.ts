/**
 * The decal editor's Scene-view tool, in its three modes:
 *
 * - **Place:** click a surface to place the picked decal facing out of it
 *   (one `createEntity`), Shift+click to stamp more (each with a seeded turn
 *   and size). The decal under the pointer is drawn as it would be placed,
 *   through the same adapter path as a stored one (one object drawn besides
 *   the project's, moved as the pointer moves; a clipped preview takes an
 *   empty result as final at once). A drag orbits.
 * - **Scatter:** drag with the shared brush (its footprint, the one cursor,
 *   the brush keys) to scatter the picked decal over the surfaces under it:
 *   the density, spacing and seeded turns and sizes are the scatter's own
 *   (`session/decal-editor.ts`). Each place is dropped onto the surface along
 *   the dab's normal and marked; the release stores the stroke as one
 *   `createEntities` (one undo; a stroke past what one command holds, by
 *   count or by bytes, goes on as the next stroke).
 * - **Select:** with no tool (Navigate, in every rail mode) a click picks the
 *   decal under the pointer (the front one of those whose image covers it,
 *   among those the filter lets through), Shift adds, Ctrl removes, a click
 *   on no decal clears; a drag orbits, but a drag on a selected decal moves
 *   it over the surfaces (one `setTransform`). With the Box tool every drag
 *   draws a box that picks the decals whose middle is in it. Del deletes the
 *   selection; Esc clears it.
 *
 * In every mode the primary selected decal shows its turn ring and size
 * corner: dragging the knob turns it about its normal (one `setTransform`),
 * the corner scales its width and height (one `setComponent`); both preview
 * while dragging and Esc drops them.
 *
 * Only decals are picked: the rest of the scene is drawn and is where decals
 * are placed, never selected (the edit mode's isolation).
 *
 * Browser-only (three.js); the maths is `session/decal-place.ts` and
 * `session/decal-editor.ts`.
 */
import * as THREE from 'three';
import type { DecalComponent } from '@thirdlight/project-model';
import { isDecalMark } from '@thirdlight/three-adapter';

import { brushRadius, type BrushStore, type BrushUse } from '../session/brush';
import { decalMatches, scatterPlacement, ScatterStroke, type DecalFilter, type DecalScatterSettings } from '../session/decal-editor';
import { decalPlaceCommand, decalPlacement, turnAboutNormal, type DecalToolSettings } from '../session/decal-place';
import type { ProjectedEntity } from '../session/projection';
import { createEntitiesBatcher, type RequestBatcher } from '../session/request-batches';
import { BrushControl } from './brush-control';
import { BrushCursor, tokenColour } from './brush-cursor';
import { DecalMarks } from './decal-marks';
import { ringGeometry, ringLine } from './helper-shapes';

/** The preview's object id: never a stored id (a NUL lead, as the generators' own objects have). */
export const DECAL_PREVIEW_ID = '\u0000decal-tool-preview';
/** How near (px) the pointer must be to a grip to take it. */
const GRIP_REACH_PX = 12;
/** A turn drag with snapping on moves in steps of this many degrees. */
const TURN_SNAP_DEG = 15;
/** A scatter stroke adds a dab once its surface point moved this many radii. */
const DAB_STEP = 0.5;
/** The shared brush settings a scatter stroke uses: its footprint. */
export const DECAL_SCATTER_USES: readonly BrushUse[] = ['size'];

type V3 = [number, number, number];
type Trs = { position: number[]; rotation: number[]; scale: number[] };

/** One stored decal as the tool sees it. */
export interface DecalTarget {
  readonly id: string;
  readonly trs: Trs;
  readonly decal: DecalComponent;
}

export interface DecalToolHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  canvas(): HTMLCanvasElement;
  /** The surface under a pointer position (world point and the normal facing the camera), decals and the preview left out. */
  surfaceAt(clientX: number, clientY: number): { point: V3; normal: V3 } | null;
  /** The first surface along a ray within `far` metres, decals left out. */
  surfaceOnRay(origin: V3, dir: V3, far: number): { point: V3; normal: V3 } | null;
  /** The decals that can be picked now (shown, not locked). */
  decals(): readonly DecalTarget[];
  /** Draw this object besides the project's (null: none). */
  setPreview(e: ProjectedEntity | null): void;
  /** Draw an entity at this local transform without storing it (null: as stored). */
  previewTransform(id: string, t: Trs | null): void;
  /** Draw an entity's decal as given without storing it (null: as stored). */
  previewDecal(id: string, decal: DecalComponent | null): void;
  worldOf(id: string): THREE.Matrix4 | null;
  /** The world matrix of an entity's parent (null: it has none). */
  parentWorld(id: string): THREE.Matrix4 | null;
  /** The clipped mesh drawn for an object now (null: none yet). */
  clippedMesh(id: string): THREE.Mesh | null;
  snapping(): boolean;
  requestRender(): void;
}

export interface DecalToolCallbacks {
  /** Store a new decal (`createEntity` args); resolves its id (null: refused). */
  place(args: Record<string, unknown>): Promise<string | null>;
  /** Store a stroke's decals (`createEntities` items, one command); resolves their ids (null: refused). */
  placeMany(items: Record<string, unknown>[]): Promise<string[] | null>;
  /** Store a decal's transform (one `setTransform`: a turn or a move). */
  transform(entityId: string, transform: Trs): Promise<boolean>;
  /** Store a decal's new size (one `setComponent`). */
  resize(entityId: string, decal: DecalComponent): Promise<boolean>;
  /** The selection changed (picked, boxed, cleared). */
  select(ids: readonly string[], primary: string | null): void;
  /** Delete these decals. */
  remove(ids: readonly string[]): void;
  refused(message: string): void;
}

export type DecalToolMode = 'place' | 'scatter' | 'select';

/** What the tool is armed with: the editor's mode and the settings and selection it works with. */
export interface DecalArm {
  readonly mode: DecalToolMode;
  /** Select: Navigate (a click picks, a drag orbits or moves a selected decal) or Box (every drag boxes). */
  readonly selectTool: 'navigate' | 'box';
  readonly settings: DecalToolSettings;
  readonly scatter: DecalScatterSettings;
  /** The shared brush's footprint (scatter). */
  readonly brush: BrushStore;
  readonly selection: readonly string[];
  readonly primary: string | null;
  readonly filter: DecalFilter;
  /** The scene new decals go into. */
  readonly sceneId: string | null;
}

interface GripDrag {
  kind: 'turn' | 'size';
  target: DecalTarget;
  centre: THREE.Vector3;
  x: THREE.Vector3;
  y: THREE.Vector3;
  plane: THREE.Plane;
  start: { angle: number; dist: number };
  now: Trs | DecalComponent | null;
}

/** A press in Select: on a decal (a click picks it, a drag on a selected one moves it) or on ground (a box). */
interface SelectPress {
  x: number;
  y: number;
  hit: DecalTarget | null;
  box: boolean;
  shift: boolean;
  ctrl: boolean;
  dragging: boolean;
  /** A move drag's transform now (null: not moved yet). */
  moved: Trs | null;
}

/**
 * The first surface among a ray's hits (nearest first) a decal is placed on, and its normal turned to face
 * the ray: decals' own marks and the preview are passed over (a decal is placed on the surface under them).
 * A hit with no triangle (terrain answers from its heights) asks `heightNormal` for the ground's normal.
 */
export function decalSurfaceOf(hits: readonly THREE.Intersection[], ray: THREE.Ray, owner: (o: THREE.Object3D) => string | null, heightNormal: (entityId: string, x: number, z: number) => readonly number[] | null): { point: V3; normal: V3 } | null {
  for (const h of hits) {
    const o = h.object as THREE.Mesh;
    if (o.isMesh !== true || isDecalMark(o)) continue;
    const id = owner(o);
    if (id === DECAL_PREVIEW_ID) continue;
    const n = new THREE.Vector3();
    if (h.face !== undefined && h.face !== null) {
      // The face's normal in the world: through the copy's own matrix for instanced and batched draws.
      const m = o.matrixWorld.clone();
      const inst = new THREE.Matrix4();
      if (h.instanceId !== undefined && (o as unknown as THREE.InstancedMesh).isInstancedMesh === true) m.multiply(((o as unknown as THREE.InstancedMesh).getMatrixAt(h.instanceId, inst), inst));
      else if (h.batchId !== undefined && (o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true) m.multiply(((o as unknown as THREE.BatchedMesh).getMatrixAt(h.batchId, inst), inst));
      n.copy(h.face.normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m));
    } else {
      const g = id === null ? null : heightNormal(id, h.point.x, h.point.z);
      n.set(g?.[0] ?? 0, g?.[1] ?? 1, g?.[2] ?? 0);
    }
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    if (n.dot(ray.direction) > 0) n.negate();
    return { point: [h.point.x, h.point.y, h.point.z], normal: [n.x, n.y, n.z] };
  }
  return null;
}

export class DecalTool {
  private arm_: DecalArm | null = null;
  /** Stamps placed since the tool was armed or its seed changed (the next stamp's number). */
  private stamps = 0;
  private seed: number | null = null;
  private placed = 0;
  private preview: { position: number[]; rotation: number[]; decal: DecalComponent } | null = null;
  private grip: GripDrag | null = null;
  private press: { x: number; y: number } | null = null;
  private select: SelectPress | null = null;
  private hoverId: string | null = null;
  private stroke: { scatter: ScatterStroke; last: THREE.Vector3; batch: RequestBatcher<Record<string, unknown>> } | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly marks: DecalMarks;
  private readonly cursor: BrushCursor;
  private readonly control: BrushControl;
  private readonly strokeMarks = new THREE.Group();
  private readonly strokeRing = ringGeometry('xy', 24);
  private readonly strokeMat = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
  private cursorAt: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  private unstore: (() => void) | null = null;
  /** The last scatter stroke: its places, how many were stored, the first and last stored ids (tests read them). */
  private lastStroke: { places: number; stored: number; first?: string; last?: string } | null = null;

  /** `slopPx`: a pointer that moved less than this between press and release is a click, not a drag (the view's). */
  constructor(private readonly host: DecalToolHost, private readonly cb: DecalToolCallbacks, private readonly slopPx: number) {
    this.marks = new DecalMarks(host.overlay);
    this.cursor = new BrushCursor(host.overlay, 'decal-scatter-cursor');
    this.control = new BrushControl({ canvas: host.canvas(), surfaceAt: (x, y) => this.surfacePoint(x, y)?.point ?? null, ctrlChanged: () => undefined });
    this.strokeMarks.renderOrder = 13;
    this.strokeMat.color.copy(tokenColour('--brush'));
    host.overlay.add(this.strokeMarks);
  }

  armed(): boolean {
    return this.arm_ !== null;
  }

  /** Arm the tool (null: off). */
  arm(a: DecalArm | null): void {
    const was = this.arm_;
    this.arm_ = a;
    if (a === null || was === null || a.settings.stamp.seed !== this.seed) this.stamps = 0;
    this.seed = a?.settings.stamp.seed ?? null;
    if (a === null || a.mode !== was?.mode) {
      this.dropGesture();
      this.control.cancel();
      this.showPreview(null);
      this.setHover(null);
    }
    if (a?.brush !== was?.brush) {
      this.unstore?.();
      this.unstore = a?.brush.subscribe(() => this.drawCursor()) ?? null;
    }
    const scatter = a?.mode === 'scatter';
    this.control.setStore(scatter ? a.brush : null, DECAL_SCATTER_USES);
    this.control.arm(scatter);
    if (!scatter) this.cursor.hide();
    this.cursor.setLook({ falloff: 'constant', hardness: 0, strength: 0, mask: null, state: a?.settings.material === null ? 'off' : 'paint' });
    this.drawSelection();
    this.host.requestRender();
  }

  pointerDown(e: PointerEvent): 'capture' | 'consume' | null {
    const r = this.takePress(e);
    // A Shift+click or a drag the tool takes never selects the page's text.
    if (r !== null) e.preventDefault();
    return r;
  }

  private takePress(e: PointerEvent): 'capture' | 'consume' | null {
    const a = this.arm_;
    if (a === null || e.button !== 0 || e.altKey) return null;
    this.press = { x: e.clientX, y: e.clientY };
    if (this.beginGrip(e)) {
      this.press = null;
      return 'capture';
    }
    if (a.mode === 'scatter') {
      this.press = null;
      if (this.control.press()) return 'consume';
      if (a.settings.material === null) {
        this.cb.refused('Pick a decal in the palette to scatter.');
        return 'consume';
      }
      const at = this.surfacePoint(e.clientX, e.clientY);
      if (at === null) return null;
      this.stroke = { scatter: new ScatterStroke(a.scatter), last: at.point.clone(), batch: createEntitiesBatcher(a.sceneId) };
      this.dab(at.point, at.normal);
      return 'capture';
    }
    if (a.mode === 'select') {
      const hit = a.selectTool === 'box' ? null : this.decalAt(e.clientX, e.clientY);
      // Navigate: a press on a selected decal may move it; any other is the orbit's, and its release, a click, selects.
      if (a.selectTool === 'navigate' && (hit === null || !a.selection.includes(hit.id))) return null;
      this.press = null;
      this.select = { x: e.clientX, y: e.clientY, hit, box: hit === null, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, dragging: false, moved: null };
      return 'capture';
    }
    // Place: the release places; a drag orbits.
    return null;
  }

  /** A move: a gesture in flight follows it (true: the tool owns the pointer); otherwise the hover shows. */
  pointerMove(e: PointerEvent): boolean {
    const a = this.arm_;
    if (a === null) return false;
    if (this.grip !== null) {
      this.moveGrip(e.clientX, e.clientY);
      return true;
    }
    if (a.mode === 'scatter') {
      const at = this.surfacePoint(e.clientX, e.clientY);
      if (this.control.move(e, at?.point ?? null)) {
        this.drawCursor();
        return true;
      }
      this.cursorAt = at;
      this.drawCursor();
      const s = this.stroke;
      if (s !== null && at !== null && at.point.distanceTo(s.last) >= brushRadius(a.brush.get()) * DAB_STEP) {
        s.last.copy(at.point);
        this.dab(at.point, at.normal);
      }
      return s !== null;
    }
    const sel = this.select;
    if (sel !== null) {
      if (!sel.dragging && Math.hypot(e.clientX - sel.x, e.clientY - sel.y) <= this.slopPx) return true;
      sel.dragging = true;
      if (sel.box) this.marks.setBox(this.host.canvas(), { x: sel.x, y: sel.y }, { x: e.clientX, y: e.clientY });
      else this.moveDecal(sel, e.clientX, e.clientY);
      this.host.requestRender();
      return true;
    }
    if (e.buttons !== 0) return false;
    if (a.mode === 'place') this.hover(e.clientX, e.clientY, e.shiftKey);
    else this.setHover(this.decalAt(e.clientX, e.clientY));
    return false;
  }

  /** A release that ends the tool's own gesture (a grip, a stroke, a select press): true when it did. */
  pointerUp(e: PointerEvent): boolean {
    if (this.arm_ === null || e.button !== 0) return false;
    const g = this.grip;
    if (g !== null) {
      this.grip = null;
      this.commitGrip(g);
      return true;
    }
    const s = this.stroke;
    if (s !== null) {
      this.stroke = null;
      this.commitStroke(s.batch.take());
      return true;
    }
    const sel = this.select;
    if (sel !== null) {
      this.select = null;
      this.endSelect(sel, e.clientX, e.clientY);
      return true;
    }
    return false;
  }

  /** A release no gesture claimed: in Place a click places (Shift: a stamp); in Navigate it selects. True when it did. */
  click(e: PointerEvent): boolean {
    const a = this.arm_;
    const press = this.press;
    this.press = null;
    if (a === null || e.button !== 0 || press === null || Math.hypot(e.clientX - press.x, e.clientY - press.y) > this.slopPx) return false;
    if (a.mode === 'select') {
      if (a.selectTool !== 'navigate') return false;
      this.endSelect({ x: press.x, y: press.y, hit: this.decalAt(e.clientX, e.clientY), box: false, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, dragging: false, moved: null }, e.clientX, e.clientY);
      return true;
    }
    if (a.mode !== 'place') return false;
    this.place(e.clientX, e.clientY, e.shiftKey);
    return true;
  }

  /** A gesture is in flight (its release is the tool's alone). */
  dragging(): boolean {
    return this.grip !== null || this.stroke !== null || this.select !== null;
  }

  /** The pointer left the view: no preview, hover or cursor under it. */
  leave(): void {
    if (this.dragging()) return;
    this.showPreview(null);
    this.setHover(null);
    if (this.control.leave()) {
      this.cursorAt = null;
      this.cursor.hide();
      this.host.requestRender();
    }
  }

  /** Esc: a gesture in flight is dropped (nothing stored); else an F drag put back; else the selection cleared. True when one was. */
  cancel(): boolean {
    if (this.dropGesture() || this.control.cancel()) return true;
    const a = this.arm_;
    if (a !== null && a.selection.length > 0) {
      this.cb.select([], null);
      return true;
    }
    return false;
  }

  /** Drop a grip drag, a stroke or a select press in flight (nothing stored); true when there was one. */
  private dropGesture(): boolean {
    const g = this.grip;
    if (g !== null) {
      this.grip = null;
      if (g.kind === 'turn') this.host.previewTransform(g.target.id, null);
      else this.host.previewDecal(g.target.id, null);
      this.drawSelection();
      this.host.requestRender();
      return true;
    }
    if (this.stroke !== null) {
      this.stroke = null;
      this.strokeMarks.clear();
      this.host.requestRender();
      return true;
    }
    const sel = this.select;
    if (sel !== null) {
      this.select = null;
      this.marks.setBox(this.host.canvas(), null);
      if (sel.hit !== null && sel.moved !== null) this.host.previewTransform(sel.hit.id, null);
      this.host.requestRender();
      return true;
    }
    return false;
  }

  /** A key while armed (the edit mode routes it here): Del deletes the selection, the brush keys in Scatter. */
  key(e: KeyboardEvent): boolean {
    const a = this.arm_;
    if (a === null) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey && a.selection.length > 0) {
      this.cb.remove(a.selection);
      return true;
    }
    if (a.mode === 'scatter' && this.stroke === null) return this.control.key(e);
    return false;
  }

  /** Before a frame: outlines follow their decals, grips keep their screen size; the tool's state for tests (`data-decal-tool`). */
  frame(): void {
    const canvas = this.host.canvas();
    const a = this.arm_;
    if (a === null) {
      if (canvas.hasAttribute('data-decal-tool')) canvas.removeAttribute('data-decal-tool');
      return;
    }
    // A new decal's world matrix is the adapter's after its first sync: the marks are laid again each frame.
    if (this.grip === null && (this.select?.moved ?? null) === null) this.drawSelection();
    this.marks.frame(this.host.camera);
    const grips = this.marks.gripsShown() ? { turn: this.clientAt(this.marks.gripWorld.turn), size: this.clientAt(this.marks.gripWorld.size) } : null;
    canvas.setAttribute(
      'data-decal-tool',
      JSON.stringify({ mode: a.mode, selectTool: a.selectTool, preview: this.preview, target: a.primary, selection: a.selection, hover: this.hoverId, grips, stamps: this.stamps, placed: this.placed, stroke: this.lastStroke, clippedPreview: this.preview !== null && this.host.clippedMesh(DECAL_PREVIEW_ID) !== null }),
    );
  }

  dispose(): void {
    this.showPreview(null);
    this.unstore?.();
    this.control.dispose();
    this.cursor.dispose();
    this.marks.dispose();
    this.strokeMarks.removeFromParent();
    this.strokeRing.dispose();
    this.strokeMat.dispose();
  }

  // ---- place ---------------------------------------------------------------------------------

  private hover(clientX: number, clientY: number, stamp: boolean): void {
    const a = this.arm_!;
    const s = a.settings;
    const hit = s.material === null ? null : this.host.surfaceAt(clientX, clientY);
    if (hit === null) return this.showPreview(null);
    this.showPreview(decalPlacement(s, s.material!, hit.point, hit.normal, stamp ? this.stamps : null));
  }

  private showPreview(p: { position: number[]; rotation: number[]; decal: DecalComponent } | null): void {
    if (p === null && this.preview === null) return;
    this.preview = p;
    const sceneId = this.arm_?.sceneId ?? null;
    this.host.setPreview(
      p === null
        ? null
        : { id: DECAL_PREVIEW_ID, name: 'Decal (preview)', parentId: null, kind: 'entity', active: true, visible: true, locked: false, static: false, keepLoaded: false, tags: 0, position: p.position, rotation: p.rotation, scale: [1, 1, 1], ...(sceneId !== null ? { sceneId } : {}), components: { decal: p.decal } },
    );
    this.host.requestRender();
  }

  private place(clientX: number, clientY: number, stamp: boolean): void {
    const a = this.arm_!;
    const s = a.settings;
    if (s.material === null) return this.cb.refused('Pick a decal in the palette to place it.');
    const hit = this.host.surfaceAt(clientX, clientY);
    if (hit === null) return this.cb.refused('No surface under the pointer to place the decal on.');
    const p = decalPlacement(s, s.material, hit.point, hit.normal, stamp ? this.stamps : null);
    if (stamp) this.stamps += 1;
    this.placed += 1;
    void this.cb.place(decalPlaceCommand(a.sceneId, 'Decal', p).args);
    // The next stamp's look under the pointer.
    this.hover(clientX, clientY, stamp);
  }

  // ---- scatter -------------------------------------------------------------------------------

  /** Where the pointer meets a surface, with the surface's normal (decals left out). */
  private surfacePoint(clientX: number, clientY: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const hit = this.host.surfaceAt(clientX, clientY);
    return hit === null ? null : { point: new THREE.Vector3(...hit.point), normal: new THREE.Vector3(...hit.normal) };
  }

  private drawCursor(): void {
    const a = this.arm_;
    const at = this.cursorAt;
    if (a === null || a.mode !== 'scatter' || at === null) this.cursor.hide();
    else {
      const r = brushRadius(a.brush.get());
      this.cursor.place({ centre: at.point, rx: r, rz: r, normal: at.normal, fill: false });
    }
    this.host.requestRender();
  }

  /** A dab of the stroke: its new places dropped onto the surfaces along the dab's normal, marked until the stroke is stored. */
  private dab(point: THREE.Vector3, normal: THREE.Vector3): void {
    const a = this.arm_!;
    const s = this.stroke!;
    const r = brushRadius(a.brush.get());
    for (const p of s.scatter.dab([point.x, point.y, point.z], [normal.x, normal.y, normal.z], r)) {
      const n = p.normal;
      const from: V3 = [p.point[0] + n[0] * r, p.point[1] + n[1] * r, p.point[2] + n[2] * r];
      const hit = this.host.surfaceOnRay(from, [-n[0], -n[1], -n[2]], 2 * r);
      if (hit === null) continue;
      const placed = scatterPlacement(a.settings, a.scatter, a.settings.material!, hit.point, hit.normal, p.index);
      // Past what one command carries (its count or its bytes): what the stroke laid so far is stored, and the drag goes on as the next stroke.
      const full = s.batch.add(decalPlaceCommand(a.sceneId, 'Decal', placed).args);
      if (full !== null) this.commitStroke(full);
      const mark = ringLine(this.strokeRing, this.strokeMat);
      mark.position.set(...placed.position);
      mark.quaternion.set(...(placed.rotation as [number, number, number, number]));
      mark.scale.setScalar(0.5 * Math.hypot(placed.decal.size[0], placed.decal.size[1]));
      mark.renderOrder = 13;
      mark.raycast = () => undefined;
      this.strokeMarks.add(mark);
    }
    this.host.requestRender();
  }

  private commitStroke(items: Record<string, unknown>[]): void {
    this.lastStroke = { places: items.length, stored: 0 };
    if (items.length === 0) {
      this.strokeMarks.clear();
      this.host.requestRender();
      return;
    }
    void this.cb.placeMany(items).then((ids) => {
      this.lastStroke = { places: items.length, stored: ids?.length ?? 0, ...(ids !== null && ids.length > 0 ? { first: ids[0]!, last: ids[ids.length - 1]! } : {}) };
      // The marks stand until the stored decals are drawn (or the stroke is refused).
      this.strokeMarks.clear();
      this.host.requestRender();
    });
  }

  // ---- select --------------------------------------------------------------------------------

  /** The decals the filter lets the pointer pick, with their world matrices. */
  private pickable(): { t: DecalTarget; world: THREE.Matrix4 }[] {
    const f = this.arm_!.filter;
    const out: { t: DecalTarget; world: THREE.Matrix4 }[] = [];
    for (const t of this.host.decals()) {
      if (!decalMatches(t.decal, f)) continue;
      const world = this.host.worldOf(t.id);
      if (world !== null) out.push({ t, world });
    }
    return out;
  }

  /** The decal whose image covers the pointer, the nearest to the camera of them (null: none). */
  private decalAt(clientX: number, clientY: number): DecalTarget | null {
    this.aim(clientX, clientY);
    let best: { t: DecalTarget; d: number } | null = null;
    const local = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    for (const { t, world } of this.pickable()) {
      const n = new THREE.Vector3().setFromMatrixColumn(world, 2).normalize();
      const centre = new THREE.Vector3().setFromMatrixPosition(world);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, centre);
      const p = this.ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (p === null) continue;
      local.copy(p).applyMatrix4(inv.copy(world).invert());
      if (Math.abs(local.x) > t.decal.size[0] / 2 || Math.abs(local.y) > t.decal.size[1] / 2) continue;
      const d = p.distanceTo(this.ray.ray.origin);
      if (best === null || d < best.d) best = { t, d };
    }
    return best?.t ?? null;
  }

  private setHover(t: DecalTarget | null): void {
    if ((t?.id ?? null) === this.hoverId) return;
    this.hoverId = t?.id ?? null;
    const world = t === null ? null : this.host.worldOf(t.id);
    this.marks.setHover(t === null || world === null ? null : { id: t.id, world, size: t.decal.size });
    this.host.requestRender();
  }

  /** A press's release in Select: a click picks, a box picks what is in it, a move is stored. */
  private endSelect(sel: SelectPress, clientX: number, clientY: number): void {
    const a = this.arm_!;
    this.marks.setBox(this.host.canvas(), null);
    if (sel.hit !== null && sel.dragging) {
      if (sel.moved === null) return;
      const id = sel.hit.id;
      const restore = (): void => {
        this.host.previewTransform(id, null);
        this.host.requestRender();
      };
      void this.cb.transform(id, sel.moved).then(restore, restore);
      return;
    }
    let picked: string[];
    if (sel.box && sel.dragging) {
      const [x0, x1] = [Math.min(sel.x, clientX), Math.max(sel.x, clientX)];
      const [y0, y1] = [Math.min(sel.y, clientY), Math.max(sel.y, clientY)];
      picked = this.pickable()
        .filter(({ world }) => {
          const c = this.clientAt(new THREE.Vector3().setFromMatrixPosition(world));
          return c !== null && c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1;
        })
        .map(({ t }) => t.id);
    } else picked = sel.hit === null ? [] : [sel.hit.id];
    const have = a.selection;
    let ids: string[];
    if (sel.ctrl) ids = have.filter((id) => !picked.includes(id));
    else if (sel.shift) ids = [...have, ...picked.filter((id) => !have.includes(id))];
    else ids = picked;
    const primary = !sel.ctrl && picked.length > 0 ? picked[picked.length - 1]! : a.primary !== null && ids.includes(a.primary) ? a.primary : (ids.at(-1) ?? null);
    this.cb.select(ids, primary);
  }

  /** A drag on a decal: a selected one follows the pointer over the surfaces (its turn about its normal kept); an unselected one is a click. */
  private moveDecal(sel: SelectPress, clientX: number, clientY: number): void {
    const t = sel.hit!;
    if (!this.arm_!.selection.includes(t.id)) return;
    const hit = this.host.surfaceAt(clientX, clientY);
    const world = this.host.worldOf(t.id);
    if (hit === null || world === null) return;
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(world));
    const was = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const turned = new THREE.Quaternion().setFromUnitVectors(was, new THREE.Vector3(...hit.normal)).multiply(q);
    const target = new THREE.Matrix4().compose(new THREE.Vector3(...hit.point), turned, new THREE.Vector3(...t.trs.scale.map((v) => v ?? 1)));
    const parent = this.host.parentWorld(t.id);
    if (parent !== null) target.premultiply(parent.clone().invert());
    const p = new THREE.Vector3();
    const r = new THREE.Quaternion();
    const s = new THREE.Vector3();
    target.decompose(p, r, s);
    const mm = (v: number): number => Math.round(v * 1000) / 1000;
    const fine = (v: number): number => Math.round(v * 1e6) / 1e6;
    const rot = r.w < 0 ? [-r.x, -r.y, -r.z, -r.w] : [r.x, r.y, r.z, r.w];
    sel.moved = { position: [mm(p.x), mm(p.y), mm(p.z)], rotation: rot.map(fine), scale: [...t.trs.scale] };
    this.host.previewTransform(t.id, sel.moved);
  }

  /** The selection's outlines and the primary's grips, as stored (or as a grip drag previews them). */
  private drawSelection(now?: Trs | DecalComponent | null): void {
    const a = this.arm_;
    if (a === null || a.selection.length === 0) {
      this.marks.setSelection([]);
      this.marks.setGrips(null, [1, 1]);
      return;
    }
    const byId = new Map(this.host.decals().map((t) => [t.id, t]));
    const marked = [];
    for (const id of a.selection) {
      const t = byId.get(id);
      const world = t === undefined ? null : this.host.worldOf(id);
      if (t !== undefined && world !== null) marked.push({ id, world, size: t.decal.size });
    }
    this.marks.setSelection(marked);
    const p = a.primary === null ? undefined : byId.get(a.primary);
    const world = p === undefined ? null : this.host.worldOf(p.id);
    if (p === undefined || world === null) return this.marks.setGrips(null, [1, 1]);
    const m = world.clone();
    let size = p.decal.size;
    if (now !== undefined && now !== null) {
      if ('rotation' in now) {
        // The world frame turned as the preview turns it (about the decal's own Z).
        const q = new THREE.Quaternion(...(now.rotation as [number, number, number, number]));
        const q0 = new THREE.Quaternion(...(p.trs.rotation as [number, number, number, number]));
        m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(q0.invert().multiply(q)));
      } else size = now.size;
    }
    this.marks.setGrips(m, size);
  }

  // ---- grips ---------------------------------------------------------------------------------

  private primaryTarget(): DecalTarget | null {
    const id = this.arm_?.primary ?? null;
    return id === null ? null : (this.host.decals().find((t) => t.id === id) ?? null);
  }

  private beginGrip(e: PointerEvent): boolean {
    const grip = this.gripAt(e.clientX, e.clientY);
    const target = grip === null ? null : this.primaryTarget();
    if (grip === null || target === null) return false;
    const world = this.host.worldOf(target.id);
    if (world === null) return false;
    const centre = new THREE.Vector3().setFromMatrixPosition(world);
    const x = new THREE.Vector3().setFromMatrixColumn(world, 0).normalize();
    const y = new THREE.Vector3().setFromMatrixColumn(world, 1).normalize();
    const n = new THREE.Vector3().setFromMatrixColumn(world, 2).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, centre);
    const drag: GripDrag = { kind: grip, target, centre, x, y, plane, start: { angle: 0, dist: 0 }, now: null };
    const p = this.onPlane(drag, e.clientX, e.clientY);
    if (p === null) return false;
    drag.start = { angle: Math.atan2(p.dot(y), p.dot(x)), dist: Math.max(1e-6, p.length()) };
    this.grip = drag;
    return true;
  }

  private moveGrip(clientX: number, clientY: number): void {
    const d = this.grip!;
    const p = this.onPlane(d, clientX, clientY);
    if (p === null) return;
    if (d.kind === 'turn') {
      let deg = ((Math.atan2(p.dot(d.y), p.dot(d.x)) - d.start.angle) * 180) / Math.PI;
      if (this.host.snapping()) deg = Math.round(deg / TURN_SNAP_DEG) * TURN_SNAP_DEG;
      const t = { ...d.target.trs, rotation: turnAboutNormal(d.target.trs.rotation, deg) };
      d.now = t;
      this.host.previewTransform(d.target.id, t);
    } else {
      const k = p.length() / d.start.dist;
      const s = d.target.decal.size;
      const mm = (v: number): number => Math.max(0.01, Math.round(v * 1000) / 1000);
      const decal: DecalComponent = { ...d.target.decal, size: [mm(s[0] * k), mm(s[1] * k), s[2]] };
      d.now = decal;
      this.host.previewDecal(d.target.id, decal);
    }
    this.drawSelection(d.now);
    this.host.requestRender();
  }

  private commitGrip(d: GripDrag): void {
    const now = d.now;
    const restore = (): void => {
      if (d.kind === 'turn') this.host.previewTransform(d.target.id, null);
      else this.host.previewDecal(d.target.id, null);
      this.host.requestRender();
    };
    if (now === null) return restore();
    const stored = d.kind === 'turn' ? this.cb.transform(d.target.id, now as Trs) : this.cb.resize(d.target.id, now as DecalComponent);
    // The stored value arrives with the projection; the preview stands until then (none, if refused).
    void stored.then(restore, restore);
  }

  /** The pointer's point on the drag's plane, relative to the decal's centre. */
  private onPlane(d: GripDrag, clientX: number, clientY: number): THREE.Vector3 | null {
    this.aim(clientX, clientY);
    const p = this.ray.ray.intersectPlane(d.plane, new THREE.Vector3());
    return p === null ? null : p.sub(d.centre);
  }

  private aim(clientX: number, clientY: number): void {
    const r = this.host.canvas().getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.host.camera);
  }

  private gripAt(clientX: number, clientY: number): 'turn' | 'size' | null {
    this.drawSelection();
    if (!this.marks.gripsShown()) return null;
    let best: ['turn' | 'size', number] | null = null;
    for (const kind of ['turn', 'size'] as const) {
      const c = this.clientAt(this.marks.gripWorld[kind]);
      if (c === null) continue;
      const dist = Math.hypot(c.x - clientX, c.y - clientY);
      if (dist <= GRIP_REACH_PX && (best === null || dist < best[1])) best = [kind, dist];
    }
    return best?.[0] ?? null;
  }

  /** A world point on the page (client coordinates; null: behind the camera). */
  private clientAt(p: THREE.Vector3): { x: number; y: number } | null {
    const r = this.host.canvas().getBoundingClientRect();
    if (r.width === 0) return null;
    this.host.camera.updateMatrixWorld();
    const v = p.clone().project(this.host.camera);
    if (v.z > 1) return null;
    return { x: Math.round(r.left + ((v.x + 1) / 2) * r.width), y: Math.round(r.top + ((1 - v.y) / 2) * r.height) };
  }
}
