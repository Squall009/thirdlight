/**
 * Test-only inline v3 documents for the project-model test suite (NOT part of
 * the package's public surface — not exported from index.ts, imported only
 * by .test.ts files).
 *
 * Phase 9.3 replacement for the M1 interchange fixture corpus
 * (archived to archive/removed-v1-v2/fixtures-project-model/): the same
 * documents, as the storage-v3 project parts — the v1 manifest, a
 * schemaVersion 3 scene and an empty v3 content block. Texts are
 * deliberately non-canonical (inline arrays) so byte parsing sees real
 * authoring-style input.
 */

export const DEMO_MANIFEST_TEXT = `{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "id": "demo-0001",
  "name": "Demo Project",
  "createdAt": "2026-09-16T23:40:00Z",
  "scenes": [
    { "id": "scene-main", "path": "scenes/main.json" }
  ]
}
`;

/** Hierarchy (world > ground, world > player), 45-degree yaw on player, box materials, one camera. */
export const DEMO_SCENE_TEXT = `{
  "schemaVersion": 3,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "world",
      "name": "World",
      "components": {
        "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }
      }
    },
    {
      "id": "ground",
      "name": "Ground",
      "parentId": "world",
      "components": {
        "transform": { "position": [0, -0.1, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "box": { "size": [4, 0.2, 1], "material": { "color": "#5c7a4b" } }
      }
    },
    {
      "id": "player",
      "name": "Player",
      "parentId": "world",
      "components": {
        "transform": {
          "position": [0, 0.25, 0],
          "rotation": [0, 0.3826834323650898, 0, 0.9238795325112867],
          "scale": [1, 1, 1]
        },
        "box": { "size": [0.5, 0.5, 0.5], "material": { "color": "#d94f3d" } }
      }
    },
    {
      "id": "cam-main",
      "name": "Main Camera",
      "components": {
        "transform": { "position": [0, 0.5, 4], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "camera": { "type": "perspective", "fovY": 60, "near": 0.1, "far": 100 }
      }
    }
  ]
}
`;

/** One camera entity: the smallest valid v3 scene. */
export const MINIMAL_SCENE_TEXT = `{
  "schemaVersion": 3,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "cam-main",
      "name": "Main Camera",
      "components": {
        "transform": { "position": [0, 0.5, 4], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "camera": { "type": "perspective", "fovY": 60, "near": 0.1, "far": 100 }
      }
    }
  ]
}
`;

/** An escaped duplicate of `schemaVersion` (`schemaVersion`): JSON.parse alone would keep the last one. */
export const DUPLICATE_KEY_SCENE_TEXT = `{
  "schemaVersion": 3,
  "\\u0073chemaVersion": 4,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    { "id": "cam-main", "components": { "transform": {}, "camera": {} } }
  ]
}
`;

/** 1e400 / -1e400: valid JSON syntax that decodes to ±Infinity. */
export const NUMERIC_OVERFLOW_SCENE_TEXT = `{
  "schemaVersion": 3,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "cam-main",
      "components": {
        "transform": { "position": [1e400, -1e400, 0] },
        "camera": {}
      }
    }
  ]
}
`;

/** The empty v3 content block (no assets, no game). */
export function emptyContentV3(): Record<string, unknown> {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
