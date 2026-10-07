/**
 * The adapter's side of block-layer cut-aways: their subject followed each
 * frame (a point or object scripts named, else the drawn camera's target) and
 * the fade copies compiled ahead of their first fade.
 *
 * A fade copy waits in the scene, fully faded, for the next precompile, so
 * its first fade does not stall a frame; once a precompile has settled and a
 * frame has drawn it, it leaves the scene.
 */
import * as THREE from 'three';
import type { GridCutawayState } from '@thirdlight/runtime';

import type { BlockLayerView } from './block-layers';
import { ANIMATION_MAX_DELTA_SECONDS } from './animation';

export interface CutawayFollowDeps {
  readonly view: BlockLayerView;
  readonly scene: THREE.Scene;
  /** The running game (its scripts' cut-away state and the camera's target). */
  readonly runtime: unknown;
  /** An object's drawn world position (false: none). */
  position(id: string, out: number[]): boolean;
  /** No precompile wanted or running. */
  precompileIdle(): boolean;
  /** Ask for a precompile of the scene. */
  requestPrecompile(): void;
  onChange?(): void;
}

export interface CutawayFollower {
  /** A fade copy to compile ahead (the view's `precompile`). */
  probe(object: THREE.Object3D): void;
  /** Whether a frame should follow: a layer has cut-aways or copies wait. */
  wanted(): boolean;
  /** Follow the subject for this frame. */
  follow(): void;
}

export function createCutawayFollower(d: CutawayFollowDeps): CutawayFollower {
  const probes: THREE.Object3D[] = [];
  let probeFrames = 0;
  /** The scripts' state last handed to the view, when the last frame followed, and scratch. */
  let seen: unknown = null;
  let at: number | null = null;
  const pos: number[] = [0, 0, 0];
  const subjectAt = new THREE.Vector3();
  return {
    probe(object) {
      d.scene.add(object);
      probes.push(object);
      probeFrames = 0;
      d.requestPrecompile();
      d.onChange?.();
    },
    wanted: () => d.view.hasCutaways() || probes.length > 0,
    follow() {
      if (probes.length > 0 && d.precompileIdle() && ++probeFrames > 1) {
        for (const p of probes) d.scene.remove(p);
        probes.length = 0;
      }
      const rt = d.runtime as { blockCutaways?: () => GridCutawayState; cameraView?: () => { target?: string } | null };
      const st = rt.blockCutaways?.();
      if (st !== undefined && st !== seen) {
        seen = st;
        d.view.setGameCutaways(st.forced);
      }
      const now = performance.now();
      const dt = at === null ? 0 : Math.min(ANIMATION_MAX_DELTA_SECONDS, Math.max(0, (now - at) / 1000));
      at = now;
      const named = st?.subject ?? null;
      let subject: THREE.Vector3 | null = null;
      if (Array.isArray(named)) subject = subjectAt.set(named[0]!, named[1]!, named[2]!);
      else {
        const id = typeof named === 'string' ? named : (rt.cameraView?.()?.target ?? null);
        if (id !== null && d.position(id, pos)) subject = subjectAt.set(pos[0]!, pos[1]!, pos[2]!);
      }
      if (d.view.updateCutaways(dt, subject)) d.onChange?.();
    },
  };
}
