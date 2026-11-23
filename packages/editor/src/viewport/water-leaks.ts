/**
 * Where water bodies leak, drawn over the Scene view: a marker at each
 * place the backend reports a body's fill would leave its bound (past its
 * reach, out of the world it knows), so the designer sees where to close
 * the gap. The same markers show the cells a spline's last write left
 * alone or could not keep (edited since it wrote them). A post from the place down to the ground it stands over is not
 * known here: the marker is a cross of three lines and a ring at the
 * place, in the misfit colour, drawn over everything (no depth test: a
 * leak behind a hill is still found). Drawn only, never picked.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';

/** Drawn after the scene, over the structure overlay's lines. */
const ORDER = 1000;
/** The structure overlay's misfit red: something the designer must fix, where it is. */
const MARK_COLOUR = new THREE.Color(0xff4a4a);
/** A marker's half size (metres): a few cells, seen from across a lake. */
const MARK_M = 1.5;

/** A leak as the view draws it: the body it belongs to and where (metres in the scene). */
export interface WaterLeakMark {
  readonly entityId: string;
  readonly at: readonly [number, number, number];
}

export class WaterLeakMarkers {
  private readonly group = new THREE.Group();
  private lines: THREE.LineSegments | null = null;
  private key = '';

  /** `name`: what the view's group is called (the leaks', or another set of marks). */
  constructor(parent: THREE.Object3D, private readonly name = 'water-leaks') {
    this.group.name = name;
    parent.add(this.group);
  }

  /** The marks drawn now (an empty list clears them); the same list again draws nothing new. */
  set(marks: readonly WaterLeakMark[]): void {
    const key = JSON.stringify(marks);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (marks.length === 0) return;
    const pts: number[] = [];
    const n = 24;
    for (const { at } of marks) {
      const [x, y, z] = at as [number, number, number];
      pts.push(x - MARK_M, y, z, x + MARK_M, y, z, x, y - MARK_M, z, x, y + MARK_M * 2, z, x, y, z - MARK_M, x, y, z + MARK_M);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const b = ((k + 1) / n) * Math.PI * 2;
        pts.push(x + Math.cos(a) * MARK_M, y, z + Math.sin(a) * MARK_M, x + Math.cos(b) * MARK_M, y, z + Math.sin(b) * MARK_M);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.LineBasicMaterial({ color: MARK_COLOUR, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
    this.lines = new THREE.LineSegments(g, m);
    this.lines.renderOrder = ORDER;
    this.lines.frustumCulled = false;
    this.lines.name = `${this.name}-marks`;
    this.lines.userData['marks'] = marks.length;
    this.group.add(this.lines);
  }

  private clear(): void {
    if (this.lines === null) return;
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.lines = null;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
