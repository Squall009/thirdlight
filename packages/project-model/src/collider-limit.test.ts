/**
 * Phase 21.2: the collider limit is per scene. Play and the export capture the
 * start scenes merged into one runtime scene; the per-scene limits (256
 * colliders) apply to each scene, not to their sum — a world of several start
 * scenes may carry more colliders than one scene can.
 */
import { describe, expect, it } from 'vitest';

import { MAX_COLLIDERS } from './components';
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
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null, scenes: sceneIds.map((sceneId) => ({ sceneId, name: sceneId })), startScenes: sceneIds };
}
const ctx = { projectId: 'p', revision: 1 };

describe('the collider limit is per scene (phase 21.2)', () => {
  it('captures start scenes whose colliders together exceed one scene’s limit', () => {
    const a = scene('scene-a', colliders('block-a', 200));
    const b = scene('scene-b', colliders('block-b', 200));
    const merged = scene('scene-a', [...(a['entities'] as Obj[]), ...(b['entities'] as Obj[])]);
    expect((merged['entities'] as Obj[]).length).toBeGreaterThan(MAX_COLLIDERS);
    const view = captureContentViewV3(merged, content(['scene-a', 'scene-b']), ctx, [a, b]);
    expect(view.ok, JSON.stringify(view.ok ? null : view.errors)).toBe(true);
    expect(resolveMediaIdentityV3(merged, content(['scene-a', 'scene-b']), [a, b]).ok).toBe(true);
  });

  it('still refuses one scene over the limit', () => {
    const big = scene('scene-a', colliders('block-a', MAX_COLLIDERS + 1));
    const view = captureContentViewV3(big, content(['scene-a']), ctx, [big]);
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.errors[0]!.message).toContain(`collider limit of ${MAX_COLLIDERS}`);
    // Without the scene list the one scene is checked on its own.
    expect(captureContentViewV3(big, content(['scene-a']), ctx).ok).toBe(false);
  });
});
