/**
 * Phase 9.7: plays an animator pose on a model instance.
 *
 * The runtime's animator (a deterministic state machine stepped with the
 * simulation) decides which clips play, at which time and with which
 * weight; this only poses the model: one `THREE.AnimationMixer` per
 * instance, every action enabled with its time and weight set directly (no
 * time integration here, so Play and a replay look the same).
 *
 * Phase 14.6:
 * - Override layers with bone masks. The tracks of every clip are split by
 *   which layers cover their bone (a layer covers the bones of its mask, or
 *   every bone when the mask is empty) and each part gets its own action, so
 *   a bone gets `base × (1 − L)` plus the layer's clips × L, where L is the
 *   layer's weight times how much of its state machine is playing (an
 *   `empty` state plays nothing). Later layers override earlier ones.
 * - Clips of another asset (an animation-only file marked "clips for" this
 *   model's asset) come from `clipsOf`; they bind to this model's bones by
 *   name. Until they are loaded the pose skips them.
 * A pose without layers plays exactly as before (the whole clip, one action).
 */
import * as THREE from 'three';

export interface AnimatorPoseClipLike {
  readonly assetId: string;
  readonly clip: string;
  readonly time: number;
  readonly weight: number;
}

export interface AnimatorPoseLike {
  readonly clips: readonly AnimatorPoseClipLike[];
  /** Phase 14.6: override layers, in order (absent = the base layer only). */
  readonly layers?: readonly { readonly mask: readonly string[]; readonly weight: number; readonly clips: readonly AnimatorPoseClipLike[] }[];
}

export interface AnimatorPlayer {
  apply(pose: AnimatorPoseLike): void;
  dispose(): void;
}

export interface AnimatorPlayerOptions {
  /** Phase 14.6: the clips of another asset for this model (null = not available, or not yet). */
  readonly clipsOf?: (assetId: string) => readonly THREE.AnimationClip[] | null;
}

/** The node a track animates (`bone.quaternion` → `bone`). */
function trackNode(track: THREE.KeyframeTrack): string {
  try {
    return THREE.PropertyBinding.parseTrackName(track.name).nodeName;
  } catch {
    return '';
  }
}

