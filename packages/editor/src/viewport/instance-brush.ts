/**
 * The Scene view's instance brush: paint copies of the selected instance
 * set onto whatever collides (block layers, objects with a collider), or
 * erase them.
 *
 * A press starts a stroke and every move adds a dab (a quarter radius
 * apart) where the pointer meets a surface; the release sends the stroke as
 * one `paintInstances` command (one undo). The places come from the stroke
 * and its seed (project-model's `StrokeCandidates`, the backend computes the
 * same list); for paint the brush looks straight down under each place for
 * the highest surface within reach of its dab — block layers by their
 * colliders' shape, other objects by their drawn shape — and sends what it
 * found, so the backend can place copies on surfaces it cannot see. A
 * stroke that would carry more places than one command holds ends there and
 * the drag goes on as the next stroke.
 *
 * The brush kit is the shared one: its size (metres across; the stroke's
 * radius is half) and paint/erase (X switches, Ctrl held erases one
 * stroke) live in the tool's settings store, the cursor is the shared one
 * (`brush-cursor.ts`, its footprint only: a copy brush has no strength) and
 * the keys and in-view drags are the shared ones (`brush-control.ts`).
 */

import type { BlockChunk, BlockLayerComponent, BlockType, BrushBlockLayer, BrushVec3, InstanceBrush, InstanceStroke, StrokeSurfaceSample } from '@thirdlight/project-model';
import { BlockGrid, INSTANCE_BRUSH_LIMITS, StrokeCandidates, candidateDrop, dropOntoBlockLayers } from '@thirdlight/runtime';
import { BATCHED_LAYER } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { brushRadius, type BrushStore } from '../session/brush';
import { INSTANCE_BRUSH_USES } from '../session/instance-brush';
import { BrushControl } from './brush-control';
import { BrushCursor, tokenColour } from './brush-cursor';
import { ringGeometry, ringLine } from './helper-shapes';

export type InstanceBrushMode = 'paint' | 'erase';

/** A new dab once the pointer's surface point moved this many radii from the last one. */
const DAB_STEP = 0.25;
/** Painted values are sent in millimetres and normals in thousandths (the stroke stays small). */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface InstanceBrushDeps {
  /** Where the brush adds its ring and marks (the Scene view's overlay group). */
  scene: THREE.Object3D;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  requestRender: () => void;
  /** The drawn objects that collide (not block layers), visible, not the set itself. */
  colliders: (exceptId: string) => THREE.Object3D[];
  /** The block layers' drawn chunks (where the pointer meets them). */
  blockRoot: () => THREE.Object3D | null;
  /** The block layers as surfaces (their colliders' shape). */
  blockLayers: () => BrushBlockLayer[];
  /** Why a stroke cannot be painted (shown to the user). */
  refused: (message: string) => void;
}

/** What the last stroke cost (the Scene view shows it to tests and the bench). */
export interface StrokeTiming {
  mode: InstanceBrushMode;
  dabs: number;
  candidates: number;
  surfaceMs: number;
  commandMs: number;
  ok: boolean;
}

