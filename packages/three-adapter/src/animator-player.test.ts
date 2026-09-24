/**
 * Phase 14.6: the animator player masks override layers by bone and plays
 * clips of an animation-only asset on the model's bones (matched by name).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createAnimatorPlayer } from './animator-player';

/** hips → spine → arm, each bone at x = 0. */
function rig(): { root: THREE.Object3D; hips: THREE.Bone; spine: THREE.Bone; arm: THREE.Bone } {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'hips';
  const spine = new THREE.Bone();
  spine.name = 'spine';
  const arm = new THREE.Bone();
  arm.name = 'arm';
  root.add(hips);
  hips.add(spine);
  spine.add(arm);
  return { root, hips, spine, arm };
}

/** A clip holding every bone at x = `x` (constant over 1 s). */
function holdClip(name: string, x: number, bones: readonly string[] = ['hips', 'spine', 'arm']): THREE.AnimationClip {
  return new THREE.AnimationClip(
    name,
    1,
    bones.map((b) => new THREE.VectorKeyframeTrack(`${b}.position`, [0, 1], [x, 0, 0, x, 0, 0])),
  );
}

const A = 'asset-rig';
const at = (clip: string, weight = 1, assetId = A) => ({ assetId, clip, time: 0.5, weight });

describe('animator player (phase 14.6)', () => {
  it('plays a pose without layers as before: the whole clip on every bone', () => {
    const r = rig();
    const p = createAnimatorPlayer(r.root, [holdClip('run', 1), holdClip('attack', 5)], A);
    p.apply({ clips: [at('run')] });
    expect([r.hips.position.x, r.spine.position.x, r.arm.position.x]).toEqual([1, 1, 1]);
    p.apply({ clips: [at('run', 0.5), at('attack', 0.5)] });
    expect(r.hips.position.x).toBeCloseTo(3, 5);
    p.dispose();
  });

  it('an override layer drives only the bones of its mask; the rest keep the base pose', () => {
    const r = rig();
    const p = createAnimatorPlayer(r.root, [holdClip('run', 1), holdClip('attack', 5)], A);
    p.apply({ clips: [at('run')], layers: [{ mask: ['spine', 'arm'], weight: 1, clips: [at('attack')] }] });
    expect(r.hips.position.x).toBeCloseTo(1, 5);
    expect(r.spine.position.x).toBeCloseTo(5, 5);
    expect(r.arm.position.x).toBeCloseTo(5, 5);
    // Half the layer weight: the masked bones are halfway between.
    p.apply({ clips: [at('run')], layers: [{ mask: ['spine', 'arm'], weight: 0.5, clips: [at('attack')] }] });
    expect(r.hips.position.x).toBeCloseTo(1, 5);
    expect(r.spine.position.x).toBeCloseTo(3, 5);
    // An empty layer state (no clips): the base shows through everywhere.
    p.apply({ clips: [at('run')], layers: [{ mask: ['spine', 'arm'], weight: 1, clips: [] }] });
    expect([r.hips.position.x, r.spine.position.x, r.arm.position.x].map((x) => Math.round(x * 1e5) / 1e5)).toEqual([1, 1, 1]);
    // An empty mask covers every bone.
    p.apply({ clips: [at('run')], layers: [{ mask: [], weight: 1, clips: [at('attack')] }] });
    expect(r.hips.position.x).toBeCloseTo(5, 5);
    // Back to no layers.
    p.apply({ clips: [at('run')] });
    expect([r.hips.position.x, r.spine.position.x, r.arm.position.x].map((x) => Math.round(x * 1e5) / 1e5)).toEqual([1, 1, 1]);
    p.dispose();
  });

  it('later layers override earlier ones on the bones they share', () => {
    const r = rig();
    const p = createAnimatorPlayer(r.root, [holdClip('run', 1), holdClip('attack', 5), holdClip('wave', 9)], A);
    p.apply({
      clips: [at('run')],
      layers: [
        { mask: ['spine', 'arm'], weight: 1, clips: [at('attack')] },
        { mask: ['arm'], weight: 1, clips: [at('wave')] },
      ],
    });
    expect([r.hips.position.x, r.spine.position.x, r.arm.position.x].map((x) => Math.round(x * 1e5) / 1e5)).toEqual([1, 5, 9]);
    p.dispose();
  });

  it('plays clips of an animation-only asset on the model bones by name, once they are available', () => {
    const r = rig();
    let loaded = false;
    const p = createAnimatorPlayer(r.root, [holdClip('run', 1)], A, {
      clipsOf: (assetId) => (assetId === 'asset-anims' && loaded ? [holdClip('attack', 7, ['spine', 'arm'])] : null),
    });
    const pose = { clips: [at('run')], layers: [{ mask: ['spine', 'arm'], weight: 1, clips: [at('attack', 1, 'asset-anims')] }] };
    p.apply(pose);
    // Not loaded yet: the base pose everywhere.
    expect(r.spine.position.x).toBeCloseTo(1, 5);
    loaded = true;
    p.apply(pose);
    expect(r.hips.position.x).toBeCloseTo(1, 5);
    expect(r.spine.position.x).toBeCloseTo(7, 5);
    // A base-layer clip of the other asset (no layers).
    p.apply({ clips: [at('attack', 1, 'asset-anims')] });
    expect(r.arm.position.x).toBeCloseTo(7, 5);
    // An asset the player is not given clips for is skipped.
    p.apply({ clips: [at('run'), at('other', 1, 'asset-else')] });
    expect(r.hips.position.x).toBeCloseTo(1, 5);
    p.dispose();
  });
});
