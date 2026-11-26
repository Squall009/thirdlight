/**
 * The Scene view's voxel brush tool: the one brush that edits voxels by
 * hand, on a voxel world's lattice (the world edit mode's Sculpt and Paint)
 * or on a structure's own grid (the structure mode's hand edits). It builds
 * nothing of its own beside the stroke:
 *
 * - the pointer is found by the view's voxel pick (the worker's walk through
 *   the worlds and their grids, each grid in its own frame); only a hit on
 *   the grid the tool is armed for is the tool's, a press elsewhere is the
 *   view's (it orbits);
 * - the brush is the shared one: its settings store, its keys and in-view
 *   drags (`BrushControl`: `[` `]`, F, Ctrl to invert Add and Dig) and its
 *   cursor (`BrushCursor`), laid on the face under the pointer at the
 *   brush's size in whole cells, with the cells' box where the brush is one;
 * - a drag collects dabs on the grid's cells, thinned to the brush's
 *   spacing (`session/voxel-brush.ts`), and the release sends **one**
 *   `editVoxels` command for the stroke, so a stroke is one undo step.
 *   Nothing is written while dragging: the trail of the dabs shows where the
 *   stroke goes, and the view draws the result when the change feed brings
 *   the changed chunks (`voxelsChanged`), as it does for any client's edit.
 *
 * Flatten's plane is the surface under the stroke's first dab. Esc drops a
 * stroke in flight; nothing is sent.
 *
 * Tests read `data-voxel-brush`: the tool, the cell under the pointer, the
 * stroke in flight and the last one sent.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { grownCapacity } from '@thirdlight/shared';
import { GridFrame, VOXEL_SIZE_M, type BrushShape, type GridPlacement } from '@thirdlight/voxel';

import { strokeMask, type BrushStore, type BrushUse } from '../session/brush';
import { brushCells, dabCell, dabSpacingCells, DabTrail, surfaceHeightCells, voxelStrokeCommand, type VoxelBrushKind, type VoxelBrushVoxel } from '../session/voxel-brush';
import type { ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { BrushControl } from './brush-control';
import { BrushCursor, tokenColour } from './brush-cursor';
import type { ToolPress } from './tool-input';

/** What an edit mode arms the brush with. */
export interface VoxelBrushArm {
  readonly kind: VoxelBrushKind;
  /** No tool in hand: a press is the view's (orbit, select). */
  readonly navigate: boolean;
  readonly world: string;
  /** The grid edited: 0 the world's lattice, else a structure's own grid. */
  readonly grid: number;
  /** The structure object whose grid it is (where the grid stands); null: the world's lattice. */
  readonly entityId: string | null;
  /** The brush's settings (the shared panel and keys change them). */
  readonly store: BrushStore;
  /** The settings this brush uses (`mask`: a Paint goes through the noise mask when it is on). */
  readonly uses: readonly BrushUse[];
  readonly shape: BrushShape;
  /** A soft rim (Add, Dig, Smooth, Flatten). */
  readonly soft: boolean;
  /** What Add writes and Paint gives (null: none picked; Add and Paint then say so and send nothing). */
  readonly voxel: VoxelBrushVoxel | null;
}

export interface VoxelBrushHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  canvas(): HTMLCanvasElement;
  requestRender(): void;
  /** What the voxel worlds meet first under a pointer (null: no world open). */
  pick(clientX: number, clientY: number): Promise<ScenePickHit | null> | null;
  /** Where a structure object's grid is drawn now (null: not drawn yet). */
  place(entityId: string): GridPlacement | null;
}

export interface VoxelBrushCallbacks {
  /** A stroke: one `editVoxels` command on `world` (its `grid` names the lattice). */
  stroke(world: string, command: Record<string, unknown>): Promise<void>;
  /** Why something was not sent (the shell's status line shows it). */
  refused(message: string): void;
  /** What the stroke in flight holds, said live (null: none). */
  readout(text: string | null): void;
}

/** Where a lattice stands: its cell 0's corner and its turn about the vertical. */
type LatticePlace = Pick<GridPlacement, 'position' | 'yawRad'>;
/** The world's own lattice: cell 0 at the world's origin, not turned. */
const WORLD_PLACE: LatticePlace = Object.freeze({ position: [0, 0, 0] as const, yawRad: 0 });
/** A point of a lattice (its own metres) in the world: the world's lattice as it is, a structure's grid through its frame. */
type ToWorld = (x: number, y: number, z: number) => readonly [number, number, number];
/** Lifted off the cells so the trail does not sink into the faces it runs over. */
const TRAIL_LIFT_M = 0.06;
/** Drawn after the scene, with the brush cursor. */
const ORDER = 22;

