/**
 * The voxel brush tool's fill gesture: what a press, a drag and a release
 * do while the world edit mode's Fill rail (or its spline entry) has the
 * tool. The brush tool owns the pointer, the pick and the grid; this part
 * holds the gesture and draws it.
 *
 * - **Fog to a level, drain, water**: the press takes the open cell at the
 *   pick as the seed; the level starts a set depth over the surface clicked
 *   and follows the pointer up and down the screen; the release sends one
 *   command: a `flood` stroke for fog (a gas) or a drain (air), a
 *   `createEntity` of a water body for water. The level is drawn as the
 *   ring a water body's level handle shows (`heightRingLines`), with its
 *   post from the surface.
 * - **A refused flood** that names where it leaked is marked there with
 *   the water bodies' leak markers (`WaterLeakMarkers`) until the next fill
 *   is made or the tool is put down; nothing was written.
 * - **A spline**: the press is its first point, the drag's end its second;
 *   the release makes the object and hands it to the spline's own handles.
 *
 * Esc drops a gesture in flight; nothing is sent.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

import { heightRingLines, SCENE_HEIGHT_RING_M } from '../session/handles';
import { surfaceHeightCells } from '../session/voxel-brush';
import { cellMiddleM, draggedLevelM, FILL_LEVEL_STEP_M, floodCommand, leakMessage, metresPerPixel, seedCell, snapLevelM, splineCreate, waterBodyCreate, type FloodLeak, type SplineStartVoxels, type VoxelFillKind } from '../session/voxel-fill';
import type { ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { tokenColour } from './brush-cursor';
import { WaterLeakMarkers } from './water-leaks';

/** What a rail arms a fill with. */
export interface VoxelFillArm {
  readonly kind: VoxelFillKind;
  /** The gas a fog fill writes, the liquid a water body holds (null: none picked; a drain and a spline name none). */
  readonly material: number | null;
  /** The level a click gives, metres over the surface clicked (a drag changes it). */
  readonly depthM: number;
  /** A flood's reach from its seed, metres. */
  readonly reachM: number;
  /** A fog fill's fade under its level, metres (0: none). */
  readonly fadeM: number;
  /** The scene new objects go into (null: the backend's choice). */
  readonly sceneId: string | null;
  /** A spline's `voxels` section as it starts (null: no material for it). */
  readonly spline?: SplineStartVoxels | null;
}

/** A command's answer as the gesture reads it. */
export type FillAnswer = { readonly ok: true; readonly createdId?: string } | { readonly ok: false; readonly code: string; readonly message: string; readonly leaks?: readonly FloodLeak[] };

export interface VoxelFillCallbacks {
  /** One command of the project (`editVoxels`, `createEntity`), sent as any of the editor's. */
  send(op: string, args: Record<string, unknown>): Promise<FillAnswer>;
  /** Why something was not made (the status line shows it). */
  refused(message: string): void;
  /** What the gesture in flight holds, said live (null: none). */
  readout(text: string | null): void;
  /** A gesture ended at this depth over its surface: the next click starts there. */
  depth?(m: number): void;
  /** An object was made: a water body (the mode stays), a spline (handed to its own handles). */
  made?(what: 'water' | 'spline', entityId: string): void;
}

export interface VoxelFillHost {
  readonly overlay: THREE.Object3D;
  readonly camera: THREE.PerspectiveCamera;
  canvas(): HTMLCanvasElement;
  requestRender(): void;
}

interface Gesture {
  readonly kind: VoxelFillKind;
  readonly seed: [number, number, number];
  /** The seed's column at the surface clicked (metres): where the ring's post stands, a spline's first point. */
  readonly base: [number, number, number];
  readonly pressY: number;
  readonly perPixelM: number;
  readonly startLevelM: number;
  levelM: number;
  /** A spline: where the drag is now (metres). */
  to: [number, number, number];
}

/** Drawn after the scene, with the brush cursor. */
const ORDER = 22;
/** Who the flood's leak marks belong to (the markers name an object for a water body's). */
const FLOOD_MARKS = 'flood';

const WHAT: Readonly<Record<VoxelFillKind, string>> = Object.freeze({ fog: 'The fog', drain: 'The drain', water: 'The water', spline: 'The spline' });

/** The surface a hit shows, metres in the grid: ground met from above at the height its fill gives, else the seed cell's floor. */
export function hitSurfaceM(h: Pick<ScenePickHit, 'cell' | 'normal' | 'record'>): [number, number, number] {
  const seed = seedCell(h.cell, h.normal);
  const mid = cellMiddleM(seed);
  const y = h.normal[1] > 0 ? surfaceHeightCells(h.cell, h.record) * VOXEL_SIZE_M : seed[1] * VOXEL_SIZE_M;
  return [mid[0], y, mid[2]];
}

