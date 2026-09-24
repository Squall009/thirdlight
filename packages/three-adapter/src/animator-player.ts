/**
 * Phase 9.7: plays an animator pose on a model instance.
 *
 * The runtime's animator (a deterministic state machine stepped with the
 * simulation) decides which clips play, at which time and with which
 * weight; this only poses the model: one `THREE.AnimationMixer` per
 * instance, every action enabled with its time and weight set directly (no
 * time integration here, so Play and a replay look the same).
 */
import * as THREE from 'three';

export interface AnimatorPoseLike {
  readonly clips: readonly { readonly assetId: string; readonly clip: string; readonly time: number; readonly weight: number }[];
}

export interface AnimatorPlayer {
  apply(pose: AnimatorPoseLike): void;
  dispose(): void;
}

export function createAnimatorPlayer(root: THREE.Object3D, clips: readonly THREE.AnimationClip[], assetId: string): AnimatorPlayer {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.play();
    action.setEffectiveWeight(0);
    action.setEffectiveTimeScale(0);
    actions.set(clip.name, action);
  }
  return {
    apply(pose) {
      const weights = new Map<string, { time: number; weight: number }>();
      for (const c of pose.clips) {
        if (c.assetId !== assetId || !actions.has(c.clip)) continue;
        const have = weights.get(c.clip);
        // The same clip twice (a crossfade into itself): the heavier one sets the time.
        if (have === undefined) weights.set(c.clip, { time: c.time, weight: c.weight });
        else weights.set(c.clip, { time: c.weight > have.weight ? c.time : have.time, weight: have.weight + c.weight });
      }
      for (const [name, action] of actions) {
        const w = weights.get(name);
        action.setEffectiveWeight(w?.weight ?? 0);
        if (w !== undefined) action.time = Math.min(w.time, action.getClip().duration);
      }
      mixer.update(0);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
