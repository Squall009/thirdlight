/**
 * Test-only scene fixture for the three-adapter test suite (NOT part of
 * the public surface — not exported from index.ts, imported only by
 * .test.ts files). Local by design: no package may consume another
 * package's tests/fixtures (dependencies.md §3).
 */

/** A valid M1 scene (project-model §9/§10): one camera, one group, one
 *  box under the group (parent before child, §11 order). */
export function baseScene(): { schemaVersion: 1; sceneId: string; revision: number; entities: unknown[] } {
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 7,
    entities: [
      {
        id: 'cam-main',
        name: 'Main Camera',
        components: {
          transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
      {
        id: 'group-0001',
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      },
      {
        id: 'box-0001',
        parentId: 'group-0001',
        components: {
          transform: { position: [0.5, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          box: { size: [0.2, 0.2, 0.2], material: { color: '#ff8800' } },
        },
      },
    ],
  };
}

/** A well-formed runtime snapshot over `scene`. */
export function snapshotOf(scene: { revision: number }, projectId = 'demo-0001'): unknown {
  const revision = scene.revision;
  return { snapshotId: `${projectId}@r${revision}`, projectId, revision, scene };
}

/** Plain JSON clone. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}