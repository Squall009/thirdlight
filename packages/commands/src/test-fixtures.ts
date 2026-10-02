/**
 * Test-only fixture access for the commands test suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only by
 * .test.ts files).
 *
 * Fixture files under `fixtures/commands/` are read through the Vite
 * `import.meta.glob` `?raw` transform (eager, raw text) because this
 * package's boundary rules forbid Node builtin imports in package sources
 * (the only exempted test import is vitest). Every fixture file is valid
 * UTF-8, so the raw text round-trips to the exact file bytes via `TextEncoder`.
 *
 * The fixtures are the normative command examples, in storage v4:
 * self-contained scenarios whose `disk-before`/`disk-after`
 * are whole v4 projects (`project.json`, `content.json`,
 * `scenes/scene-main.json`) and `messages.json` request/result pairs. The
 * scenario `out` payloads are the workspace's acknowledgements; the pure
 * layer's result is the same payload without the `sceneId` the workspace
 * appends for a v4 project (`withoutSceneId`), asserted verbatim.
 */

import { sceneCamerasAsShots, validateContentV4, validateSceneV4, type ContentCatalogV4, type SceneV4 } from '@thirdlight/project-model';

import type { ContentDocument } from './types';

const RAW = import.meta.glob('../../../fixtures/commands/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const PREFIX = '../../../fixtures/commands/';

/** Raw UTF-8 text of `fixtures/commands/<rel>`. */
export function fixtureText(rel: string): string {
  const key = `${PREFIX}${rel}`;
  const v = RAW[key];
  if (typeof v !== 'string') {
    throw new Error(
      `fixture not found: ${rel} (matched ${Object.keys(RAW).length} files; ` +
        `sample keys: ${Object.keys(RAW).slice(0, 3).join(', ')})`,
    );
  }
  return v;
}

/** Exact bytes of `fixtures/commands/<rel>` (UTF-8, BOM-free fixtures). */
export function fixtureBytes(rel: string): Uint8Array {
  return new TextEncoder().encode(fixtureText(rel));
}

/**
 * The v4 project state under `fixtures/commands/<dir>` (a `disk-before` /
 * `disk-after` directory): the one scene of `scenes/scene-main.json` (with
 * the project revision, as the workspace hands it to the pure layer) and the
 * content catalog of `content.json`, both validated by the model.
 */
export function fixtureProjectV4(dir: string): { scene: SceneV4; content: ContentDocument } {
  const sceneFile = JSON.parse(fixtureText(`${dir}/scenes/scene-main.json`)) as { scene: unknown };
  const contentFile = JSON.parse(fixtureText(`${dir}/content.json`)) as { revision: number; content: unknown };
  const scene = validateSceneV4(sceneFile.scene);
  if (!scene.ok) throw new Error(`fixture scene invalid: ${JSON.stringify(scene.errors)}`);
  // content.json holds the project-wide settings; the corpus has no resource files (no prefabs or behaviors).
  const content = validateContentV4({ prefabs: [], behaviors: [], ...(contentFile.content as object) });
  if (!content.ok) throw new Error(`fixture content invalid: ${JSON.stringify(content.errors)}`);
  const revision = Math.max(scene.normalized.revision, contentFile.revision);
  return {
    scene: { ...scene.normalized, revision },
    content: content.normalized as ContentCatalogV4 as unknown as ContentDocument,
  };
}

/** A workspace acknowledgement without the `sceneId` a v4 project appends (the pure success payload). */
export function withoutSceneId(out: Record<string, unknown>): Record<string, unknown> {
  const { sceneId: _sceneId, ...rest } = out;
  return rest;
}

/** Constant-time-free plain byte equality (no Buffer dependency). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
// ---- command fixtures (fixtures/m2/{commands,contracts/commands,prefabs}) --
// Only the command scenarios the v4 ports replay (content-ops-v4,
// prefab-ops-v4, model-authoring-v4) are loaded.

const M2_RAW = import.meta.glob('../../../fixtures/m2/{commands,contracts/commands,prefabs}/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const M2_PREFIX = '../../../fixtures/m2/';

/** Raw UTF-8 text of `fixtures/m2/<rel>`. */
export function m2FixtureText(rel: string): string {
  const key = `${M2_PREFIX}${rel}`;
  const v = M2_RAW[key];
  if (typeof v !== 'string') {
    throw new Error(
      `fixture not found: ${rel} (matched ${Object.keys(M2_RAW).length} files)`,
    );
  }
  return v;
}

/** Parsed JSON value of `fixtures/m2/<rel>`. */
export function m2FixtureJson<T = unknown>(rel: string): T {
  return JSON.parse(m2FixtureText(rel)) as T;
}

/**
 * The state of a command envelope under `fixtures/m2/<rel>` lifted to
 * one v4 project scene (the command layer edits no v2 scene): the scene is
 * re-labelled `schemaVersion 4` and the content block gains the v4 keys
 * (`game: null`, the one scene `scene-main` as the index and start set) and
 * its scene camera becomes the shot the format upgrade makes of it.
 * Both are validated by the v4 model rules, so a fixture that is not a
 * valid v4 state fails loudly here instead of inside a test.
 */
export function m2EnvelopeV4(rel: string): { projectId: string; scene: SceneV4; content: ContentDocument } {
  const env = m2FixtureJson<{ projectId: string; scene: Record<string, unknown>; content: Record<string, unknown> }>(rel);
  // Its scene camera is the shot the format upgrade makes of it (the engine owns the view).
  const scene = validateSceneV4({ ...env.scene, schemaVersion: 4, entities: sceneCamerasAsShots((env.scene['entities'] as unknown[]) ?? []) });
  if (!scene.ok) throw new Error(`${rel}: scene is not a valid v4 scene: ${JSON.stringify(scene.errors)}`);
  const content = validateContentV4({
    ...env.content,
    scenes: [{ sceneId: 'scene-main', name: 'Main' }],
    startScenes: ['scene-main'],
  });
  if (!content.ok) throw new Error(`${rel}: content is not a valid v4 block: ${JSON.stringify(content.errors)}`);
  return {
    projectId: env.projectId,
    scene: scene.normalized,
    content: content.normalized as ContentCatalogV4 as unknown as ContentDocument,
  };
}

// ---- v3 contract fixtures (fixtures/m3/contracts/**) ---------------

const M3_CONTRACT_RAW = import.meta.glob('../../../fixtures/m3/contracts/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const M3_CONTRACT_PREFIX = '../../../fixtures/m3/contracts/';

/** Raw UTF-8 text of `fixtures/m3/contracts/<rel>`. */
export function m3ContractText(rel: string): string {
  const key = `${M3_CONTRACT_PREFIX}${rel}`;
  const v = M3_CONTRACT_RAW[key];
  if (typeof v !== 'string') {
    throw new Error(`fixture not found: ${rel} (matched ${Object.keys(M3_CONTRACT_RAW).length} files)`);
  }
  return v;
}

/** Parsed JSON value of `fixtures/m3/contracts/<rel>`. */
export function m3ContractJson<T = unknown>(rel: string): T {
  return JSON.parse(m3ContractText(rel)) as T;
}

/**
 * The `fixtures/m3` contract envelopes were recorded against a game layer
 * the engine does not have (the `cameraFollow` and `gameZone` components and
 * the `content.game` block). A neutral copy for the generic suites: every
 * `cameraFollow` is dropped, every `gameZone` entity is removed, and
 * `content.game` is `null`. Everything else (ids, revision, assets, spawns,
 * surfaces, lights, models) is the recorded value.
 */
export function neutralM3Envelope<T>(env: T): T {
  const copy = structuredClone(env) as unknown as {
    scene: { entities: Array<{ components: Record<string, unknown> }> };
    content: Record<string, unknown>;
  };
  copy.scene.entities = copy.scene.entities
    .filter((e) => e.components['gameZone'] === undefined)
    .map((e) => {
      const { cameraFollow: _cameraFollow, ...components } = e.components;
      return { ...e, components };
    });
  copy.content = { ...copy.content, game: null };
  return copy as unknown as T;
}

/** `neutralM3Envelope` of the parsed `fixtures/m3/contracts/<rel>` envelope. */
export function m3NeutralJson<T = unknown>(rel: string): T {
  return neutralM3Envelope(m3ContractJson<T>(rel));
}
