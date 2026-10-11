/**
 * The vertex paint channel view (the editor's paint tool): the whole view
 * drawn with one paint channel as grey — white where it is full, black where
 * nothing is painted — so paint that a material reads only faintly (grime,
 * wetness, blend weights) can be seen while painting it.
 *
 * One unlit material over the scene (three's override material); it reads
 * paint the way every material does (`paintNode`: a mesh's attribute, an
 * instanced draw's stream), so painted copies, batches and merged cells show
 * theirs. Nothing is built while it is off.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { paintNode } from './vertex-paint-draw';

const TSL: N = TSLTyped;

export class PaintChannelView {
  private material: THREE.MeshBasicNodeMaterial | null = null;
  private readonly mask: N = TSL.uniform(new THREE.Vector4(1, 0, 0, 0));
  private on: number | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  /** Show channel 0–3 (R, G, B, A) as grey, or the materials again (null). */
  set(channel: number | null): void {
    const c = channel !== null && Number.isInteger(channel) && channel >= 0 && channel < 4 ? channel : null;
    if (c === this.on) return;
    this.on = c;
    if (c === null) {
      if (this.scene.overrideMaterial === this.material) this.scene.overrideMaterial = null;
      return;
    }
    (this.mask.value as THREE.Vector4).set(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, c === 3 ? 1 : 0);
    if (this.material === null) {
      const m = new THREE.MeshBasicNodeMaterial();
      m.name = 'vertex paint channel view';
      m.fog = false;
      m.lights = false;
      const v = TSL.dot(paintNode(), this.mask);
      m.colorNode = TSL.vec4(TSL.vec3(v), 1) as unknown as THREE.MeshBasicNodeMaterial['colorNode'];
      this.material = m;
    }
    this.scene.overrideMaterial = this.material;
  }

  /** The channel shown (null: off). */
  channel(): number | null {
    return this.on;
  }

  dispose(): void {
    if (this.scene.overrideMaterial === this.material) this.scene.overrideMaterial = null;
    this.material?.dispose();
    this.material = null;
  }
}