export class InstanceBrushTool {
  private target: { entityId: string; store: BrushStore; brush: InstanceBrush } | null = null;
  private stroke: { entityId: string; mode: InstanceBrushMode; brush: InstanceBrush; candidates: StrokeCandidates; last: THREE.Vector3 } | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly cursor: BrushCursor;
  private readonly control: BrushControl;
  private unstore: (() => void) | null = null;
  /** The surface under the pointer when it last moved (the cursor lies there). */
  private hover: THREE.Vector3 | null = null;
  private readonly marks = new THREE.Group();
  private readonly ringGeometry: THREE.BufferGeometry;
  private readonly ringMaterial = new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.6 });
  private pending: Promise<unknown> = Promise.resolve();
  lastTiming: StrokeTiming | null = null;

  constructor(
    private readonly deps: InstanceBrushDeps,
    private readonly send: (entityId: string, stroke: InstanceStroke) => Promise<boolean>,
  ) {
    this.ray.layers.enable(BATCHED_LAYER);
    // The stroke's dabs stay marked until it is sent (copies appear with the stored stroke), in the brush's colour.
    this.ringGeometry = ringGeometry('xz');
    this.marks.renderOrder = 12;
    deps.scene.add(this.marks);
    this.cursor = new BrushCursor(deps.scene, 'instance-brush-cursor');
    this.control = new BrushControl({ canvas: deps.canvas, surfaceAt: (x, y) => this.surfacePoint(x, y), distance: (a, b) => Math.hypot(a.x - b.x, a.z - b.z), ctrlChanged: () => this.refreshLook() });
  }

  /** Paint or erase copies of this set (null: off): the shared brush's size and invert from `store`, the copies' own settings in `brush`. */
  set(entityId: string | null, store: BrushStore | null, brush: InstanceBrush): void {
    this.target = entityId === null || store === null ? null : { entityId, store, brush };
    if (this.target === null) {
      this.cancel();
      this.cursor.hide();
      this.hover = null;
    }
    if (store !== this.storeOf()) {
      this.unstore?.();
      this.unstore = store?.subscribe(() => this.refreshLook()) ?? null;
    }
    this.control.setStore(this.target?.store ?? null, INSTANCE_BRUSH_USES);
    this.control.arm(this.target !== null);
    this.refreshLook();
  }

  private storeOf(): BrushStore | null {
    return this.target?.store ?? null;
  }

  /** The mode a stroke begun now paints in (the brush's invert, flipped while Ctrl is held). */
  private mode(): InstanceBrushMode {
    return this.control.inverted() ? 'erase' : 'paint';
  }

  /** The cursor's colour from paint or erase, and the canvas's published state; laid again where it is. */
  private refreshLook(): void {
    const t = this.target;
    const mode = this.mode();
    this.deps.canvas.setAttribute('data-brush', t?.entityId ?? '');
    this.deps.canvas.setAttribute('data-brush-mode', t === null ? '' : mode);
    // A copy brush has no strength: the footprint alone (no fill, no falloff ring).
    this.cursor.setLook({ falloff: 'constant', hardness: 0, strength: 0, mask: null, state: mode });
    this.ringMaterial.color.copy(tokenColour(mode === 'erase' ? '--brush-erase' : '--brush'));
    this.drawCursor();
  }

  private drawCursor(): void {
    const t = this.target;
    const p = this.hover;
    if (t === null || p === null) this.cursor.hide();
    else {
      const r = brushRadius(t.store.get());
      this.cursor.place({ centre: p, rx: r, rz: r });
    }
    this.deps.requestRender();
  }

  /** A brush key while armed (the editor's shortcuts route it here); true when taken. */
  key(e: KeyboardEvent): boolean {
    if (this.target === null || this.stroke !== null) return false;
    return this.control.key(e);
  }

  /** A press that ends an F drag (a click sets it). */
  pressAdjust(): boolean {
    return this.control.press();
  }

  active(selectedId: string | null): boolean {
    return this.target !== null && this.target.entityId === selectedId;
  }

  stroking(): boolean {
    return this.stroke !== null;
  }

  /** Start a stroke at the pointer (false: no surface under it, nothing started); `invert`: erase instead (Ctrl held at the press flips the brush's). */
  begin(clientX: number, clientY: number, ctrl = false): boolean {
    const t = this.target;
    if (t === null) return false;
    const p = this.surfacePoint(clientX, clientY);
    if (p === null) return false;
    const b = t.store.get();
    const brush: InstanceBrush = { ...t.brush, radius: brushRadius(b), scale: [t.brush.scale[0], t.brush.scale[1]] };
    this.stroke = { entityId: t.entityId, mode: b.invert !== ctrl ? 'erase' : 'paint', brush, candidates: new StrokeCandidates(brush), last: p.clone() };
    this.addDab(p);
    return this.stroke !== null;
  }

  /** The pointer moved: the cursor follows it; a stroke gains a dab every quarter radius. True while an F drag takes it. */
  move(e: PointerEvent): boolean {
    const t = this.target;
    if (t === null) return false;
    const p = this.surfacePoint(e.clientX, e.clientY);
    if (this.control.move(e, p)) {
      this.drawCursor();
      return true;
    }
    this.hover = p;
    this.drawCursor();
    const s = this.stroke;
    if (s !== null && p !== null && p.distanceTo(s.last) >= s.brush.radius * DAB_STEP) this.addDab(p);
    return false;
  }

  /** The pointer left the Scene view: the cursor goes with it (not during an F drag). */
  leave(): void {
    if (!this.control.leave()) return;
    this.hover = null;
    if (!this.cursor.visible()) return;
    this.cursor.hide();
    this.deps.requestRender();
  }

  /** The release: the stroke ends where the pointer let go and goes out as one command. */
  end(clientX: number, clientY: number): void {
    const p = this.stroke !== null ? this.surfacePoint(clientX, clientY) : null;
    if (p !== null && p.distanceTo(this.stroke!.last) > 1e-3) this.addDab(p);
    const s = this.stroke;
    this.stroke = null;
    this.clearMarks();
    if (s === null || s.candidates.dabs.length === 0) return;
    this.commit(s);
  }

  /** Esc: the stroke is dropped (nothing is sent), or what F was dragging put back. */
  cancel(): boolean {
    if (this.control.cancel()) return true;
    if (this.stroke === null) return false;
    this.stroke = null;
    this.clearMarks();
    return true;
  }

  /** Strokes still being answered (tests and the bench wait for them). */
  settled(): Promise<unknown> {
    return this.pending;
  }

  dispose(): void {
    this.cancel();
    this.unstore?.();
    this.control.dispose();
    this.cursor.dispose();
    this.marks.removeFromParent();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }

  private addDab(p: THREE.Vector3): void {
    const s = this.stroke!;
    const dab: BrushVec3 = [round3(p.x), round3(p.y), round3(p.z)];
    if (!s.candidates.add(dab)) {
      // Past what one command carries: this stroke ends here and the drag goes on as the next.
      if (s.candidates.dabs.length > 0) this.commit(s);
      this.clearMarks();
      const next = { ...s, candidates: new StrokeCandidates(s.brush) };
      this.stroke = next;
      if (!next.candidates.add(dab)) {
        // One dab alone holds more places than a stroke may: nothing can be painted with this brush.
        this.stroke = null;
        this.lastTiming = { mode: s.mode, dabs: 0, candidates: 0, surfaceMs: 0, commandMs: 0, ok: false };
        this.deps.canvas.setAttribute('data-instance-stroke', JSON.stringify(this.lastTiming));
        this.deps.refused(`one dab of this brush holds more than ${INSTANCE_BRUSH_LIMITS.samples} places for copies: lower the radius or the density`);
        return;
      }
    }
    this.stroke!.last.copy(p);
    const mark = ringLine(this.ringGeometry, this.ringMaterial);
    mark.position.set(p.x, p.y + 0.02, p.z);
    mark.scale.setScalar(s.brush.radius);
    this.marks.add(mark);
  }

  private clearMarks(): void {
    this.marks.clear();
    this.deps.requestRender();
  }

  private commit(s: NonNullable<InstanceBrushTool['stroke']>): void {
    const t0 = performance.now();
    const dabs = s.candidates.dabs.map((d) => [d[0], d[1], d[2]] as BrushVec3);
    const stroke: InstanceStroke = { mode: s.mode, dabs, brush: s.brush };
    const list = s.mode === 'paint' ? s.candidates.list() : [];
    if (s.mode === 'paint') stroke.surface = this.surfaceUnder(list, dabs, s.brush.radius, s.entityId);
    const t1 = performance.now();
    const timing: StrokeTiming = { mode: s.mode, dabs: dabs.length, candidates: list.length, surfaceMs: Math.round(t1 - t0), commandMs: 0, ok: false };
    // Strokes go out in order (a later one plans against the earlier one's copies).
    this.pending = this.pending.then(async () => {
      const ok = await this.send(s.entityId, stroke).catch(() => false);
      timing.commandMs = Math.round(performance.now() - t1);
      timing.ok = ok;
      this.lastTiming = timing;
      this.deps.canvas.setAttribute('data-instance-stroke', JSON.stringify(timing));
    });
  }

  /** Where the pointer meets something that collides (block layers and colliders), or null. */
  private surfacePoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.deps.camera);
    const targets = this.deps.colliders(this.target?.entityId ?? '');
    const blocks = this.deps.blockRoot();
    if (blocks !== null) targets.push(blocks);
    for (const h of this.ray.intersectObjects(targets, true)) {
      if ((h.object as THREE.Mesh).isMesh === true && h.object.visible) return h.point.clone();
    }
    return null;
  }

  /** For each place, the highest surface straight down within reach of its dab: [y, nx, nz] or null. */
  private surfaceUnder(list: ReturnType<StrokeCandidates['list']>, dabs: BrushVec3[], radius: number, setId: string): StrokeSurfaceSample[] {
    const blocks = dropOntoBlockLayers(this.deps.blockLayers());
    // Only the colliders whose bounds reach the stroke are tested.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const d of dabs) {
      minX = Math.min(minX, d[0] - radius);
      maxX = Math.max(maxX, d[0] + radius);
      minZ = Math.min(minZ, d[2] - radius);
      maxZ = Math.max(maxZ, d[2] + radius);
    }
    const box = new THREE.Box3();
    const near = this.deps.colliders(setId).filter((o) => {
      box.setFromObject(o);
      return !box.isEmpty() && box.max.x >= minX && box.min.x <= maxX && box.max.z >= minZ && box.min.z <= maxZ;
    });
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    return list.map((c) => {
      const span = candidateDrop(c, dabs, radius);
      let best: StrokeSurfaceSample = blocks(c.x, span.top, span.bottom, c.z);
      if (near.length > 0) {
        this.ray.set(from.set(c.x, span.top, c.z), down);
        this.ray.far = span.top - span.bottom;
        for (const h of this.ray.intersectObjects(near, true)) {
          if ((h.object as THREE.Mesh).isMesh !== true || !h.object.visible || h.face == null) continue;
          if (best !== null && h.point.y <= best[0]) break;
          normalMatrix.getNormalMatrix(h.object.matrixWorld);
          normal.copy(h.face.normal).applyMatrix3(normalMatrix).normalize();
          // Seen from above a face turned away is the underside of something: look further down.
          if (normal.y <= 0) continue;
          best = [h.point.y, normal.x, normal.z];
          break;
        }
        this.ray.far = Infinity;
      }
      return best === null ? null : ([round3(best[0]), round3(best[1]), round3(best[2])] as [number, number, number]);
    });
  }
}

