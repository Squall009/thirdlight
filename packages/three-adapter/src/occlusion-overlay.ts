/**
 * What occlusion culling leaves out, drawn over the frame: a tinted box
 * round each draw a culling path hides now (draws culled whole on WebGPU
 * whose last answer said hidden, draws the WebGL 2 queries hid). Drawn
 * without the depth test (what it shows is behind something by definition),
 * on the view only: lines are never occludees, cast no shadow and belong to
 * no object, so isolation leaves them drawn. Instanced copies are culled one
 * by one on the GPU and have no box here; the diagnostics count them.
 */
import * as THREE from 'three';

/** The boxes' colour: a magenta no lit surface of a level is likely to be. */
const CULLED_TINT = 0xff3cc8;

/** The 12 edges of a box as corner index pairs (corners: bit 0 x, bit 1 y, bit 2 z). */
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

/** Write the line vertices of `boxes`' edges into `out` from vertex 0 (24 a box); the vertices written. */
export function boxEdgeVertices(boxes: readonly THREE.Box3[], out: Float32Array): number {
  let v = 0;
  for (const b of boxes) {
    if (b.isEmpty()) continue;
    for (const c of EDGES) {
      out[v * 3] = c & 1 ? b.max.x : b.min.x;
      out[v * 3 + 1] = c & 2 ? b.max.y : b.min.y;
      out[v * 3 + 2] = c & 4 ? b.max.z : b.min.z;
      v += 1;
    }
  }
  return v;
}

export class OcclusionOverlay {
  private lines: THREE.LineSegments | null = null;
  private positions = new Float32Array(0);
  private shown = 0;

  constructor(private readonly scene: THREE.Scene) {}

  get on(): boolean {
    return this.lines !== null;
  }

  /** The boxes drawn in the last update. */
  get boxes(): number {
    return this.shown;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    if (!on) {
      this.lines!.removeFromParent();
      this.lines!.geometry.dispose();
      (this.lines!.material as THREE.Material).dispose();
      this.lines = null;
      this.shown = 0;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({ color: CULLED_TINT, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.name = 'occlusion-culled';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = Number.MAX_SAFE_INTEGER;
    this.scene.add(this.lines);
  }

  /** The boxes of what is culled now (world space). */
  update(boxes: readonly THREE.Box3[]): void {
    const lines = this.lines;
    if (lines === null) return;
    if (this.positions.length < boxes.length * 72) {
      this.positions = new Float32Array(Math.max(72, boxes.length * 72 * 2));
      lines.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    }
    const n = boxEdgeVertices(boxes, this.positions);
    const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr !== undefined) {
      attr.needsUpdate = true;
      lines.geometry.setDrawRange(0, n);
    }
    this.shown = n / 24;
  }

  dispose(): void {
    this.set(false);
  }
}
