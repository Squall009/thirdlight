/**
 * What the Scene view reports on its element each frame (tests and the perf
 * check read it): its pose and lens, its view-projection matrix (both only
 * when they change), the frames drawn and whether another is asked for, the renderer's live resources and the
 * frame's draw counts; and the model failures, handed on when they change.
 *
 * Browser-only (DOM attributes).
 */
import { rendererMemory, type SceneAdapter } from '@thirdlight/three-adapter';
import * as THREE from 'three';

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export class ViewMarks {
  /** Frames drawn (render on demand: none while nothing changes). */
  private framesDrawn = 0;
  /** The model failures last reported (a change is reported again). */
  private failuresMark = '';
  /** The view's pose last stamped on the canvas. */
  private poseMark = '';
  /** The view-projection matrix last stamped on the canvas. */
  private viewProjMark = '';
  private readonly viewProj = new THREE.Matrix4();
  private wantedMark: boolean | null = null;

  /** The view's pose and lens (a test frames a game camera the same way). */
  pose(root: HTMLElement, c: THREE.PerspectiveCamera): void {
    const pose = JSON.stringify({ position: c.position.toArray().map(r6), rotation: c.quaternion.toArray().map(r6), fovY: c.fov, near: c.near, far: c.far });
    if (pose === this.poseMark) return;
    this.poseMark = pose;
    root.setAttribute('data-view-camera', pose);
  }

  /** The view-projection matrix when it changes (tests map cells and world points to the screen). */
  viewProjection(root: HTMLElement, c: THREE.PerspectiveCamera): void {
    c.updateMatrixWorld();
    const viewProj = JSON.stringify(this.viewProj.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).elements.map(r6));
    if (viewProj === this.viewProjMark) return;
    this.viewProjMark = viewProj;
    root.setAttribute('data-view-proj', viewProj);
  }

  /** Whether a frame is asked for (`data-frame-wanted`: 0 once the view has nothing more to draw; a test's still picture). */
  wanted(root: HTMLElement, on: boolean): void {
    if (on === this.wantedMark) return;
    this.wantedMark = on;
    root.setAttribute('data-frame-wanted', on ? '1' : '0');
  }

  /** A frame was drawn. */
  drawn(root: HTMLElement): void {
    this.framesDrawn += 1;
    root.setAttribute('data-frames', String(this.framesDrawn));
  }

  /** The renderer's live resource counts and the frame's draw counts, after the frame. */
  counts(root: HTMLElement, adapter: SceneAdapter): void {
    const f = adapter.lastFrame?.();
    // The renderer's live resource counts after the frame (the leak tests read them).
    const live = adapter.currentRenderer?.() ?? null;
    if (live !== null) root.setAttribute('data-memory', JSON.stringify(rendererMemory(live)));
    if (f === undefined) return;
    root.setAttribute('data-draw-calls', String(f.drawCalls));
    root.setAttribute('data-triangles', String(f.triangles));
    const b = f.batching ?? { groups: 0, batched: 0, single: 0 };
    root.setAttribute('data-batches', `${b.groups} ${b.batched} ${b.single}`);
    // Static batching: merged cells drawn, objects drawn through them, cells still building.
    const m = f.batching?.merging;
    root.setAttribute('data-merged', m === undefined ? '' : `${m.cells} ${m.merged} ${m.pending}`);
    root.setAttribute('data-msaa', String(f.samples));
  }

  /** The placements' model failures, when they changed since the last report. */
  failures(adapter: SceneAdapter, report: ((failures: ReadonlyMap<string, { code: string; message: string }>) => void) | undefined): void {
    const failures = adapter.modelFailures?.() ?? new Map();
    const mark = JSON.stringify([...failures]);
    if (mark === this.failuresMark) return;
    this.failuresMark = mark;
    report?.(failures);
  }
}