interface Stroke {
  readonly kind: VoxelBrushKind;
  readonly trail: DabTrail;
  /** Flatten's plane (cells): the surface under the first dab. */
  readonly height: number;
  /** The release came while a pick was in flight: the stroke is sent when the pick answers. */
  ended: boolean;
}

const BOX_EDGES = ((): number[] => {
  const c = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]];
  return [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7].flatMap((i) => c[i]!);
})();

export class VoxelBrushTool {
  private arming: VoxelBrushArm | null = null;
  private stroke: Stroke | null = null;
  private readonly cursor: BrushCursor;
  private readonly control: BrushControl;
  /** The grid's frame: the cells' box and the trail are drawn in the grid's own metres. */
  private readonly frameGroup = new THREE.Group();
  private readonly box: THREE.LineSegments;
  private readonly trail: THREE.Line;
  private trailRoom = 0;
  /** The last voxel hit under the pointer, the pointer it was picked for, and whether a pick is in flight. */
  private hover: ScenePickHit | null = null;
  private hoverAtPx: [number, number] | null = null;
  private picking = false;
  private pendingPointer: { x: number; y: number } | null = null;
  private last: Record<string, unknown> | null = null;
  private stamp = '';
  private unstore: (() => void) | null = null;

  constructor(private readonly host: VoxelBrushHost, private readonly cb: VoxelBrushCallbacks) {
    this.cursor = new BrushCursor(host.overlay, 'voxel-brush-cursor');
    this.control = new BrushControl({ canvas: host.canvas(), surfaceAt: () => this.hoverPoint(), ctrlChanged: () => this.redraw() });
    const line = (): THREE.LineBasicMaterial => new THREE.LineBasicMaterial({ color: tokenColour('--brush'), depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
    const boxGeo = new THREE.BufferGeometry();
    boxGeo.setAttribute('position', new THREE.Float32BufferAttribute(BOX_EDGES, 3));
    this.box = new THREE.LineSegments(boxGeo, line());
    this.trail = new THREE.Line(new THREE.BufferGeometry(), line());
    for (const o of [this.box, this.trail]) {
      o.renderOrder = ORDER;
      o.frustumCulled = false;
      o.raycast = () => undefined;
      o.visible = false;
    }
    this.frameGroup.name = 'voxel-brush';
    this.frameGroup.add(this.box, this.trail);
    host.overlay.add(this.frameGroup);
  }

  armed(): boolean {
    return this.arming !== null && !this.arming.navigate;
  }

  /** Arm the brush (null: off; a stroke in flight is dropped). */
  arm(a: VoxelBrushArm | null): void {
    const was = this.arming;
    if (a?.kind !== was?.kind || a?.grid !== was?.grid || a?.world !== was?.world || a?.navigate !== was?.navigate) this.cancel();
    if (a?.store !== was?.store) {
      this.unstore?.();
      this.unstore = a?.store.subscribe(() => this.redraw()) ?? null;
    }
    this.arming = a;
    const on = a !== null && !a.navigate;
    this.control.setStore(on ? a.store : null, on ? this.controlUses(a) : []);
    this.control.arm(on);
    if (!on) this.hover = null;
    this.redraw();
  }

  /** The keys the brush takes: its own uses; invert only where it means something (Add and Dig swap). */
  private controlUses(a: VoxelBrushArm): BrushUse[] {
    return a.uses.filter((u) => u !== 'invert' || a.kind === 'add' || a.kind === 'dig');
  }

  /** What a stroke begun now does: Add and Dig swap while the brush inverts (its setting, or Ctrl held). */
  private kindNow(a: VoxelBrushArm): VoxelBrushKind {
    if (!this.control.inverted()) return a.kind;
    return a.kind === 'add' ? 'dig' : a.kind === 'dig' ? 'add' : a.kind;
  }

  // ---- input ---------------------------------------------------------------------------------

  key(e: KeyboardEvent): boolean {
    if (!this.armed() || this.stroke !== null) return false;
    return this.control.key(e);
  }

  pointerDown(e: PointerEvent): ToolPress {
    const a = this.arming;
    if (a === null || a.navigate || e.button !== 0 || e.altKey) return null;
    if (this.control.press()) return 'consume';
    // A stroke starts on a cell of the armed grid under the pointer (a press elsewhere is the view's).
    const h = this.hover;
    if (h === null || !this.mine(a, h)) return null;
    const kind = this.kindNow(a);
    if ((kind === 'add' || kind === 'paint') && a.voxel === null) {
      this.cb.refused(kind === 'add' ? 'Add needs a material: pick one in the palette.' : 'Paint needs a material: pick one in the palette.');
      return 'consume';
    }
    const across = brushCells(a.store.get().size);
    const trail = new DabTrail(dabSpacingCells(across, a.store.get().spacing));
    trail.add(dabCell(kind, h.cell, h.normal));
    this.stroke = { kind, trail, height: surfaceHeightCells(h.cell, h.record), ended: false };
    this.say();
    this.redraw();
    return 'capture';
  }

  pointerMove(e: PointerEvent): boolean {
    const a = this.arming;
    if (a === null || a.navigate) return false;
    if (this.control.move(e, this.hoverPoint())) return true;
    this.hoverAt(e.clientX, e.clientY);
    if (this.stroke === null) return false;
    this.host.requestRender();
    return true;
  }

  pointerUp(_e: PointerEvent): boolean {
    const s = this.stroke;
    if (s === null || this.arming === null) return false;
    // The cell under the release is still being picked: the stroke ends with it.
    if (this.picking) s.ended = true;
    else this.finish(s);
    return true;
  }

  leave(): void {
    if (this.stroke === null) {
      this.hover = null;
      this.redraw();
    }
    this.control.leave();
  }

  /** Esc: an F drag's value put back, else the stroke in flight dropped (nothing is sent). */
  cancel(): boolean {
    if (this.control.cancel()) return true;
    if (this.stroke === null) return false;
    this.stroke = null;
    this.last = { stroke: 'cancelled', ok: false };
    this.cb.readout(null);
    this.redraw();
    return true;
  }

  // ---- the stroke ----------------------------------------------------------------------------

  private mine(a: VoxelBrushArm, h: ScenePickHit): boolean {
    return h.world === a.world && h.grid === a.grid;
  }

  private say(): void {
    const n = this.stroke?.trail.cells.length ?? 0;
    this.cb.readout(this.stroke === null ? null : `${n} dab${n === 1 ? '' : 's'}: release to apply, Esc to drop`);
  }

  /** The stroke's one command, sent; the last stroke's answer and its time are kept for tests and measurements. */
  private finish(s: Stroke): void {
    const a = this.arming;
    this.stroke = null;
    this.cb.readout(null);
    this.redraw();
    if (a === null) return;
    const b = a.store.get();
    const command = voxelStrokeCommand({
      grid: a.grid,
      kind: s.kind,
      shape: a.shape,
      across: brushCells(b.size),
      soft: a.soft,
      cells: s.trail.cells,
      ...(a.voxel !== null ? { voxel: s.kind === 'paint' ? { material: a.voxel.material, wetness: a.voxel.wetness } : a.voxel } : {}),
      ...(s.kind === 'flatten' ? { height: s.height } : {}),
      mask: s.kind === 'paint' ? strokeMask(b, a.uses) : null,
    });
    if (command === null) {
      this.cb.refused('The noise mask lets nothing through here: lower its threshold, or turn it off.');
      this.last = { stroke: s.kind, ok: false, refused: 'mask' };
      return;
    }
    const t0 = performance.now();
    const entry: Record<string, unknown> = { stroke: s.kind, dabs: s.trail.cells.length, sentAt: Math.round(t0), ok: null };
    this.last = entry;
    void this.cb.stroke(a.world, command).then(
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

  /** Picks the cell under the pointer (one pick in flight; the latest position is picked next); a stroke in flight takes its dab. */
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
      const s = this.stroke;
      if (s !== null && a !== null && hit !== null && this.mine(a, hit) && s.trail.add(dabCell(s.kind, hit.cell, hit.normal)) > 0) this.say();
      const next = this.pendingPointer;
      this.pendingPointer = null;
      if (next !== null) this.hoverAt(next.x, next.y);
      else if (s !== null && s.ended && this.stroke === s) this.finish(s);
      this.redraw();
    });
  }

  // ---- drawing -------------------------------------------------------------------------------

  private placeOf(a: VoxelBrushArm): { place: LatticePlace; toWorld: ToWorld } | null {
    if (a.entityId === null) return { place: WORLD_PLACE, toWorld: (x, y, z) => [x, y, z] };
    const place = this.host.place(a.entityId);
    if (place === null) return null;
    const f = new GridFrame(place);
    return { place, toWorld: (x, y, z) => f.toWorld(x, y, z) };
  }

  /** The face under the pointer, in the world (F measures the brush's size from it). */
  private hoverPoint(): THREE.Vector3 | null {
    const a = this.arming;
    const h = this.hover;
    if (a === null || h === null || !this.mine(a, h)) return null;
    const at = this.placeOf(a);
    return at === null ? null : this.facePoint(at.toWorld, h);
  }

  /** The middle of the face a hit entered by, in the world: on ground met from above, at the height its fill gives. */
  private facePoint(toWorld: ToWorld, h: ScenePickHit): THREE.Vector3 {
    const c = h.cell;
    const n = h.normal;
    const y = n[1] > 0 ? surfaceHeightCells(c, h.record) : c[1] + 0.5 + n[1] * 0.5;
    const w = toWorld((c[0] + 0.5 + n[0] * 0.5) * VOXEL_SIZE_M, y * VOXEL_SIZE_M, (c[2] + 0.5 + n[2] * 0.5) * VOXEL_SIZE_M);
    return new THREE.Vector3(w[0], w[1], w[2]);
  }

  /** The cursor, the cells' box and the trail as they are now, and a frame asked for. */
  private redraw(): void {
    this.draw();
    this.host.requestRender();
  }

  private draw(): void {
    const a = this.arming;
    const h = this.hover;
    const at = a === null ? null : this.placeOf(a);
    const on = a !== null && !a.navigate && at !== null;
    this.frameGroup.visible = on;
    if (!on) {
      this.cursor.hide();
      return;
    }
    const { place, toWorld } = at;
    this.frameGroup.position.set(place.position[0], place.position[1], place.position[2]);
    this.frameGroup.rotation.set(0, place.yawRad, 0);
    this.drawTrail();
    const over = h !== null && this.mine(a, h);
    this.box.visible = over && a.shape === 'box';
    if (!over) {
      this.cursor.hide();
      return;
    }
    const kind = this.stroke?.kind ?? this.kindNow(a);
    const b = a.store.get();
    const n = brushCells(b.size);
    const c = dabCell(kind, h.cell, h.normal);
    const r = (n - 1) / 2;
    this.box.position.set((c[0] - r) * VOXEL_SIZE_M, (c[1] - r) * VOXEL_SIZE_M, (c[2] - r) * VOXEL_SIZE_M);
    this.box.scale.setScalar(n * VOXEL_SIZE_M);
    const centre = this.facePoint(toWorld, h);
    const nw = toWorld(h.normal[0], h.normal[1], h.normal[2]);
    const normal = new THREE.Vector3(nw[0] - place.position[0], nw[1] - place.position[1], nw[2] - place.position[2]);
    const mask = kind === 'paint' ? strokeMask(b, a.uses) : null;
    this.cursor.setLook({ falloff: a.soft && kind !== 'paint' ? 'smooth' : 'constant', hardness: 1, strength: 1, mask, state: kind === 'dig' ? 'erase' : (kind === 'add' || kind === 'paint') && a.voxel === null ? 'off' : 'paint' });
    const radius = (n * VOXEL_SIZE_M) / 2;
    const fill = this.stroke === null;
    // Flat on ground met from above (the mask reads as the stroke's columns do); on any other face, on that face's plane.
    if (h.normal[1] > 0) this.cursor.place({ centre, rx: radius, rz: radius, maskOrigin: [place.position[0], place.position[2]], fill });
    else if (normal.lengthSq() > 0.5) this.cursor.place({ centre, rx: radius, rz: radius, normal: normal.normalize(), fill });
    else this.cursor.hide();
  }

  /** The stroke's dabs as a line through their cells' middles (grid metres). */
  private drawTrail(): void {
    const cells = this.stroke?.trail.cells ?? [];
    this.trail.visible = cells.length > 1;
    if (!this.trail.visible) return;
    if (cells.length > this.trailRoom) {
      this.trailRoom = grownCapacity(this.trailRoom, cells.length);
      this.trail.geometry.dispose();
      this.trail.geometry = new THREE.BufferGeometry();
      this.trail.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.trailRoom * 3), 3));
    }
    const pos = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    cells.forEach((c, i) => pos.setXYZ(i, (c[0] + 0.5) * VOXEL_SIZE_M, (c[1] + 0.5) * VOXEL_SIZE_M + TRAIL_LIFT_M, (c[2] + 0.5) * VOXEL_SIZE_M));
    pos.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, cells.length);
  }

  /** Before a frame: the drawings follow the grid where it stands now, and the tool's state is published. */
  frame(): void {
    const a = this.arming;
    const root = this.host.canvas();
    if (a === null) {
      if (this.stamp !== '') {
        this.stamp = '';
        root.removeAttribute('data-voxel-brush');
      }
      return;
    }
    this.draw();
    const h = this.hover;
    const mark = JSON.stringify({ kind: a.kind, navigate: a.navigate, world: a.world, grid: a.grid, shape: a.shape, across: brushCells(a.store.get().size), stroke: this.stroke === null ? null : { kind: this.stroke.kind, dabs: this.stroke.trail.cells.length }, hover: h === null ? null : { grid: h.grid, cell: h.cell, normal: h.normal, at: this.hoverAtPx, mine: this.mine(a, h) }, cursor: this.cursor.visible(), last: this.last });
    if (mark !== this.stamp) {
      this.stamp = mark;
      root.setAttribute('data-voxel-brush', mark);
    }
  }

  dispose(): void {
    this.unstore?.();
    this.control.dispose();
    this.cursor.dispose();
    this.frameGroup.removeFromParent();
    for (const o of [this.box, this.trail]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}
