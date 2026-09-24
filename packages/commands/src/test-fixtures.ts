/**
 * Test-only fixture access for the commands test suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only by
 * .test.ts files).
 *
 * Fixture files under `fixtures/commands/` are read through the Vite
 * `import.meta.glob` `?raw` transform (eager, raw text) because this
 * package's boundary rules forbid Node builtin imports in package sources
 * (dependencies.md §4.1/§5 check 1; the only exempted test import is
 * vitest). Every fixture file is valid UTF-8 (packet 02 verification),
 * so the raw text round-trips to the exact file bytes via `TextEncoder`.
 *
 * The fixtures are the normative examples of commands.md §12, in storage v4
 * since phase 9.3: self-contained scenarios whose `disk-before`/`disk-after`
 * are whole v4 projects (`project.json`, `content.json`,
 * `scenes/scene-main.json`) and `messages.json` request/result pairs. The
 * scenario `out` payloads are the workspace's acknowledgements; the pure
 * layer's result is the same payload without the `sceneId` the workspace
 * appends for a v4 project (`withoutSceneId`), asserted verbatim.
 */

import { validateContentV4, validateSceneV4, type ContentCatalogV4, type SceneV4 } from '@thirdlight/project-model';

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
  const content = validateContentV4(contentFile.content);
  if (!content.ok) throw new Error(`fixture content invalid: ${JSON.stringify(content.errors)}`);
  const revision = Math.max(scene.normalized.revision, contentFile.revision);
  return {
    scene: { ...scene.normalized, revision },
    content: content.normalized as ContentCatalogV4 as unknown as ContentDocument,
  };
}

/** A workspace acknowledgement without the `sceneId` a v4 project appends (the pure §5.1 payload). */
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
// ---- packet 21: M2 command fixtures (fixtures/m2/{commands,contracts/commands,prefabs}) --
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
 * The state of an M2 command envelope under `fixtures/m2/<rel>` lifted to
 * one v4 project scene (phase 9.3 removed the v2 scene model): the scene is
 * re-labelled `schemaVersion 4` and the content block gains the v4 keys
 * (`game: null`, the one scene `scene-main` as the index and start set).
 * Both are validated by the v4 model rules, so a fixture that is no longer a
 * valid v4 state fails loudly here instead of inside a test.
 */
export function m2EnvelopeV4(rel: string): { projectId: string; scene: SceneV4; content: ContentDocument } {
  const env = m2FixtureJson<{ projectId: string; scene: Record<string, unknown>; content: Record<string, unknown> }>(rel);
  const scene = validateSceneV4({ ...env.scene, schemaVersion: 4 });
  if (!scene.ok) throw new Error(`${rel}: scene is not a valid v4 scene: ${JSON.stringify(scene.errors)}`);
  const content = validateContentV4({
    ...env.content,
    game: null,
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

// ---- packet 45: M3 v3 contract fixtures (fixtures/m3/contracts/**) ---------------

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
