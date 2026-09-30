/**
 * A scene has no collider count of its own: every entity may carry one.
 * Play and the export capture the start scenes merged into one runtime
 * scene, and the per-scene limits apply to each scene, not to their sum.
 */
import { describe, expect, it } from 'vitest';

import { captureContentViewV3, resolveMediaIdentityV3 } from './manifest-v2';

type Obj = Record<string, unknown>;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function colliders(prefix: string, n: number): Obj[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(4, '0')}`,
    components: { transform: { ...T, position: [i * 2, 0, 0] }, box: { size: [1, 1, 1], material: { color: '#808080' } }, collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } },
  }));
}
function scene(sceneId: string, entities: Obj[]): Obj {
  return { schemaVersion: 4, sceneId, revision: 1, entities };
}
function content(sceneIds: string[]): Obj {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: sceneIds.map((sceneId) => ({ sceneId, name: sceneId })), startScenes: sceneIds };
}
const ctx = { projectId: 'p', revision: 1 };

describe('colliders in a scene', () => {
  it('a scene carries as many colliders as it has entities (the 256 once allowed was a sample size)', () => {
    const big = scene('scene-a', colliders('block-a', 2_000));
    const view = captureContentViewV3(big, content(['scene-a']), ctx, [big]);
    expect(view.ok, JSON.stringify(view.ok ? null : view.errors).slice(0, 400)).toBe(true);
  });

  it('captures start scenes merged into one runtime scene', () => {
    const a = scene('scene-a', colliders('block-a', 1_000));
    const b = scene('scene-b', colliders('block-b', 1_000));
    const merged = scene('scene-a', [...(a['entities'] as Obj[]), ...(b['entities'] as Obj[])]);
    const view = captureContentViewV3(merged, content(['scene-a', 'scene-b']), ctx, [a, b]);
    expect(view.ok, JSON.stringify(view.ok ? null : view.errors).slice(0, 400)).toBe(true);
    expect(resolveMediaIdentityV3(merged, content(['scene-a', 'scene-b']), [a, b]).ok).toBe(true);
  });
});
