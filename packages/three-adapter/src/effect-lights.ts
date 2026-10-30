/**
 * The effects' lights: a pool of point-light slots the light clusters list
 * like any local light (`cluster-frame.ts` gathers them, `cluster-lights.ts`
 * shades them), so an effect light turned on, moved or added builds no
 * program and costs only the pixels its cells reach.
 *
 * - **No count.** The pool grows as the playing effects ask for lights; its
 *   memory is the slots and their records in the clusters' texture, under
 *   the clusters' budget (`CLUSTER_INDEX_MIB`).
 * - **Where it lights.** The pool's object sits in the scene (or a group in
 *   it) its effects play in; the clusters of a scene gather every live pool
 *   whose object is in that scene (`effectLightPoolsIn`).
 * - **Light layers** are per slot (a slot carries its mask); a pool whose
 *   game has an effect light with a narrower mask (`layered`) makes the
 *   clusters' loop test masks, as a layered scene light does.
 * - **Not in the surface cache**: a surface reading the cache shades an
 *   effect light whole, not only its highlight.
 */
import * as THREE from 'three/webgpu';

import { LIGHT_LAYERS_ALL } from '@thirdlight/project-model';

/** One slot of the pool: a point light by value (world position, linear colour). */
export class EffectLightSlot {
  readonly position = new THREE.Vector3();
  readonly color = new THREE.Color(1, 1, 1);
  intensity = 0;
  /** Cut-off distance (three's `PointLight.distance`). */
  distance = 2;
  decay = 2;
  /** The light layers it lights (bit n: layer n + 1). */
  mask = LIGHT_LAYERS_ALL;
}

/** What a pool's lights need of the shaders (decided from the game's effects before the first frame). */
export interface EffectLightsAbilities {
  /** Some effect light lights fewer than every layer: the clusters' loop tests each light's mask. */
  layered: boolean;
}

/** The pools whose object is in some scene (the clusters find theirs here). */
const pools = new Set<EffectLights>();

/** The pool's place in the scene: `count` slots in use, in order. */
export class EffectLights extends THREE.Object3D {
  readonly isEffectLights = true;
  readonly slots: EffectLightSlot[] = [];
  /** Slots in use (the first `count`). */
  count = 0;
  readonly abilities: EffectLightsAbilities = { layered: false };

  constructor() {
    super();
    this.name = 'effect lights';
    // Slots hold world positions: the object itself never moves.
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    pools.add(this);
  }

  /** Slot `i`, made when the pool first reaches it. */
  slot(i: number): EffectLightSlot {
    while (this.slots.length <= i) this.slots.push(new EffectLightSlot());
    return this.slots[i]!;
  }

  dispose(): void {
    pools.delete(this);
    this.removeFromParent();
  }
}

/** The live pools whose object is in `scene`. */
export function effectLightPoolsIn(scene: THREE.Object3D, out: EffectLights[]): EffectLights[] {
  out.length = 0;
  for (const p of pools) {
    let o: THREE.Object3D | null = p;
    while (o !== null && o !== scene) o = o.parent;
    if (o === scene) out.push(p);
  }
  return out;
}
