/**
 * Test-only scene/request builders (NOT part of the package's public
 * surface — imported only by .test.ts files).
 *
 * Builds VALID canonical v4 scenes (one scene file of a storage v4 project)
 * with the matching v4 project content block, and well-formed mutation
 * requests so the hand-crafted suites can exercise the pure layer end to end
 * (applyMutation in, canonical scene out). Since phase 9.3 the command layer
 * edits schemaVersion 3/4 scenes only, and a v4 command state is validated
 * together with its v4 content block (`gateResultV4`).
 */

import type { EntityV3, Quat, SceneV4, Vec3 } from '@thirdlight/project-model';

import { createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';

let counter = 0;

/** A fresh syntactically valid requestId (req- + 32 lowercase hex). */
export function freshRequestId(): string {
  counter += 1;
  const hex = BigInt(counter).toString(16).padStart(32, '0');
  return `req-${hex}`;
}

export interface EntityOpts {
  parentId?: string | null;
  name?: string;
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  size?: Vec3;
  color?: string;
}

export function cameraEntity(id = 'cam-main', opts: EntityOpts = {}): EntityV3 {
  const e: EntityV3 = {
    id,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.parentId != null ? { parentId: opts.parentId } : {}),
    components: {
      transform: {
        position: opts.position ?? [0, 0.5, 4],
        rotation: opts.rotation ?? [0, 0, 0, 1],
        scale: opts.scale ?? [1, 1, 1],
      },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    },
  };
  return e;
}

export function boxEntity(id: string, opts: EntityOpts = {}): EntityV3 {
  const e: EntityV3 = {
    id,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.parentId != null ? { parentId: opts.parentId } : {}),
    components: {
      transform: {
        position: opts.position ?? [0, 0, 0],
        rotation: opts.rotation ?? [0, 0, 0, 1],
        scale: opts.scale ?? [1, 1, 1],
      },
      box: {
        size: opts.size ?? [1, 1, 1],
        material: { color: opts.color ?? '#b0b0b0' },
      },
    },
  };
  return e;
}

export function groupEntity(id: string, opts: EntityOpts = {}): EntityV3 {
  const e: EntityV3 = {
    id,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.parentId != null ? { parentId: opts.parentId } : {}),
    components: {
      transform: {
        position: opts.position ?? [0, 0, 0],
        rotation: opts.rotation ?? [0, 0, 0, 1],
        scale: opts.scale ?? [1, 1, 1],
      },
    },
  };
  return e;
}

/** A v4 scene `scene-main` (the default project's one start scene). */
export function scene(revision: number, entities: EntityV3[]): SceneV4 {
  return {
    schemaVersion: 4,
    sceneId: 'scene-main',
    revision,
    entities,
  };
}

/**
 * The empty v4 project content block naming `scene-main` as its one scene
 * and start scene (what a new project's `content.json` holds).
 */
export function v4Content(): ContentDocument {
  return {
    assets: [],
    prefabs: [],
    behaviors: [],
    settings: {},
    behaviorTrust: { entries: [] },
    game: null,
    scenes: [{ sceneId: 'scene-main', name: 'Main' }],
    startScenes: ['scene-main'],
  } as unknown as ContentDocument;
}

/** A fresh command state over a v4 scene and its v4 content block. */
export function v4State(sc: SceneV4, content: ContentDocument = v4Content()): CommandState {
  return createCommandState(sc, content) as CommandState;
}

export interface RequestOpts {
  projectId?: string;
  expectedRevision?: number;
  requestId?: string;
  origin?: { kind: 'browser' | 'mcp' | 'admin'; clientId: string } | null;
}

/** A well-formed mutation request (args are spread through verbatim). */
export function req(
  op: string,
  args: Record<string, unknown> | object,
  opts: RequestOpts = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    op,
    projectId: opts.projectId ?? 'demo-0001',
    expectedRevision: opts.expectedRevision ?? 0,
    requestId: opts.requestId ?? freshRequestId(),
  };
  if (opts.origin !== null && opts.origin !== undefined) {
    out.origin = opts.origin;
  }
  out.args = args;
  return out;
}

/**
 * A well-formed request whose expectedRevision is derived from the state's
 * current revision — for chained test steps (each successful mutation
 * advances the revision by exactly 1).
 */
export function at(
  st: { scene: { revision: number } },
  op: string,
  args: Record<string, unknown> | object,
  opts: RequestOpts = {},
): Record<string, unknown> {
  return req(op, args, { expectedRevision: st.scene.revision, ...opts });
}

/** JSON-round-trip snapshot (deep value copy) for purity assertions. */
export function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}