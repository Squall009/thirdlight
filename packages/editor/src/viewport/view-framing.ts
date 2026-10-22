/**
 * Moving the Scene view's camera onto things: focus (orbit around an
 * object), framing an object, a box or the whole level from the present
 * heading in the part of the view the editor's panels leave, and the working
 * view an edit mode enters with.
 *
 * Browser-only (three.js, the scene adapter).
 */
import type { SceneAdapter } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ProjectedEntity } from '../session/projection';
import { ENTRY_LEVEL_DEG, framePose, insideBox, NO_INSETS, viewPitchDeg, viewShowsBox, type FrameInsets } from './frame-view';
import type { SceneQueries } from './scene-queries';

/**
 * The share of the view's height a working view (an edit mode entered) keeps
 * above the horizon: it looks down obliquely, so relief reads, with the sky
 * in the top of the picture (about 20° down with the editor's 50° lens).
 */
export const WORK_VIEW_SKY = 0.12;

type LocalBox = { min: readonly number[]; max: readonly number[] };

export interface ViewFramingHost {
  readonly adapter: () => SceneAdapter;
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly queries: SceneQueries;
  readonly requestRender: () => void;
}

function box3(b: LocalBox): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...(b.min as [number, number, number])), new THREE.Vector3(...(b.max as [number, number, number])));
}

export class ViewFraming {
  /** What covers the view's sides (an editor's open panels): frames fit and centre in the rest. */
  private insets: (() => FrameInsets) | null = null;

  constructor(private readonly host: ViewFramingHost) {}

  setInsets(read: (() => FrameInsets) | null): void {
    this.insets = read;
  }

  /**
   * Orbit around the entity's world position, keeping the view direction and
   * distance — unless that puts the camera inside what the entity draws (a
   * building's walls): then the view frames it from outside. A terrain is
   * ground, not walls: a view low over it is inside its box but sees it, so F
   * orbits it.
   */
  focus(id: string): void {
    const { adapter, camera, orbit, queries } = this.host;
    adapter().sync?.();
    const m = queries.worldOf(id);
    if (m === null) return;
    const world = new THREE.Vector3().setFromMatrixPosition(m);
    const offset = camera.position.clone().sub(orbit.target);
    const box = queries.boundsOf(queries.subtreeIds(id), () => true);
    const ground = adapter().terrains?.()?.field(id) != null;
    if (!ground && !box.isEmpty() && insideBox(world.clone().add(offset).toArray(), { min: box.min.toArray(), max: box.max.toArray() }, camera.near)) {
      this.fitBox(box);
      return;
    }
    orbit.target.copy(world);
    camera.position.copy(world).add(offset);
    orbit.update();
  }

  /** Frame an object from the current view direction: `localBox` (its own frame) or else the meshes it draws. */
  frameEntity(id: string, localBox?: LocalBox): boolean {
    const { queries } = this.host;
    this.host.adapter().sync?.();
    const world = queries.worldOf(id);
    if (world === null) return false;
    const box = localBox !== undefined ? box3(localBox).applyMatrix4(world) : queries.boundsOf(queries.subtreeIds(id), () => true);
    if (box.isEmpty()) {
      this.focus(id);
      return true;
    }
    this.fitBox(box);
    return true;
  }