export function createAnimatorPlayer(root: THREE.Object3D, clips: readonly THREE.AnimationClip[], assetId: string, options: AnimatorPlayerOptions = {}): AnimatorPlayer {
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.play();
    action.setEffectiveWeight(0);
    action.setEffectiveTimeScale(0);
    actions.set(clip.name, action);
  }

  // ---- phase 14.6: layered poses ------------------------------------------------
  /** The masks the layered actions were built for (a change rebuilds them). */
  let layoutKey: string | null = null;
  /** Layer masks as sets (null = every bone). */
  let masks: (ReadonlySet<string> | null)[] = [];
  /** `${layer}|${assetId}|${clip}|${coverage}` → the action of that part of the clip. */
  const parts = new Map<string, THREE.AnimationAction>();
  /** `${assetId}|${clip}` → the clip's tracks grouped by coverage (bit i = layer i covers the bone). */
  const groups = new Map<string, Map<number, THREE.KeyframeTrack[]>>();

  const sourceClip = (clipAssetId: string, name: string): THREE.AnimationClip | null => {
    if (clipAssetId === assetId) return actions.get(name)?.getClip() ?? null;
    const list = options.clipsOf?.(clipAssetId) ?? null;
    return list?.find((c) => c.name === name) ?? null;
  };
  const coverage = (node: string): number => {
    let k = 0;
    masks.forEach((m, i) => {
      if (m === null || m.has(node)) k |= 1 << i;
    });
    return k;
  };
  const groupsOf = (clipAssetId: string, clip: THREE.AnimationClip): Map<number, THREE.KeyframeTrack[]> => {
    const key = `${clipAssetId}|${clip.name}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = new Map();
      for (const track of clip.tracks) {
        const k = coverage(trackNode(track));
        const list = g.get(k) ?? [];
        list.push(track);
        g.set(k, list);
      }
      groups.set(key, g);
    }
    return g;
  };
  const partAction = (layer: number, clipAssetId: string, clip: THREE.AnimationClip, k: number, tracks: THREE.KeyframeTrack[]): THREE.AnimationAction => {
    const key = `${layer}|${clipAssetId}|${clip.name}|${k}`;
    let a = parts.get(key);
    if (a === undefined) {
      a = mixer.clipAction(new THREE.AnimationClip(`${clip.name}#${layer}.${k}`, clip.duration, tracks));
      a.play();
      a.setEffectiveTimeScale(0);
      a.setEffectiveWeight(0);
      parts.set(key, a);
    }
    return a;
  };
  const clearParts = (): void => {
    for (const a of parts.values()) {
      a.stop();
      mixer.uncacheAction(a.getClip());
      mixer.uncacheClip(a.getClip());
    }
    parts.clear();
    groups.clear();
  };

  const applyLayered = (pose: AnimatorPoseLike & { layers: NonNullable<AnimatorPoseLike['layers']> }): void => {
    const key = pose.layers.map((l) => (l.mask.length === 0 ? '*' : l.mask.join('\u0000'))).join('\u0001');
    if (key !== layoutKey) {
      clearParts();
      layoutKey = key;
      masks = pose.layers.map((l) => (l.mask.length === 0 ? null : new Set(l.mask)));
    }
    // L_i: how much layer i replaces what is under it.
    // (Clips not loaded yet do not count: the layers under show through meanwhile.)
    const influence = pose.layers.map((l) => Math.min(1, Math.max(0, l.weight)) * Math.min(1, l.clips.reduce((s, c) => s + (sourceClip(c.assetId, c.clip) === null ? 0 : Math.max(0, c.weight)), 0)));
    /** Π (1 − L_j) over the layers j > from that cover coverage k. */
    const keep = (k: number, from: number): number => {
      let f = 1;
      for (let j = from + 1; j < influence.length; j++) if ((k & (1 << j)) !== 0) f *= 1 - influence[j]!;
      return f;
    };
    const wanted = new Map<THREE.AnimationAction, { time: number; weight: number; best: number }>();
    const add = (layer: number, list: readonly AnimatorPoseClipLike[], scale: number): void => {
      for (const c of list) {
        const clip = sourceClip(c.assetId, c.clip);
        if (clip === null || c.weight <= 0) continue;
        for (const [k, tracks] of groupsOf(c.assetId, clip)) {
          // A layer's clip only drives the bones the layer covers.
          if (layer >= 0 && (k & (1 << layer)) === 0) continue;
          const w = c.weight * scale * keep(k, layer);
          if (w <= 0) continue;
          const action = partAction(layer, c.assetId, clip, k, tracks);
          const have = wanted.get(action);
          if (have === undefined) wanted.set(action, { time: c.time, weight: w, best: c.weight });
          else wanted.set(action, { time: c.weight > have.best ? c.time : have.time, weight: have.weight + w, best: Math.max(have.best, c.weight) });
        }
      }
    };
    add(-1, pose.clips, 1);
    pose.layers.forEach((l, i) => add(i, l.clips, Math.min(1, Math.max(0, l.weight))));
    for (const a of actions.values()) a.setEffectiveWeight(0);
    for (const a of parts.values()) {
      const w = wanted.get(a);
      a.setEffectiveWeight(w?.weight ?? 0);
      if (w !== undefined) a.time = Math.min(w.time, a.getClip().duration);
    }
    mixer.update(0);
  };

  return {
    apply(pose) {
      if (pose.layers !== undefined && pose.layers.length > 0) {
        applyLayered(pose as AnimatorPoseLike & { layers: NonNullable<AnimatorPoseLike['layers']> });
        return;
      }
      if (layoutKey !== null) {
        // Back from a layered pose: its per-layer parts go.
        clearParts();
        layoutKey = null;
      }
      const weights = new Map<string, { time: number; weight: number }>();
      /** Phase 14.6: clips of an animation-only asset (no layers): whole-clip actions. */
      const foreign = new Map<THREE.AnimationAction, { time: number; weight: number }>();
      for (const c of pose.clips) {
        if (c.assetId !== assetId) {
          const clip = sourceClip(c.assetId, c.clip);
          if (clip === null) continue;
          const action = partAction(-1, c.assetId, clip, -1, clip.tracks);
          const have = foreign.get(action);
          foreign.set(action, have === undefined ? { time: c.time, weight: c.weight } : { time: c.weight > have.weight ? c.time : have.time, weight: have.weight + c.weight });
          continue;
        }
        if (!actions.has(c.clip)) continue;
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
      for (const a of parts.values()) {
        const w = foreign.get(a);
        a.setEffectiveWeight(w?.weight ?? 0);
        if (w !== undefined) a.time = Math.min(w.time, a.getClip().duration);
      }
      mixer.update(0);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