export class VoxelFillGesture {
  private gesture: Gesture | null = null;
  private readonly lines: THREE.LineSegments;
  private readonly marks: WaterLeakMarkers;
  private leaks: readonly FloodLeak[] = [];
  private last: Record<string, unknown> | null = null;
  /** What the lines hold now (the same again builds nothing). */
  private drawn = '';

  constructor(private readonly host: VoxelFillHost, private readonly cb: () => VoxelFillCallbacks) {
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: tokenColour('--brush'), depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
    this.lines.name = 'voxel-fill-level';
    this.lines.renderOrder = ORDER;
    this.lines.frustumCulled = false;
    this.lines.raycast = () => undefined;
    this.lines.visible = false;
    host.overlay.add(this.lines);
    this.marks = new WaterLeakMarkers(host.overlay, 'flood-leaks');
  }

  active(): boolean {
    return this.gesture !== null;
  }

  /** The tool was put down or armed with something else: the gesture and the marks go. */
  reset(): void {
    this.gesture = null;
    this.setLeaks([]);
    this.lines.visible = false;
  }

  /** A press on a cell of the armed grid: the gesture begins there ('consume': refused in words, nothing begins). */
  press(a: VoxelFillArm, h: ScenePickHit, e: PointerEvent): 'capture' | 'consume' {
    const cb = this.cb();
    const why = a.kind === 'fog' && a.material === null ? 'Fog needs a gas material: pick one in the palette, or make one.' : a.kind === 'water' && a.material === null ? 'Water needs a liquid material: pick one in the palette, or make one.' : a.kind === 'spline' && (a.spline ?? null) === null ? 'No voxel material for it: a road or path takes a ground or construction material, a river a liquid.' : null;
    if (why !== null) {
      cb.refused(why);
      return 'consume';
    }
    const base = hitSurfaceM(h);
    const eye = this.host.camera.position;
    const perPixelM = metresPerPixel(this.host.camera.fov, this.host.canvas().getBoundingClientRect().height, Math.hypot(eye.x - base[0], eye.y - base[1], eye.z - base[2]));
    const startLevelM = this.levelFor(a, base);
    this.gesture = { kind: a.kind, seed: seedCell(h.cell, h.normal), base, pressY: e.clientY, perPixelM, startLevelM, levelM: startLevelM, to: [...base] };
    this.say();
    return 'capture';
  }

  /** The level a click on `base` gives: the set depth over it, on the level's step, at least a step over the surface. */
  private levelFor(a: VoxelFillArm, base: readonly [number, number, number]): number {
    return Math.max(snapLevelM(base[1] + a.depthM), snapLevelM(base[1]) + FILL_LEVEL_STEP_M);
  }

  /** The pointer moved: the level follows it up and down the screen. */
  move(e: PointerEvent): void {
    const g = this.gesture;
    if (g === null || g.kind === 'spline') return;
    g.levelM = Math.max(snapLevelM(g.base[1]) + FILL_LEVEL_STEP_M, draggedLevelM(g.startLevelM, g.pressY - e.clientY, g.perPixelM));
    this.say();
  }

  /** The cell under the pointer was picked (null: none of the grid's): a spline's drag ends there. */
  hover(h: ScenePickHit | null): void {
    const g = this.gesture;
    if (g === null || g.kind !== 'spline' || h === null) return;
    g.to = hitSurfaceM(h);
    this.say();
  }

  private say(): void {
    const g = this.gesture;
    const cb = this.cb();
    if (g === null) return cb.readout(null);
    if (g.kind === 'spline') return cb.readout(`${Math.hypot(g.to[0] - g.base[0], g.to[2] - g.base[2]).toFixed(1)} m: release where the first stretch ends, Esc to drop`);
    cb.readout(`Level ${g.levelM.toFixed(2)} m (${(g.levelM - g.base[1]).toFixed(2)} m over the point): drag up or down, release to ${g.kind === 'drain' ? 'drain' : 'fill'}, Esc to drop`);
  }

  cancel(): boolean {
    if (this.gesture === null) return false;
    this.gesture = null;
    this.last = { fill: 'cancelled', ok: false };
    this.cb().readout(null);
    return true;
  }

