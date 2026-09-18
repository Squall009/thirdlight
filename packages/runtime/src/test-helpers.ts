/**
 * Test-only fixture/helpers for the runtime test suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only
 * by .test.ts files; same pattern as project-model's test-fixtures.ts).
 */

/** A valid M1 scene (project-model §9/§10): one camera, one group, one
 *  box under the group (parent before child, §11 order). */
export function baseScene(): {
  schemaVersion: 1;
  sceneId: string;
  revision: number;
  entities: unknown[];
} {
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 4,
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

/** A well-formed runtime snapshot (runtime.md §2) over `scene`. */
export function snapshotOf(scene: { revision: number }, projectId = 'demo-0001'): unknown {
  const revision = scene.revision;
  return {
    snapshotId: `${projectId}@r${revision}`,
    projectId,
    revision,
    scene,
  };
}

/** Plain JSON clone (test inputs are JSON-able). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Test-side recursive freeze (mirrors the contract's deep-freeze rule). */
export function deepFreezeForTest<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  const rec = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(rec)) deepFreezeForTest(rec[key]);
  return value;
}

/** The box entity's authored x (the demo's x0). */
export const BOX_X0 = 0.5;
export const BOX_ID = 'box-0001';
export const GROUP_ID = 'group-0001';
export const CAM_ID = 'cam-main';