/** Block layers as the brush's surfaces (grids built once per revision of the layers and set of hidden ones). */
export class BrushBlockSurfaces {
  private built: { revision: number; hidden: string; layers: BrushBlockLayer[] } | null = null;
  private source: { types: readonly BlockType[]; layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; hidden?: boolean }>; revision: number } | null = null;

  update(types: readonly BlockType[], layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: ReadonlyMap<string, BlockChunk>; origin: readonly number[]; hidden?: boolean }>, revision: number): void {
    this.source = { types, layers, revision };
  }

  layers(): BrushBlockLayer[] {
    const src = this.source;
    if (src === null) return [];
    // Hiding a layer (an inactive object, a closed scene) changes no cells, so the revision stays.
    const hidden = [...src.layers].filter(([, l]) => l.hidden === true).map(([id]) => id).join(',');
    if (this.built?.revision === src.revision && this.built.hidden === hidden) return this.built.layers;
    const types = new Map(src.types.map((t) => [t.blockId, t]));
    const layers: BrushBlockLayer[] = [];
    for (const [id, l] of src.layers) {
      if (l.hidden === true || l.component.metadataOnly === true) continue;
      layers.push({ grid: BlockGrid.from(l.component, { entityId: id, chunks: [...l.chunks.values()] }), types, origin: l.origin });
    }
    this.built = { revision: src.revision, hidden, layers };
    return layers;
  }
}
