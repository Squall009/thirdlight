/**
 * The Scene view's camera overlays: every virtual camera's preview (rebuilt
 * from the authored data on each sync with the runtime's own rig maths, the
 * pose Play starts it at, before input moves it; shown while selected) and
 * the timeline tab's scrub preview — the bound objects at the timeline's
 * time (the runtime's own evaluation, `evaluateTimelineAt`) and the live
 * camera's frustum there. Presentation only: nothing is written to the
 * project. The game's aspect and the project's lens shape the frustums.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import { VIEW_LENS_DEFAULTS } from '@thirdlight/runtime';
import type { ProjectedEntity } from '../session/projection';
import { virtualCameraPreviews } from './camera-previews';
import type { SceneSource } from './scene-source';

/** The game's aspect before the Scene view is told one (16:9, the common screen shape). */
const DEFAULT_GAME_ASPECT = 16 / 9;

type Pose = { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] };
export type TimelinePreview = { time: number; transforms: ReadonlyMap<string, Pose>; camera: { entityId: string; progress: number | null } | null };

export interface CameraOverlayHost {
  readonly overlay: THREE.Object3D;
  readonly root: () => HTMLElement;
  readonly source: SceneSource;
  /** The entity objects last synced, by id. */
  readonly synced: ReadonlyMap<string, ProjectedEntity>;
  readonly projected: () => readonly ProjectedEntity[];
  readonly selectedId: () => string | null;
  /** The gizmo drags this entity now (its drawn transform is the drag's). */
  readonly dragged: (id: string) => boolean;
  readonly requestRender: () => void;
}

export class CameraOverlay {
  private readonly vcamPreviews = new THREE.Group();
  private timeline: TimelinePreview | null = null;
  private readonly timelinePreviewed = new Set<string>();
  private timelineFrustum: THREE.LineSegments | null = null;
  private gameAspect = DEFAULT_GAME_ASPECT;
  /** The project's lens (its camera settings; the engine defaults until the project's arrive). */
  private viewLens: { fovY: number; near: number; far: number } = { ...VIEW_LENS_DEFAULTS };

  constructor(private readonly host: CameraOverlayHost) {}

  /** A timeline scrub preview is shown. */
  get scrubbing(): boolean {
    return this.timeline !== null;
  }

  /** The timeline preview draws this entity (it keeps its override). */
  previews(id: string): boolean {
    return this.timelinePreviewed.has(id);
  }

  /** The virtual cameras' previews, made again from the entities. */
  syncCameras(entities: readonly ProjectedEntity[]): void {
    for (const c of [...this.vcamPreviews.children]) {
      this.vcamPreviews.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
      ((c as THREE.LineSegments).material as THREE.Material).dispose();
    }
    const previews = virtualCameraPreviews(entities, this.gameAspect, this.viewLens);
    if (previews.length > 0 && this.vcamPreviews.parent === null) {
      this.vcamPreviews.name = 'virtual-camera-previews';
      this.host.overlay.add(this.vcamPreviews);
    }
    const selected = this.host.selectedId();
    for (const v of previews) {
      v.lines.visible = selected === v.id;
      this.vcamPreviews.add(v.lines);
    }
    this.showSelected();
  }

  /** The selected virtual camera's preview shows (`data-virtual-camera` says which). */
  showSelected(): void {
    let shown: unknown = null;
    const selected = this.host.selectedId();
    for (const c of this.vcamPreviews.children) {
      const on = c.userData['virtualCameraFrustum']?.id === selected;
      c.visible = on;
      if (on) shown = c.userData['virtualCameraFrustum'];
    }
    this.host.root().setAttribute('data-virtual-camera', shown === null ? '' : JSON.stringify(shown));
  }

  /** The project's lens: true when it changed (the previews were made again). */
  setViewLens(lens: { fovY: number; near: number; far: number }): boolean {
    if (this.viewLens.fovY === lens.fovY && this.viewLens.near === lens.near && this.viewLens.far === lens.far) return false;
    this.viewLens = { ...lens };
    this.syncCameras(this.host.projected());
    return true;
  }

  /** The game view's aspect: true when it changed (the previews were made again). */
  setGameAspect(aspect: number): boolean {
    if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(aspect - this.gameAspect) < 1e-3) return false;
    this.gameAspect = aspect;
    this.syncCameras(this.host.projected());
    return true;
  }

  /** The scrub preview (null restores the authored transforms); `data-timeline-preview` reports what is drawn. */
  setTimeline(preview: TimelinePreview | null): void {
    this.timeline = preview;
    this.applyTimeline();
  }

  /** Draw the scrub preview over the synced transforms again. */
  applyTimeline(): void {
    const { source, root } = this.host;
    for (const id of this.timelinePreviewed) if (!this.host.dragged(id)) source.setOverride(id, null);
    this.timelinePreviewed.clear();
    if (this.timelineFrustum !== null) {
      this.timelineFrustum.removeFromParent();
      this.timelineFrustum.geometry.dispose();
      (this.timelineFrustum.material as THREE.Material).dispose();
      this.timelineFrustum = null;
    }
    const p = this.timeline;
    if (p === null) {
      root().setAttribute('data-timeline-preview', '');
      this.host.requestRender();
      return;
    }
    const shown: Record<string, number[]> = {};
    for (const [id, pose] of p.transforms) {
      const base = this.host.synced.get(id);
      if (base === undefined) continue;
      const t = { position: pose.position ?? base.position, rotation: pose.rotation ?? base.rotation, scale: pose.scale ?? base.scale };
      source.setOverride(id, t);
      this.timelinePreviewed.add(id);
      shown[id] = [t.position[0] ?? 0, t.position[1] ?? 0, t.position[2] ?? 0];
    }
    let camera: unknown = null;
    if (p.camera !== null) {
      const v = virtualCameraPreviews(this.host.projected(), this.gameAspect, this.viewLens, p.camera, p.transforms)[0];
      if (v !== undefined) {
        this.timelineFrustum = v.lines;
        this.timelineFrustum.name = `timeline-camera:${v.id}`;
        this.host.overlay.add(this.timelineFrustum);
        camera = { id: v.id, position: [...v.pose.position], rotation: [...v.pose.rotation] };
      }
    }
    root().setAttribute('data-timeline-preview', JSON.stringify({ time: Math.round(p.time * 1000) / 1000, transforms: shown, camera }));
    this.host.requestRender();
  }
}
