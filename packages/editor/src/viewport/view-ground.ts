/**
 * The Scene view's grid and its dark ground square. A level's floor most
 * often lies at y = 0: both sit under it so they never show through a floor
 * there; where nothing is built they show as before.
 *
 * How far under depends on how far away the view looks at them from. A
 * line's pixels take their depth along the line, up to a pixel off the
 * pixel's own centre, and on a ground seen at a slant a pixel is a long way
 * in depth: a grid a centimetre under a floor is hidden behind it only
 * within about ten metres, and drew over the floor as a wire grid from
 * farther off. So the drop grows with the camera's distance
 * ({@link viewGroundDrop}): still a centimetre up close, a few centimetres
 * from an overview, where it cannot be seen as a gap.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

/** The grid's side (m), centred on the origin. */
export const VIEW_GROUND_SIZE = 20;
/** How far (m) the grid and its ground square sit under y = 0 at least: clear of a floor there, too little to read as a gap. */
export const VIEW_GROUND_MIN_DROP = 0.01;
/** Pixels a grid line's depth may be taken off its pixel's centre (a line's own half pixel, and as much again for a view drawn below the screen's resolution). */
const LINE_DEPTH_SLACK_PX = 1;

/**
 * How far (m) under y = 0 the grid sits for a camera at (`x`, `z`) whose picture is `focalPx` pixels of focal length
 * (half the view's height over the tangent of half its vertical field of view): a pixel at the grid's farthest
 * corner spans (its horizontal distance ÷ the focal length) metres of height on a level ground whatever the
 * camera's height, so that much under the floor, a line's depth taken a pixel off is still behind the floor's.
 */
export function viewGroundDrop(x: number, z: number, focalPx: number): number {
  const half = VIEW_GROUND_SIZE / 2;
  const far = Math.hypot(Math.abs(x) + half, Math.abs(z) + half);
  if (!(focalPx > 0) || !Number.isFinite(far)) return VIEW_GROUND_MIN_DROP;
  return Math.max(VIEW_GROUND_MIN_DROP, (LINE_DEPTH_SLACK_PX * far) / focalPx);
}

export class ViewGround {
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;

  constructor(overlay: THREE.Object3D) {
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(VIEW_GROUND_SIZE, VIEW_GROUND_SIZE), new THREE.MeshLambertMaterial({ color: 0x1c1f27, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -VIEW_GROUND_MIN_DROP;
    overlay.add(this.ground);
    this.grid = new THREE.GridHelper(VIEW_GROUND_SIZE, VIEW_GROUND_SIZE, 0x333844, 0x23262f);
    this.grid.position.y = -VIEW_GROUND_MIN_DROP;
    overlay.add(this.grid);
  }

  show(on: boolean): void {
    this.grid.visible = on;
    this.ground.visible = on;
  }

  /** Before a frame: the drop for where `camera` looks from, in a view `heightPx` pixels high. */
  frame(camera: THREE.PerspectiveCamera, heightPx: number): void {
    const focalPx = heightPx / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const y = -viewGroundDrop(camera.position.x, camera.position.z, focalPx);
    if (this.grid.position.y === y) return;
    this.grid.position.y = y;
    this.ground.position.y = y;
  }

  dispose(): void {
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
  }
}
