/**
 * The hand-over's fade as the volume's per-pixel read takes it
 * (voxel-light-handover.ts has the rule and the CPU twin): a uniform read in
 * every arrangement, so alone the volume's share is 1 everywhere (its fade
 * lies before any distance) and the program is the same whichever store a
 * page switches to at run time. The cache's share is the rest by
 * construction: the volume's read is built after the probes' and mixes over
 * what they gave by its weight times this share.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import type { HandoverRing } from './voxel-light-handover';

const TSL: N = TSLTyped;

/** The volume alone: its share is 1 at every distance (its fade lies before 0). */
const VOLUME_ALONE: HandoverRing = Object.freeze({ from: -2, to: -1 });

/** The fade the volume's read takes, as a uniform (x: from, y: to), shared by every program on the page. */
const volumeFade = TSL.uniform(new THREE.Vector2(VOLUME_ALONE.from, VOLUME_ALONE.to));

/** The page's hand-over from now on (null: no hybrid, the volume's share 1 everywhere). */
export function setVoxelHandover(ring: HandoverRing | null): void {
  const v = ring ?? VOLUME_ALONE;
  (volumeFade.value as THREE.Vector2).set(v.from, v.to);
}

/** The pixel's distance to the eye across (TSL). */
function acrossNode(): N {
  return TSL.positionWorld.xz.sub(TSL.cameraPosition.xz).length();
}

/** The volume's share at this pixel (TSL; 1 unless the page hands over). */
export function volumeShareNode(): N {
  return TSL.smoothstep(volumeFade.x, volumeFade.y, acrossNode());
}
