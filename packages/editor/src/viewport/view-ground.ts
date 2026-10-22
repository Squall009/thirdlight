/**
 * The Scene view's grid and its dark ground square. A level's floor most
 * often lies at y = 0: both sit just under it (and the square is pushed back
 * in depth) so they never z-fight a floor there in dark streaks; where
 * nothing is built they show as before.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

const GROUND_SIZE = 20;
/** How far (m) the grid and its ground square sit under y = 0: clear of a floor there, too little to read as a gap. */
const GROUND_DROP = 0.01;

export class ViewGround {
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;

  constructor(overlay: THREE.Object3D) {
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new THREE.MeshLambertMaterial({ color: 0x1c1f27, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -GROUND_DROP;
    overlay.add(this.ground);
    this.grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x333844, 0x23262f);
    this.grid.position.y = -GROUND_DROP;
    overlay.add(this.grid);
  }

  show(on: boolean): void {
    this.grid.visible = on;
    this.ground.visible = on;
  }

  dispose(): void {
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
  }
}
