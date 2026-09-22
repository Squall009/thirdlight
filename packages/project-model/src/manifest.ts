/**
 * The immutable runtime-content manifest (sessions.md §17.1.1, packet 36).
 *
 * `captureManifest` is the pure derivation of the delivery manifest from ONE
 * already-captured authoring state: the captured scene document, the resolved
 * asset versions (project-model §19), the reachable source-bearing behaviors
 * and the required engine module IDs. It has no I/O, no clock and no
 * randomness — the caller supplies `capturedAt` — so two captures of the same
 * state produce byte-identical documents (export.md §7 / project-model §19.3).
 *
 * The document is the play/export structural input; `buildId` is its
 * self-identifying digest (sessions.md §17.1.1), never an engine-independent
 * binary hash.
 *
 * This module lives in the zero-dependency `project-model` leaf because the
 * canonical JSON text and the SHA-256 helpers (`./sha256`) already live here
 * (dependencies.md §3 lists `captureManifest` on the project-model row). The
 * contract's duplicate constants on the `protocol` row (`RUNTIME_CONTENT_TYPE`,
 * `MANIFEST_KEYS`, `buildOptionsRecordBytes`) are cross-checked against these
 * values by the packet-36 integration evidence; see the contract-change
 * request C36-2 in docs/handoffs/36.md.
 */
import { resolveRequiredModules } from './modules';
import { canonicalJsonText, sha256Hex, sha256HexOfText } from './sha256';

/** The manifest discriminator (sessions.md §17.1.1). */
export const RUNTIME_CONTENT_TYPE = 'thirdlight-runtime-content' as const;

/** The manifest shape version (sessions.md §17.1.1). */
export const RUNTIME_CONTENT_MANIFEST_VERSION = 1 as const;

/** The manifest document cap (sessions.md §17.1.3 numeric bounds). */
export const RUNTIME_CONTENT_MANIFEST_MAX_BYTES = 262_144;

/** The exact canonical option-set record (delivery.md §4.2 / export.md §5.3). */
export const BUILD_OPTIONS_RECORD = Object.freeze({
  bundler: 'esbuild@0.28.2',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  treeShaking: false,
  sourcemap: false,
  minify: false,
  target: 'es2022',
  loaders: ['ts', 'tsx'],
});