  /**
   * A working view of part of an object (an edit mode entered): looking down
   * from the present heading, the horizon {@link WORK_VIEW_SKY} of the view
   * below its top, onto the middle of `localBox` (its own frame) — on the
   * ground there when the object is a terrain — near enough that the box's
   * width fills the view. With `keepIf` (the object's whole box, its own
   * frame) a view already aimed inside its footprint is left as it is: the
   * user framed what to work on. True once settled (false: the object is not
   * drawn yet).
   */
  frameWorkArea(id: string, localBox: LocalBox, keepIf: LocalBox | null = null): boolean {
    const { adapter, camera, orbit } = this.host;
    adapter().sync?.();
    const world = this.host.queries.worldOf(id);
    if (world === null) return false;
    const boxOf = (b: LocalBox): THREE.Box3 => box3(b).applyMatrix4(world);
    const box = boxOf(localBox);
    const center = box.getCenter(new THREE.Vector3());
    const ground = adapter().terrains?.()?.field(id)?.heightAt(center.x, center.z);
    if (typeof ground === 'number' && Number.isFinite(ground)) center.y = ground;
    const span = Math.max(2, box.max.x - box.min.x, box.max.z - box.min.z);
    const heading = camera.position.clone().sub(orbit.target).setY(0);
    if (heading.lengthSq() < 1e-6) heading.set(0, 0, 1);
    heading.normalize();
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const pitch = Math.atan((1 - 2 * WORK_VIEW_SKY) * half);
    const distance = span / 2 / half;
    if (keepIf !== null) {
      const whole = boxOf(keepIf);
      const t = orbit.target;
      const margin = 1;
      const aimed = t.x >= whole.min.x - margin && t.x <= whole.max.x + margin && t.z >= whole.min.z - margin && t.z <= whole.max.z + margin;
      if (aimed && viewPitchDeg(camera.position.toArray(), t.toArray()) >= ENTRY_LEVEL_DEG) return true;
    }
    const dir = heading.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, distance);
    camera.far = Math.max(1000, distance * 10);
    camera.updateProjectionMatrix();
    orbit.update();
    this.host.requestRender();
    return true;
  }

  /** Frame every entity (the whole level) from the current view direction. */
  frameAll(entities: readonly ProjectedEntity[]): void {
    const { queries } = this.host;
    this.host.adapter().sync?.();
    const box = new THREE.Box3();
    const at = new THREE.Vector3();
    for (const e of entities) {
      if (e.kind !== 'box' && e.kind !== 'model') continue; // lights/cameras are markers, not content
      const m = queries.worldOf(e.id);
      if (m !== null) box.expandByPoint(at.setFromMatrixPosition(m));
      if (e.kind === 'box') box.union(queries.boundsOf([e.id], () => true));
    }
    if (box.isEmpty()) return;
    this.fitBox(box);
  }

  /** Whether the view shows `box` (world metres) sensibly: from outside and above it, looking down at it (`viewShowsBox`). */
  viewShows(box: LocalBox): boolean {
    const { camera, orbit } = this.host;
    return viewShowsBox({ min: box.min as [number, number, number], max: box.max as [number, number, number] }, camera.position.toArray(), orbit.target.toArray(), camera.fov, camera.aspect);
  }

  /** The camera outside `box`, looking at it whole in the part of the view the panels leave (`framePose`: the view's heading, a pitch looking down). */
  private fitBox(box: THREE.Box3): void {
    const { camera, orbit } = this.host;
    const pose = framePose({ min: box.min.toArray(), max: box.max.toArray() }, camera.position.toArray(), orbit.target.toArray(), camera.fov, camera.aspect, this.insets?.() ?? NO_INSETS);
    orbit.target.set(...pose.target);
    camera.position.set(...pose.position);
    camera.far = Math.max(1000, pose.distance * 10);
    camera.updateProjectionMatrix();
    orbit.update();
    this.host.requestRender();
  }

  /** Frame a box in world metres; `ground`: a terrain object whose ground under the box's centre the box's heights are measured from. */
  frameBox(box: LocalBox, ground?: string): void {
    const b = box3(box);
    const c = b.getCenter(new THREE.Vector3());
    const y = ground === undefined ? undefined : this.host.adapter().terrains?.()?.field(ground)?.heightAt(c.x, c.z);
    if (typeof y === 'number' && Number.isFinite(y)) b.translate(new THREE.Vector3(0, y, 0));
    this.fitBox(b);
  }

  /** An object's box in world metres: `localBox` (its own frame) through its transform, else the meshes it draws (null: none). */
  worldBoxOf(id: string, localBox?: LocalBox): { min: number[]; max: number[] } | null {
    const { queries } = this.host;
    const world = queries.worldOf(id);
    if (world === null) return null;
    const box = localBox !== undefined ? box3(localBox).applyMatrix4(world) : queries.boundsOf(queries.subtreeIds(id), () => true);
    return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
  }
}
