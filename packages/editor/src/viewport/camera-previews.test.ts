/**
 * The Scene view's virtual camera frustum reads the lens the camera will have
 * in Play: its own fovY/near/far when set, else the project's (its camera
 * settings, the engine defaults when it sets none), at the game view's aspect.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedEntity } from '../session/projection';
import { virtualCameraPreviews } from './camera-previews';

/** The project lens the editor hands in when the project sets none (the engine's defaults). */
const ENGINE_LENS = { fovY: 60, near: 0.1, far: 100 };
const camera = (vc: Record<string, unknown>): ProjectedEntity =>
  ({ id: 'cam', name: 'Camera', parentId: null, kind: 'entity', active: true, visible: true, locked: false, static: false, keepLoaded: false, tags: 0, position: [0, 2, 8], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { virtualCamera: { rig: 'fixed', ...vc } } }) as unknown as ProjectedEntity;
const frustumOf = (vc: Record<string, unknown>, lens: { fovY: number; near: number; far: number }, aspect = 16 / 9) => {
  const [p] = virtualCameraPreviews([camera(vc)], aspect, lens);
  return p!.lines.userData['virtualCameraFrustum'] as { id: string; fovY: number; near: number; far: number; aspect: number };
};

describe('virtual camera previews', () => {
  it("a camera without a lens of its own shows the project's; its own fovY wins; the game's aspect", () => {
    expect(frustumOf({}, ENGINE_LENS)).toMatchObject({ id: 'cam', fovY: 60, near: 0.1, far: 100, aspect: 16 / 9 });
    expect(frustumOf({}, { fovY: 45, near: 0.1, far: 400 })).toMatchObject({ fovY: 45, far: 400 });
    expect(frustumOf({ fovY: 70 }, ENGINE_LENS, 4 / 3)).toMatchObject({ fovY: 70, near: 0.1, aspect: 4 / 3 });
    expect(virtualCameraPreviews([{ ...camera({}), components: {} } as ProjectedEntity], 1, ENGINE_LENS)).toEqual([]);
  });
});