/** `JSON.stringify(record, null, 2) + "\n"` — the bytes `buildOptionsDigest` covers. */
export function buildOptionsRecordBytes(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(BUILD_OPTIONS_RECORD, null, 2)}\n`);
}

/** The manifest keys in their exact canonical order (`buildId` last). */
export const MANIFEST_KEYS = [
  'manifestVersion',
  'type',
  'projectId',
  'revision',
  'snapshotId',
  'capturedAt',
  'sceneDigest',
  'contentDigest',
  'assets',
  'behaviors',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;

/**
 * The pinned engine table recorded in `enginePins` (behaviors.md §5.3),
 * ascending by `id`. Identical to the packet-35 table (asserted by the
 * packet-36 evidence); a version change is an owner-approved decision change
 * (dependencies.md §9).
 */
export const M2_ENGINE_PINS: ReadonlyArray<{ id: string; version: string; apiVersion: number }> = Object.freeze([
  Object.freeze({ id: '@thirdlight/input', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/physics-rapier', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/platformer', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 1 }),
  Object.freeze({ id: '@thirdlight/three', version: '0.186.0', apiVersion: 0 }),
  Object.freeze({ id: '@thirdlight/three-adapter', version: '0.1.0', apiVersion: 1 }),
]);

/** The package a known module id belongs to (the manifest `modules` rows). */
export const M2_MODULE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'thirdlight.demo:box-motion': '@thirdlight/runtime',
  'thirdlight.input:keyboard-gamepad': '@thirdlight/input',
  'thirdlight.physics-rapier:2d': '@thirdlight/physics-rapier',
  'thirdlight.platformer:controller': '@thirdlight/platformer',
  'thirdlight.three-adapter:gltf-loader': '@thirdlight/three-adapter',
});

/** The engine module IDs this model version knows (ascending). */
export const M2_KNOWN_MODULE_IDS: readonly string[] = Object.freeze(Object.keys(M2_MODULE_PACKAGES).sort());

/** One resolved asset version of the captured view (project-model §19.1). */
export interface ManifestAssetInput {
  assetId: string;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
  /** The import recipe the deprecated `recipeDigest` is derived from. */
  importRecipe?: unknown;
  /** A caller-supplied `recipeDigest` (packet-35 play capture compatibility). */
  recipeDigest?: string;
  /** A caller-supplied `metricsDigest` (packet-35 play capture compatibility). */
  metricsDigest?: string;
}

/** One reachable source-bearing behavior (project-model §22.2). */
export interface ManifestBehaviorInput {
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  apiVersion: number;
  declaration: unknown;
  ownedTransforms: readonly string[];
  requiredModules: readonly string[];
}

export interface CaptureManifestInput {
  projectId: string;
  revision: number;
  /** UTC second at capture (project-model §7.2), e.g. `2026-09-19T10:00:00Z`. */
  capturedAt: string;
  /** The canonical runtime scene document (`{schemaVersion, sceneId, revision, entities}`). */
  scene?: unknown;
  /** A caller-supplied scene digest (when the caller already captured it). */
  sceneDigest?: string;
  assets: readonly ManifestAssetInput[];
  behaviors: readonly ManifestBehaviorInput[];
  moduleIds: readonly string[];
  recipeVersions?: { 'gltf-glb': number; 'behavior-source': number };
  /** A caller-supplied captured-view digest (when the caller already captured it). */
  contentDigest?: string;
}

/** The manifest document (field order = §17.1.1 key order; `buildId` last). */
export interface RuntimeContentManifest {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  assets: ReadonlyArray<Record<string, unknown>>;
  behaviors: ReadonlyArray<Record<string, unknown>>;
  modules: ReadonlyArray<Record<string, unknown>>;
  enginePins: ReadonlyArray<Record<string, unknown>>;
  recipes: Record<string, number>;
  toolchain: Record<string, unknown>;
  buildOptionsDigest: string;
  buildId: string;
}

export interface ManifestError {
  code: string;
  cls: 'validation' | 'internal';
  message: string;
  reason?: string;
  limit?: string;
  current?: number;
  max?: number;
}

export type CaptureManifestResult =
  | { ok: true; manifest: RuntimeContentManifest; bytes: Uint8Array; buildId: string }
  | { ok: false; error: ManifestError };

const DIGEST_RE = /^[0-9a-f]{64}$/;

function manifestError(code: string, message: string, reason?: string, limit?: string, current?: number, max?: number): ManifestError {
  return {
    code,
    cls: code === 'internal' ? 'internal' : 'validation',
    message: message.slice(0, 256),
    ...(reason !== undefined ? { reason } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/**
 * The `contentDigest` of a captured content view (project-model §19.1): the
 * canonical JSON of `{contentVersion, projectId, revision, assets}` with the
 * per-entry key order `assetId, version, sourceDigest, sourceByteLength,
 * importRecipe`. `canonicalJsonText` sorts keys, so the view's own key order is
 * irrelevant to the digest — byte-identical to the workspace's
 * `captureContentView` result for the same view.
 */
export function capturedViewDigest(input: {
  projectId: string;
  revision: number;
  assets: readonly ManifestAssetInput[];
}): string {
  const withoutDigest = {
    contentVersion: 1 as const,
    projectId: input.projectId,
    revision: input.revision,
    assets: input.assets.map((a) => ({
      assetId: a.assetId,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      ...(a.importRecipe !== undefined ? { importRecipe: a.importRecipe } : {}),
    })),
  };
  return sha256HexOfText(canonicalJsonText(withoutDigest));
}

/** `recipeDigest` for one import recipe (project-model §18.5). */
export function recipeDigestOf(importRecipe: unknown): string {
  return sha256HexOfText(canonicalJsonText(importRecipe));
}

/** The digest of one version's bounded record facts (packet-35 `metricsDigest`). */
export function versionFactsDigest(v: {
  assetId: string;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
}): string {
  return sha256HexOfText(
    canonicalJsonText({
      assetId: v.assetId,
      version: v.version,
      sourceDigest: v.sourceDigest,
      sourceByteLength: v.sourceByteLength,
    }),
  );
}

/**
 * The required engine module IDs for one captured M2 scene (ascending) —
 * the declared-dependency resolver over the scene's referenced content
 * (see `modules.ts`); a plain scene resolves to no modules.
 */
export function requiredModuleIds(
  scene: { entities: ReadonlyArray<Record<string, unknown>> },
  demo: boolean,
  hasBehaviors: boolean,
): string[] {
  void hasBehaviors;
  const r = resolveRequiredModules({ scene, game: null, demo });
  return r.ok ? r.moduleIds : [];
}

/**
 * Capture the §17.1.1 manifest from one captured state. Pure: every field is
 * derived from the arguments; `capturedAt` is caller-supplied.
 */
export function captureManifest(input: CaptureManifestInput): CaptureManifestResult {
  const assets = [...input.assets]
    .map((a) => ({
      assetId: a.assetId,
      version: a.version,
      sourceDigest: a.sourceDigest,
      sourceByteLength: a.sourceByteLength,
      recipeDigest: a.recipeDigest ?? recipeDigestOf(a.importRecipe),
      metricsDigest: a.metricsDigest ?? versionFactsDigest(a),
      path: `content/sha256/${a.sourceDigest}`,
    }))
    .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.version - b.version));
  const behaviors = [...input.behaviors]
    .map((b) => ({
      behaviorId: b.behaviorId,
      sourceDigest: b.sourceDigest,
      sourceByteLength: b.sourceByteLength,
      manifestDigest: b.manifestDigest,
      outputDigest: b.outputDigest,
      outputByteLength: b.outputByteLength,
      apiVersion: b.apiVersion,
      declaration: b.declaration,
      ownedTransforms: [...b.ownedTransforms],
      requiredModules: [...b.requiredModules],
      path: `behaviors/${b.outputDigest}.js`,
    }))
    .sort((a, b) => (a.behaviorId < b.behaviorId ? -1 : a.behaviorId > b.behaviorId ? 1 : 0));
  const moduleIds = [...new Set(input.moduleIds)].sort();
  const modules = moduleIds.map((id) => {
    const pkg = M2_MODULE_PACKAGES[id];
    const pin = pkg !== undefined ? M2_ENGINE_PINS.find((p) => p.id === pkg) : undefined;
    return { id, apiVersion: pin?.apiVersion ?? 1, package: pkg ?? '@thirdlight/runtime', version: pin?.version ?? '0.1.0' };
  });
  const recipes = input.recipeVersions ?? { 'gltf-glb': 1, 'behavior-source': 1 };

  for (const [name, value] of [
    ['scene', input.scene],
  ] as const) {
    if (value === undefined && input.sceneDigest === undefined) {
      return { ok: false, error: manifestError('internal', `${name} is required for a manifest capture`) };
    }
  }
  const sceneDigest = input.sceneDigest ?? sha256HexOfText(canonicalJsonText(input.scene));
  const contentDigest =
    input.contentDigest ?? capturedViewDigest({ projectId: input.projectId, revision: input.revision, assets: input.assets });
  for (const [name, value] of [
    ['sceneDigest', sceneDigest],
    ['contentDigest', contentDigest],
  ] as const) {
    if (!DIGEST_RE.test(value)) {
      return { ok: false, error: manifestError('field_value', `${name} must be 64 lowercase hex`) };
    }
  }

  const buildOptionsDigest = sha256Hex(buildOptionsRecordBytes());
  const withoutBuildId: Record<string, unknown> = {
    manifestVersion: RUNTIME_CONTENT_MANIFEST_VERSION,
    type: RUNTIME_CONTENT_TYPE,
    projectId: input.projectId,
    revision: input.revision,
    snapshotId: `${input.projectId}@r${input.revision}`,
    capturedAt: input.capturedAt,
    sceneDigest,
    contentDigest,
    assets,
    behaviors,
    modules,
    enginePins: M2_ENGINE_PINS.map((p) => ({ id: p.id, version: p.version, apiVersion: p.apiVersion })),
    recipes,
    toolchain: { esbuild: '0.28.2', typescript: '5.9.3', optionsDigest: buildOptionsDigest },
    buildOptionsDigest,
  };
  const preimage = manifestBuildIdInput(withoutBuildId);
  if (preimage === null) {
    return { ok: false, error: manifestError('internal', 'the manifest document could not be serialized') };
  }
  const buildId = sha256Hex(preimage);
  const manifest = { ...withoutBuildId, buildId } as unknown as RuntimeContentManifest;
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > RUNTIME_CONTENT_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      error: manifestError(
        'limits_exceeded',
        `the manifest document exceeds ${RUNTIME_CONTENT_MANIFEST_MAX_BYTES} bytes`,
        'limits_exceeded',
        'manifest_bytes',
        bytes.length,
        RUNTIME_CONTENT_MANIFEST_MAX_BYTES,
      ),
    };
  }
  return { ok: true, manifest, bytes, buildId };
}

/**
 * The exact bytes `buildId` covers (sessions.md §17.1.1): the canonical
 * document serialization of the manifest without `buildId`, key order exactly
 * as §17.1.1 writes it. Identical to `protocol`'s `manifestBuildIdInput` for
 * the same document (asserted by the packet-36 evidence).
 */
export function manifestBuildIdInput(manifest: Record<string, unknown>): Uint8Array | null {
  const without: Record<string, unknown> = {};
  for (const key of MANIFEST_KEYS) {
    if (key === 'buildId') continue;
    if (!(key in manifest)) return null;
    without[key] = manifest[key];
  }
  return new TextEncoder().encode(`${JSON.stringify(without, null, 2)}\n`);
}

/** One emitted artifact of the export closure (path relative to the output root). */
export interface EmittedArtifactDigest {
  path: string;
  digest: string;
  byteLength: number;
}

/**
 * `meta.json.outputDigest` (export.md §6): the SHA-256 record of the emitted
 * closure. Deterministic over the emitted artifact listing (sorted by path,
 * excluding `meta.json` itself — it carries `exportedAt` and this value):
 *
 *   sha256( for each artifact: `${path}\n${digest}\n${byteLength}\n` )
 *
 * The algorithm is not fixed by the accepted contract text (a contract-change
 * request C36-3 records the proposed definition).
 */
export function digestEmittedClosure(artifacts: readonly EmittedArtifactDigest[]): string {
  const rows = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let text = '';
  for (const a of rows) text += `${a.path}\n${a.digest}\n${a.byteLength}\n`;
  return sha256HexOfText(text);
}

/** SHA-256 (lowercase hex) of one byte string — re-exported for closure digests. */
export const digestBytes = sha256Hex;