  /** The release: the gesture's one command, sent. */
  release(a: VoxelFillArm, world: string, grid: number): void {
    const g = this.gesture;
    this.gesture = null;
    const cb = this.cb();
    cb.readout(null);
    if (g === null) return;
    let op: string;
    let args: Record<string, unknown> | null;
    if (g.kind === 'spline') {
      op = 'createEntity';
      args = a.spline == null ? null : splineCreate({ sceneId: a.sceneId, from: g.base, to: g.to, voxels: a.spline });
      if (args === null) {
        cb.refused('Drag from where it starts to where its first stretch ends: a click alone lays nothing.');
        this.last = { fill: g.kind, ok: false, refused: 'short' };
        return;
      }
    } else if (g.kind === 'water') {
      op = 'createEntity';
      args = waterBodyCreate({ sceneId: a.sceneId, world, seed: g.seed, levelM: g.levelM, material: a.material! });
    } else {
      op = 'editVoxels';
      args = { world, command: floodCommand({ grid, seed: g.seed, levelM: g.levelM, gas: g.kind === 'fog' ? a.material : null, reachM: a.reachM, fadeM: a.fadeM }) };
    }
    if (g.kind !== 'spline') cb.depth?.(g.levelM - g.base[1]);
    const entry: Record<string, unknown> = { fill: g.kind, seed: g.seed, level: g.levelM, ok: null };
    this.last = entry;
    void cb.send(op, args).then(
      (r) => {
        entry['ok'] = r.ok;
        if (r.ok) {
          this.setLeaks([]);
          if (r.createdId !== undefined) {
            entry['created'] = r.createdId;
            if (g.kind === 'water' || g.kind === 'spline') cb.made?.(g.kind, r.createdId);
          }
          return;
        }
        entry['error'] = r.code;
        const leaks = r.leaks ?? [];
        entry['leaks'] = leaks.length;
        this.setLeaks(leaks);
        // A drain or a fog over what is already so changes nothing: said, not an error.
        cb.refused(leaks.length > 0 ? leakMessage(WHAT[g.kind], leaks) : r.code === 'no_change' ? `${WHAT[g.kind]} changed nothing: the space under the level already is as asked.` : `${WHAT[g.kind]}: ${r.message}`);
      },
      (err: unknown) => {
        entry['ok'] = false;
        entry['error'] = err instanceof Error ? err.message : String(err);
        cb.refused(`${WHAT[g.kind]}: ${String(entry['error'])}`);
      },
    );
  }

  private setLeaks(leaks: readonly FloodLeak[]): void {
    this.leaks = leaks;
    this.marks.set(leaks.map((l) => ({ entityId: FLOOD_MARKS, at: l.at })));
    this.host.requestRender();
  }

  /**
   * The level ring and its post (a gesture's, or what a click on `hover`
   * would give), or a spline's first stretch, drawn now; `hover` null and
   * no gesture: nothing.
   */
  draw(a: VoxelFillArm | null, hover: ScenePickHit | null): void {
    const g = this.gesture;
    const pts: number[] = [];
    if (a !== null && (g !== null || hover !== null)) {
      const base = g?.base ?? hitSurfaceM(hover!);
      if (a.kind === 'spline') {
        const to = g?.to ?? base;
        pts.push(base[0], base[1], base[2], to[0], to[1], to[2]);
        for (const p of [base, to]) pts.push(p[0] - 0.5, p[1], p[2], p[0] + 0.5, p[1], p[2], p[0], p[1], p[2] - 0.5, p[0], p[1], p[2] + 0.5, p[0], p[1], p[2], p[0], p[1] + 1, p[2]);
      } else {
        const level = g?.levelM ?? this.levelFor(a, base);
        for (const line of heightRingLines({ x: base[0], y: base[1], z: base[2] }, level - base[1], SCENE_HEIGHT_RING_M)) {
          for (let i = 0; i + 1 < line.length; i++) pts.push(line[i]!.x, line[i]!.y, line[i]!.z, line[i + 1]!.x, line[i + 1]!.y, line[i + 1]!.z);
        }
        // The seed: a post up the ring's middle, from the point clicked to the level.
        pts.push(base[0], base[1], base[2], base[0], level, base[2]);
      }
    }
    this.lines.visible = pts.length > 0;
    const key = pts.join(',');
    if (pts.length === 0 || key === this.drawn) return;
    this.drawn = key;
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry();
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  /** The gesture's state for the tool's published mark (tests read it). */
  mark(a: VoxelFillArm): Record<string, unknown> {
    const g = this.gesture;
    return { kind: a.kind, gesture: g === null ? null : { seed: g.seed, level: g.levelM, ...(g.kind === 'spline' ? { to: g.to } : {}) }, ring: this.lines.visible, leaks: this.leaks.map((l) => l.at), last: this.last };
  }

  dispose(): void {
    this.marks.dispose();
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
